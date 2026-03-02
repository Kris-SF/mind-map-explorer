"""
Scrape Moontower Substack posts from moontower.substack.com.
1. Paginate through the /api/v1/archive endpoint to get all post metadata
2. Fetch each post's full HTML content
3. Extract title + body text
4. Output data/substack_raw.json
"""

import json
import re
import time
import sys
from pathlib import Path

import requests
from bs4 import BeautifulSoup

SUBSTACK_DOMAIN = "moontower.substack.com"
ARCHIVE_API = f"https://{SUBSTACK_DOMAIN}/api/v1/archive"
OUTPUT = Path(__file__).parent.parent / "data" / "substack_raw.json"
DELAY = 1.5  # seconds between requests
PAGE_SIZE = 12  # Substack's default page size


def fetch_all_posts():
    """Paginate through the Substack archive API to get all post metadata."""
    print(f"Fetching archive from {ARCHIVE_API}...")
    all_posts = []
    offset = 0

    while True:
        params = {"sort": "new", "limit": PAGE_SIZE, "offset": offset}
        try:
            resp = requests.get(ARCHIVE_API, params=params, timeout=30)
            resp.raise_for_status()
        except requests.RequestException as e:
            print(f"  Error fetching archive page at offset {offset}: {e}")
            break

        posts = resp.json()
        if not posts:
            break

        all_posts.extend(posts)
        print(f"  Fetched {len(all_posts)} posts so far...")
        offset += PAGE_SIZE
        time.sleep(DELAY)

    print(f"Found {len(all_posts)} total posts")
    return all_posts


def extract_text_from_html(html):
    """Extract clean body text from Substack post HTML."""
    if not html:
        return ""
    soup = BeautifulSoup(html, "html.parser")

    # Remove script/style/nav elements
    for tag in soup.find_all(["script", "style", "nav", "footer", "header"]):
        tag.decompose()

    return soup.get_text(separator="\n", strip=True)


def fetch_post_content(post_url):
    """Fetch a post page and extract the full body text."""
    try:
        resp = requests.get(post_url, timeout=30)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"    Error fetching post: {e}")
        return None

    soup = BeautifulSoup(resp.text, "html.parser")

    # Substack post body is typically in .body or .post-content
    text = ""
    for selector in [".body", ".post-content", ".available-content", "article", "main"]:
        content_el = soup.select_one(selector)
        if content_el:
            for tag in content_el.find_all(["script", "style", "nav", "footer", "header"]):
                tag.decompose()
            text = content_el.get_text(separator="\n", strip=True)
            break

    # Fallback to body
    if not text:
        body = soup.find("body")
        if body:
            for tag in body.find_all(["script", "style", "nav", "footer", "header"]):
                tag.decompose()
            text = body.get_text(separator="\n", strip=True)

    return text


def main():
    posts = fetch_all_posts()
    if not posts:
        print("No posts found! Check the Substack archive API.")
        sys.exit(1)

    results = []
    for i, post in enumerate(posts):
        post_id = post.get("id", i + 1)
        title = post.get("title", "Untitled")
        subtitle = post.get("subtitle", "")
        slug = post.get("slug", "")
        post_url = post.get("canonical_url") or f"https://{SUBSTACK_DOMAIN}/p/{slug}"
        post_date = post.get("post_date", None)
        post_type = post.get("type", "newsletter")

        # Skip non-article types (e.g., podcast-only posts)
        if post_type == "podcast" and not post.get("body_html"):
            print(f"  [{i+1}/{len(posts)}] Skipping podcast-only: {title[:60]}")
            continue

        print(f"  [{i+1}/{len(posts)}] {title[:60]}")

        # Substack API often includes body_html directly
        body_html = post.get("body_html", "")
        if body_html:
            text = extract_text_from_html(body_html)
        else:
            # Fall back to scraping the post page
            text = fetch_post_content(post_url)
            time.sleep(DELAY)

        results.append({
            "id": f"ss_{post_id}",
            "title": title,
            "subtitle": subtitle,
            "url": post_url,
            "date": post_date,
            "category": post_type,
            "text": text or "",
        })

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT, "w") as f:
        json.dump(results, f, indent=2)

    with_content = sum(1 for r in results if r["text"])
    print(f"\nDone! {with_content}/{len(results)} posts with content saved to {OUTPUT}")


if __name__ == "__main__":
    main()
