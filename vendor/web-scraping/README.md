# Web Scraping Skill for Claude Code

A Claude Code skill that teaches AI agents best practices for web scraping — session management with tmux, resume-friendly architecture, parallel pipelines, rate limiting, and Crawl4AI integration.

## What This Skill Does

When installed, this skill gives Claude Code (and other compatible AI agents) the knowledge to:

- **Protect long-running scrapes** with tmux sessions
- **Build resume-friendly scrapers** with checkpointing and atomic writes
- **Run parallel pipelines** — scrape, enrich, validate, export simultaneously
- **Use Crawl4AI** for AI-powered data extraction from JS-rendered pages
- **Handle rate limits** with configurable delays and retry logic
- **Manage email enrichment waterfalls** with multi-phase execution
- **Monitor background jobs** without interrupting running processes

## Installation

### Option 1: Project-Level (Recommended)

Add to any project so the skill is available when working in that repo:

```bash
# From your project root
mkdir -p .claude/skills
cd .claude/skills
git clone https://github.com/bcharleson/webscraping-skill.git web-scraping
```

Your agent now has web scraping best practices whenever it works in this project.

### Option 2: Personal (All Projects)

Install globally so the skill is available across all your projects:

```bash
cd ~/.claude/skills
git clone https://github.com/bcharleson/webscraping-skill.git web-scraping
```

### Option 3: Copy the SKILL.md

If you prefer a minimal setup, just copy `SKILL.md` to:

```
.claude/skills/web-scraping/SKILL.md
```

## Usage

Once installed, the skill activates automatically when you ask Claude Code to:

- Build or run a web scraper
- Set up a data extraction pipeline
- Run a long-running script
- Do lead generation or contact enrichment

You can also invoke it directly:

```
/web-scraping
```

### Example Prompts

```
"Scrape all listings from this directory and save to CSV.
 Use tmux since this will take a few hours."

"Build a Crawl4AI scraper for these 500 URLs.
 Include resume support and run it in tmux."

"Set up a lead generation pipeline: scrape, enrich emails,
 validate, and export. Run each stage in parallel."

"Check on the scraping job I started earlier."
```

## What's Inside

```
webscraping-skill/
├── SKILL.md          # Main skill — tmux patterns, scraping architecture,
│                     # agent guidelines, Crawl4AI integration, quick reference
├── REFERENCE.md      # Detailed reference — Python templates, advanced patterns,
│                     # Scrapy/Playwright/BeautifulSoup examples
├── README.md         # This file
└── LICENSE           # MIT License
```

## Key Patterns Covered

### tmux Session Management

```bash
# Standard scraping workflow
tmux new -s my-scrape
python scraper.py --resume
# Ctrl+B, D to detach

# Agent pattern (detached launch)
tmux new -d -s my-scrape 'python scraper.py --resume'
tmux capture-pane -t my-scrape -p | tail -10  # Check status
```

### Parallel Pipeline

```bash
tmux new -d -s scrape   'python scrape.py --resume'
tmux new -d -s enrich   'python enrich.py --watch-input data/raw.csv'
tmux new -d -s validate 'python validate.py --watch-input data/enriched.csv'
tmux ls  # Monitor all stages
```

### Resume-Friendly Architecture

```python
# Atomic checkpoint pattern
progress = load_progress()  # Resume from last save
for i, url in enumerate(urls[progress["last_index"]:]):
    result = scrape(url)
    save_progress({"last_index": i, "completed": progress["completed"] + [url]})
```

### Crawl4AI Integration

```python
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
async with AsyncWebCrawler() as crawler:
    result = await crawler.arun(url=url, config=config)
    if result.success:
        process(result.markdown)
```

## Compatibility

- **Claude Code** (primary target)
- **Cursor** (via Agent Skills standard)
- **VS Code Copilot** (via Agent Skills standard)
- Any tool supporting the [Agent Skills](https://agentskills.io) specification

## Full Guide

For a comprehensive walkthrough with real-world examples, see the full guide:

**[tmux for Web Scraping — The Essential Guide](https://topoffunnel.com/resources/tmux-web-scraping)**

## License

MIT License — use freely in personal and commercial projects.

## Author

Built by [Top of Funnel](https://topoffunnel.com) — AI-powered growth engineering for B2B companies.
