// lib/swap.mjs — "donate in BTC, I receive XMR", via a non-custodial swap API.
//
// WHAT THIS DOES
// A donor picks Bitcoin. We ask a swap provider for a one-time deposit address,
// show it, and the provider converts to Monero and forwards it to the operator's
// collection address. The provider never holds our keys, we never hold the
// donor's funds, and no account balance exists anywhere in this codebase.
//
// ── READ THIS BEFORE TRUSTING IT WITH PRIVACY ──────────────────────────────
// This buys real privacy from ONE party and none at all from another, and the
// difference matters more than any code below.
//
//   Hidden from the PUBLIC.  A blockchain observer watching the operator's
//   Monero address sees nothing useful: Monero conceals amounts, sender and
//   receiver. An observer watching the BTC deposit address sees a payment to a
//   swap provider's address, not to the operator.
//
//   NOT hidden from the SWAP PROVIDER.  They necessarily learn the deposit
//   address, the amount, the destination Monero address and the timing, and
//   they keep records. Most are incorporated somewhere, have terms of service,
//   respond to legal process, and screen deposits against sanctions and
//   blockchain-analytics risk scores. "Non-custodial" and "account-free"
//   describe how funds are held and whether you register — NOT whether the
//   flow is logged. Anyone treating this as anonymous from the provider has
//   misunderstood it.
//
//   The collection address is the linchpin. It is handed to the provider on
//   every request, so hiding the server's IP while sending them the same
//   destination address every time protects far less than it appears to.
//
// ── EGRESS PROXY ───────────────────────────────────────────────────────────
// Outbound calls honour HTTPS_PROXY when the process is started with
// `--use-env-proxy` (Node 24+, built in, no dependency). That is an HTTP
// CONNECT proxy. Tor's default 9050 port is SOCKS5 and will NOT work directly;
// Tor can expose a CONNECT proxy itself with `HTTPTunnelPort 9080` in torrc,
// which is the dependency-free way to do this. Two honest caveats: swap
// providers commonly block Tor exits and geo-restrict, so this can turn into
// "donations silently fail", and an egress proxy hides the server's IP from the
// provider while changing nothing about the records they keep.
//
// ── WHAT IS NEVER STORED ───────────────────────────────────────────────────
// Nothing here writes an IP, session id, user agent, cookie, device id or
// gameplay history anywhere. createInvoice takes no user identity because it is
// not given any — the argument simply does not exist, which is a stronger
// guarantee than remembering not to log it.

import { verifyMoneroAddress } from './monero-address.mjs';

const TIMEOUT_MS = 15_000;

/**
 * Providers. Each maps our shape onto theirs and back.
 *
 * `needsKey` is honest about the "account-free" claim: SideShift works without
 * one but applies a worse rate and stricter limits; the others require a key.
 */
export const PROVIDERS = {
  sideshift: {
    id: 'sideshift',
    label: 'SideShift.ai',
    needsKey: false,
    keyEnv: 'SIDESHIFT_SECRET',
    // MANDATORY, and discovered by actually calling the API rather than by
    // reading about it: without affiliateId the endpoint rejects the whole
    // request with "Invalid parameters: affiliateId: expected string, received
    // undefined". Sending it as undefined means JSON.stringify drops the key
    // and every donation fails at the moment a donor clicks. Required here so
    // the failure happens at boot, in the log, instead.
    requiredEnv: ['SIDESHIFT_AFFILIATE_ID'],
    // Variable-rate shift: the donor sends any amount within limits. Fixed-rate
    // quotes expire in minutes, which is wrong for a donation page somebody may
    // leave open.
    async create({ from, toAddress, key, fetchImpl }) {
      const r = await fetchImpl('https://sideshift.ai/api/v2/shifts/variable', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { 'x-sideshift-secret': key } : {}),
        },
        body: JSON.stringify({
          settleCoin: 'xmr', settleNetwork: 'monero',
          depositCoin: from.coin, depositNetwork: from.network,
          settleAddress: toAddress,
          affiliateId: String(process.env.SIDESHIFT_AFFILIATE_ID || ''),
        }),
      });
      const j = await r.json().catch(() => ({}));
      // The provider's own error text goes to the SERVER LOG (via `detail`),
      // never to the browser: it is third-party wording that can name request
      // parameters and internal state ("affiliateId: expected string…"), and a
      // donor can act on none of it.
      if (!r.ok) {
        throw new SwapError('the swap provider could not create a deposit address', 502,
          `provider ${r.status}: ${String(j?.error?.message || '').slice(0, 300)}`);
      }
      if (!j?.depositAddress) throw new SwapError('provider returned no deposit address', 502);
      return {
        depositAddress: String(j.depositAddress),
        depositMemo: j.depositMemo ? String(j.depositMemo) : '',
        min: j.depositMin ?? null,
        max: j.depositMax ?? null,
        providerRef: String(j.id || ''),
        expiresAt: j.expiresAt ? String(j.expiresAt) : '',
      };
    },
  },
};

