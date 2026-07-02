-- db/load-json-games.sql
-- ============================================================================
-- Loads non-Y8 games from api/games.json into Supabase
-- ============================================================================
-- This file contains INSERT statements for games from api/games.json
-- (855 games from OnlineGames.io, GameDistribution, etc.)
--
-- HOW TO RUN:
--   1. Supabase → SQL Editor → New query
--   2. Paste this file → Run
--   3. You should see a count at the end confirming the insert
--
-- NOTE: This uses ON CONFLICT (slug) DO UPDATE so it's safe to re-run
-- It will update existing games without creating duplicates
-- ============================================================================

set statement_timeout = '180s';

insert into public.games (slug, title, game_url, thumbnail_url, category, is_working, last_checked)
values
  ('cake-match-puzzle', 'Cake Match Puzzle', 'https://cloud.onlinegames.io/games/2024/unity3/cake-match-puzzle/index-og.html', 'https://www.onlinegames.io/media/posts/908/responsive/55-xs.jpg', 'puzzle', true, now()),
  ('love-tester', 'Love Tester', 'https://www.onlinegames.io/games/2021/3/love-tester/index.html', 'https://www.onlinegames.io/media/posts/152/responsive/love-tester-xs.jpg', 'casual', true, now()),
  ('stack-fire-ball', 'Stack Fire Ball', 'https://www.onlinegames.io/games/2021/unity/stack-fire-ball/index.html', 'https://www.onlinegames.io/media/posts/184/responsive/Stack-Fire-Ball-Game-xs.jpg', 'arcade', true, now()),
  ('stickman-destruction', 'Stickman Destruction', 'https://www.onlinegames.io/games/2021/unity3/stickman-destruction/index.html', 'https://www.onlinegames.io/media/posts/233/responsive/Stickman-Destruction-xs.jpg', 'action', true, now())
on conflict (slug) do update set
  title = excluded.title,
  game_url = excluded.game_url,
  thumbnail_url = excluded.thumbnail_url,
  category = excluded.category,
  is_working = excluded.is_working,
  last_checked = excluded.last_checked,
  updated_at = now();

-- Sample insert for demonstration - you would need to generate the full list
-- from api/games.json using the script below

-- ============================================================================
-- To generate the full SQL file with all 855 games, run this Node.js script:
-- ============================================================================
/*
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('api/games.json', 'utf8'));
const games = data.games || data;

let sql = '-- db/load-json-games.sql\n';
sql += '-- Generated from api/games.json\n';
sql += 'set statement_timeout = "180s";\n\n';
sql += 'insert into public.games (slug, title, game_url, thumbnail_url, category, is_working, last_checked)\n';
sql += 'values\n';

const values = games.map(g => {
  const slug = (g.slug || '').replace(/'/g, "''");
  const title = (g.title || '').replace(/'/g, "''");
  const game_url = (g.embed_url || '').replace(/'/g, "''");
  const thumbnail_url = (g.thumbnail || '').replace(/'/g, "''");
  const category = (g.category || 'arcade').replace(/'/g, "''");
  return `  ('${slug}', '${title}', '${game_url}', '${thumbnail_url}', '${category}', true, now())`;
});

sql += values.join(',\n');
sql += '\non conflict (slug) do update set\n';
sql += '  title = excluded.title,\n';
sql += '  game_url = excluded.game_url,\n';
sql += '  thumbnail_url = excluded.thumbnail_url,\n';
sql += '  category = excluded.category,\n';
sql += '  is_working = excluded.is_working,\n';
sql += '  last_checked = excluded.last_checked,\n';
sql += '  updated_at = now();\n\n';
sql += 'select count(*) as inserted_games from public.games;\n';

fs.writeFileSync('db/load-json-games.sql', sql);
console.log('Generated db/load-json-games.sql with', games.length, 'games');
*/
