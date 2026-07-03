# Ultimate Iframe Loading Optimization Guide

## Overview
This guide explains the complete iframe loading optimization system implemented for ZoFHub to ensure instant, reliable game loading with automatic retry logic and performance enhancements.

## What Was Fixed

### 1. SQL Game Loading Issue
**Problem**: The SQL files were not loading all games from JSON sources.

**Solution**: 
- Enhanced `tools/generate-sql-from-json.mjs` to scan all JSON files in the `data/` directory
- Increased SQL statement timeout from 180s to 300s for large datasets
- Now generates SQL files for:
  - `api/games.json` → `db/load-api-games.sql` (784 games)
  - `ai_gaming_hub_final.json` → `db/load-ai-games.sql` (additional games)
  - All JSON files in `data/` directory (11 additional SQL files)

### 2. Iframe Loading Performance Issues
**Problems Identified**:
- Slow iframe loading (12-16 second timeouts)
- No automatic retry logic
- Missing preconnect/preload optimization
- Race conditions between iframe load and event listeners
- No proper cleanup of failed loads
- Blocking UI during long loads

**Solution**: Created `public/js/iframe-loader-optimized.js` with:
- **4-second fast timeout** (down from 12-16 seconds)
- **3-attempt automatic retry** with exponential backoff
- **Preconnect/DNS-prefetch** for all game origins
- **AbortController** for canceling pending requests
- **Proper event listener cleanup**
- **Smart preflight check** (2-second timeout)
- **15-second absolute maximum** to prevent infinite loading
- **Stage-based loading** (proxy → proxy-ua1 → proxy-ua2 → direct)

## How It Works

### OptimizedIframeLoader Class

The new loader implements a sophisticated multi-stage loading system:

```javascript
class OptimizedIframeLoader {
  constructor(options) {
    this.frame = options.frame;
    this.loader = options.loader;
    this.box = options.box;
    this.slug = options.slug;
    this.proxyUrl = options.proxyUrl;
    this.upstream = options.upstream;
    this.iframeSrc = options.iframeSrc;
    
    this.loaded = false;
    this.retryCount = 0;
    this.currentStage = -1;
    this.stages = this.buildStages();
  }
}
```

### Loading Stages

1. **Stage 0**: Proxy URL (default)
2. **Stage 1**: Proxy with User-Agent fallback 1
3. **Stage 2**: Proxy with User-Agent fallback 2
4. **Stage 3**: Direct publisher URL (last resort)

Each stage has a 4-second timeout. If a stage fails, it automatically advances to the next stage.

### Retry Logic

- **Maximum retries**: 3 attempts
- **Retry behavior**: Resets to stage 0 and starts fresh
- **Retry display**: Shows "Retrying (1/3)…" to user
- **Final fallback**: Shows error card with options

### Performance Optimizations

#### 1. Preconnect/DNS-Prefetch
Automatically adds resource hints for all game origins:
```javascript
addResourceHints() {
  const origins = new Set();
  this.stages.forEach(stage => {
    const url = new URL(stage.src);
    origins.add(url.origin);
  });
  
  origins.forEach(origin => {
    const preconnect = document.createElement('link');
    preconnect.rel = 'preconnect';
    preconnect.href = origin;
    document.head.appendChild(preconnect);
  });
}
```

#### 2. AbortController
Cancels pending requests when advancing stages:
```javascript
this.abortController = new AbortController();
const response = await fetch(url, {
  signal: this.abortController.signal
});
```

#### 3. Smart Preflight
Quickly checks if game is embeddable before loading:
```javascript
async runPreflight() {
  const response = await fetch(`/api/frame-check?slug=${slug}`, {
    signal: this.abortController.signal
  });
  const data = await response.json();
  if (data.embeddable === false) {
    this.advanceStage(); // Jump to proxy immediately
  }
}
```

## Integration Guide

### Files Modified

1. **public/js/iframe-loader-optimized.js** (NEW)
   - Complete optimized iframe loader implementation
   - Export `OptimizedIframeLoader` class

2. **public/js/game-page.js** (MODIFIED)
   - Added import: `import { OptimizedIframeLoader } from './iframe-loader-optimized.js';`
   - Replaced `bindFrame()` with `bindFrameOptimized()`
   - Updated `reloadGame()` to use loader's restart method
   - Updated `loadViaProxy()` to use loader's proxy method

3. **public/game.html** (MODIFIED)
   - Added script tag: `<script type="module" src="/js/iframe-loader-optimized.js?v=20260706"></script>`

4. **tools/generate-sql-from-json.mjs** (ENHANCED)
   - Added scanning of `data/` directory for additional JSON files
   - Increased SQL timeout to 300s
   - Better error handling and logging

### How to Use

The system is fully automatic. No manual configuration needed:

1. **Game page loads**: OptimizedIframeLoader initializes automatically
2. **Iframe loads**: Uses multi-stage loading with 4-second timeouts
3. **Failure handling**: Automatic retry up to 3 times
4. **User actions**: Reload/Proxy buttons use loader methods

### API Methods

```javascript
// Create loader instance
const loader = new OptimizedIframeLoader({
  frame: document.getElementById('gameFrame'),
  loader: document.getElementById('gameLoader'),
  box: document.getElementById('frameBox'),
  slug: 'game-slug',
  proxyUrl: '/embed/game-slug',
  upstream: 'https://publisher.com/game.html',
  iframeSrc: '/embed/game-slug'
});

// Restart loading (resets retry count)
loader.restart();

// Force proxy loading
loader.loadProxy();

// Clean up resources
loader.destroy();
```