/**
 * `message` is safe to show a donor. `detail` is for the server log only.
 */
export class SwapError extends Error {
  constructor(message, status = 502, detail = '') {
    super(message);
    this.name = 'SwapError';
    this.status = status;
    this.detail = detail;
  }
}

// Coins we will accept as a deposit. An allowlist, not free text: `from` comes
// from the browser, and it is interpolated into a request to a third party.
export const DEPOSIT_COINS = {
  btc: { coin: 'btc', network: 'bitcoin', label: 'Bitcoin' },
  ltc: { coin: 'ltc', network: 'litecoin', label: 'Litecoin' },
  sol: { coin: 'sol', network: 'solana', label: 'Solana' },
  eth: { coin: 'eth', network: 'ethereum', label: 'Ethereum' },
  doge: { coin: 'doge', network: 'dogecoin', label: 'Dogecoin' },
};

/** Is the swap path configured at all? */
export function swapConfig() {
  const providerId = String(process.env.SWAP_PROVIDER || '').toLowerCase();
  const provider = PROVIDERS[providerId] || null;
  const collect = String(process.env.DONATE_XMR_ADDRESS || '').trim();
  const key = provider ? String(process.env[provider.keyEnv] || '').trim() : '';
  const missing = provider ? (provider.requiredEnv || []).filter(k => !String(process.env[k] || '').trim()) : [];
  // The collection address is where EVERY swapped donation settles, so it gets
  // the same full verification as the donate page's Monero method — before
  // this it was used unchecked, and a typo here would have forwarded every
  // swap to an address nobody controls. Invalid means the feature is OFF
  // (fail closed); there is no fallback address, ever.
  const collectCheck = collect ? verifyMoneroAddress(collect) : { ok: false, why: 'unset' };
  return {
    provider,
    missing,
    // Never returned to a client and never logged — only its presence is.
    key,
    collect: collectCheck.ok ? collect : '',
    collectProblem: collect && !collectCheck.ok ? collectCheck.why : null,
    enabled: Boolean(provider && collectCheck.ok && missing.length === 0),
    coins: Object.keys(DEPOSIT_COINS),
  };
}

/**
 * Create a one-time deposit address that settles to the operator's XMR address.
 *
 * Deliberately takes NO user identity — not an IP, not a session, not a device
 * id. There is nothing to forget to strip.
 */
export async function createInvoice({ from, fetchImpl = fetch, config = swapConfig() } = {}) {
  const { provider, key, collect, enabled } = config;
  if (!enabled) throw new SwapError('swap donations are not configured', 503);

  const coin = DEPOSIT_COINS[String(from || '').toLowerCase()];
  if (!coin) throw new SwapError('unsupported deposit coin', 400);
  if (provider.needsKey && !key) throw new SwapError('swap provider key is not set', 503);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const wrapped = (url, init) => fetchImpl(url, { ...init, signal: ac.signal });
    const out = await provider.create({ from: coin, toAddress: collect, key, fetchImpl: wrapped });
    return {
      coin: coin.coin, network: coin.network, label: coin.label,
      depositAddress: out.depositAddress,
      depositMemo: out.depositMemo,
      min: out.min, max: out.max,
      expiresAt: out.expiresAt,
      // The provider's own reference. Useful to the DONOR if a shift goes wrong
      // and they need support; useless for identifying who they are.
      providerRef: out.providerRef,
      provider: provider.id,
    };
  } catch (e) {
    if (e instanceof SwapError) throw e;
    if (e?.name === 'AbortError') throw new SwapError('swap provider timed out', 504);
    // The raw error can carry the proxy host or the request URL, so it is not
    // passed through to the client.
    throw new SwapError('swap provider unreachable', 502);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One-line startup summary. Prints whether a key is PRESENT, never its value,
 * and never the collection address.
 */
export function swapStatusLine(cfg = swapConfig()) {
  if (!cfg.provider) return '[swap] disabled (SWAP_PROVIDER not set)';
  if (cfg.collectProblem) return `[swap] disabled (DONATE_XMR_ADDRESS is not a valid mainnet Monero address: ${cfg.collectProblem})`;
  if (!cfg.collect) return `[swap] disabled (${cfg.provider.label} selected but DONATE_XMR_ADDRESS is unset)`;
  if (cfg.missing?.length) return `[swap] disabled (${cfg.provider.label} requires ${cfg.missing.join(', ')})`;
  const proxied = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy);
  return `[swap] ${cfg.provider.label} ready · key ${cfg.key ? 'present' : 'absent (public rate)'} · egress ${proxied ? 'via HTTPS_PROXY' : 'direct'}`;
}
