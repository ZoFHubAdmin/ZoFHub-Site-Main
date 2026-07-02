// tools/verify-games.mjs
// Game verification script - checks game URLs and identifies broken games
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Game sources to verify
const GAME_SOURCES = [
  { file: 'api/games.json', name: 'API Games' },
  { file: 'somethingrandom.json', name: 'Famobi Games' },
  { file: 'master_games.json', name: 'GameMonetize Games' },
  { file: 'everygame.json', name: 'OnlineGames.io Games' },
  { file: 'y8-games.json', name: 'Y8 Games' },
  { file: 'ai_gaming_hub_final.json', name: 'AI Gaming Hub' }
];

function isValidUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeGame(game) {
  const title = game.title || game.name || '';
  if (!title) return null;
  
  const game_url = game.embed_url || game.embedUrl || game.embed || game.link || game.game_url || game.url || '';
  if (!game_url) return null;
  
  const thumbnail_url = game.thumbnail || game.thumbnail_url || game.thumbnailUrl || game.image || game.imageUrl || '';
  const category = (game.category || game.type || game.genre || 'arcade').toString().toLowerCase();
  const slug = game.slug || generateSlug(title);
  
  return { slug, title, game_url, thumbnail_url, category };
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

function loadJsonFile(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    
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
    
    return games.map(normalizeGame).filter(g => g !== null);
  } catch (error) {
    console.error(`Error loading ${filePath}:`, error.message);
    return [];
  }
}

function verifyGameUrl(url) {
  // Basic URL validation
  if (!isValidUrl(url)) {
    return { valid: false, reason: 'Invalid URL format' };
  }
  
  // Check for known broken patterns
  const brokenPatterns = [
    'example.com',
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    'test',
    'placeholder'
  ];
  
  for (const pattern of brokenPatterns) {
    if (url.toLowerCase().includes(pattern)) {
      return { valid: false, reason: `Contains broken pattern: ${pattern}` };
    }
  }
  
  // Check for empty URLs
  if (url.trim() === '' || url === 'about:blank') {
    return { valid: false, reason: 'Empty URL' };
  }
  
  // Check for missing protocol
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { valid: false, reason: 'Missing protocol' };
  }
  
  return { valid: true };
}

function verifyGames() {
  console.log('=== Game Verification Report ===\n');
  
  let totalGames = 0;
  let validGames = 0;
  let brokenGames = [];
  
  for (const source of GAME_SOURCES) {
    const filePath = join(ROOT, source.file);
    
    if (!existsSync(filePath)) {
      console.log(`⚠ Skipping ${source.name} - file not found: ${source.file}`);
      continue;
    }
    
    console.log(`\n📁 Verifying ${source.name} (${source.file})...`);
    
    const games = loadJsonFile(filePath);
    totalGames += games.length;
    
    let sourceValid = 0;
    let sourceBroken = [];
    
    for (const game of games) {
      const verification = verifyGameUrl(game.game_url);
      
      if (verification.valid) {
        sourceValid++;
        validGames++;
      } else {
        sourceBroken.push({
          slug: game.slug,
          title: game.title,
          url: game.game_url,
          reason: verification.reason
        });
      }
    }
    
    console.log(`   Total: ${games.length} | Valid: ${sourceValid} | Broken: ${sourceBroken.length}`);
    
    if (sourceBroken.length > 0) {
      console.log(`   ⚠ Found ${sourceBroken.length} potentially broken games`);
      brokenGames.push({ source: source.name, games: sourceBroken });
    }
  }
  
  console.log('\n=== Summary ===');
  console.log(`Total games: ${totalGames}`);
  console.log(`Valid games: ${validGames}`);
  console.log(`Broken games: ${totalGames - validGames}`);
  
  if (brokenGames.length > 0) {
    console.log('\n=== Broken Games Details ===');
    for (const source of brokenGames) {
      console.log(`\n${source.source}:`);
      for (const game of source.games.slice(0, 10)) { // Show first 10
        console.log(`  - ${game.title} (${game.slug}): ${game.reason}`);
        console.log(`    URL: ${game.url}`);
      }
      if (source.games.length > 10) {
        console.log(`  ... and ${source.games.length - 10} more`);
      }
    }
    
    // Save broken games report
    const reportPath = join(ROOT, 'broken-games-report.json');
    writeFileSync(reportPath, JSON.stringify(brokenGames, null, 2));
    console.log(`\n📄 Full report saved to: broken-games-report.json`);
  } else {
    console.log('\n✅ All games passed basic URL validation!');
  }
  
  return { totalGames, validGames, brokenGames };
}

// Run verification
verifyGames();
