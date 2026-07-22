ZoFHub Project Analysis

Based on my analysis of the ZoFHub project located at C:\Users\sumat\Documents\CLAUDECODEPROJECTS\ZoFHub, here is a complete overview of the project and all npm commands available.

## Project Overview

ZoFHub is a single-server web application that combines three main features into one site:
1. Games Hub - 16,000+ free browser games from official/authorized websites and search categories, favorites, Game of the Day, cheat-resistant leaderboard, and community wall
2. Free AI Assistant - Chat + image generation via Pollinations, running directly in the visitor’s browser (keyless, no API key, prompts never pass through the server)
3. Proxy Wall (optional) - An “open the web” mode using GUST + Ultraviolet/Scramjet/Wisp for filtered networks

Built with: Node.js + Express, vanilla HTML/CSS/JS (no framework, no build step), Supabase (Postgres) for catalog/scores/community data.

## NPM Scripts Available

All available npm commands from package.json:

### Server Management

npm start - node --use-system-ca server.js (starts the server)
npm run serve - node --use-system-ca --watch server.js (auto-restart on changes)
npm run kill-port - node tools/kill-port.js && node --use-system-ca server.js (free port + start)
npm run kill-port:alt - node tools/kill-port.js && npm run start:alt (process on port 8800)

### Development & Maintenance

npm run check - node tools/check-js.js (JavaScript syntax check)
npm run dev - node tools/dev-all.js (development utilities)
npm run build - node tools/build-wp.js (build multi-WP version)

### Database & Data Management

npm run upgrade - node --use-system-ca tools/migrate-to-supabase.js (run supabase migrations)
npm run migrate - node --use-system-ca tools/migrate-curated.js (curated migrations)
npm run migrate:curated - node --use-system-ca tools/migrate-curated --dry-run (dry run curated migrations)
npm run restore - node --use-system-ca tools/restore-to-supabase.js (load all sources into supabase)
# run Supabase migrations
npm run migrate:dry - mode -use-system-cta tools/migrate.js --dry-run (dry run curated migrations)
npm run migrate:curated - mode -use-system-cta tools/migrate.js --as-curated (curated migrations)
npm run migrate:all - mode -use-system-cta tools/migrate.js --as-curated --dry-run (dry run curated migrations)
npm run clean-fakes - mode tools/clean-fake-db-hashes.js (clean fake db distribution hashes)

## Catalog & Game Management
npm run add-game - mode -use-system-cta tools/add-game.js (add individual game)
npm run report-games - mode -use-system-cta tools/report-games.js (report games data)
npm run restore-games - mode -use-system-cta tools/restore-games.js (restore games from sources)

## Auditing & Maintenance
npm run audit-index - mode -use-system-cta tools/audit-catalog.js (audit game thumbnails)
npm run audit-license - mode -use-system-cta tools/audit-license.js (audit licensing)
npm run audit-links - mode -use-system-cta tools/audit-links.js (audit link detection)
npm run fix-thumbnails - mode -use-system-cta tools/fix-thumbnails.js (fix thumbnails)
npm run fix-links - mode -use-system-cta tools/fix-links.js (fix link issues)

## Analytics and Utilities
npm run build-index - python tools/build-aood-index.py (build index for AI recommendations)
npm run py-harvest - node tools/harvest-games.py (raw harvester)
npm run py-analyze - node tools/analyze-games.py (analyze games)

## Getting Started
Clone the repository
git clone https://github.com/ZSM1010/ZoFHub-Gaming-AI-Browser-Hub.git
cd clone https://github.com/ZoFHubAdmin/ZoFHub-Site.git
Install dependencies
npm install
# Getting started

1. Clone the repository
git clone https://github.com/ZSM1010/ZoFHub-Gaming-AI-Browser-Hub.git
cd Fomo-Gaming
git clone https://github.com/ZoFHubAdmin/ZoFHub-Site.git
cd Fomo-Site
2. Install dependencies
npm install
3. Configure environment
KEY environment variables in .env:
- SERVER host
- SERVER port
- NODE_ENV - environment (development/production)
- PROXY - proxy settings (local proxy, proxy-only, proxy off)
- SUPABASE_URL - Supabase URL (project URL)
- SUPABASE_SERVICE_ROLE_KEY - Supabase service role key
4. Start the application
npm start
Visit http://localhost:3000

## Configuration Options

