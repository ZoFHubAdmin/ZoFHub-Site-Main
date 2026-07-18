// tools/kill-port.mjs — cross-platform "free this TCP port" helper.
//
//   node tools/kill-port.mjs 8080
//
// Used by `npm run restart` so a stale ZoFHub process can't keep us from
// re-launching.  Silent on success; prints a short note if it killed anything.

import { execSync } from 'node:child_process';

const port = parseInt(process.argv[2] || '8080', 10);
if (!port || port < 1 || port > 65535) {
  console.error('[kill-port] usage: node tools/kill-port.mjs <port>');
  process.exit(2);
}

function shell(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
}

const pids = new Set();

if (process.platform === 'win32') {
  // netstat output, find rows where local address ends with :<port> and grab last column (PID)
  const out = shell(`netstat -ano -p tcp`);
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (m && parseInt(m[1], 10) === port) pids.add(parseInt(m[2], 10));
  }
} else {
  // Unix: lsof if available
  const out = shell(`lsof -ti tcp:${port}`);
  for (const id of out.split(/\s+/).filter(Boolean)) pids.add(parseInt(id, 10));
}

if (pids.size === 0) {
  // Port already free — nothing to do.
  process.exit(0);
}

for (const pid of pids) {
  if (process.platform === 'win32') shell(`taskkill /PID ${pid} /F`);
  else { try { process.kill(pid, 'SIGTERM'); } catch {} }
  console.log(`[kill-port] freed port ${port} (pid ${pid})`);
}
// Give the OS a beat to release the socket.
await new Promise(r => setTimeout(r, 250));
