"""
Scrape blog.moontower.ai (Ghost blog).
1. Try the Ghost sitemap/RSS to discover post URLs
2. Fall back to paginating /page/N/ if needed
3. Fetch each post's title + body text
4. Output data/blog_raw.json
"""

import json
import re
import time
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
from bs4 import BeautifulSoup

BLOG_DOMAIN = "blog.moontower.ai"
BLOG_URL = f"https://{BLOG_DOMAIN}"
OUTPUT = Path(__file__).parent.parent / "data" / "blog_raw.json"
DELAY = 1.5  # seconds between requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; MindMapBot/1.0)",
}


def fetch(url):
    """Fetch a URL with retries and polite headers."""
    for attempt in range(3):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=30)
            resp.raise_for_status()
            return resp
        except requests.RequestException as e:
            if attempt == 2:
                raise
            print(f"    Retry {attempt + 1} for {url}: {e}")
            time.sleep(DELAY * (attempt + 1))


def discover_posts_via_sitemap():
    """Try to get post URLs from Ghost's sitemap."""
    posts = []

    # Ghost generates sitemaps at /sitemap.xml -> /sitemap-posts.xml
    for sitemap_url in [
        f"{BLOG_URL}/sitemap-posts.xml",
        f"{BLOG_URL}/sitemap.xml",
    ]:
        try:
            print(f"Trying sitemap: {sitemap_url}")
            resp = fetch(sitemap_url)
            root = ET.fromstring(resp.text)
            ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}

            # Check if this is a sitemap index
            for sitemap in root.findall("sm:sitemap", ns):
                loc = sitemap.find("sm:loc", ns)
                if loc is not None and "posts" in loc.text:
                    print(f"  Found posts sitemap: {loc.text}")
                    sub_resp = fetch(loc.text)
                    sub_root = ET.fromstring(sub_resp.text)
                    for url_el in sub_root.findall("sm:url", ns):
                        loc2 = url_el.find("sm:loc", ns)
                        if loc2 is not None:
                            posts.append(loc2.text)

            # Direct URL entries
            for url_el in root.findall("sm:url", ns):
                loc = url_el.find("sm:loc", ns)
                if loc is not None:
                    posts.append(loc.text)

            if posts:
                break
        except Exception as e:
            print(f"  Sitemap error: {e}")

    # Filter to actual post URLs (not tag/author/page URLs)
    skip_prefixes = ["/tag/", "/author/", "/page/", "/ghost/"]
    filtered = []
    for url in posts:
        path = url.replace(BLOG_URL, "")
        if any(path.startswith(p) for p in skip_prefixes):
            continue
        if path in ("", "/"):
            continue
        filtered.append(url)

    return filtered


def discover_posts_via_rss():
    """Try Ghost RSS feed."""
    posts = []
    for rss_url in [f"{BLOG_URL}/rss/", f"{BLOG_URL}/feed/"]:
        try:
            print(f"Trying RSS: {rss_url}")
            resp = fetch(rss_url)
            root = ET.fromstring(resp.text)
            for item in root.iter("item"):
                link = item.find("link")
                title = item.find("title")
                if link is not None and link.text:
                    posts.append({
                        "url": link.text.strip(),
                        "title": title.text.strip() if title is not None and title.text else "",
                    })
            if posts:
                print(f"  Found {len(posts)} posts via RSS")
                return posts
        except Exception as e:
            print(f"  RSS error: {e}")
    return posts


def discover_posts_via_pagination():
    """Paginate through the blog's homepage/archive."""
    posts = []
    page = 1
    while True:
        url = BLOG_URL if page == 1 else f"{BLOG_URL}/page/{page}/"
        print(f"Fetching page {page}: {url}")
        try:
            resp = fetch(url)
        except Exception:
            break

        soup = BeautifulSoup(resp.text, "html.parser")

        # Find post links — Ghost themes typically use <article> or <h2><a> patterns
        found = 0
        for link in soup.find_all("a", href=True):
            href = link["href"]
            text = link.get_text(strip=True)
            if not text or len(text) < 3:
                continue

            # Normalize URL
            if href.startswith("/"):
                href = f"{BLOG_URL}{href}"

            # Must be on this domain and look like a post
            if BLOG_DOMAIN not in href:
                continue
            path = href.replace(BLOG_URL, "").rstrip("/")
            if not path or "/" in path.lstrip("/"):
                continue  # Skip nested paths like /tag/foo
            skip = ["/tag", "/author", "/page", "/ghost", "/rss", "/about", "/membership"]
            if any(path.startswith(s) for s in skip):
                continue

            if href not in [p["url"] for p in posts]:
                posts.append({"url": href, "title": text})
                found += 1

        if found == 0:
            break
        page += 1
        time.sleep(DELAY)

    return posts


def fetch_post_content(url):
    """Fetch a post page and extract title + body text."""
    try:
        resp = fetch(url)
    except Exception as e:
        print(f"    Error fetching post: {e}")
        return None, None

    soup = BeautifulSoup(resp.text, "html.parser")

    # Extract title
    title = None
    h1 = soup.find("h1")
    if h1:
        title = h1.get_text(strip=True)
    if not title:
        og_title = soup.find("meta", property="og:title")
        if og_title:
            title = og_title.get("content", "")
    if not title:
        title_tag = soup.find("title")
        if title_tag:
            title = title_tag.get_text(strip=True)

    # Extract body text — Ghost uses .gh-content, .post-content, article, etc.
    text = ""
    for selector in [".gh-content", ".post-content", ".post-full-content",
                     ".article-content", "article", ".content", "main"]:
        content_el = soup.select_one(selector)
        if content_el:
            for tag in content_el.find_all(["script", "style", "nav", "footer", "header"]):
                tag.decompose()
            text = content_el.get_text(separator="\n", strip=True)
            break

    if not text:
        body = soup.find("body")
        if body:
            for tag in body.find_all(["script", "style", "nav", "footer", "header"]):
                tag.decompose()
            text = body.get_text(separator="\n", strip=True)

    return title, text


def main():
    # Try multiple discovery methods
    post_urls = discover_posts_via_sitemap()
    post_data = []

    if post_urls:
        print(f"Found {len(post_urls)} posts via sitemap")
        post_data = [{"url": u, "title": ""} for u in post_urls]
    else:
        # Try RSS
        rss_posts = discover_posts_via_rss()
        if rss_posts:
            post_data = rss_posts
        else:
            # Fall back to pagination
            print("Sitemap and RSS failed, trying pagination...")
            post_data = discover_posts_via_pagination()

    if not post_data:
        print("No posts found! Check that blog.moontower.ai is accessible.")
        sys.exit(1)

    print(f"\nDiscovered {len(post_data)} posts. Fetching content...")

    results = []
    seen_urls = set()
    for i, post in enumerate(post_data):
        url = post["url"]
        if url in seen_urls:
            continue
        seen_urls.add(url)

        print(f"  [{i+1}/{len(post_data)}] {post.get('title', url)[:60]}")
        title, text = fetch_post_content(url)
        time.sleep(DELAY)

        results.append({
            "id": f"blog_{i+1}",
            "title": title or post.get("title", "Untitled"),
            "url": url,
            "category": "blog",
            "text": text or "",
        })

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT, "w") as f:
        json.dump(results, f, indent=2)

    with_content = sum(1 for r in results if r["text"])
    print(f"\nDone! {with_content}/{len(results)} posts with content saved to {OUTPUT}")


if __name__ == "__main__":
    main()
