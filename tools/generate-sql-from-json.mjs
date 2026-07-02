// tools/generate-sql-from-json.mjs
// Generates SQL INSERT statements from JSON game files for Supabase
// Handles multiple JSON structures with different field names
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function escapeSql(str) {
  if (!str) return '';
  return String(str).replace(/'/g, "''");
}

function generateSlug(title) {
  if (!title) return '';
  return String(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeGame(game) {
  // Handle different JSON structures
  const title = game.title || game.name || '';
  if (!title) return null;
  
  // Extract game URL from various field names
  const game_url = game.embed_url || game.embedUrl || game.embed || game.link || game.game_url || game.url || '';
  if (!game_url) return null;
  
  // Extract thumbnail from various field names
  const thumbnail_url = game.thumbnail || game.thumbnail_url || game.thumbnailUrl || game.image || game.imageUrl || '';
  
  // Extract category from various field names
  const category = (game.category || game.type || game.genre || 'arcade').toString().toLowerCase();
  
  // Generate slug if not present
  const slug = game.slug || generateSlug(title);
  
  return { slug, title, game_url, thumbnail_url, category };
}

function generateSqlFromJson(jsonPath, tableName = 'public.games') {
  const raw = readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw);
  
  // Handle different JSON structures
  let games = [];
  if (Array.isArray(data)) {
    games = data;
  } else if (data.games && Array.isArray(data.games)) {
    games = data.games;
  } else if (data.gamesFlat && Array.isArray(data.gamesFlat)) {
    games = data.gamesFlat;
  } else if (data._meta && data.gamesFlat) {
    games = data.gamesFlat;
  }
  
  // Normalize games and filter out invalid ones
  const normalizedGames = games.map(normalizeGame).filter(g => g !== null);
  
  let sql = `-- Generated from ${jsonPath}\n`;
  sql += `-- ${normalizedGames.length} games (from ${games.length} total entries)\n`;
  sql += `set statement_timeout = '600s';\n\n`; // Increased timeout for very large datasets
  
  sql += `insert into ${tableName} (slug, title, game_url, thumbnail_url, category, is_working, last_checked)\n`;
  sql += `values\n`;
  
  const values = normalizedGames.map(g => {
    const slug = escapeSql(g.slug);
    const title = escapeSql(g.title);
    const game_url = escapeSql(g.game_url);
    const thumbnail_url = escapeSql(g.thumbnail_url);
    const category = escapeSql(g.category);
    return `  ('${slug}', '${title}', '${game_url}', '${thumbnail_url}', '${category}', true, now())`;
  });
  
  // Split into batches of 1000 to avoid SQL size limits
  const batchSize = 1000;
  const batches = [];
  for (let i = 0; i < values.length; i += batchSize) {
    batches.push(values.slice(i, i + batchSize));
  }
  
  let batchSql = '';
  batches.forEach((batch, index) => {
    batchSql += `-- Batch ${index + 1} of ${batches.length}\n`;
    batchSql += `insert into ${tableName} (slug, title, game_url, thumbnail_url, category, is_working, last_checked)\n`;
    batchSql += `values\n`;
    batchSql += batch.join(',\n');
    batchSql += `\non conflict (slug) do update set\n`;
    batchSql += `  title = excluded.title,\n`;
    batchSql += `  game_url = excluded.game_url,\n`;
    batchSql += `  thumbnail_url = excluded.thumbnail_url,\n`;
    batchSql += `  category = excluded.category,\n`;
    batchSql += `  is_working = excluded.is_working,\n`;
    batchSql += `  last_checked = excluded.last_checked,\n`;
    batchSql += `  updated_at = now();\n\n`;
  });
  
  batchSql += `select count(*) as total_games from ${tableName};\n`;
  
  return batchSql;
}

// Generate SQL for api/games.json
const apiGamesPath = join(ROOT, 'api', 'games.json');
const apiGamesSql = generateSqlFromJson(apiGamesPath);
writeFileSync(join(ROOT, 'db', 'load-api-games.sql'), apiGamesSql);
console.log(`✓ Generated db/load-api-games.sql from api/games.json`);

// Generate SQL for ai_gaming_hub_final.json
const aiGamesPath = join(ROOT, 'ai_gaming_hub_final.json');
try {
  const aiGamesSql = generateSqlFromJson(aiGamesPath);
  writeFileSync(join(ROOT, 'db', 'load-ai-games.sql'), aiGamesSql);
  console.log(`✓ Generated db/load-ai-games.sql from ai_gaming_hub_final.json`);
} catch (e) {
  console.log(`⚠ Skipped ai_gaming_hub_final.json (may not be a game list):`, e.message);
}

// Generate SQL for all root-level game JSON files
const rootGameFiles = ['somethingrandom.json', 'master_games.json', 'everygame.json', 'y8-games.json'];
for (const file of rootGameFiles) {
  try {
    const filePath = join(ROOT, file);
    const sql = generateSqlFromJson(filePath);
    const outputName = `load-${file.replace('.json', '')}.sql`;
    writeFileSync(join(ROOT, 'db', outputName), sql);
    console.log(`✓ Generated db/${outputName} from ${file}`);
  } catch (e) {
    console.log(`⚠ Skipped ${file}:`, e.message);
  }
}

// Check for additional JSON files in data/ directory
const dataDir = join(ROOT, 'data');
try {
  const files = readdirSync(dataDir).filter(f => f.endsWith('.json') && f !== 'catalog-overrides.json');
  for (const file of files) {
    try {
      const filePath = join(dataDir, file);
      const sql = generateSqlFromJson(filePath);
      const outputName = `load-${file.replace('.json', '')}.sql`;
      writeFileSync(join(ROOT, 'db', outputName), sql);
      console.log(`✓ Generated db/${outputName} from data/${file}`);
    } catch (e) {
      console.log(`⚠ Skipped data/${file}:`, e.message);
    }
  }
} catch (e) {
  console.log(`⚠ No additional JSON files in data/ directory`);
}

console.log('\n=== COMPLETE SETUP SEQUENCE ===');
console.log('1. Run db/schema.sql in Supabase (creates tables)');
console.log('2. Run db/load-api-games.sql in Supabase (loads games from api/games.json)');
console.log('3. Run db/load-ai-games.sql in Supabase (loads games from ai_gaming_hub_final.json)');
console.log('4. Run db/load-somethingrandom.sql in Supabase (loads Famobi games)');
console.log('5. Run db/load-master_games.sql in Supabase (loads GameMonetize games)');
console.log('6. Run db/load-everygame.sql in Supabase (loads OnlineGames.io games)');
console.log('7. Run db/load-y8-games.sql in Supabase (loads 2,415 Y8 games)');
console.log('8. Run db/community.sql (creates scores/recommendations tables)');
console.log('9. Run db/stats.sql (optional, for persistent play counts)');
console.log('10. Run db/y8-games-check.sql to verify totals');
console.log('\nExpected total: 14,000+ games from all sources');
