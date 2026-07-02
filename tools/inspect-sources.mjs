import fs from 'node:fs';

function inspect(path) {
  console.log('===', path, '===');
  const raw = fs.readFileSync(path, 'utf8').trim();
  let j;
  try { j = JSON.parse(raw); } catch (e) { console.log('parse err:', e.message); return; }
  if (typeof j === 'string') {
    try { j = JSON.parse(j); } catch (e) { console.log('inner parse err:', e.message); return; }
  }
  const arr = Array.isArray(j) ? j : j.games;
  console.log('top-level type:', Array.isArray(j) ? 'array' : 'object');
  console.log('top keys:', Array.isArray(j) ? '(array)' : Object.keys(j).join(','));
  console.log('count:', arr?.length);
  if (arr && arr[0]) console.log('first sample keys:', Object.keys(arr[0]).join(','));
  if (arr && arr[0]) console.log('first sample:', JSON.stringify(arr[0], null, 2).slice(0, 600));
  // host distribution
  const hosts = {};
  for (const g of arr || []) {
    const u = g.embed_url || g.url;
    if (u) {
      try { const url = new URL(u); hosts[url.hostname] = (hosts[url.hostname]||0)+1; } catch {}
    }
  }
  console.log('top hosts:');
  Object.entries(hosts).sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([h,c])=>console.log(`  ${h}: ${c}`));
}

inspect('ai_gaming_hub_final.json');
inspect('data/top_games.json');
inspect('master_games.json');
