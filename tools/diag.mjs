import { readFileSync } from 'node:fs';
const raw = readFileSync('master_games.json', 'utf8');
let inStr = false, esc = false, opens = 0, closes = 0;
const positions = [];
let depth = 0;
for (let i = 0; i < raw.length; i++) {
  const c = raw[i];
  if (esc) { esc = false; continue; }
  if (inStr) {
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = false;
    continue;
  }
  if (c === '"') { inStr = true; continue; }
  if (c === '[') { opens++; depth++; }
  else if (c === ']') { closes++; depth--; if (depth === 0) positions.push(i); }
}
console.log('total [ outside strings:', opens);
console.log('total ] outside strings:', closes);
console.log('depth-0 close positions count:', positions.length);
positions.slice(0, 6).forEach(p => {
  const line = raw.slice(0, p + 1).split('\n').length;
  console.log(' close at line', line, 'pos', p);
});
positions.slice(-3).forEach(p => {
  const line = raw.slice(0, p + 1).split('\n').length;
  console.log(' close at line', line, 'pos', p);
});
