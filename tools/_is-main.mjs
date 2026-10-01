// tools/_is-main.mjs — "was this file RUN, or merely imported?"
// ---------------------------------------------------------------------------
// WHY THIS EXISTS. Every tool in this directory used to call main() at the
// top level, unconditionally. An ES module runs its top level the moment
// anything imports it — so `import('./tools/migrate-to-supabase.mjs')` did not
// inspect the migration, it PERFORMED one. That is not hypothetical: it
// happened during development and wrote 12,107 rows to the live catalog. The
// write turned out to be a value-for-value no-op re-import, which was luck
// rather than design.
//
// Anything can trigger that import: a test that wants to assert a tool's
// exports, a type-checker, an IDE's auto-import, a `--watch` reload, a future
// script that reuses one helper out of a tool. None of those intend to mutate
// production, and none of them pass a flag saying so.
//
// So destructive tools now ask this first. Guarding is cheap; the failure mode
// is not.
//
// HOW IT DECIDES. process.argv[1] is the script Node was told to run. Compared
// as a resolved path, because argv[1] arrives in whatever form the caller
// typed — relative, absolute, with or without the extension, and on Windows
// with backslashes and a drive letter whose case is not stable. realpathSync
// also resolves symlinks, so a tool invoked through a bin shim still matches.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when `moduleUrl` is the entry point Node was asked to execute.
 *
 * Call it with `import.meta.url`:
 *
 *     if (isMain(import.meta.url)) main().catch(...)
 *
 * Returns FALSE when it cannot tell. A tool that stays silent when imported is
 * a minor annoyance; one that writes to production because a path comparison
 * was inconclusive is not.
 */
export function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (!entry || !moduleUrl) return false;
  try {
    const self = fileURLToPath(moduleUrl);
    const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
    const a = real(self);
    const b = real(entry);
    // Windows paths are case-insensitive and Node does not normalise the drive
    // letter's case, so `C:\…` and `c:\…` are the same file and must compare equal.
    return process.platform === 'win32'
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  } catch {
    return false;
  }
}

export default isMain;
