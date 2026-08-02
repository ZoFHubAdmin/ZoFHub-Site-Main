// tools/run-python.mjs — run a Python tool on whatever this machine calls Python.
// Usage (from package.json):  node tools/run-python.mjs tools/build-mood-index.py [args…]
//
// WHY THIS EXISTS
// The seven Python scripts were invoked as a bare `python tools/foo.py`. That
// command does not exist on most of the machines this repo is meant to clone
// onto:
//
//   • Debian/Ubuntu (and therefore most CI images and Docker bases) ship
//     /usr/bin/python3 with NO `python` alias — Debian dropped it deliberately.
//   • macOS removed /usr/bin/python entirely in 12.3; Homebrew installs python3.
//   • Windows has `python`, and also a `python3.exe` stub in WindowsApps that is
//     not Python at all: it exits non-zero and opens the Microsoft Store.
//
// So hardcoding either name breaks a real platform. This probes for an
// interpreter that genuinely answers "Python 3", runs the script through it, and
// forwards the exit code unchanged. When nothing qualifies it says so once, in
// English, instead of a shell's "command not found".

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Ordered by how likely each is to be a REAL Python 3 rather than a stub.
const CANDIDATES = [
  ['python3', []],
  ['python', []],
  ['py', ['-3']],      // the Windows launcher, which is reliable when present
];

/** The first candidate that actually reports Python 3.x, or null. */
export function findPython() {
  for (const [cmd, prefix] of CANDIDATES) {
    let out;
    try {
      out = spawnSync(cmd, [...prefix, '--version'], { encoding: 'utf8', timeout: 15_000 });
    } catch { continue; }
    if (!out || out.error || out.status !== 0) continue;
    // The WindowsApps stub exits 9009/non-zero and prints nothing useful, so the
    // version string is the check that matters — not merely "the file exists".
    const version = `${out.stdout || ''}${out.stderr || ''}`.trim();
    if (/^Python 3\./.test(version)) return { cmd, prefix, version };
  }
  return null;
}

function main(argv) {
  const [script, ...args] = argv;
  if (!script) {
    console.error('usage: node tools/run-python.mjs <script.py> [args…]');
    return 2;
  }

  const scriptPath = resolve(ROOT, script);
  if (!existsSync(scriptPath)) {
    console.error(`[run-python] no such script: ${script}`);
    return 2;
  }

  const py = findPython();
  if (!py) {
    console.error(
      '[run-python] No Python 3 interpreter found (tried python3, python, py -3).\n'
      + '\n'
      + '  These tools are OPTIONAL — nothing the server needs to run depends on them.\n'
      + '  They are catalog/thumbnail maintenance utilities.\n'
      + '\n'
      + '  To use them, install Python 3 and then:\n'
      + '      pip install -r tools/requirements.txt\n',
    );
    return 127;
  }

  const r = spawnSync(py.cmd, [...py.prefix, scriptPath, ...args], { stdio: 'inherit', cwd: ROOT });
  if (r.error) {
    console.error(`[run-python] failed to run ${py.cmd}: ${r.error.message}`);
    return 1;
  }
  return r.status ?? (r.signal ? 1 : 0);
}

// Only act as a CLI when executed directly. Importing this module — which the
// test suite does, to exercise findPython() — must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
