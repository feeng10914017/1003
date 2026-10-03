/*
 * 世界脈動 World Pulse — 主程式
 * 流程：讀取新聞資料 → 解析 → 自動分類 → 依篩選條件畫出卡片／條列 → 點新聞開啟內頁
 *      另外整理「熱門話題」：Google 搜尋趨勢＋多家媒體同時報導的焦點
 */

const PLACEHOLDER = 'images/placeholder.svg';
const CACHE_KEY = 'world-pulse-cache-v3';
const OUTDATED_HOURS = 3;        // 資料超過幾小時沒更新就顯示警告
const READ_LIMIT = 2000;         // 最多記住幾則已讀
const FETCH_TIMEOUT = 8000;
const CONCURRENCY = 4;
const FOCUS_WINDOW_HOURS = 48;   // 媒體焦點只看最近幾小時的新聞
const FOCUS_SIMILARITY = 0.25;   // 兩則標題相似度超過這個值，就視為同一事件
const FOCUS_MAX = 10;

const state = {
  lang: 'zh',          // 介面語言（只影響按鈕、標籤等文字，不影響新聞內容）
  cat: 'all',
  region: 'all',
  srcLang: 'all',      // 新聞原文語言篩選
  query: '',
  view: 'cards',       // cards | list
  hotTab: 'trends',    // trends | focus
  hotSort: 'hot',      // hot（最熱）| new（最新）
  geo: Object.keys(TRENDS)[0] || 'tw',
  items: [],
  trends: {},
  focus: null,         // 媒體焦點（算過就暫存）
  status: {},
  onlyNew: false,      // 只看「自上次來訪後新增」
  sharePages: false,   // GitHub 有沒有產生 s/ 分享頁
  pendingStory: null,  // 網址帶 #story= 時，等資料載入後要打開的新聞
  loading: false,      // 正在載入資料
  loadError: null,     // 完全載入失敗時：'offline'（沒網路）或 'failed'（其他原因）
  loadId: 0
};

const $ = (sel) => document.querySelector(sel);
const t = () => I18N[state.lang];
const locale = () => (state.lang === 'zh' ? 'zh-TW' : 'en');

/* ---------- 小工具 ---------- */

function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 無痕模式等情況會失敗，忽略即可 */ }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function stripHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 圖片說明、圖說小字不放進摘要
  doc.querySelectorAll('img, figure, figcaption, p[style]').forEach((node) => node.remove());
  return (doc.body.textContent || '')
    .replace(/Continue reading\.*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 有些來源（如紐時中文網）把圖片放在摘要的 HTML 裡 */
function firstImageInHtml(html) {
  if (!html || !html.includes('<img')) return '';
  const img = new DOMParser().parseFromString(html, 'text/html').querySelector('img[src]');
  return img ? img.getAttribute('src') : '';
}

function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch (e) { return ''; }
}

/* 新聞代號：網址的 FNV-1a 雜湊轉 36 進位（和 scripts/fetch_news.py 的 story_hash 算法一樣，分享頁才對得上） */
function storyHash(text) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/* 已讀紀錄、上次來訪看過哪些新聞：存在讀者自己的瀏覽器 */
const readSet = new Set(storageGet('world-pulse-read') || []);
const seenBefore = (() => {
  const saved = storageGet('world-pulse-seen');
  return Array.isArray(saved) ? new Set(saved) : null; // null = 第一次來，不標「新」
})();

function markRead(sid) {
  if (readSet.has(sid)) return;
  readSet.add(sid);
  storageSet('world-pulse-read', [...readSet].slice(-READ_LIMIT));
}

const isNew = (it) => seenBefore !== null && !seenBefore.has(it.sid) && !readSet.has(it.sid);

let toastTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2400);
}

/* BBC 縮圖只有 240px，換成 800px 版本比較清楚 */
function upgradeImage(url) {
  if (!url) return '';
  return url.replace(/(ichef\.bbci\.co\.uk\/ace\/(?:standard|ws))\/\d+\//, '$1/800/');
}

function timeAgo(date) {
  if (!date || isNaN(date)) return '';
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const diff = (date.getTime() - Date.now()) / 1000;
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, sec] of units) {
    if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), unit);
  }
  return rtf.format(0, 'minute');
}

