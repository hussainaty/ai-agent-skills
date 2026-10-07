# Web Scraping Reference

Detailed reference material for the web-scraping skill. This file contains Python templates, advanced patterns, and framework-specific examples.

## Python Scraper Templates

### Template 1: Basic HTTP Scraper with Resume Support

```python
#!/usr/bin/env python3
"""
Basic web scraper with resume support, rate limiting, and file logging.
Usage: python scraper.py --resume --output data/results.csv
"""

import argparse
import csv
import json
import logging
import os
import signal
import sys
import time
import random
import requests
from typing import Optional

# ── Configuration ──────────────────────────────────────────

PROGRESS_FILE = "output/progress.json"
DEFAULT_DELAY = (1, 3)  # Random delay range in seconds
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
}

# ── Logging ────────────────────────────────────────────────

def setup_logging(log_file="output/scrape.log"):
    os.makedirs(os.path.dirname(log_file), exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            logging.FileHandler(log_file),
            logging.StreamHandler(),
        ],
    )

# ── Progress Management ────────────────────────────────────

def load_progress() -> dict:
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE) as f:
            return json.load(f)
    return {"completed_urls": [], "last_index": 0, "total_scraped": 0}

def save_progress(progress: dict):
    """Atomic write — prevents corruption if interrupted mid-write."""
    os.makedirs(os.path.dirname(PROGRESS_FILE), exist_ok=True)
    tmp = PROGRESS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(progress, f, indent=2)
    os.rename(tmp, PROGRESS_FILE)

# ── Graceful Shutdown ──────────────────────────────────────

shutdown_requested = False

def signal_handler(signum, frame):
    global shutdown_requested
    logging.info("Shutdown requested. Saving progress...")
    shutdown_requested = True

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# ── Scraper Core ───────────────────────────────────────────

def scrape_url(url: str, session: requests.Session) -> Optional[dict]:
    """Scrape a single URL. Returns parsed data or None on failure."""
    try:
        response = session.get(url, headers=HEADERS, timeout=30)
        response.raise_for_status()

        # Parse your data here
        data = {
            "url": url,
            "status": response.status_code,
            "content_length": len(response.text),
            # Add your parsing logic
        }
        return data

    except requests.RequestException as e:
        logging.warning(f"Failed: {url} — {e}")
        return None

def run_scraper(urls: list, output_file: str, resume: bool = False):
    """Main scraper loop with resume, rate limiting, and progress tracking."""
    progress = load_progress() if resume else {"completed_urls": [], "last_index": 0, "total_scraped": 0}
    completed = set(progress["completed_urls"])
    start_index = progress["last_index"] if resume else 0

    # Filter already-completed URLs
    remaining = [(i, url) for i, url in enumerate(urls) if url not in completed and i >= start_index]
    logging.info(f"Starting scrape: {len(remaining)} URLs remaining (of {len(urls)} total)")

    # Open output CSV in append mode
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    file_exists = os.path.exists(output_file) and resume
    fieldnames = ["url", "status", "content_length"]

    with open(output_file, "a" if file_exists else "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        if not file_exists:
            writer.writeheader()

        session = requests.Session()

        for i, url in remaining:
            if shutdown_requested:
                logging.info("Graceful shutdown. Progress saved.")
                break

            result = scrape_url(url, session)
            if result:
                writer.writerow(result)
                f.flush()
                completed.add(url)
                progress["total_scraped"] += 1

            progress["last_index"] = i + 1
            progress["completed_urls"] = list(completed)

            # Save progress every 10 records
            if i % 10 == 0:
                save_progress(progress)

            # Rate limiting
            delay = random.uniform(*DEFAULT_DELAY)
            time.sleep(delay)

            # Log progress
            if i % 50 == 0:
                logging.info(f"[{i+1}/{len(urls)}] Scraped: {progress['total_scraped']} | URL: {url}")

    save_progress(progress)
    logging.info(f"Complete. Total scraped: {progress['total_scraped']}")

# ── CLI ────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Web scraper with resume support")
    parser.add_argument("--input", required=True, help="File with URLs (one per line)")
    parser.add_argument("--output", default="data/results.csv", help="Output CSV file")
    parser.add_argument("--resume", action="store_true", help="Resume from last checkpoint")
    args = parser.parse_args()

    setup_logging()

    with open(args.input) as f:
        urls = [line.strip() for line in f if line.strip()]

    run_scraper(urls, args.output, resume=args.resume)
```

