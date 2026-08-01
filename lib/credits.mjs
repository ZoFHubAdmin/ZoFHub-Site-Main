// lib/credits.mjs — attribution for every direct dependency, generated from the
// packages actually installed.
//
// WHY GENERATED AND NOT HAND-WRITTEN
// A hand-maintained credits list is wrong the moment a dependency is added,
// removed or upgraded, and nobody notices because nothing breaks. This reads
// node_modules at boot, so the page always matches what is really shipping.
//
// ── THE LICENSE FIELD IN package.json CANNOT BE TRUSTED ────────────────────
// Verified against the installed packages:
//
//   @titaniumnetwork-dev/ultraviolet   package.json: "MIT"   LICENSE: GNU AGPL
//   @mercuryworkshop/scramjet          package.json: "MIT"   LICENSE: GNU AGPL
//   @mercuryworkshop/bare-mux          package.json: (none)  LICENSE: MIT text
//
// Two of the proxy engines this site is built on declare MIT in metadata while
// shipping an AGPL-3.0 licence file. Anyone auditing by `npm ls --json` — which
// is what most licence tooling does — would conclude we have no copyleft
// obligations at all. We have several.
//
// So the LICENSE FILE wins, and where the two disagree the page says so. When
// neither is conclusive we report "see LICENSE file" rather than guessing:
// guessing wrong on a copyleft licence is the expensive direction.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/** Detect the licence from the LICENSE file's text. Order matters: AGPL text
 *  contains the words "GENERAL PUBLIC LICENSE" too, so it must be tested first. */
function licenceFromText(text) {
  const t = text.slice(0, 4000).toUpperCase();
  if (t.includes('AFFERO GENERAL PUBLIC LICENSE')) return 'AGPL-3.0';
  if (t.includes('LESSER GENERAL PUBLIC LICENSE')) return 'LGPL-3.0';
  if (t.includes('GNU GENERAL PUBLIC LICENSE')) return 'GPL-3.0';
  if (t.includes('APACHE LICENSE')) return 'Apache-2.0';
  if (t.includes('MOZILLA PUBLIC LICENSE')) return 'MPL-2.0';
  if (t.includes('BSD')) return 'BSD';
  if (t.includes('ISC LICENSE') || /\bISC\b/.test(t)) return 'ISC';
  // MIT has no title line in many packages — match the operative sentence.
  if (t.includes('PERMISSION IS HEREBY GRANTED, FREE OF CHARGE')) return 'MIT';
  return null;
}

function findLicenceFile(dir) {
  try {
    const f = readdirSync(dir).find(n => /^licen[sc]e(\.|$)/i.test(n));
    return f ? join(dir, f) : null;
  } catch { return null; }
}

function normaliseRepo(repo) {
  if (!repo) return '';
  const url = typeof repo === 'string' ? repo : repo.url || '';
  return url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/\.git$/, '');
}

function authorOf(pkg) {
  const a = pkg.author;
  if (!a) return (Array.isArray(pkg.contributors) && pkg.contributors[0]
    ? (typeof pkg.contributors[0] === 'string' ? pkg.contributors[0] : pkg.contributors[0].name)
    : '') || '';
  if (typeof a === 'string') return a.replace(/\s*<[^>]*>/g, '').replace(/\s*\([^)]*\)/g, '').trim();
  return a.name || '';
}

let CACHE = null;

/** One entry per DIRECT dependency, with the licence resolved from its file. */
export function getCredits() {
  if (CACHE) return CACHE;
  let root;
  try { root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')); }
  catch { return (CACHE = []); }

  const deps = { ...(root.dependencies || {}), ...(root.devDependencies || {}) };
  const devNames = new Set(Object.keys(root.devDependencies || {}));
  const out = [];

  for (const name of Object.keys(deps).sort()) {
    const dir = join(ROOT, 'node_modules', ...name.split('/'));
    let pkg = {};
    try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
    catch { /* not installed (e.g. a dev-only dep on a prod install) */ }

    const declared = typeof pkg.license === 'string' ? pkg.license
      : (pkg.license && pkg.license.type) || '';

    let detected = null;
    const licFile = findLicenceFile(dir);
    if (licFile) {
      try { detected = licenceFromText(readFileSync(licFile, 'utf8')); } catch { /* unreadable */ }
    }

    // The file is authoritative. Where they disagree, report BOTH — an
    // unexplained change from "MIT" to "AGPL-3.0" on a credits page looks like
    // a mistake, and the discrepancy is itself the useful information.
    // Text detection is coarse by design — it identifies the FAMILY (BSD, MIT,
    // AGPL). When the declaration agrees on family but is more specific
    // ("BSD-3-Clause" vs a detected "BSD", "AGPL-3.0-only" vs "AGPL-3.0"), the
    // declaration is the better label and there is no conflict to report.
    const family = (s) => String(s || '').toUpperCase().split('-')[0];
    const agrees = detected && declared && family(declared) === family(detected);
    const licence = agrees
      ? (declared.length >= detected.length ? declared : detected)
      : (detected || declared || 'see LICENSE file');
    // A real conflict is a family disagreement — MIT declared, AGPL shipped.
    const conflict = !!(detected && declared && !agrees);

    out.push({
      name,
      version: pkg.version || (deps[name] || '').replace(/^[^\d]*/, '') || '',
      author: authorOf(pkg),
      repository: normaliseRepo(pkg.repository),
      homepage: pkg.homepage || '',
      licence,
      declaredLicence: declared || null,
      licenceConflict: conflict,
      copyleft: /AGPL|LGPL|GPL|MPL/i.test(licence),
      dev: devNames.has(name),
      installed: !!pkg.version,
    });
  }
  CACHE = out;
  return out;
}

/** Counts for the page intro, so the numbers can never contradict the table. */
export function creditsSummary() {
  const c = getCredits();
  return {
    total: c.length,
    runtime: c.filter(x => !x.dev).length,
    dev: c.filter(x => x.dev).length,
    copyleft: c.filter(x => x.copyleft).length,
    conflicts: c.filter(x => x.licenceConflict).length,
  };
}

export default { getCredits, creditsSummary };
