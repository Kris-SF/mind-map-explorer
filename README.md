# Mind Map Explorer

Interactive knowledge graph for exploring Moontower content by Kris Abdelmessih across [moontowermeta.com](https://moontowermeta.com), [blog.moontower.ai](https://blog.moontower.ai), and [moontower.substack.com](https://moontower.substack.com) using D3.js force-directed graphs.

**Live demo:** [mind-map-explorer.netlify.app](https://mind-map-explorer.netlify.app)

![screenshot](https://img.shields.io/badge/status-live-brightgreen)

## Features

- Force-directed graph visualization of 500+ articles/threads
- AI-generated summaries, concept extraction, and difficulty levels
- Cross-content connections, topic clusters, and curated learning paths
- Search, filter by difficulty, and explore by concept or cluster
- AI chat to ask questions about the content (powered by Gemini)
- Incremental refresh — a "Refresh Data" button scrapes new articles, enriches them via Gemini, and updates the live data without redeploying

## Architecture

```
Static site (index.html + D3.js)
├── data/*.json              # Pre-computed enriched datasets
├── netlify/functions/
│   ├── data.mjs             # Serves data from Netlify Blobs (or static fallback)
│   ├── refresh.mjs          # Incremental scrape → enrich → save pipeline
│   └── gemini-key.mjs       # Serves API key from env vars
└── scraper/                 # Python scripts for initial bulk scraping + enrichment
```

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Netlify CLI](https://docs.netlify.com/cli/get-started/) (`npm i -g netlify-cli`)
- A [Gemini API key](https://aistudio.google.com/apikey) (for chat and refresh features)

### Local development

```bash
npm install
netlify dev
```

This serves the site locally with function endpoints available.

### Environment variables

Set these in your Netlify dashboard (Site settings > Environment variables):

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key — used by chat and refresh functions |

### Regenerating data from scratch

The `data/` directory ships with pre-computed datasets. To re-scrape and re-enrich:

```bash
cd scraper
pip install -r requirements.txt
export GEMINI_API_KEY=your-key-here

# Scrape raw content
python scrape_moontower.py    # moontowermeta.com
python scrape_blog.py         # blog.moontower.ai
python scrape_substack.py     # moontower.substack.com

# Enrich with AI (summaries, concepts, connections)
python enrich_moontower.py    # moontowermeta.com
python enrich_blog.py         # blog.moontower.ai
python enrich_substack.py     # moontower.substack.com
```

### Deploy

```bash
netlify deploy --prod
```

## License

MIT