### Template 2: Async Crawl4AI Scraper

```python
#!/usr/bin/env python3
"""
Async web scraper using Crawl4AI for JavaScript-rendered pages.
Usage: python crawl_scraper.py --input data/urls.txt --output output/pages/ --resume
"""

import asyncio
import json
import logging
import os
import argparse
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, CacheMode

PROGRESS_FILE = "output/crawl_progress.json"

def setup_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            logging.FileHandler("output/crawl.log"),
            logging.StreamHandler(),
        ],
    )

def load_progress():
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE) as f:
            return json.load(f)
    return {"completed": [], "failed": []}

def save_progress(progress):
    tmp = PROGRESS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(progress, f, indent=2)
    os.rename(tmp, PROGRESS_FILE)

async def crawl_urls(urls, output_dir, resume=False):
    progress = load_progress() if resume else {"completed": [], "failed": []}
    completed = set(progress["completed"])
    remaining = [url for url in urls if url not in completed]

    logging.info(f"Crawling {len(remaining)} URLs ({len(completed)} already done)")
    os.makedirs(output_dir, exist_ok=True)

    config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        page_timeout=30000,
    )

    async with AsyncWebCrawler() as crawler:
        for i, url in enumerate(remaining):
            try:
                result = await crawler.arun(url=url, config=config)

                if result.success:
                    # Save markdown content
                    safe_name = url.replace("https://", "").replace("/", "_")[:100]
                    filepath = os.path.join(output_dir, f"{safe_name}.md")
                    with open(filepath, "w") as f:
                        f.write(result.markdown)

                    progress["completed"].append(url)
                    status = "OK"
                else:
                    progress["failed"].append(url)
                    status = "FAIL"

                logging.info(f"[{i+1}/{len(remaining)}] {status} — {url}")

            except Exception as e:
                logging.error(f"[{i+1}/{len(remaining)}] ERROR — {url}: {e}")
                progress["failed"].append(url)

            # Save progress every 5 pages
            if i % 5 == 0:
                save_progress(progress)

            # Rate limit
            await asyncio.sleep(2)

    save_progress(progress)
    logging.info(f"Done. Completed: {len(progress['completed'])} | Failed: {len(progress['failed'])}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="File with URLs")
    parser.add_argument("--output", default="output/pages", help="Output directory")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    setup_logging()

    with open(args.input) as f:
        urls = [line.strip() for line in f if line.strip()]

    asyncio.run(crawl_urls(urls, args.output, args.resume))
```

## Advanced Patterns

### Retry with Exponential Backoff

```python
import time
import random

def fetch_with_retry(url, session, max_retries=3, base_delay=2):
    for attempt in range(max_retries):
        try:
            response = session.get(url, timeout=30)
            response.raise_for_status()
            return response
        except Exception as e:
            if attempt == max_retries - 1:
                raise
            delay = base_delay * (2 ** attempt) + random.uniform(0, 1)
            logging.warning(f"Retry {attempt+1}/{max_retries} for {url} in {delay:.1f}s: {e}")
            time.sleep(delay)
```

### Proxy Rotation

```python
import itertools

proxies = itertools.cycle([
    {"https": "http://proxy1:8080"},
    {"https": "http://proxy2:8080"},
    {"https": "http://proxy3:8080"},
])

def fetch_with_proxy(url, session):
    proxy = next(proxies)
    return session.get(url, proxies=proxy, timeout=30)
```

### User-Agent Rotation

```python
import random

USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
]

def get_headers():
    return {"User-Agent": random.choice(USER_AGENTS)}
```