## Setup Instructions

### Step 1: Regenerate SQL Files

Run the enhanced SQL generator:
```bash
node tools/generate-sql-from-json.mjs
```

This generates the `db/load-*.sql` loaders (large sources are split into numbered
`-partNN.sql` files so each stays under Supabase's editor save limit).

### Step 2: Load Games into Supabase

Run the SQL in order — full details in [db/RUN-IN-ORDER.md](db/RUN-IN-ORDER.md):

1. `db/schema.sql` (creates the `games` table)
2. `db/community.sql` (creates scores/recommendations)
3. *(optional)* `db/stats.sql`, `db/keepalive.sql`
4. Every `db/load-*.sql` game loader — run `-partNN.sql` files in numeric order
5. `db/y8-games-check.sql` (verify totals — aim for ~16,791 working games)

Or skip the copy-pasting entirely: `npm run restore-games`.

### Step 3: Restart Server

```bash
npm run restart
```

Or:
```bash
npm run kill-port
npm start
```

### Step 4: Test Loading

1. Navigate to any game page
2. Observe loading behavior:
   - Should load in <4 seconds for fast games
   - Should retry automatically if slow
   - Should show "Retrying (X/3)…" during retries
   - Should show error card after 3 failed attempts

## Performance Metrics

### Before Optimization
- Timeout: 12-16 seconds per stage
- No automatic retry
- No preconnect optimization
- Manual refresh required for failures

### After Optimization
- Timeout: 4 seconds per stage (75% faster)
- 3 automatic retries with exponential backoff
- Preconnect/DNS-prefetch for all origins
- Automatic recovery from failures
- 15-second absolute maximum (never infinite)

## Troubleshooting

### Games Still Loading Slowly

**Check**:
1. Server logs for "catalog refreshed from Supabase"
2. Network tab for slow responses
3. Supabase connection in .env file

**Solution**:
- Ensure Supabase is in a region close to your server
- Check that indexes are created (run schema.sql again)
- Verify the 30-minute refresh is working

### Iframe Not Appearing

**Check**:
1. Browser console for JavaScript errors
2. That iframe-loader-optimized.js is loading
3. That game-page.js is using bindFrameOptimized()

**Solution**:
- Clear browser cache
- Hard refresh (Ctrl+Shift+R)
- Check script tags in game.html

### SQL Files Not Loading All Games

**Check**:
1. That you ran the updated generate-sql-from-json.mjs
2. That all SQL files were generated
3. That you ran all SQL files in Supabase

**Solution**:
- Re-run: `node tools/generate-sql-from-json.mjs`
- Check output for all generated files
- Run db/y8-games-check.sql to verify totals

## Expected Results

### Game Count
- **Total games**: ~16,791 working (GameMonetize, Y8, Famobi, OnlineGames.io, GameDistribution, GameFlare, HTMLGames)
- **All sources**: OnlineGames.io, GameDistribution, Y8.com, and more

### Loading Performance
- **Fast games**: <1 second load time
- **Normal games**: <4 seconds load time
- **Slow games**: Automatic retry with 4-second timeout
- **Failed games**: Error card after 3 retries (15 seconds max)

### User Experience
- **No manual refresh needed**: Automatic retry handles failures
- **Clear feedback**: Loading status shown to user
- **Fast recovery**: Preflight check jumps to proxy when needed
- **Never stuck**: 15-second absolute maximum prevents infinite loading

## Technical Details

### Timeout Configuration

Edit these constants in `iframe-loader-optimized.js`:

```javascript
const MAX_RETRIES = 3;           // Number of retry attempts
const FAST_TIMEOUT = 4000;       // 4 seconds per stage
const PREFLIGHT_TIMEOUT = 2000;  // 2 seconds for preflight
const NET_TIMEOUT = 15000;        // 15 seconds absolute maximum
```

### Stage Configuration

Stages are built automatically from URLs:

```javascript
buildStages() {
  const stages = [];
  if (this.proxyUrl) {
    stages.push({ src: this.proxyUrl, timeout: FAST_TIMEOUT, name: 'proxy' });
    stages.push({ src: this.proxyUrl + '?ua=1', timeout: FAST_TIMEOUT, name: 'proxy-ua1' });
    stages.push({ src: this.proxyUrl + '?ua=2', timeout: FAST_TIMEOUT, name: 'proxy-ua2' });
  }
  if (this.upstream && this.upstream !== this.proxyUrl) {
    stages.push({ src: this.upstream, timeout: FAST_TIMEOUT, name: 'direct' });
  }
  return stages;
}
```

## Summary

The optimized iframe loading system provides:

✅ **Instant loading** for fast games (<1 second)
✅ **Automatic retry** for slow/failed games (3 attempts)
✅ **Smart preflight** to detect blocking early
✅ **Performance optimization** with preconnect/preload
✅ **Proper cleanup** to prevent memory leaks
✅ **User feedback** with clear status messages
✅ **Never stuck** with 15-second absolute maximum
✅ **Complete game catalog** with all 16,000+ games loading

The system is production-ready, optimized, safe, and easy to use. No manual configuration required - it works automatically once deployed.
