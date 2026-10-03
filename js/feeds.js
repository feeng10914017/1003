/*
 * 世界脈動 World Pulse — 設定檔
 * 想新增／移除新聞來源、修改介面文字、調整自動分類關鍵字，都改這個檔案就好。
 */

/* ---------- 新聞來源 ----------
 * 所有來源都會一起抓，新聞保持原文；介面的中／英切換不會影響新聞內容。
 * 每個來源請寫在同一行（GitHub 的抓取程式是一行一行讀的）。
 *
 * lang    ：新聞原文語言，'zh' 或 'en'（給「原文語言」篩選用）
 * source  ：卡片上顯示的媒體名稱
 * url     ：RSS 網址
 * cat     ：（選填）這條 RSS 固定屬於哪個分類，沒填就用關鍵字自動判斷
 * region  ：（選填）這條 RSS 固定屬於哪個地區，沒填就用關鍵字自動判斷
 */
const FEEDS = [
  { lang: 'zh', source: 'BBC 中文', url: 'https://feeds.bbci.co.uk/zhongwen/trad/rss.xml' },
  { lang: 'zh', source: '法廣 RFI', url: 'https://www.rfi.fr/tw/rss' },
  { lang: 'zh', source: '德國之聲 DW', url: 'https://rss.dw.com/rdf/rss-chi-all' },
  { lang: 'zh', source: '紐約時報中文網', url: 'https://cn.nytimes.com/rss/zh-hant/' },
  { lang: 'zh', source: '中央社', url: 'https://feeds.feedburner.com/rsscna/intworld', cat: 'world' },
  { lang: 'zh', source: '自由時報', url: 'https://news.ltn.com.tw/rss/world.xml', cat: 'world' },
  { lang: 'en', source: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', cat: 'world' },
  { lang: 'en', source: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/asia/rss.xml', cat: 'world', region: 'asia' },
  { lang: 'en', source: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/europe/rss.xml', cat: 'world', region: 'europe' },
  { lang: 'en', source: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml', cat: 'world', region: 'americas' },
  { lang: 'en', source: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/latin_america/rss.xml', cat: 'world', region: 'americas' },
  { lang: 'en', source: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml', cat: 'world', region: 'africa' },
  { lang: 'en', source: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml', cat: 'world', region: 'middle_east' },
  { lang: 'en', source: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/australia/rss.xml', cat: 'world', region: 'oceania' },
  { lang: 'en', source: 'BBC', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', cat: 'business' },
  { lang: 'en', source: 'BBC', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', cat: 'tech' },
  { lang: 'en', source: 'BBC', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', cat: 'science' },
  { lang: 'en', source: 'BBC', url: 'https://feeds.bbci.co.uk/news/health/rss.xml', cat: 'health' },
  { lang: 'en', source: 'BBC', url: 'https://feeds.bbci.co.uk/sport/rss.xml', cat: 'sport' },
  { lang: 'en', source: 'BBC', url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', cat: 'culture' },
  { lang: 'en', source: 'The Guardian', url: 'https://www.theguardian.com/world/rss', cat: 'world' }
];

/* ---------- 熱門話題：Google 搜尋趨勢 ----------
 * 想加其他國家，照格式加一行，例如 jp: 'https://trends.google.com/trending/rss?geo=JP'
 * （也要在下面 I18N 的 geo 裡加上顯示名稱）
 */
const TRENDS = {
  tw: 'https://trends.google.com/trending/rss?geo=TW',
  us: 'https://trends.google.com/trending/rss?geo=US'
};

/* ---------- 跨網域代理（備援用） ----------
 * 正常情況下網站讀的是 GitHub Actions 準備好的 data/news.json。
 * 只有讀不到時（例如在自己電腦直接打開 index.html），才透過這些免費代理抓 RSS。
 * 依序嘗試，第一個失敗就換下一個。type: 'xml' 回傳原始 RSS，'json' 是 rss2json 格式。
 */
const PROXIES = [
  { type: 'xml', build: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  { type: 'json', build: (u) => 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(u) },
  { type: 'xml', build: (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u) }
];

/* ---------- 篩選選項 ---------- */
const CATEGORIES = ['all', 'world', 'business', 'tech', 'science', 'health', 'sport', 'culture'];
const REGIONS = ['all', 'asia', 'europe', 'americas', 'africa', 'middle_east', 'oceania'];
const SOURCE_LANGS = ['all', 'zh', 'en'];

/* ---------- 介面文字（中／英） ---------- */
const I18N = {
  zh: {
    siteName: '世界脈動',
    tagline: '即時掌握全球大小事',
    searchPlaceholder: '搜尋新聞關鍵字…',
    refresh: '重新整理',
    categoryLabel: '分類',
    regionLabel: '地區',
    langLabel: '原文語言',
    cat: { all: '全部', world: '國際', business: '財經', tech: '科技', science: '科學環境', health: '健康', sport: '體育', culture: '文化娛樂' },
    region: { all: '全球', asia: '亞洲', europe: '歐洲', americas: '美洲', africa: '非洲', middle_east: '中東', oceania: '大洋洲' },
    srcLang: { all: '全部', zh: '中文', en: 'English' },
    viewCards: '卡片',
    viewList: '條列',
    hotTitle: '熱門話題',
    hotTrends: '搜尋趨勢',
    hotFocus: '媒體焦點',
    sortHot: '最熱',
    sortNew: '最新',
    liveLabel: '即時',
    themeLabel: '配色',
    themes: {
      auto: ['自動', '跟隨裝置的淺色／深色設定'],
      paper: ['暖白', '米白紙張感，預設配色'],
      white: ['白色', '清爽明亮'],
      navy: ['深藍', '深藍報頭，穩重柔和'],
      black: ['經典黑', '黑色報頭，對比強烈'],
      dark: ['深色', '適合夜間閱讀']
    },
    share: '分享',
    translate: '用 Google 翻譯原文',
    copied: '已複製分享連結',
    shareFail: '無法分享，請直接複製瀏覽器網址列的連結',
    newSince: (n) => `自上次來訪後新增 ${n} 則`,
    newTag: '新',
    alsoReported: '其他媒體的相同報導',
    moreOutlets: (n) => `另有 ${n} 家媒體報導`,
    storyGone: '找不到這則新聞，可能已從最新新聞中移除。',
    outdated: (h) => `新聞已經 ${h} 小時沒有更新，自動更新可能暫停了。`,
    latest: '最新快訊',
    seeMore: '看更多',
    browseAll: (n) => `以條列瀏覽全部 ${n} 則新聞`,
    geo: { tw: '台灣', us: '美國' },
    searches: (n) => `${n} 次搜尋`,
    outlets: (n) => `${n} 家媒體報導`,
    relatedNews: '相關報導',
    searchHere: (q, n) => `查看本站 ${n} 則「${q}」相關新聞`,
    trendsUnavailable: '搜尋趨勢暫時無法取得，請稍後再試。',
    trendsEmpty: '這個地區目前沒有搜尋趨勢資料，可以切換到其他地區看看。',
    focusEmpty: '最近 48 小時還沒有多家媒體共同報導的事件。',
    trendNoNews: '這個關鍵字剛開始變熱門，Google 還沒整理出相關報導。可以直接搜尋，看看大家在討論什麼。',
    trendCardHint: '尚無整理好的報導，點開可直接搜尋',
    googleNews: 'Google 新聞搜尋',
    googleSearch: 'Google 搜尋',
    trendNote: '資料來源：Google 搜尋趨勢，反映大家正在搜尋的關鍵字。',
    focusNote: '48 小時內有多家媒體報導的事件。',
    loading: '正在載入最新新聞…',
    loadingSlow: '載入時間比平常久，請稍候…',
    refreshing: '正在檢查新內容…',
    tickerEmpty: '目前沒有最新新聞',
    updatedAt: (t) => `更新於 ${t}`,
    count: (n) => `共 ${n} 則`,
    partialFail: (n) => `${n} 個來源暫時無法載入`,
    stale: '目前無法連線到新聞來源，顯示的是上次儲存的較舊內容。',
    staleOffline: '目前沒有連上網路，顯示的是上次儲存的新聞。',
    errorTitle: '暫時無法載入新聞',
    errorText: '可能是網路不穩，或新聞來源暫時沒有回應。請稍後再試一次。',
    offlineTitle: '目前沒有連上網路',
    offlineText: '請檢查 Wi-Fi 或行動網路。連上網路後，網站會自動重新載入。',
    retry: '重新載入',
    backOnline: '網路已恢復，正在重新載入…',
    wentOffline: '網路連線中斷',
    emptyTitle: '找不到符合條件的新聞',
    emptyText: (conds) => `目前的條件：${conds}。可以換個關鍵字，或放寬篩選條件。`,
    onlyNewLabel: '只看新的',
    clearFilters: '清除所有篩選',
    noSummary: '這則新聞沒有提供摘要，請點「閱讀原文」查看完整內容。',
    readMore: '閱讀原文',
    modalNote: '這裡只顯示摘要，完整報導請點「閱讀原文」。',
    close: '關閉',
    featured: '頭條',
    footer: '新聞內容版權屬於各原始媒體，本站僅透過各媒體公開的新聞摘要（RSS）顯示標題與摘要；「搜尋趨勢」資料來自 Google。'
  },
  en: {
    siteName: 'World Pulse',
    tagline: 'The world, as it happens',
    searchPlaceholder: 'Search news…',
    refresh: 'Refresh',
    categoryLabel: 'Category',
    regionLabel: 'Region',
    langLabel: 'Language',
    cat: { all: 'All', world: 'World', business: 'Business', tech: 'Tech', science: 'Science', health: 'Health', sport: 'Sport', culture: 'Culture' },
    region: { all: 'Global', asia: 'Asia', europe: 'Europe', americas: 'Americas', africa: 'Africa', middle_east: 'Middle East', oceania: 'Oceania' },
    srcLang: { all: 'All', zh: '中文', en: 'English' },
    viewCards: 'Cards',
    viewList: 'List',
    hotTitle: 'Trending',
    hotTrends: 'Searches',
    hotFocus: 'In the news',
    sortHot: 'Hottest',
    sortNew: 'Latest',
    liveLabel: 'Live',
    themeLabel: 'Theme',
    themes: {
      auto: ['Auto', 'Follow your device’s light/dark setting'],
      paper: ['Paper', 'Warm off-white, the default'],
      white: ['White', 'Clean and bright'],
      navy: ['Navy', 'Navy masthead, calm and steady'],
      black: ['Classic black', 'Black masthead, high contrast'],
      dark: ['Dark', 'Easy on the eyes at night']
    },
    share: 'Share',
    translate: 'Read in Google Translate',
    copied: 'Link copied',
    shareFail: 'Couldn’t share — please copy the address manually',
    newSince: (n) => `${n} new since your last visit`,
    newTag: 'New',
    alsoReported: 'Same story from other outlets',
    moreOutlets: (n) => `+${n} more outlet${n > 1 ? 's' : ''}`,
    storyGone: 'That story is no longer available here.',
    outdated: (h) => `News hasn’t been updated for ${h} hours. Automatic updates may have stopped.`,
    latest: 'Latest',
    seeMore: 'See more',
    browseAll: (n) => `Browse all ${n} stories as a list`,
    geo: { tw: 'Taiwan', us: 'US' },
    searches: (n) => `${n} searches`,
    outlets: (n) => `${n} outlets`,
    relatedNews: 'Related coverage',
    searchHere: (q, n) => `See ${n} related ${n > 1 ? 'stories' : 'story'} on this site`,
    trendsUnavailable: 'Search trends are unavailable right now. Please try again later.',
    trendsEmpty: 'No search trends for this region right now — try another region.',
    focusEmpty: 'No story has been covered by several outlets in the last 48 hours yet.',
    trendNoNews: 'This search just started trending, so Google hasn’t gathered coverage yet. Search it directly to see what people are talking about.',
    trendCardHint: 'No coverage yet — tap to search',
    googleNews: 'Search Google News',
    googleSearch: 'Search Google',
    trendNote: 'Source: Google Trends — what people are searching for right now.',
    focusNote: 'Stories covered by several outlets in the last 48 hours.',
    loading: 'Loading the latest headlines…',
    loadingSlow: 'This is taking longer than usual — please hang on…',
    refreshing: 'Checking for new stories…',
    tickerEmpty: 'No latest stories right now',
    updatedAt: (t) => `Updated ${t}`,
    count: (n) => `${n} stories`,
    partialFail: (n) => `${n} source${n > 1 ? 's' : ''} unavailable`,
    stale: 'Can’t reach the news sources right now — showing older saved stories.',
    staleOffline: 'You’re offline — showing the stories saved from your last visit.',
    errorTitle: 'Couldn’t load the news',
    errorText: 'The connection may be unstable, or the news sources aren’t responding. Please try again in a moment.',
    offlineTitle: 'You’re offline',
    offlineText: 'Check your Wi-Fi or mobile data. The site will reload automatically once you’re back online.',
    retry: 'Try again',
    backOnline: 'Back online — reloading…',
    wentOffline: 'Connection lost',
    emptyTitle: 'No stories match',
    emptyText: (conds) => `Current filters: ${conds}. Try another keyword or loosen the filters.`,
    onlyNewLabel: 'New only',
    clearFilters: 'Clear all filters',
    noSummary: 'This story has no summary — tap “Read full story” to see the full article.',
    readMore: 'Read full story',
    modalNote: 'Only a summary is shown here — tap “Read full story” for the full article.',
    close: 'Close',
    featured: 'Top story',
    footer: 'All stories belong to their original publishers. This site only shows headlines and summaries from public RSS feeds; trending searches come from Google Trends.'
  }
};

/* ---------- 自動分類關鍵字 ----------
 * 來源沒有指定分類／地區時，用標題與摘要中的關鍵字猜。
 * 中文關鍵字同時放繁體與簡體（DW 中文是簡體）。
 * 全大寫的英文（如 US、AI）會區分大小寫，避免把 "us" 也算進去。
 */
const KEYWORDS = {
  region: {
    asia: ['china', 'chinese', 'japan', 'korea', 'india', 'pakistan', 'taiwan', 'hong kong', 'vietnam', 'thailand', 'indonesia', 'philippines', 'singapore', 'malaysia', 'myanmar', 'bangladesh', 'afghanistan', 'nepal', 'sri lanka', 'beijing', 'tokyo', 'seoul',
      '中國', '中国', '日本', '韓國', '韩国', '朝鮮', '朝鲜', '印度', '巴基斯坦', '台灣', '台湾', '臺灣', '香港', '越南', '泰國', '泰国', '印尼', '菲律賓', '菲律宾', '新加坡', '馬來西亞', '马来西亚', '緬甸', '缅甸', '北京', '東京', '东京', '首爾', '首尔', '亞洲', '亚洲', '南海', '澳門', '澳门', '習近平', '习近平', '港台'],
    europe: ['UK', 'EU', 'britain', 'british', 'england', 'france', 'french', 'germany', 'german', 'ukraine', 'russia', 'italy', 'spain', 'poland', 'european', 'london', 'paris', 'berlin', 'kyiv', 'moscow', 'NATO', 'putin', 'zelensky',
      '歐洲', '欧洲', '英國', '英国', '法國', '法国', '德國', '德国', '烏克蘭', '乌克兰', '俄羅斯', '俄罗斯', '義大利', '意大利', '西班牙', '波蘭', '波兰', '歐盟', '欧盟', '倫敦', '伦敦', '巴黎', '柏林', '基輔', '基辅', '莫斯科', '北約', '北约', '普京', '普丁', '澤連斯基', '泽连斯基', '烏軍', '乌军', '俄軍', '俄军', '俄國', '俄国', '俄烏', '俄乌'],
    americas: ['US', 'USA', 'america', 'american', 'trump', 'washington', 'canada', 'mexico', 'brazil', 'argentina', 'venezuela', 'colombia', 'chile', 'cuba', 'peru', 'white house',
      '美國', '美国', '特朗普', '川普', '華盛頓', '华盛顿', '白宮', '白宫', '加拿大', '墨西哥', '巴西', '阿根廷', '委內瑞拉', '委内瑞拉', '古巴', '美洲', '拉美', '哥倫比亞', '哥伦比亚'],
    africa: ['africa', 'african', 'nigeria', 'kenya', 'egypt', 'ethiopia', 'sudan', 'congo', 'somalia', 'ghana', 'uganda', 'morocco', 'algeria', 'zimbabwe',
      '非洲', '奈及利亞', '尼日利亚', '肯亞', '肯尼亚', '埃及', '衣索比亞', '埃塞俄比亚', '蘇丹', '苏丹', '南非', '剛果', '刚果', '索馬利亞', '索马里'],
    middle_east: ['israel', 'gaza', 'iran', 'iraq', 'syria', 'lebanon', 'saudi', 'yemen', 'UAE', 'dubai', 'qatar', 'turkey', 'palestin', 'hamas', 'hezbollah', 'middle east',
      '以色列', '加沙', '加薩', '伊朗', '伊拉克', '敘利亞', '叙利亚', '黎巴嫩', '沙特', '沙烏地', '也門', '葉門', '也门', '阿聯酋', '阿联酋', '杜拜', '迪拜', '卡塔爾', '卡塔尔', '土耳其', '巴勒斯坦', '中東', '中东', '哈馬斯', '哈马斯', '真主黨', '真主党'],
    oceania: ['australia', 'australian', 'new zealand', 'fiji', 'papua', 'pacific island',
      '澳洲', '澳大利亞', '澳大利亚', '紐西蘭', '新西兰', '斐濟', '斐济', '太平洋島國', '太平洋岛国']
  },
  cat: {
    business: ['economy', 'economic', 'market', 'stocks', 'trade', 'tariff', 'inflation', 'bank', 'oil price', 'company', 'business', 'GDP', 'interest rate', 'investor',
      '經濟', '经济', '股市', '貿易', '贸易', '關稅', '关税', '通膨', '通胀', '銀行', '银行', '企業', '企业', '投資', '投资', '油價', '油价', '央行', '市場', '市场', '財經', '财经'],
    tech: ['AI', 'artificial intelligence', 'tech', 'technology', 'apple', 'google', 'microsoft', 'chip', 'semiconductor', 'cyber', 'software', 'robot', 'smartphone', 'openai', 'internet', 'hacker',
      '人工智慧', '人工智能', 'AI', '科技', '晶片', '芯片', '半導體', '半导体', '機器人', '机器人', '手機', '手机', '駭客', '黑客', '電動車', '电动车', '網路安全', '网络安全'],
    science: ['climate', 'space', 'NASA', 'scientist', 'environment', 'species', 'planet', 'research', 'earthquake', 'wildlife',
      '氣候', '气候', '太空', '科學', '科学', '環境', '环境', '研究', '物種', '物种', '地震', '野生'],
    health: ['health', 'virus', 'disease', 'hospital', 'vaccine', 'cancer', 'medical', 'covid', 'outbreak', 'doctor', 'NHS',
      '健康', '病毒', '疾病', '醫院', '医院', '疫苗', '癌', '醫療', '医疗', '疫情', '醫生', '医生'],
    sport: ['football', 'sport', 'world cup', 'olympic', 'tennis', 'cricket', 'NBA', 'league', 'championship', 'premier league', 'golf', 'formula 1',
      '足球', '體育', '体育', '奧運', '奥运', '網球', '网球', '世界盃', '世界杯', '籃球', '篮球', '亞運', '亚运', '球星'],
    culture: ['film', 'music', 'movie', 'art', 'celebrity', 'festival', 'book', 'actor', 'singer', 'album', 'oscar',
      '電影', '电影', '音樂', '音乐', '藝術', '艺术', '文化', '明星', '演員', '演员', '歌手', '電視劇', '电视剧']
  }
};
