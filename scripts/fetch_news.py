"""
世界脈動 World Pulse — 新聞抓取程式（由 GitHub Actions 每小時自動執行）

讀取 js/feeds.js 裡的 RSS 清單與 Google 搜尋趨勢，下載後整理成 data/news.json。
網站會優先讀這個檔案，就不需要透過免費代理抓 RSS。

另外替每則新聞產生分享頁 s/<代號>.html：LINE、Facebook 讀得到這則新聞的標題與圖片，
人點進去會自動跳回首頁並打開這則新聞。
GitHub Actions 會傳入 SITE_URL（網站完整網址），用來把預覽圖換成完整網址。

只用 Python 內建功能，不需要安裝任何套件。
自己電腦想測試的話：在 world-pulse 資料夾裡執行  python3 scripts/fetch_news.py
"""

import gzip
import html
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
FEEDS_JS = ROOT / 'js' / 'feeds.js'
DATA_DIR = ROOT / 'data'
SHARE_DIR = ROOT / 's'
SITE_URL = os.environ.get('SITE_URL', '').rstrip('/')
MAX_ITEMS_PER_FEED = 30
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; WorldPulseBot/1.0; +https://github.com/)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Encoding': 'gzip',
}


def read_config():
    """從 js/feeds.js 讀出 FEEDS 的 RSS 網址與 TRENDS 的趨勢網址"""
    text = FEEDS_JS.read_text(encoding='utf-8')
    feeds = re.search(r'const FEEDS = \[(.*?)\n\];', text, re.S)
    trends = re.search(r'const TRENDS = \{(.*?)\n\};', text, re.S)
    if not feeds:
        sys.exit('找不到 js/feeds.js 裡的 FEEDS 設定')
    feed_urls = re.findall(r"url:\s*'([^']+)'", feeds.group(1))
    trend_urls = dict(re.findall(r"(\w+):\s*'([^']+)'", trends.group(1))) if trends else {}
    return feed_urls, trend_urls


def local(tag):
    """去掉 XML 命名空間，例如 {http://search.yahoo.com/mrss/}thumbnail → thumbnail"""
    return tag.rsplit('}', 1)[-1]


def child_text(node, *names):
    for el in node:
        if local(el.tag) in names:
            if local(el.tag) == 'link' and el.get('href'):  # Atom 格式
                return el.get('href').strip()
            return (el.text or '').strip()
    return ''


def parse_feed(data):
    root = ET.fromstring(data)
    nodes = [el for el in root.iter() if local(el.tag) in ('item', 'entry')]
    items = []
    for node in nodes[:MAX_ITEMS_PER_FEED]:
        image, best_width = '', -1
        for el in node:
            url = el.get('url')
            name = local(el.tag)
            is_image = name in ('thumbnail', 'content') or (name == 'enclosure' and (el.get('type') or '').startswith('image'))
            if url and is_image:
                width = int(el.get('width') or 0)
                if width > best_width:
                    best_width, image = width, url
        items.append({
            'title': child_text(node, 'title'),
            'link': child_text(node, 'link') or node.get('{http://www.w3.org/1999/02/22-rdf-syntax-ns#}about', ''),
            'description': child_text(node, 'description', 'summary', 'encoded'),
            'date': child_text(node, 'pubDate', 'date', 'published', 'updated'),
            'image': image,
            'categories': [(el.text or el.get('term') or '').strip() for el in node if local(el.tag) in ('category', 'subject')],
        })
    return items


def parse_trends(data):
    """Google 搜尋趨勢 RSS：關鍵字、搜尋量、圖片、相關新聞"""
    root = ET.fromstring(data)
    trends = []
    for node in [el for el in root.iter() if local(el.tag) == 'item'][:20]:
        news = []
        for n in node:
            if local(n.tag) != 'news_item':
                continue
            news.append({
                'title': child_text(n, 'news_item_title'),
                'url': child_text(n, 'news_item_url'),
                'source': child_text(n, 'news_item_source'),
                'picture': child_text(n, 'news_item_picture'),
            })
        trends.append({
            'title': child_text(node, 'title'),
            'traffic': child_text(node, 'approx_traffic'),
            'picture': child_text(node, 'picture'),
            'date': child_text(node, 'pubDate'),
            'news': news[:4],
        })
    return trends


def download(url):
    with urlopen(Request(url, headers=HEADERS), timeout=20) as res:
        data = res.read()
        if res.headers.get('Content-Encoding') == 'gzip' or data[:2] == b'\x1f\x8b':
            data = gzip.decompress(data)
    return data


