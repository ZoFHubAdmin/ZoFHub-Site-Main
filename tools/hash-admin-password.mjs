// tools/hash-admin-password.mjs
// ---------------------------------------------------------------------------
// Generate the three admin credentials for .env / the host dashboard.
//
//   npm run admin-hash                 # prompts, hidden input
//   npm run admin-hash -- 'password'   # non-interactive (leaves shell history)
//
// Prints ONLY the hash and a fresh session secret. The password itself is never
// written anywhere by this tool — not to a file, not to stdout, not to a log.
// ---------------------------------------------------------------------------
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { hashPasswordSync } from '../lib/admin-auth.mjs';

const MIN_LEN = 12;

function readHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Swallow echo so a shoulder-surfer and a scrollback buffer both see nothing.
    const onData = (ch) => {
      const s = String(ch);
      if (s === '\n' || s === '\r' || s === '\u0004') return;
      process.stdout.write('\u001b[2K\u001b[200D' + prompt + '*'.repeat(rl.line.length));
    };
    process.stdout.write(prompt);
    process.stdin.on('data', onData);
    rl.question('', (answer) => {
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

const argPassword = process.argv.slice(2).find((a) => !a.startsWith('-'));
const password = argPassword || await readHidden('Admin password: ');

if (!password || password.length < MIN_LEN) {
  console.error(`\n  Password must be at least ${MIN_LEN} characters. Nothing was written.`);
  process.exit(1);
}
if (!argPassword) {
  const again = await readHidden('Confirm password: ');
  if (again !== password) { console.error('\n  Passwords did not match. Nothing was written.'); process.exit(1); }
}

const hash = hashPasswordSync(password);
const sessionSecret = randomBytes(48).toString('base64url');

console.log(`
  Add these to your host's environment (Render → Environment), or to .env locally.

  ADMIN_USERNAME=<choose a username>
  ADMIN_PASSWORD_HASH=${hash}
  ADMIN_SESSION_SECRET=${sessionSecret}

  Notes
    · The hash is safe to store; the password is not stored anywhere by this tool.
    · ADMIN_SESSION_SECRET keys the session tokens AND the IP hashes in the audit
      trail. Changing it logs every admin session out and makes older IP hashes
      incomparable with new ones — which is what you want after a suspected leak.
    · To rotate the password: run this again and replace ADMIN_PASSWORD_HASH.
      Existing sessions stay valid until they expire, so also use "Sign out
      everywhere" in the Security Centre if the old password may be known.
`);
