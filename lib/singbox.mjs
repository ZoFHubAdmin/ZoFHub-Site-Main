// lib/singbox.mjs — read-only adapter for a sing-box instance's Clash API.
// ---------------------------------------------------------------------------
// sing-box (https://github.com/SagerNet/sing-box, GPL-3.0) is a SEPARATE Go
// daemon. This module never links it, bundles it, or derives from it — it speaks
// to its HTTP management API (the Clash-compatible `external_controller`) over
// the network, exactly the relationship ZoFHub already has with the AGPL proxy
// engines it runs beside. Talking to a program's network API is not a derivative
// work, so nothing here changes ZoFHub's own license, and nothing here uses the
// sing-box name to imply endorsement — the panel labels it "sing-box (external)"
// and reports it as an instance YOU run.
//
// ── HONEST FAILURE IS THE WHOLE DESIGN ─────────────────────────────────────
// The trap this avoids: a telemetry panel pointed at a daemon that is not
// running renders zeroes, and zeroes read as "healthy, no traffic" when the
// truth is "there is no such service". So every non-success returns
// `{ reachable: false, reason }` — NEVER a zero-valued stats object. The UI
// keys on `reachable` and shows "not connected", not an idle dashboard.
//
// Unset config is the normal state on this deployment (sing-box is optional and
// not part of the default single-container deploy), so "not configured" is a
// first-class, non-error answer — it must not log noise or throw.

const TIMEOUT_MS = Number(process.env.SINGBOX_API_TIMEOUT_MS) || 1500;

/** Configured only when an API URL is present. Secret is optional (loopback). */
export function singboxConfigured(env = process.env) {
  return Boolean(String(env.SINGBOX_API_URL || '').trim());
}

/**
 * A point-in-time read of the sing-box instance, shaped for /api/admin/proxy.
 *
 * Always resolves — never rejects — so a caller can `await` it inline without a
 * try/catch and without one dead daemon taking down the whole proxy endpoint.
 *
 * @returns {Promise<object>} either
 *   { reachable:false, configured, reason }  or
 *   { reachable:true, live, uploadBytes, downloadBytes, memoryBytes, ... }
 */
export async function singboxTelemetry(env = process.env, { fetchImpl = fetch } = {}) {
  const base = String(env.SINGBOX_API_URL || '').trim().replace(/\/+$/, '');
  if (!base) return { reachable: false, configured: false, reason: 'not-configured' };

  const secret = String(env.SINGBOX_API_SECRET || '').trim();
  const headers = secret ? { authorization: `Bearer ${secret}` } : {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    // /connections is the Clash-API live connection table. It carries the
    // cumulative byte counters too, so one cheap GET answers the dashboard
    // without opening the /traffic stream (which would be a long-lived socket
    // this poll has no use for).
    const r = await fetchImpl(`${base}/connections`, { headers, signal: ctrl.signal });
    if (r.status === 401 || r.status === 403) {
      return { reachable: false, configured: true, reason: 'unauthorized' };
    }
    if (!r.ok) return { reachable: false, configured: true, reason: `http-${r.status}` };

    let d;
    try { d = await r.json(); }
    catch { return { reachable: false, configured: true, reason: 'bad-response' }; }

    const conns = Array.isArray(d?.connections) ? d.connections : [];
    return {
      reachable: true,
      configured: true,
      live: conns.length,
      // Cumulative counters straight from the daemon; surfaced, not recomputed.
      uploadBytes: Number(d?.uploadTotal) || 0,
      downloadBytes: Number(d?.downloadTotal) || 0,
      memoryBytes: Number(d?.memory) || 0,
    };
  } catch (e) {
    // Abort, connection refused, DNS failure — all "no such service", never a
    // zero that reads as "up but idle".
    return {
      reachable: false,
      configured: true,
      reason: e?.name === 'AbortError' ? 'timeout' : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

export default { singboxConfigured, singboxTelemetry };