### CSV Deduplication

```python
import pandas as pd

def deduplicate_csv(input_file, output_file, key_columns):
    """Remove duplicate rows based on key columns."""
    df = pd.read_csv(input_file)
    before = len(df)
    df = df.drop_duplicates(subset=key_columns, keep="first")
    after = len(df)
    df.to_csv(output_file, index=False)
    logging.info(f"Deduplication: {before} → {after} ({before - after} removed)")
```

### Multi-Source Merge

```python
import pandas as pd
import glob

def merge_sources(input_pattern, output_file, dedup_key="email"):
    """Merge multiple CSV sources and deduplicate."""
    files = glob.glob(input_pattern)
    frames = [pd.read_csv(f) for f in files]
    combined = pd.concat(frames, ignore_index=True)

    before = len(combined)
    combined = combined.drop_duplicates(subset=[dedup_key], keep="first")
    after = len(combined)

    combined.to_csv(output_file, index=False)
    logging.info(f"Merged {len(files)} files: {before} records → {after} unique")
```

## Framework-Specific Notes

### BeautifulSoup

```python
from bs4 import BeautifulSoup
import requests

def parse_listing_page(url):
    response = requests.get(url, headers=HEADERS, timeout=30)
    soup = BeautifulSoup(response.text, "html.parser")

    listings = []
    for card in soup.select(".listing-card"):
        listings.append({
            "name": card.select_one("h3").get_text(strip=True),
            "url": card.select_one("a")["href"],
            "description": card.select_one(".description").get_text(strip=True),
        })
    return listings
```

### Playwright (Headless Browser)

```python
from playwright.async_api import async_playwright

async def scrape_with_playwright(url):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.goto(url, wait_until="networkidle")

        # Wait for dynamic content
        await page.wait_for_selector(".results-container", timeout=10000)

        content = await page.content()
        await browser.close()
        return content
```

### Scrapy Spider

```python
import scrapy

class DirectorySpider(scrapy.Spider):
    name = "directory"
    start_urls = ["https://example.com/directory"]

    custom_settings = {
        "DOWNLOAD_DELAY": 2,
        "CONCURRENT_REQUESTS": 1,
        "FEEDS": {"output/results.csv": {"format": "csv"}},
        "JOBDIR": "output/crawl_state",  # Resume support built-in
    }

    def parse(self, response):
        for listing in response.css(".listing"):
            yield {
                "name": listing.css("h3::text").get(),
                "url": listing.css("a::attr(href)").get(),
            }

        # Follow pagination
        next_page = response.css("a.next::attr(href)").get()
        if next_page:
            yield response.follow(next_page, self.parse)
```

## tmux Advanced Usage

### Session Scripting

Automate multi-pane tmux layouts:

```bash
#!/bin/bash
# setup-scraping-workspace.sh

SESSION="scraping"
tmux new-session -d -s $SESSION

# Pane 0: Main scraper
tmux send-keys -t $SESSION "python scraper.py --resume" Enter

# Pane 1: Log watcher (horizontal split)
tmux split-window -h -t $SESSION
tmux send-keys -t $SESSION "tail -f output/scrape.log" Enter

# Pane 2: System monitor (below log watcher)
tmux split-window -v -t $SESSION
tmux send-keys -t $SESSION "watch -n 5 'wc -l output/results.csv'" Enter

# Focus on main pane
tmux select-pane -t $SESSION:0.0

echo "Workspace ready. Attach with: tmux attach -t $SESSION"
```

### tmux Status Monitoring Script

```bash
#!/bin/bash
# check-scrapes.sh — Quick status of all running scrapes

echo "=== Active Scraping Sessions ==="
tmux ls 2>/dev/null || echo "No tmux sessions running."
echo ""

for session in $(tmux ls -F '#{session_name}' 2>/dev/null); do
    echo "--- $session ---"
    tmux capture-pane -t "$session" -p | tail -3
    echo ""
done
```
