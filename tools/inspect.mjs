import fs from 'node:fs';

const raw = fs.readFileSync('api/games.json', 'utf8').trim();
let j = JSON.parse(raw);
if (typeof j === 'string') j = JSON.parse(j);
const games = j.games;

const total = games.length;
let validEmbed = 0;
let httpsEmbed = 0;
let hasThumb = 0;
let noSlug = 0;
let badSlug = 0;
let badUrl = 0;
const hosts = {};
const cats = {};
const missingSlugSample = [];
const badUrlSample = [];
const noThumbSample = [];

for (const g of games) {
  if (!g.slug) noSlug++; else if (!/^[a-z0-9-]+$/i.test(g.slug)) badSlug++;
  if (g.embed_url) {
    validEmbed++;
    if (g.embed_url.startsWith('https://')) httpsEmbed++;
    try {
      const u = new URL(g.embed_url);
      hosts[u.hostname] = (hosts[u.hostname] || 0) + 1;
    } catch { badUrl++; if (badUrlSample.length < 5) badUrlSample.push(g); }
  } else {
    badUrl++;
    if (badUrlSample.length < 5) badUrlSample.push(g);
  }
  if (g.thumbnail) hasThumb++;
  else if (noThumbSample.length < 5) noThumbSample.push(g);
  if (g.category) cats[g.category] = (cats[g.category] || 0) + 1;
  if (!g.slug && missingSlugSample.length < 5) missingSlugSample.push(g);
}

console.log('=== api/games.json ===');
console.log('total games:', total);
console.log('valid embed_url:', validEmbed);
console.log('https embed_url:', httpsEmbed);
console.log('has thumbnail:', hasThumb);
console.log('missing slug:', noSlug);
console.log('bad slug format:', badSlug);
console.log('bad/missing url:', badUrl);
console.log('--- top hosts ---');
Object.entries(hosts).sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([h,c])=>console.log(`  ${h}: ${c}`));
console.log('--- categories ---');
Object.entries(cats).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${k}: ${v}`));
console.log('--- bad url sample ---');
for (const s of badUrlSample) console.log(`  ${s.slug || '<no slug>'} -> ${s.embed_url}`);
console.log('--- no thumb sample ---');
for (const s of noThumbSample) console.log(`  ${s.slug} -> ${s.thumbnail}`);