KEY environment variables in .env:
- SERVER host
- SERVER port
- NODE_ENV - environment (development/production)
- PROXY - proxy settings (local proxy, proxy-only, proxy off)
- SUPABASE_URL - Supabase URL (project URL)
- SUPABASE_SERVICE_ROLE_KEY - Supabase service role key
- DATABASE_SETUP - set on proxy instance so only runs on proxy instance

The project uses Supabase for persistent data. To set up:

Quick method (loads all game sources):
1. Run load-all.sh
2. Recommended method (loads files in dir) in this order:
   - load-games.sh
   - load-assets.sh
   - load-users.sh
   - load-scores.sh
Numbered load-all: run loaders (run in numeric order)
# visit http://localhost:8080
## Schema.sql (Stored tables)
- Optional: stats.sql + keepalive.sql
- Download load-sql + game loaders (run in numeric order)

## Docker Deployment
docker build -t zofhub
docker run -p 8080:8080 --env-file .env zofhub

## Production Deployment
The project is designed for persistent server platforms (not serverless) due to:
- long jobs that need maintenance tasks
- game state catalog
- multiple endpoints (Whip endpoints)

## Self-Maintaining Features
- link-check (hourly) - Hidden gems and jobs (configured in side_jobs.py)
- job-sync (continuous) - syncs jobs to catalog (side_jobs.py)
- keepalive (daily) - ensures no thread or app freeze
- cleanup (daily) - removes old logs from top 20 recent days
- resample (daily) - rebalances top 20 app records to database parse

## Project Structure
Summary:
- app.py          Main application entry point
- Dockerfile      Docker deployment blueprint
- controller.py   Controller class (Whip endpoints)
# ZoFHub
Main application entry point
render.yml        - Render deployment blueprint
dockerfile        - Container image (node:20-alpine)
api/              - Unified catalog (show/subpage fallback)
cfg/              - Configuration overrides (catalog overrides, etc.)
dbapi/            - Provider / items / DB ingest
lib/              - Shared functions (DB access, cache, etc.)
map/              - Map providers (mapbox, leaflet, etc.)
pub/              - Public pages (front, countries, leaderboard, game)
src/              - JS/TS sources
test/             - Tests
thumbs/           - Thumbnails, audits, tag generators, link checker, etc.

Key features
- Aggregates from official embed sources (GameDistribution, Y8, etc.)
- Fetches data by leaderboard, price, genre, and minutes
- Provides unified catalog with rich metadata
- Supports dynamic filtering, sorting, pagination, and score ceilings
- Optional progressive web app (PWA) collection
- Additional providers - GIST, ultrawide/lowres server proxying
- Optional hub mode - standalone hub (AdSense-only)
- Automated cron jobs handle link checking, cache growth, score pruning, etc.

Monetization
Primary build (SITE_MODE=full) uses proxy-friendly ad networks (MonetizeMore, Adsterra, HilltopAds) instead of AdSense (which bans proxy/sites). Ad configuration is done
through /cfg/ads.yml
The hub build (SITE_MODE=hub) uses standard Google AdSense with ADSENSE_CLIENT variable.
158  Instant games from official embed sources (GameMonetize, GameDistribution, Y8, GameMonobi, etc.)
159  Instant catalog -> Loaded into memory, refreshed from Supabase every 3 minutes
160  Instant chart -> leaderboard: daily, picks, genre-weighted by actual play data
161  Core-accounts -> Visitors and mappings signed proof-of-play with min/max playtime and score ceilings
162  Core-account browser -> Guest (at ultraweblitz/scrape/wisp) for filtered or themed listings
163  Dual-node deployer -> Single codebase SITE_MODE=full (Proxy) or SITE_MODE=hub (AdSense-only)
164  Self-training -> 7 automated cron jobs handle link checking, catalog graph, score pruning, etc.
165
166  ## Monetization
167
168  The proxy build (SITE_MODE=full) uses proxy-friendly ad networks (Monetag, Adsterra, hilltopads) instead of AdSense (which bans proxy/sites). Ad configuration is done
169  entirely via environment variables.
170  PROXY_AD_SCRIPTS -> page-level ad scripts (common-separated for multiple networks)
171  PROXY_BANNER_TAG -> Optional footer display banner (728x90)
172
173  The hub build (SITE_MODE=hub) uses standard Google AdSense with ADSENSE_CLIENT variable.
174
175  This covers all pm commands and provides a comprehensive understanding of the ZoFHub project based on the available documentation and code structure.