def fetch(url, parser=None):
    try:
        items = (parser or parse_feed)(download(url))
        print(f'  ✓ {len(items):>3} 則  {url}')
        return url, items
    except Exception as e:  # 單一來源失敗不影響其他來源
        print(f'  ✗ 失敗      {url}（{e}）')
        return url, None


def story_hash(text):
    """新聞代號：網址的 FNV-1a 雜湊轉 36 進位（js/app.js 的 storyHash 算法完全一樣）"""
    h = 0x811c9dc5
    for b in text.encode('utf-8'):
        h ^= b
        h = (h * 0x01000193) & 0xffffffff
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    out = ''
    while True:
        h, r = divmod(h, 36)
        out = digits[r] + out
        if h == 0:
            return out


def plain_text(raw):
    """把摘要裡的 HTML 標籤拿掉，只留文字"""
    raw = re.sub(r'<(figure|figcaption|p style)[^>]*>.*?</(figure|figcaption|p)>', ' ', raw or '', flags=re.S)
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', raw))).strip()


def absolute(path):
    return f'{SITE_URL}/{path}' if SITE_URL else path


SHARE_TEMPLATE = """<!DOCTYPE html>
<html lang="{lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · 世界脈動</title>
<meta name="description" content="{desc}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="世界脈動 World Pulse">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{image}">
<meta property="og:url" content="{url}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0; url=../index.html#story={sid}">
<script>location.replace('../index.html#story={sid}');</script>
</head>
<body>
<p><a href="../index.html#story={sid}">{title}</a></p>
</body>
</html>
"""


def write_share_pages(feeds):
    """每則新聞一個分享頁，給 LINE／Facebook 的預覽機器人看"""
    SHARE_DIR.mkdir(exist_ok=True)
    zh_feeds = set(re.findall(r"lang:\s*'zh'[^}]*url:\s*'([^']+)'", FEEDS_JS.read_text(encoding='utf-8')))
    count = 0
    for feed_url, items in feeds.items():
        lang = 'zh-Hant' if feed_url in zh_feeds else 'en'
        for item in items:
            if not item['link'] or not item['title']:
                continue
            sid = story_hash(item['link'])
            image = item['image'] or (re.search(r"<img[^>]+src=['\"]([^'\"]+)", item['description'] or '') or [None, ''])[1]
            # BBC 縮圖只有 240px，換成 800px 預覽才清楚
            image = re.sub(r'(ichef\.bbci\.co\.uk/ace/(?:standard|ws))/\d+/', r'\1/800/', image)
            page = SHARE_TEMPLATE.format(
                lang=lang,
                sid=sid,
                title=html.escape(plain_text(item['title'])),
                desc=html.escape(plain_text(item['description'])[:160]),
                image=html.escape(image or absolute('images/og-cover.jpg')),
                url=html.escape(absolute(f's/{sid}.html')),
            )
            (SHARE_DIR / f'{sid}.html').write_text(page, encoding='utf-8')
            count += 1
    print(f'→ 產生 {count} 個分享頁（s/）')


def absolutize_index():
    """首頁的預覽圖要完整網址；原始檔維持相對路徑，只在 GitHub 發布時改寫"""
    if not SITE_URL:
        return
    index = ROOT / 'index.html'
    text = index.read_text(encoding='utf-8')
    text = text.replace('content="images/og-cover.jpg"', f'content="{absolute("images/og-cover.jpg")}"')
    text = text.replace('<meta property="og:url" content="">', f'<meta property="og:url" content="{SITE_URL}/">')
    index.write_text(text, encoding='utf-8')
    print(f'→ 首頁預覽網址設定為 {SITE_URL}/')


def main():
    DATA_DIR.mkdir(exist_ok=True)
    feed_urls, trend_urls = read_config()

    print(f'抓取 {len(feed_urls)} 個新聞來源')
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(fetch, feed_urls))

    print(f'抓取 {len(trend_urls)} 個搜尋趨勢')
    trends = {}
    for geo, url in trend_urls.items():
        _, items = fetch(url, parse_trends)
        if items:
            trends[geo] = items

    output = {
        'updated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'feeds': {url: items for url, items in results if items},
        'failed': [url for url, items in results if not items],
        'trends': trends,
        'sharePages': True,
    }
    if not output['feeds']:
        sys.exit('所有新聞來源都失敗了')
    path = DATA_DIR / 'news.json'
    path.write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'→ 寫入 {path.relative_to(ROOT)}（{len(output["feeds"])} 個來源成功，{len(output["failed"])} 個失敗）')
    write_share_pages(output['feeds'])
    absolutize_index()


if __name__ == '__main__':
    main()