function formatClock(date) {
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ---------- 抓資料 ---------- */

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function withFeed(items, feed) {
  return items.map((it) => ({ ...it, source: feed.source, lang: feed.lang, feedCat: feed.cat, feedRegion: feed.region }));
}

/* 讀取 GitHub Actions 每小時產生的 data/news.json */
async function loadSnapshot() {
  // 每 10 分鐘換一次網址參數，避免瀏覽器一直拿舊檔案
  const bucket = Math.floor(Date.now() / 600000);
  const res = await fetchWithTimeout(`data/news.json?v=${bucket}`);
  return res.json();
}

/* JSON 裡存的是 RSS 原始欄位，整理成跟 parseXml 一樣的格式 */
function fromSnapshot(raw) {
  return {
    title: stripHtml(raw.title),
    link: raw.link,
    description: stripHtml(raw.description),
    date: new Date(raw.date),
    image: raw.image || firstImageInHtml(raw.description),
    categories: raw.categories || []
  };
}

/* 代理排序：成功的往前排、失敗的往後排，並記在瀏覽器裡，下次直接先用好用的 */
let proxyOrder = (() => {
  const saved = storageGet('world-pulse-proxy-order');
  const valid = Array.isArray(saved) && saved.length === PROXIES.length &&
    PROXIES.every((_, i) => saved.includes(i));
  return valid ? saved : PROXIES.map((_, i) => i);
})();

function rankProxy(index, ok) {
  proxyOrder = proxyOrder.filter((i) => i !== index);
  if (ok) proxyOrder.unshift(index); else proxyOrder.push(index);
  storageSet('world-pulse-proxy-order', proxyOrder);
}

/* 依序嘗試每個代理；xmlOnly 用在 Google 趨勢（rss2json 會丟掉搜尋量等欄位） */
async function fetchViaProxy(url, parse, xmlOnly = false) {
  let lastError = new Error('no proxy');
  for (const index of [...proxyOrder]) {
    const proxy = PROXIES[index];
    if (xmlOnly && proxy.type !== 'xml') continue;
    try {
      const res = await fetchWithTimeout(proxy.build(url));
      const items = proxy.type === 'json' ? parseRss2Json(await res.json()) : parse(await res.text());
      if (!items.length) throw new Error('empty feed');
      if (proxyOrder[0] !== index) rankProxy(index, true);
      return items;
    } catch (e) {
      lastError = e;
      // 只有連線失敗／逾時／HTTP 錯誤才算代理的錯，RSS 內容有問題不算
      if (e.name === 'AbortError' || e instanceof TypeError || /^HTTP/.test(e.message)) rankProxy(index, false);
    }
  }
  throw lastError;
}

/* 找某個節點底下第一個符合名稱的子元素（忽略 media: / dc: / ht: 等前綴） */
function child(node, ...names) {
  for (const c of node.children) {
    if (names.includes(c.localName)) return c;
  }
  return null;
}
const childText = (node, ...names) => (child(node, ...names)?.textContent || '').trim();

function xmlItems(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('bad xml');
  return [...doc.getElementsByTagName('item')];
}

function parseXml(text) {
  return xmlItems(text).map((node) => {
    // 圖片：media:thumbnail / media:content（取最寬的）/ enclosure
    let image = '';
    let bestWidth = -1;
    for (const c of node.children) {
      const url = c.getAttribute('url');
      if (!url) continue;
      const isImage = c.localName === 'thumbnail' || c.localName === 'content' ||
        (c.localName === 'enclosure' && (c.getAttribute('type') || '').startsWith('image'));
      if (!isImage) continue;
      const width = parseInt(c.getAttribute('width') || '0', 10);
      if (width > bestWidth) { bestWidth = width; image = url; }
    }

    const categories = [...node.children]
      .filter((c) => c.localName === 'category' || c.localName === 'subject')
      .map((c) => c.textContent.trim());

    const descHtml = childText(node, 'description', 'encoded');
    return {
      title: stripHtml(childText(node, 'title')),
      link: childText(node, 'link') || node.getAttribute('rdf:about') || '',
      description: stripHtml(descHtml),
      date: new Date(childText(node, 'pubDate', 'date')),
      image: image || firstImageInHtml(descHtml),
      categories
    };
  });
}

/* Google 搜尋趨勢 RSS（格式和 fetch_news.py 的 parse_trends 一樣） */
function parseTrendsXml(text) {
  return xmlItems(text).slice(0, 20).map((node) => ({
    title: childText(node, 'title'),
    traffic: childText(node, 'approx_traffic'),
    picture: childText(node, 'picture'),
    date: childText(node, 'pubDate'),
    news: [...node.children].filter((c) => c.localName === 'news_item').slice(0, 4).map((n) => ({
      title: childText(n, 'news_item_title'),
      url: childText(n, 'news_item_url'),
      source: childText(n, 'news_item_source'),
      picture: childText(n, 'news_item_picture')
    }))
  }));
}

function parseRss2Json(data) {
  if (data.status !== 'ok') throw new Error('rss2json error');
  return data.items.map((it) => ({
    title: stripHtml(it.title),
    link: it.link,
    description: stripHtml(it.description),
    // rss2json 的時間是 UTC，但沒附時區
    date: new Date((it.pubDate || '').replace(' ', 'T') + 'Z'),
    image: it.thumbnail || it.enclosure?.link || it.enclosure?.thumbnail || firstImageInHtml(it.description),
    categories: it.categories || []
  }));
}

/* ---------- 自動分類 ---------- */

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* 把關鍵字表預先編成比對函式，避免每則新聞重算 */
function buildMatchers(table) {
  const out = {};
  for (const [key, words] of Object.entries(table)) {
    out[key] = words.map((w) => {
      if (/[一-鿿]/.test(w)) return (s) => s.includes(w);
      const caseSensitive = w === w.toUpperCase() && /[A-Z]/.test(w);
      const re = new RegExp('\\b' + escapeRegex(w), caseSensitive ? '' : 'i');
      return (s) => re.test(s);
    });
  }
  return out;
}
const MATCH_REGION = buildMatchers(KEYWORDS.region);
const MATCH_CAT = buildMatchers(KEYWORDS.cat);

/* 標題命中算 2 分、摘要算 1 分，取最高分；未達 minScore 就當作猜不出來 */
function guess(matchers, title, desc, minScore = 1) {
  let best = null;
  let bestScore = 0;
  for (const [key, fns] of Object.entries(matchers)) {
    let score = 0;
    for (const fn of fns) {
      if (fn(title)) score += 2;
      else if (fn(desc)) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = key; }
  }
  return bestScore >= minScore ? best : null;
}

/* RSS 本身附的分類名稱（例如法廣的「亞洲」「今日經濟」） */
const SOURCE_CATEGORY_MAP = {
  亞洲: { region: 'asia' }, 港台: { region: 'asia' },
  中東: { region: 'middle_east' }, 美洲: { region: 'americas' }, 歐洲: { region: 'europe' },
  法國: { region: 'europe' }, 德国新闻: { region: 'europe' }, 非洲: { region: 'africa' },
  今日經濟: { cat: 'business' }, 经济: { cat: 'business' }, 經濟: { cat: 'business' },
  科技: { cat: 'tech' }, 体育: { cat: 'sport' }, 體育: { cat: 'sport' }, 文化: { cat: 'culture' },
  Sport: { cat: 'sport' }, Business: { cat: 'business' }, Technology: { cat: 'tech' },
  Environment: { cat: 'science' }, Science: { cat: 'science' }, Health: { cat: 'health' },
  Africa: { region: 'africa' }, Europe: { region: 'europe' }, Asia: { region: 'asia' },
  'Middle East': { region: 'middle_east' }, Americas: { region: 'americas' },
  'US news': { region: 'americas' }, 'Australia news': { region: 'oceania' }
};

/* 判斷順序：RSS 設定 → 來源標籤（分類）／標題關鍵字（地區） → 另一種 → 預設 */
function classify(item) {
  let { feedCat: cat, feedRegion: region } = item;
  let tagRegion = null;
  for (const c of item.categories) {
    const hit = SOURCE_CATEGORY_MAP[c];
    if (!hit) continue;
    if (!tagRegion && hit.region) tagRegion = hit.region;
    if ((!cat || cat === 'world') && hit.cat) cat = hit.cat;
  }
  // 分類比較容易誤判，要標題命中（或摘要命中兩次）才算
  if (!cat || cat === 'world') cat = guess(MATCH_CAT, item.title, item.description, 2) || 'world';
  // 來源的地區標籤有時不準（例如法廣把很多國際新聞都標成「中國」），所以關鍵字優先
  if (!region) region = guess(MATCH_REGION, item.title, item.description) || tagRegion;
  return { cat, region };
}

/* ---------- 合併、去重 ---------- */

function linkKey(link) {
  try {
    const u = new URL(link);
    return u.host.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
  } catch (e) { return link; }
}

function mergeItems(rawItems) {
  const map = new Map();
  for (const raw of rawItems) {
    const link = safeUrl(raw.link);
    if (!raw.title || !link) continue;
    const key = linkKey(link);
    const prev = map.get(key);
    if (prev) {
      // 同一則新聞出現在多個 RSS：保留比較具體的分類與地區
      if (!prev.feedRegion && raw.feedRegion) prev.feedRegion = raw.feedRegion;
      if ((!prev.feedCat || prev.feedCat === 'world') && raw.feedCat) prev.feedCat = raw.feedCat;
      if (!prev.image && raw.image) prev.image = raw.image;
      continue;
    }
    map.set(key, { ...raw, link, rawLink: raw.link });
  }
  const items = [...map.values()]
    .map((it) => ({
      id: linkKey(it.link),
      sid: storyHash(it.rawLink),
      title: it.title,
      link: it.link,
      description: it.description,
      date: isNaN(it.date) ? null : it.date.toISOString(),
      image: safeUrl(upgradeImage(it.image)),
      source: it.source,
      lang: it.lang,
      ...classify(it)
    }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return collapseReprints(items);
}

/* 中央社、自由時報等常刊出一字不差的同一則新聞：標題幾乎一樣就合併成一則，
   其他家放進 also，卡片上顯示「另有 N 家報導」 */
function collapseReprints(items) {
  const DAY2 = 48 * 3600 * 1000;
  const grams = (title) => {
    const t = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const set = new Set();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const dice = (a, b) => {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const g of a) if (b.has(g)) shared++;
    return (2 * shared) / (a.size + b.size);
  };

  const kept = [];
  const keptGrams = [];
  for (const it of items) {
    const g = grams(it.title);
    const time = Date.parse(it.date) || 0;
    const index = kept.findIndex((k, i) =>
      k.lang === it.lang && k.source !== it.source &&
      !(k.also || []).some((a) => a.source === it.source) &&
      Math.abs((Date.parse(k.date) || 0) - time) < DAY2 &&
      dice(keptGrams[i], g) >= 0.8);
    if (index === -1) {
      kept.push(it);
      keptGrams.push(g);
      continue;
    }
    const main = kept[index];
    main.also = [...(main.also || []), { source: it.source, link: it.link, title: it.title }];
    if (!main.image && it.image) main.image = it.image;
  }
  return kept;
}

/* ---------- 媒體焦點：找出多家媒體同時報導的事件 ---------- */

const STOP_EN = new Set(('the a an of to in on for and or is are was be by with at from as after over says say said ' +
  'new its it his her their into about than more up out not this that who what how why will has have had amid ' +
  'can could would should may might been being do does did first last year years day days week live latest ' +
  'news video watch two three one man woman people').split(' '));

/* 把標題拆成「詞」：中文用相鄰兩字（雙字詞），英文用單字 */
function topicTokens(item) {
  const set = new Set();
  if (item.lang === 'zh') {
    for (const chunk of item.title.replace(/[^一-鿿A-Za-z0-9]+/g, ' ').split(' ')) {
      if (/^[A-Za-z0-9]+$/.test(chunk)) { if (chunk.length > 1) set.add(chunk.toLowerCase()); continue; }
      for (let i = 0; i < chunk.length - 1; i++) set.add(chunk.slice(i, i + 2));
    }
  } else {
    for (const w of item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
      if (w.length < 3 || STOP_EN.has(w)) continue;
      set.add(w.replace(/(?<=..)s$/, ''));
    }
  }
  return set;
}

function computeFocus(items) {
  const since = Date.now() - FOCUS_WINDOW_HOURS * 3600 * 1000;
  const recent = items.filter((it) => it.date && Date.parse(it.date) >= since);
  const tokens = new Map(recent.map((it) => [it.id, topicTokens(it)]));

  // 越常見的詞（例如「美國」）權重越低，罕見的人名、地名權重越高
  const df = new Map();
  for (const set of tokens.values()) for (const w of set) df.set(w, (df.get(w) || 0) + 1);
  const weight = (w) => Math.log((recent.length + 1) / (df.get(w) || 1));
  const total = (set) => [...set].reduce((s, w) => s + weight(w), 0);

  const similarity = (a, b) => {
    let shared = 0;
    let sharedCount = 0;
    for (const w of a) if (b.has(w)) { shared += weight(w); sharedCount++; }
    if (sharedCount < 2) return 0;
    return shared / Math.min(total(a), total(b));
  };

  const clusters = [];
  for (const item of recent) {
    const set = tokens.get(item.id);
    if (set.size < 2) continue;
    let best = null;
    let bestSim = FOCUS_SIMILARITY;
    for (const cluster of clusters) {
      if (cluster.lang !== item.lang) continue;
      for (const member of cluster.items) {
        const sim = similarity(set, tokens.get(member.id));
        if (sim >= bestSim) { bestSim = sim; best = cluster; }
      }
    }
    if (best) best.items.push(item);
    else clusters.push({ lang: item.lang, items: [item] });
  }

  return clusters
    .map((c) => ({ ...c, sources: [...new Set(c.items.flatMap((it) => [it.source, ...(it.also || []).map((a) => a.source)]))] }))
    .filter((c) => c.sources.length >= 2)
    .map((c) => ({
      ...c,
      latest: c.items.reduce((max, it) => ((it.date || '') > max ? it.date : max), ''),
      id: c.items[0].id,
      title: c.items[0].title,
      image: c.items.find((it) => it.image)?.image || ''
    }));
}

/* ---------- 載入流程 ---------- */

async function loadNews() {
  const loadId = ++state.loadId;
  const cache = storageGet(CACHE_KEY);

  $('#refresh-btn').classList.add('spinning');
  state.loading = true;
  state.loadError = null;
  if (state.items.length) {
    // 畫面上已經有新聞（例如按重新整理、每 10 分鐘自動更新）：保留畫面，只在狀態列提示
    setStatus({ ...state.status, message: 'refreshing', warn: '', retry: false });
  } else if (cache?.items?.length) {
    state.sharePages = !!cache.sharePages;
    setData(cache.items, cache.trends || {});
    setStatus({ updated: new Date(cache.time), message: 'refreshing' });
  } else {
    state.items = [];
    renderChips(); // 篩選按鈕先畫出來（還沒有數字）
    showSkeleton();
    renderHot();
    renderTicker();
    setStatus({ message: 'loading' });
  }
  // 第一次載入超過 8 秒還沒有任何新聞，告訴使用者還在努力
  const slowTimer = setTimeout(() => {
    if (loadId === state.loadId && state.loading && !state.items.length) setStatus({ message: 'loadingSlow' });
  }, 8000);

  const collected = [];
  let failed = 0;
  let queue = 0;
  let updated = new Date();
  let trends = {};

  // 第一步：讀 GitHub Actions 準備好的 JSON（最快、最穩）
  let snapshot = null;
  try {
    snapshot = await loadSnapshot();
  } catch (e) {
    // 沒有 data 檔（例如在自己電腦直接打開 index.html）→ 全部改用代理抓
  }
  if (loadId !== state.loadId) return;

  const pending = [];
  for (const feed of FEEDS) {
    const raw = snapshot?.feeds?.[feed.url];
    if (raw) collected.push(...withFeed(raw.map(fromSnapshot), feed));
    else if (snapshot?.failed?.includes(feed.url)) failed++; // GitHub 剛剛抓過也失敗，就不再重試
    else pending.push(feed); // 新加入、還沒被 GitHub 抓過的來源
  }
  if (snapshot) {
    state.sharePages = !!snapshot.sharePages;
    updated = new Date(snapshot.updated);
    trends = snapshot.trends || {};
    if (collected.length) setData(mergeItems(collected), trends);
  } else {
    // 沒有 JSON 時，趨勢也改走代理（失敗就算了，不影響新聞）
    await Promise.all(Object.entries(TRENDS).map(async ([geo, url]) => {
      try { trends[geo] = await fetchViaProxy(url, parseTrendsXml, true); } catch (e) { /* 略過 */ }
    }));
    if (loadId !== state.loadId) return;
    state.trends = trends;
    renderHot();
  }

  // 第二步：剩下的來源透過代理抓，同時最多 CONCURRENCY 個請求，避免被限流
  async function worker() {
    while (queue < pending.length) {
      const feed = pending[queue++];
      try {
        collected.push(...withFeed(await fetchViaProxy(feed.url, parseXml), feed));
        if (loadId !== state.loadId) return;
        setData(mergeItems(collected), trends);
      } catch (e) {
        failed++;
        console.warn('[World Pulse] 無法載入', feed.url, e);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  clearTimeout(slowTimer);
  if (loadId !== state.loadId) return;
  $('#refresh-btn').classList.remove('spinning');
  state.loading = false;
  if (state.pendingStory) {
    // 分享連結指到的新聞已經不在最新資料裡
    toast(t().storyGone);
    state.pendingStory = null;
    clearStoryHash();
  }

  if (collected.length) {
    storageSet(CACHE_KEY, { time: updated.getTime(), items: state.items, trends, sharePages: state.sharePages });
    // GitHub 的排程停了（例如 repo 太久沒動）時，資料會停在某個時間，要提醒讀者
    const outdated = snapshot && Date.now() - updated.getTime() > OUTDATED_HOURS * 3600 * 1000;
    setStatus({ updated, failed, warn: outdated ? 'outdated' : '' });
    // 記下這次看到哪些新聞，下次來訪才知道哪些是新的
    storageSet('world-pulse-seen', state.items.map((it) => it.sid));
  } else if (state.items.length) {
    // 抓不到新資料，但畫面上還有上次儲存的新聞
    const savedTime = cache?.time ? new Date(cache.time) : state.status.updated;
    setStatus({ updated: savedTime, warn: navigator.onLine === false ? 'staleOffline' : 'stale', retry: true });
  } else {
    // 完全沒有新聞可以顯示：新聞區改成錯誤說明＋重新載入按鈕
    state.loadError = navigator.onLine === false ? 'offline' : 'failed';
    setData([], trends);
    setStatus({});
  }
}

function setData(items, trends) {
  state.items = items;
  state.trends = trends;
  state.focus = null;
  render();
  renderHot();
  openPendingStory();
}

/* ---------- 分享連結：#story=代號 ---------- */

function readStoryHash() {
  const m = location.hash.match(/^#story=([a-z0-9]+)$/);
  return m ? m[1] : null;
}

function clearStoryHash() {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

function openPendingStory() {
  if (!state.pendingStory) return;
  const item = state.items.find((it) => it.sid === state.pendingStory);
  if (!item) return; // 可能還在載入，等下一批資料
  state.pendingStory = null;
  openArticle(item.id);
}

function shareUrl(item) {
  // 有 GitHub 產生的分享頁就用它（LINE 會顯示這則新聞的預覽卡），否則用 #story= 連結
  const path = state.sharePages ? `s/${item.sid}.html` : `index.html#story=${item.sid}`;
  return new URL(path, location.href).href;
}

async function shareItem(item) {
  const url = shareUrl(item);
  try {
    if (navigator.share) {
      await navigator.share({ title: item.title, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    toast(t().copied);
  } catch (e) {
    if (e.name !== 'AbortError') toast(t().shareFail); // AbortError = 使用者自己取消分享
  }
}

/* ---------- 畫面：狀態列 ---------- */

/* 存的是文字的「代號」，切換介面語言時可以重畫 */
function setStatus(status) {
  state.status = status;
  renderStatus();
}

function renderStatus() {
  const { updated, failed = 0, message, warn } = state.status;
  const parts = [];
  if (message) parts.push(t()[message]);
  if (updated) parts.push(t().updatedAt(formatClock(updated)));
  if (failed) parts.push(t().partialFail(failed));
  $('#status-text').textContent = parts.join(' · ');
  const warnEl = $('#status-warn');
  const warnText = warn ? t()[warn] : '';
  // 過期警示要顯示「幾小時沒更新」
  warnEl.textContent = typeof warnText === 'function'
    ? warnText(Math.floor((Date.now() - updated.getTime()) / 3600000))
    : warnText;
  if (state.status.retry) warnEl.append(createRetryButton('warn-retry'));
  warnEl.hidden = !warn;
}

function createRetryButton(className) {
  const btn = el('button', className, t().retry);
  btn.type = 'button';
  btn.dataset.action = 'retry';
  return btn;
}

/* 狀態說明框：沒資料、出錯時放在新聞區中間 */
const STATE_ICONS = {
  error: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
  offline: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 4.2-2.4M19 12.9a10 10 0 0 0-2.4-1.6M2 9.3a15 15 0 0 1 4.5-2.8M22 9.3A15 15 0 0 0 11 5.1M12 20h.01"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8.5 11h5"/></svg>'
};

function statePanel({ icon, title, text, action }) {
  const panel = el('div', 'state-panel state-panel--' + icon);
  panel.setAttribute('role', icon === 'search' ? 'status' : 'alert');
  const iconBox = el('div', 'state-panel__icon');
  iconBox.innerHTML = STATE_ICONS[icon];
  panel.append(iconBox, el('h2', 'state-panel__title', title), el('p', 'state-panel__text', text));
  if (action) panel.append(action);
  return panel;
}

/* 列出目前套用了哪些篩選，讓「找不到」的原因一目了然 */
function describeFilters() {
  const parts = [];
  if (state.query.trim()) parts.push(state.lang === 'zh' ? `「${state.query.trim()}」` : `“${state.query.trim()}”`);
  if (state.cat !== 'all') parts.push(t().cat[state.cat]);
  if (state.region !== 'all') parts.push(t().region[state.region]);
  if (state.srcLang !== 'all') parts.push(t().srcLang[state.srcLang]);
  if (state.onlyNew) parts.push(t().onlyNewLabel);
  return parts.join(state.lang === 'zh' ? '、' : ', ');
}

function clearFilters() {
  state.cat = 'all';
  state.region = 'all';
  state.srcLang = 'all';
  state.onlyNew = false;
  state.query = '';
  $('#search').value = '';
  storageSet('world-pulse-src-lang', state.srcLang);
  render();
  renderHot();
}

/* ---------- 畫面：篩選 ---------- */

/* skip：計算某一組按鈕的數字時，忽略那一組自己的條件 */
function matches(it, skip) {
  const q = state.query.trim().toLowerCase();
  return (skip === 'cat' || state.cat === 'all' || it.cat === state.cat) &&
    (skip === 'region' || state.region === 'all' || it.region === state.region) &&
    (skip === 'srcLang' || state.srcLang === 'all' || it.lang === state.srcLang) &&
    (!state.onlyNew || isNew(it)) &&
    (!q || (it.title + ' ' + it.description + ' ' + it.source).toLowerCase().includes(q));
}

function filteredItems() {
  return state.items.filter((it) => matches(it));
}

function renderChips() {
  const build = (container, keys, labels, field) => {
    const pool = state.items.filter((it) => matches(it, field));
    container.replaceChildren(...keys.map((key) => {
      const btn = el('button', 'chip' + (field === 'cat' && key !== 'all' ? ' chip--cat tag--' + key : ''));
      btn.type = 'button';
      btn.dataset.value = key;
      btn.setAttribute('aria-pressed', String(key === state[field]));
      const count = key === 'all' ? pool.length : pool.filter((it) => it[field === 'srcLang' ? 'lang' : field] === key).length;
      btn.append(el('span', '', labels[key]), el('small', '', state.items.length ? count : ''));
      return btn;
    }));
  };
  build($('#cat-chips'), CATEGORIES, t().cat, 'cat');
  build($('#region-chips'), REGIONS, t().region, 'region');
  build($('#lang-chips'), SOURCE_LANGS, t().srcLang, 'srcLang');
}

/* ---------- 畫面：新聞 ---------- */

function createImage(src, alt) {
  const img = document.createElement('img');
  img.src = src || PLACEHOLDER;
  img.alt = alt;
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.onerror = () => { img.onerror = null; img.src = PLACEHOLDER; };
  return img;
}

const readClass = (item) => (readSet.has(item.sid) ? ' is-read' : '');

function createMeta(item, label) {
  const meta = el('div', 'card__meta');
  meta.append(el('span', 'tag tag--' + item.cat, label || t().cat[item.cat]), el('span', '', item.source));
  const time = el('time');
  if (item.date) {
    time.dateTime = item.date;
    time.textContent = timeAgo(new Date(item.date));
  }
  meta.append(time);
  if (item.also?.length) meta.append(el('span', 'also-count', t().moreOutlets(item.also.length)));
  if (isNew(item)) meta.prepend(el('span', 'new-dot', t().newTag));
  return meta;
}

/* lang 屬性讓瀏覽器用正確的字型顯示中文或英文原文 */
function setContentLang(node, item) {
  node.lang = item.lang === 'zh' ? 'zh-Hant' : 'en';
}

function createCard(item, featured) {
  // 沒有圖片的新聞用純文字卡片，避免整排都是同一張預設圖
  const textOnly = !item.image && !featured;
  const card = el('article', 'card' + (featured ? ' card--featured' : '') + (textOnly ? ' card--text tag--' + item.cat : '') + readClass(item));

  const btn = el('button', 'card__hit');
  btn.type = 'button';
  btn.dataset.id = item.id;

  const body = el('div', 'card__body');
  const title = el('h3', 'card__title', item.title);
  const desc = el('p', 'card__desc', item.description);
  setContentLang(title, item);
  setContentLang(desc, item);
  body.append(createMeta(item, featured ? t().featured : ''), title, desc);

  if (!textOnly) {
    const media = el('div', 'card__media');
    media.append(createImage(item.image, ''));
    btn.append(media);
  }
  btn.append(body);
  card.append(btn);
  return card;
}

function createRow(item) {
  const row = el('article', 'row' + (item.image ? '' : ' row--text tag--' + item.cat) + readClass(item));
  const btn = el('button', 'row__hit');
  btn.type = 'button';
  btn.dataset.id = item.id;

  const thumb = el('div', 'row__thumb');
  if (item.image) thumb.append(createImage(item.image, ''));

  const body = el('div', 'row__body');
  const title = el('h3', 'row__title', item.title);
  const desc = el('p', 'row__desc', item.description);
  setContentLang(title, item);
  setContentLang(desc, item);
  body.append(createMeta(item), title, desc);

  btn.append(thumb, body);
  row.append(btn);
  return row;
}

/* 「自上次來訪後新增 N 則」：點了只看新的，再點一次取消 */
function renderNewPill() {
  const count = state.items.filter((it) => isNew(it) && (state.srcLang === 'all' || it.lang === state.srcLang)).length;
  const pill = $('#new-pill');
  if (!count && state.onlyNew) state.onlyNew = false;
  pill.hidden = !count;
  pill.textContent = t().newSince(count);
  pill.setAttribute('aria-pressed', String(state.onlyNew));
}

/* 沒有任何篩選、搜尋，而且是卡片模式時，首頁用「頭條區＋分類區塊」的報紙版面 */
function isHomeLayout() {
  return state.view === 'cards' && state.cat === 'all' && state.region === 'all' && !state.query.trim() && !state.onlyNew;
}

function render() {
  renderChips();
  renderTicker();
  renderNewPill();
  const list = filteredItems();
  const grid = $('#news-grid');
  const home = isHomeLayout() && list.length > 0;
  grid.classList.toggle('is-list', state.view === 'list');
  grid.classList.toggle('is-home', home);
  $('#result-count').textContent = state.items.length ? t().count(list.length) : '';

  if (!state.items.length) {
    grid.classList.remove('is-list');
    if (state.loadError) {
      const offline = state.loadError === 'offline';
      grid.replaceChildren(statePanel({
        icon: offline ? 'offline' : 'error',
        title: offline ? t().offlineTitle : t().errorTitle,
        text: offline ? t().offlineText : t().errorText,
        action: createRetryButton('btn-primary')
      }));
    } else if (state.loading && !grid.querySelector('.skeleton')) {
      showSkeleton();
    }
    return;
  }

  if (!list.length) {
    const btn = el('button', 'btn-primary', t().clearFilters);
    btn.type = 'button';
    btn.dataset.action = 'clear-filters';
    grid.classList.remove('is-list');
    grid.replaceChildren(statePanel({ icon: 'search', title: t().emptyTitle, text: t().emptyText(describeFilters()), action: btn }));
    return;
  }

  if (home) {
    renderHome(grid, list);
  } else if (state.view === 'list') {
    grid.replaceChildren(...list.map(createRow));
  } else {
    // 一般卡片模式：第一則有圖片的新聞放大成頭條卡片
    const featuredIndex = list.findIndex((it) => it.image);
    const cards = list.map((it, i) => createCard(it, i === featuredIndex));
    if (featuredIndex > 0) cards.unshift(cards.splice(featuredIndex, 1)[0]);
    grid.replaceChildren(...cards);
  }
  observeReveal(grid);
}

/* ---------- 首頁：頭條區＋分類區塊 ---------- */

function renderHome(grid, list) {
  const inList = new Set(list.map((it) => it.id));
  const used = new Set();
  const take = (it) => { used.add(it.id); return it; };

  // 頭條：優先選「最多媒體報導的事件」裡有圖片的那則，讓頭條真的是今天的大事
  if (!state.focus) state.focus = computeFocus(state.items);
  const focusPicks = [...state.focus]
    .sort((a, b) => b.sources.length - a.sources.length || b.items.length - a.items.length)
    .map((c) => c.items.find((it) => it.image && inList.has(it.id) && Date.parse(it.date) > Date.now() - 18 * 3600 * 1000))
    .filter(Boolean);
  const leads = [];
  for (const it of [...focusPicks, ...list.filter((x) => x.image)]) {
    if (leads.length >= 3) break;
    if (!used.has(it.id)) leads.push(take(it));
  }
  const latest = list.filter((it) => !used.has(it.id)).slice(0, 7).map(take);

  const hero = el('section', 'hero');
  if (leads[0]) hero.append(createLead(leads[0]));
  const side = el('div', 'hero__side');
  leads.slice(1).forEach((it) => side.append(createCard(it, false)));
  hero.append(side, createLatest(latest));

  // 分類區塊：每個分類挑 4 則（新的、有圖的優先）
  const blocks = CATEGORIES.filter((c) => c !== 'all').map((cat) => {
    const pool = list.filter((it) => it.cat === cat && !used.has(it.id));
    if (!pool.length) return null;
    const recent = pool.slice(0, 10);
    const picks = [...recent.filter((it) => it.image), ...recent.filter((it) => !it.image)].slice(0, 4).map(take);
    return createCatBlock(cat, picks, list.filter((it) => it.cat === cat).length);
  }).filter(Boolean);

  const more = el('div', 'browse-all');
  const btn = el('button', 'btn-ghost', t().browseAll(list.length));
  btn.type = 'button';
  btn.dataset.action = 'browse-all';
  more.append(btn);

  grid.replaceChildren(hero, ...blocks, more);
}

/* 大頭條：圖片滿版，標題壓在圖片下緣的漸層上 */
function createLead(item) {
  const card = el('article', 'lead' + readClass(item));
  const btn = el('button', 'lead__hit');
  btn.type = 'button';
  btn.dataset.id = item.id;
  const media = el('div', 'lead__media');
  media.append(createImage(item.image, ''));
  const body = el('div', 'lead__body');
  const title = el('h2', 'lead__title', item.title);
  const desc = el('p', 'lead__desc', item.description);
  setContentLang(title, item);
  setContentLang(desc, item);
  body.append(createMeta(item, t().featured), title, desc);
  btn.append(media, body);
  card.append(btn);
  return card;
}

function createLatest(items) {
  const box = el('aside', 'latest');
  const head = el('h2', 'latest__head');
  head.append(el('span', 'pulse-dot'), el('span', '', t().latest));
  const ol = el('ol', 'latest__list');
  for (const it of items) {
    const li = el('li');
    const btn = el('button', 'latest__item' + readClass(it));
    btn.type = 'button';
    btn.dataset.id = it.id;
    const time = el('time', 'latest__time', it.date ? new Date(it.date).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false }) : '');
    const title = el('span', 'latest__title', it.title);
    setContentLang(title, it);
    btn.append(time, title, el('span', 'latest__source', it.source));
    li.append(btn);
    ol.append(li);
  }
  box.append(head, ol);
  return box;
}

function createCatBlock(cat, items, total) {
  const block = el('section', 'cat-block tag--' + cat);
  const head = el('header', 'cat-block__head');
  const title = el('h2', 'cat-block__title', t().cat[cat]);
  const more = el('button', 'cat-block__more');
  more.type = 'button';
  more.dataset.cat = cat;
  more.append(el('span', '', `${t().seeMore} ${total}`), el('span', '', '→'));
  head.append(title, more);
  const row = el('div', 'cat-block__grid');
  items.forEach((it) => row.append(createCard(it, false)));
  block.append(head, row);
  return block;
}

/* ---------- 即時跑馬燈 ---------- */

let tickerSignature = '';

function renderTicker() {
  const items = state.items.filter((it) => state.srcLang === 'all' || it.lang === state.srcLang).slice(0, 12);
  // 內容沒變就不重畫，避免跑馬燈一直從頭開始
  const signature = state.lang + state.loading + items.map((it) => it.id).join('|');
  if (signature === tickerSignature) return;
  tickerSignature = signature;

  const track = $('#ticker-track');
  if (!items.length) {
    // 沒有新聞時不跑馬，只顯示一句說明
    track.classList.add('ticker__track--static');
    track.replaceChildren(el('span', 'ticker__message', state.loading ? t().loading : t().tickerEmpty));
    return;
  }
  track.classList.remove('ticker__track--static');
  const makeGroup = (hidden) => {
    const group = el('div', 'ticker__group');
    if (hidden) group.setAttribute('aria-hidden', 'true');
    for (const it of items) {
      const btn = el('button', 'ticker__item');
      btn.type = 'button';
      btn.dataset.id = it.id;
      if (hidden) btn.tabIndex = -1;
      const time = it.date ? new Date(it.date).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
      const title = el('span', '', it.title);
      setContentLang(title, it);
      btn.append(el('time', '', time), title);
      group.append(btn);
    }
    return group;
  };
  // 放兩份一樣的內容，第一份捲完時第二份剛好接上，看起來就是無限循環
  track.replaceChildren(makeGroup(false), makeGroup(true));
  track.style.setProperty('--ticker-duration', Math.max(30, items.length * 7) + 's');
}

/* ---------- 進場動畫：卡片捲到畫面裡才淡入 ---------- */

const revealObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      revealObserver.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -40px 0px' })
  : null;

function observeReveal(root) {
  if (!revealObserver || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.querySelectorAll('.card, .lead, .latest, .cat-block__head').forEach((node) => {
    node.classList.add('reveal');
    revealObserver.observe(node);
  });
}

function showSkeleton() {
  const grid = $('#news-grid');
  grid.classList.toggle('is-list', state.view === 'list');
  grid.replaceChildren(...Array.from({ length: 9 }, (_, i) => {
    const node = el('div', 'card skeleton' + (i === 0 && state.view === 'cards' ? ' card--featured' : ''));
    node.innerHTML = '<div class="card__media"></div><div class="card__body"><span></span><span></span><span></span></div>';
    return node;
  }));
  $('#result-count').textContent = '';
}

function renderViewSwitch() {
  document.querySelectorAll('.view-btn').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
    b.title = b.dataset.view === 'list' ? t().viewList : t().viewCards;
    b.setAttribute('aria-label', b.title);
  });
}

/* ---------- 畫面：熱門話題 ---------- */

/* Google 新聞的地區版本（搜尋趨勢的「台灣」「美國」對應到各自的 Google 新聞） */
const GOOGLE_NEWS_REGION = {
  tw: 'hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
  us: 'hl=en-US&gl=US&ceid=US:en'
};

/* Google 趨勢的中文關鍵字常被斷成「所得 替代 率」，把中文字之間的空白拿掉 */
function cleanTrendTitle(title) {
  return title.replace(/(?<=[一-鿿])\s+(?=[一-鿿])/g, '');
}

function renderHot() {
  document.querySelectorAll('.hot-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.hotTab)));

  const geoSwitch = $('#geo-switch');
  geoSwitch.hidden = state.hotTab !== 'trends';
  geoSwitch.replaceChildren(...Object.keys(TRENDS).map((geo) => {
    const b = el('button', 'seg__btn', t().geo[geo] || geo.toUpperCase());
    b.type = 'button';
    b.dataset.geo = geo;
    b.setAttribute('aria-pressed', String(geo === state.geo));
    return b;
  }));

  document.querySelectorAll('.sort-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === state.hotSort)));
  const byHeat = state.hotSort === 'hot';
  const strip = $('#hot-strip');
  let cards = [];

  if (state.hotTab === 'trends') {
    // key 用 Google 原始順序的位置，排序後點開才找得到同一筆
    const trends = (state.trends[state.geo] || []).map((trend, i) => ({
      trend,
      key: i,
      volume: parseTraffic(trend.traffic),
      time: Date.parse(trend.date) || 0
    }));
    // Google 給的順序是「開始熱門的時間」，不是熱度，所以自己排
    trends.sort((a, b) => (byHeat ? b.volume - a.volume : 0) || b.time - a.time);
    cards = trends.map(({ trend, key, time }, i) => createHotCard({
      kind: 'trend',
      key,
      rank: byHeat ? i + 1 : null,
      title: cleanTrendTitle(trend.title),
      image: trend.picture,
      meta: joinMeta(byHeat ? '' : timeAgo(new Date(time)), trend.traffic ? t().searches(trend.traffic) : ''),
      sub: trend.news[0]?.title || '',
      hint: !trend.news.length && t().trendCardHint
    }));
    $('#hot-note').textContent = t().trendNote;
  } else {
    if (!state.focus) state.focus = computeFocus(state.items);
    const focus = state.focus
      .filter((c) => state.srcLang === 'all' || c.lang === state.srcLang)
      .sort((a, b) => (byHeat ? b.sources.length - a.sources.length || b.items.length - a.items.length : 0) ||
        b.latest.localeCompare(a.latest))
      .slice(0, FOCUS_MAX);
    cards = focus.map((c, i) => createHotCard({
      kind: 'focus',
      key: c.id,
      rank: byHeat ? i + 1 : null,
      title: c.title,
      lang: c.lang,
      image: c.image,
      meta: joinMeta(byHeat ? '' : timeAgo(new Date(c.latest)), t().outlets(c.sources.length)),
      sub: c.sources.join(' · ')
    }));
    $('#hot-note').textContent = t().focusNote;
  }

  if (!cards.length) {
    if (state.loading && !state.items.length) {
      // 載入中：先放幾張灰色卡片佔位
      cards = Array.from({ length: 5 }, () => {
        const node = el('div', 'hot-card skeleton');
        node.innerHTML = '<div class="hot-card__media"></div><div class="hot-card__body"><span></span><span></span></div>';
        return node;
      });
    } else {
      let message;
      if (state.hotTab === 'focus') message = t().focusEmpty;
      else if (!Object.keys(state.trends).length) message = t().trendsUnavailable; // 整個趨勢資料都抓不到
      else message = t().trendsEmpty; // 只有這個地區沒資料
      cards = [el('p', 'hot__empty', message)];
    }
  }
  strip.replaceChildren(...cards);
  strip.scrollLeft = 0;
}

/* 搜尋量文字轉數字：「1000+」→ 1000、「20K+」→ 20000、「2萬+」→ 20000 */
function parseTraffic(text) {
  const m = String(text || '').replace(/,/g, '').match(/([\d.]+)\s*([KkMm萬万]?)/);
  if (!m) return 0;
  const unit = { k: 1e3, m: 1e6, 萬: 1e4, 万: 1e4 }[m[2].toLowerCase()] || 1;
  return parseFloat(m[1]) * unit;
}

function joinMeta(...parts) {
  return parts.filter(Boolean).join(' · ');
}

function createHotCard({ kind, key, rank, title, lang, image, meta, sub, hint }) {
  const btn = el('button', 'hot-card');
  btn.type = 'button';
  btn.dataset.kind = kind;
  btn.dataset.key = key;

  const media = el('div', 'hot-card__media');
  if (image) {
    media.append(createImage(safeUrl(image), ''));
  } else {
    // 沒有圖片：搜尋趨勢放放大鏡、媒體焦點放報紙圖示，看起來是刻意的設計而不是壞掉
    const icon = el('span', 'hot-card__icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = kind === 'trend'
      ? '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M4 5h13v14H6a2 2 0 0 1-2-2V5Z"/><path d="M17 9h3v8a2 2 0 0 1-2 2M7.5 9h6M7.5 12.5h6M7.5 16h4"/></svg>';
    media.append(icon);
  }
  // 「最新」排序時數字不代表熱門程度，就不顯示排名
  if (rank) media.append(el('span', 'hot-card__rank', String(rank)));

  const body = el('div', 'hot-card__body');
  const titleEl = el('strong', 'hot-card__title', title);
  if (lang) titleEl.lang = lang === 'zh' ? 'zh-Hant' : 'en';
  body.append(el('span', 'hot-card__meta', meta), titleEl);
  if (sub) body.append(el('span', 'hot-card__sub', sub));
  // 沒有相關報導：告訴讀者點開還可以做什麼，而不是留白
  else if (hint) body.append(el('span', 'hot-card__sub hot-card__hint', hint));

  btn.append(media, body);
  return btn;
}

/* ---------- 彈出視窗：新聞內頁／熱點詳情 ---------- */

function resetDialog() {
  $('#article-tags').replaceChildren();
  $('#article-related').hidden = true;
  $('#article-related-list').replaceChildren();
  $('#article-desc').hidden = false;
  $('#article-desc').classList.remove('is-placeholder');
  $('#article-note').hidden = false;
  $('#article-actions').hidden = false;
  $('#article-translate').hidden = true;
  $('#article-search').hidden = true;
  $('#trend-actions').hidden = true;
}

function addTag(text, cls) {
  $('#article-tags').append(el('span', 'tag ' + cls, text));
}

function setDialogMedia(src, alt) {
  const media = $('#article-media');
  media.replaceChildren(createImage(src, alt));
  media.hidden = !src;
}

function showDialog() {
  const dialog = $('#article');
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}

function openArticle(id) {
  const item = state.items.find((it) => it.id === id);
  if (!item) return;
  resetDialog();
  setDialogMedia(item.image, item.title);
  addTag(t().cat[item.cat], 'tag--' + item.cat);
  if (item.region) addTag(t().region[item.region], 'tag--region');

  const title = $('#article-title');
  const desc = $('#article-desc');
  title.textContent = item.title;
  desc.textContent = item.description || t().noSummary;
  desc.classList.toggle('is-placeholder', !item.description);
  setContentLang(title, item);
  setContentLang(desc, item);
  $('#article-source').textContent = item.source;
  $('#article-time').textContent = item.date
    ? new Date(item.date).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  $('#article-link').href = item.link;

  // 原文語言和介面語言不同時，提供 Google 翻譯（開新分頁，不改動原文顯示）
  const translate = $('#article-translate');
  translate.hidden = item.lang === state.lang;
  translate.href = 'https://translate.google.com/translate?sl=auto&tl=' +
    (state.lang === 'zh' ? 'zh-TW' : 'en') + '&u=' + encodeURIComponent(item.link);

  // 其他媒體一字不差的轉載
  if (item.also?.length) {
    showRelated(item.also.map((a) => ({ url: a.link, title: a.title, lang: item.lang, meta: a.source })), t().alsoReported);
  }

  state.currentItem = item;
  markRead(item.sid);
  document.querySelectorAll(`[data-id="${CSS.escape(item.id)}"]`).forEach((node) => node.closest('.card, .row, .lead, li')?.classList.add('is-read'));
  document.querySelectorAll(`[data-id="${CSS.escape(item.id)}"].latest__item`).forEach((node) => node.classList.add('is-read'));
  // 網址加上 #story=，直接複製網址列也能分享這則
  history.replaceState(null, '', '#story=' + item.sid);
  showDialog();
}

/* 相關報導清單：站內新聞（點了開內頁）或站外連結 */
function showRelated(entries, heading = t().relatedNews) {
  $('#article-related h3').textContent = heading;
  const list = $('#article-related-list');
  list.replaceChildren(...entries.map((entry) => {
    const li = el('li');
    const target = entry.id ? el('button', 'related') : el('a', 'related');
    if (entry.id) { target.type = 'button'; target.dataset.id = entry.id; } else {
      target.href = entry.url;
      target.target = '_blank';
      target.rel = 'noopener noreferrer';
    }
    const title = el('span', 'related__title', entry.title);
    if (entry.lang) title.lang = entry.lang === 'zh' ? 'zh-Hant' : 'en';
    const meta = el('span', 'related__meta', entry.meta);
    // 連到外部網站的加上 ↗，看得出會另開分頁
    if (!entry.id) meta.append(el('span', 'related__external', ' ↗'));
    target.append(title, meta);
    li.append(target);
    return li;
  }));
  $('#article-related').hidden = !entries.length;
}

function openHot(kind, key) {
  resetDialog();
  $('#article-desc').hidden = true;
  $('#article-note').hidden = true;
  $('#article-actions').hidden = true;
  clearStoryHash();
  const title = $('#article-title');
  title.removeAttribute('lang');

  if (kind === 'trend') {
    const trend = state.trends[state.geo]?.[key];
    if (!trend) return;
    const trendTitle = cleanTrendTitle(trend.title);
    setDialogMedia(safeUrl(trend.picture), trendTitle);
    addTag(t().hotTrends + ' · ' + (t().geo[state.geo] || state.geo), 'tag--hot');
    title.textContent = trendTitle;
    $('#article-source').textContent = trend.traffic ? t().searches(trend.traffic) : '';
    $('#article-time').textContent = trend.date ? timeAgo(new Date(trend.date)) : '';
    const related = trend.news.filter((n) => safeUrl(n.url));
    showRelated(related.map((n) => ({ url: safeUrl(n.url), title: n.title, meta: n.source })));
    if (!related.length) {
      const desc = $('#article-desc');
      desc.hidden = false;
      desc.textContent = t().trendNoNews;
      desc.classList.add('is-placeholder');
    }
    // 本站剛好也有相關新聞時，才顯示「看本站相關新聞」按鈕
    const q = trendTitle.toLowerCase();
    const hits = state.items.filter((it) => (it.title + ' ' + it.description).toLowerCase().includes(q)).length;
    const search = $('#article-search');
    search.hidden = !hits;
    search.dataset.query = trendTitle;
    search.textContent = t().searchHere(trendTitle, hits);

    // 直接到 Google 新聞／Google 搜尋這個關鍵字（開新分頁）；台灣話題用台灣版、美國話題用美國版
    const q2 = encodeURIComponent(trendTitle);
    const region = GOOGLE_NEWS_REGION[state.geo] || '';
    const news = $('#trend-google-news');
    news.href = `https://news.google.com/search?q=${q2}${region ? '&' + region : ''}`;
    $('#trend-google-search').href = `https://www.google.com/search?q=${q2}`;
    // 沒有任何報導可看時，Google 新聞就是最主要的下一步，用醒目的主要按鈕
    news.className = !related.length && !hits ? 'btn-primary' : 'btn-secondary';
    $('#trend-actions').hidden = false;
  } else {
    const cluster = state.focus?.find((c) => c.id === key);
    if (!cluster) return;
    setDialogMedia(cluster.image, cluster.title);
    addTag(t().hotFocus, 'tag--hot');
    title.textContent = cluster.title;
    title.lang = cluster.lang === 'zh' ? 'zh-Hant' : 'en';
    $('#article-source').textContent = t().outlets(cluster.sources.length);
    $('#article-time').textContent = cluster.sources.join(' · ');
    showRelated(cluster.items.map((it) => ({
      id: it.id,
      title: it.title,
      lang: it.lang,
      meta: it.source + (it.date ? ' · ' + timeAgo(new Date(it.date)) : '')
    })));
  }
  showDialog();
}

/* ---------- 配色主題 ---------- */

/* 每個主題的代表色：給選單色塊預覽、手機瀏覽器網址列用（實際顏色在 css/style.css） */
const THEMES = {
  paper: { head: '#fffdf8', bg: '#f6f1e8', accent: '#c2363c' },
  white: { head: '#ffffff', bg: '#f4f5f7', accent: '#e5484d' },
  navy: { head: '#0f2d52', bg: '#f3f5f8', accent: '#e5484d' },
  black: { head: '#11141c', bg: '#f4f5f7', accent: '#e5484d' },
  dark: { head: '#07080c', bg: '#0e1015', accent: '#ff6369' }
};
const THEME_CHOICES = ['auto', ...Object.keys(THEMES)];
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let themeChoice = THEME_CHOICES.includes(storageGet('world-pulse-theme')) ? storageGet('world-pulse-theme') : 'auto';

/* 「自動」：裝置是深色模式就用深色，否則用暖白 */
function resolveTheme(choice) {
  return choice === 'auto' ? (darkQuery.matches ? 'dark' : 'paper') : choice;
}

function applyTheme() {
  const theme = resolveTheme(themeChoice);
  document.documentElement.dataset.theme = theme;
  $('meta[name="theme-color"]').content = THEMES[theme].head; // 手機瀏覽器網址列的顏色
}

function renderThemeMenu() {
  const menu = $('#theme-menu');
  menu.replaceChildren(el('p', 'theme-menu__title', t().themeLabel), ...THEME_CHOICES.map((choice) => {
    const [name, hint] = t().themes[choice];
    const btn = el('button', 'theme-option');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitemradio');
    btn.setAttribute('aria-checked', String(choice === themeChoice));
    btn.dataset.theme = choice;
    const swatch = el('span', 'theme-swatch' + (choice === 'auto' ? ' theme-swatch--auto' : ''));
    if (THEMES[choice]) {
      swatch.style.setProperty('--sw-head', THEMES[choice].head);
      swatch.style.setProperty('--sw-bg', THEMES[choice].bg);
      swatch.style.setProperty('--sw-accent', THEMES[choice].accent);
    }
    const text = el('span', 'theme-option__text');
    text.append(el('span', 'theme-option__name', name), el('span', 'theme-option__hint', hint));
    btn.append(swatch, text);
    return btn;
  }));
}

function toggleThemeMenu(open) {
  const menu = $('#theme-menu');
  const show = open ?? menu.hidden;
  menu.hidden = !show;
  $('#theme-btn').setAttribute('aria-expanded', String(show));
  if (show) menu.querySelector('[aria-checked="true"]')?.focus();
}

/* ---------- 介面語言 ---------- */

function applyLanguage() {
  const strings = t();
  document.documentElement.lang = state.lang === 'zh' ? 'zh-Hant' : 'en';
  document.title = strings.siteName + ' · ' + strings.tagline;
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = strings[node.dataset.i18n];
  });
  $('#search').placeholder = strings.searchPlaceholder;
  $('#article-close').setAttribute('aria-label', strings.close);
  $('#refresh-btn').setAttribute('aria-label', strings.refresh);
  $('#theme-btn').setAttribute('aria-label', strings.themeLabel);
  renderThemeMenu();
  document.querySelectorAll('.lang-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang)));
  renderViewSwitch();
  $('#masthead-date').textContent = new Date().toLocaleDateString(locale(), { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
}

/* 只換介面文字，新聞內容不變，也不用重新抓資料 */
function setLanguage(lang) {
  if (lang === state.lang) return;
  state.lang = lang;
  storageSet('world-pulse-lang', lang);
  applyLanguage();
  renderStatus();
  render();
  renderHot();
}

/* ---------- 事件 ---------- */

function onChip(containerSel, field, after) {
  $(containerSel).addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state[field] = chip.dataset.value;
    if (after) after();
    render();
  });
}

function init() {
  const savedLang = storageGet('world-pulse-lang');
  state.lang = savedLang === 'en' || savedLang === 'zh' ? savedLang : (navigator.language.startsWith('zh') ? 'zh' : 'en');
  const savedView = storageGet('world-pulse-view');
  if (savedView === 'list' || savedView === 'cards') state.view = savedView;
  const savedSort = storageGet('world-pulse-hot-sort');
  if (savedSort === 'hot' || savedSort === 'new') state.hotSort = savedSort;
  const savedSrcLang = storageGet('world-pulse-src-lang');
  if (SOURCE_LANGS.includes(savedSrcLang)) state.srcLang = savedSrcLang;
  applyLanguage();

  onChip('#cat-chips', 'cat');
  onChip('#region-chips', 'region');
  onChip('#lang-chips', 'srcLang', () => {
    storageSet('world-pulse-src-lang', state.srcLang);
    if (state.hotTab === 'focus') renderHot();
  });

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = e.target.value; render(); }, 150);
  });

  document.querySelectorAll('.lang-btn').forEach((b) => b.addEventListener('click', () => setLanguage(b.dataset.lang)));
  $('#refresh-btn').addEventListener('click', loadNews);

  document.querySelectorAll('.view-btn').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    storageSet('world-pulse-view', state.view);
    renderViewSwitch();
    render();
  }));

  document.querySelectorAll('.hot-tab').forEach((b) => b.addEventListener('click', () => {
    state.hotTab = b.dataset.tab;
    renderHot();
  }));
  document.querySelectorAll('.sort-btn').forEach((b) => b.addEventListener('click', () => {
    state.hotSort = b.dataset.sort;
    storageSet('world-pulse-hot-sort', state.hotSort);
    renderHot();
  }));
  $('#geo-switch').addEventListener('click', (e) => {
    const b = e.target.closest('[data-geo]');
    if (!b) return;
    state.geo = b.dataset.geo;
    renderHot();
  });
  $('#hot-strip').addEventListener('click', (e) => {
    const card = e.target.closest('.hot-card');
    if (card) openHot(card.dataset.kind, card.dataset.kind === 'trend' ? Number(card.dataset.key) : card.dataset.key);
  });

  $('#news-grid').addEventListener('click', (e) => {
    const more = e.target.closest('[data-cat]');
    if (more) {
      // 分類區塊的「看更多」：直接套用該分類篩選
      state.cat = more.dataset.cat;
      render();
      $('.filters').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (e.target.closest('[data-action="browse-all"]')) {
      state.view = 'list';
      storageSet('world-pulse-view', state.view);
      renderViewSwitch();
      render();
      $('.status').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const hit = e.target.closest('[data-id]');
    if (hit) openArticle(hit.dataset.id);
  });
  $('#ticker-track').addEventListener('click', (e) => {
    const hit = e.target.closest('[data-id]');
    if (hit) openArticle(hit.dataset.id);
  });

  const dialog = $('#article');
  // 關掉內頁後：網址拿掉 #story=，更新已讀和「新」標記
  const afterClose = () => {
    clearStoryHash();
    renderNewPill();
    document.querySelectorAll('.is-read .new-dot').forEach((node) => node.remove());
  };
  const closeDialog = () => { dialog.close(); afterClose(); };
  $('#article-close').addEventListener('click', closeDialog);
  // 點視窗外的暗色區域也能關閉
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(); });
  dialog.addEventListener('close', afterClose); // 按 Esc 關閉時
  $('#article-share').addEventListener('click', () => { if (state.currentItem) shareItem(state.currentItem); });
  $('#new-pill').addEventListener('click', () => {
    state.onlyNew = !state.onlyNew;
    render();
  });
  window.addEventListener('hashchange', () => {
    const sid = readStoryHash();
    if (!sid) return;
    state.pendingStory = sid;
    openPendingStory();
  });
  // 媒體焦點裡的各家報導：點了直接切換成那則新聞的內頁
  $('#article-related-list').addEventListener('click', (e) => {
    const hit = e.target.closest('button[data-id]');
    if (hit) openArticle(hit.dataset.id);
  });
  // 熱門搜尋：「在本站搜尋」
  $('#article-search').addEventListener('click', (e) => {
    const q = e.currentTarget.dataset.query;
    closeDialog();
    $('#search').value = q;
    state.query = q;
    state.cat = 'all';
    state.region = 'all';
    state.srcLang = 'all';
    render();
    $('.status').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // 配色選單：點按鈕開關，點選項立刻換色（選單保持開著，方便比較），點外面或按 Esc 關閉
  applyTheme();
  $('#theme-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleThemeMenu(); });
  $('#theme-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    const option = e.target.closest('[data-theme]');
    if (!option) return;
    themeChoice = option.dataset.theme;
    storageSet('world-pulse-theme', themeChoice);
    applyTheme();
    renderThemeMenu();
    $(`#theme-menu [data-theme="${themeChoice}"]`).focus();
  });
  document.addEventListener('click', () => { if (!$('#theme-menu').hidden) toggleThemeMenu(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#theme-menu').hidden) { toggleThemeMenu(false); $('#theme-btn').focus(); }
  });
  // 選「自動」時，裝置切換淺色／深色模式，網站跟著換
  darkQuery.addEventListener('change', () => { if (themeChoice === 'auto') applyTheme(); });

  // 「重新載入」「清除所有篩選」按鈕（新聞區、警示列裡都有）
  document.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'retry') loadNews();
    if (action === 'clear-filters') clearFilters();
  });
  // 網路斷線／恢復
  window.addEventListener('offline', () => toast(t().wentOffline));
  window.addEventListener('online', () => {
    if (state.loadError || state.status.retry) {
      toast(t().backOnline);
      loadNews();
    }
  });

  state.pendingStory = readStoryHash();
  window.WORLD_PULSE_READY = true; // 給 index.html 的啟動檢查用：程式有正常跑起來
  loadNews();
  // 每 10 分鐘自動更新
  setInterval(() => { if (!document.hidden) loadNews(); }, 10 * 60 * 1000);
}

init();
