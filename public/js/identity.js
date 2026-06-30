// ZoFHub · identity.js — a persistent, device-local player identity.
//
// Every visitor gets a randomly-generated player name + id the first time they
// load the site, saved to localStorage and reused everywhere a name is needed
// (leaderboard, recommendations). This removes the "type Anonymous + a fake
// score" problem: there is no free-text name to spoof — the name is generated,
// stable per device, and is what the leaderboard de-duplicates on.

const KEY = 'zofhub:player:v1';

const ADJ = ['Swift','Neon','Turbo','Pixel','Cosmic','Shadow','Golden','Mighty','Rapid','Frosty',
             'Blaze','Lunar','Cyber','Hyper','Quantum','Vivid','Storm','Iron','Sonic','Mega',
             'Astro','Rogue','Crimson','Electric','Phantom','Arctic','Solar','Atomic','Wild','Epic'];
const NOUN = ['Falcon','Tiger','Comet','Ninja','Dragon','Pilot','Raptor','Wizard','Racer','Phoenix',
              'Viper','Panda','Yeti','Ghost','Knight','Shark','Wolf','Hawk','Fox','Bolt',
              'Cobra','Orca','Lynx','Puma','Drake','Griffin','Otter','Mantis','Jaguar','Badger'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const genName = () => `${pick(ADJ)}${pick(NOUN)}${Math.floor(1000 + Math.random() * 9000)}`;
function genId() {
  try { return crypto.randomUUID(); }
  catch { return 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
}

let cached = null;

export function getPlayer() {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.id && p.name) { cached = p; return cached; }
    }
  } catch { /* storage blocked -> ephemeral identity */ }
  cached = { id: genId(), name: genName(), created: Date.now() };
  try { localStorage.setItem(KEY, JSON.stringify(cached)); } catch {}
  return cached;
}

export function getPlayerName() { return getPlayer().name; }
export function getPlayerId()   { return getPlayer().id; }
// Names are intentionally auto-generated and NOT user-editable — that is what
// keeps the leaderboard spoof-resistant (no free-text "Anonymous" to abuse).
