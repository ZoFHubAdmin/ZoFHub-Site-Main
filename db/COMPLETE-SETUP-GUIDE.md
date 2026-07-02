# Complete Supabase Setup Guide for 14,000+ Games

## Overview
This guide will help you load all games (14,000+) into Supabase for optimal performance and instant loading.

## Prerequisites
- Supabase project created
- Environment variables configured (.env file with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)

## Step-by-Step Setup

### Step 1: Create Database Schema
**File**: `db/schema.sql`
**Action**: Run in Supabase SQL Editor
```sql
-- Creates the games table with proper indexes and RLS
-- Run this ONCE
```

### Step 2: Load Non-Y8 Games (855 games)
**File**: `db/load-api-games.sql` (auto-generated)
**Action**: Run in Supabase SQL Editor
```sql
-- Loads 855 games from OnlineGames.io, GameDistribution, etc.
-- Safe to re-run (uses ON CONFLICT DO UPDATE)
```

### Step 3: Load Y8 Games (2,410 games)
**Files**: `db/y8-games-01.sql` through `db/y8-games-05.sql`
**Action**: Run each file in order in Supabase SQL Editor
```sql
-- Part 1: db/y8-games-01.sql (games 1-500)
-- Part 2: db/y8-games-02.sql (games 501-1000)
-- Part 3: db/y8-games-03.sql (games 1001-1500)
-- Part 4: db/y8-games-04.sql (games 1501-2000)
-- Part 5: db/y8-games-05.sql (games 2001-2410)
```

### Step 4: Create Community Tables
**File**: `db/community.sql`
**Action**: Run in Supabase SQL Editor
```sql
-- Creates scores and recommendations tables
-- Enables leaderboard functionality
```

### Step 5: Enable Persistent Play Counts (Optional)
**File**: `db/stats.sql`
**Action**: Run in Supabase SQL Editor
```sql
-- Creates game_stats table for persistent play counts
-- Recommended for production
```

### Step 6: Verify Installation
**File**: `db/y8-games-check.sql`
**Action**: Run in Supabase SQL Editor
```sql
-- Should show:
-- total_games: ~3,265 (855 + 2,410)
-- y8_games: ~2,410
-- working_games: ~3,265
```

## Regenerating SQL from JSON

If you update `api/games.json` and need to regenerate the SQL:

```bash
node tools/generate-sql-from-json.mjs
```

This will create:
- `db/load-api-games.sql` - from api/games.json
- `db/load-ai-games.sql` - from ai_gaming_hub_final.json (if it contains games)

## Expected Game Counts After Setup

| Source | Games | File |
|--------|-------|------|
| OnlineGames.io | 855 | api/games.json → load-api-games.sql |
| Y8.com | 2,410 | y8-games-01.sql through 05.sql |
| **Total** | **3,265** | |

## Server Configuration

The server is already configured to:
1. Load games from Supabase every 30 minutes (`CATALOG_REFRESH_MS`)
2. Fall back to bundled JSON if Supabase is unavailable
3. Serve games from memory for instant loading
4. Apply catalog overrides from `data/catalog-overrides.json`

## Performance Notes

- **In-memory catalog**: All games loaded into memory for instant access
- **Pagination**: 1,000 games per page from Supabase (efficient for 14,000+ games)
- **Indexes**: Proper indexes on slug, category, is_working, and last_checked
- **Caching**: 30-minute refresh cycle reduces database load
- **Edge caching**: API responses cached for 60s (browser) / 300s (CDN)

## Troubleshooting

### Games not appearing after SQL load
- Check that `is_working = true` in the games table
- Verify the server has restarted after loading data
- Check server logs for Supabase connection errors

### Slow loading
- Ensure Supabase is in a region close to your server
- Check that indexes are created (run schema.sql again)
- Verify the catalog refresh is working (check logs for "catalog refreshed from Supabase")

### Missing thumbnails
- Check that thumbnail_url is not NULL in the database
- The schema provides a fallback to `/default-placeholder.svg`
- Catalog overrides can set custom thumbnails (see data/catalog-overrides.json)

## Next Steps After Setup

1. Restart your server: `npm run restart`
2. Verify games load on the homepage
3. Test a few game pages to ensure embeds work
4. Check the leaderboard functionality (requires community.sql)
5. Monitor play counts (requires stats.sql)
