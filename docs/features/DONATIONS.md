# Donations: addresses only, checked before they are shown

> **Off until you configure it.** With no `DONATE_*_ADDRESS` set, every method
> fails validation, is dropped, and the site shows no donate button at all.

| | |
|---|---|
| Methods | [`data/donate.json`](../../data/donate.json) — which methods exist, never the addresses |
| Validation | [`lib/donate.mjs`](../../lib/donate.mjs), with a dependency-free Keccak-256 in [`lib/keccak256.mjs`](../../lib/keccak256.mjs) |
| Swap path | [`lib/swap.mjs`](../../lib/swap.mjs) — **API only; no page offers it yet** (§5) |
| UI | the "Support ZoFHub" dialog ([`public/js/donate.js`](../../public/js/donate.js)) and the JS-optional page `/donate` |
| Admin | `GET /api/admin/donations` — what is live, what was dropped, and why |

---

## 1. The problem this is built around

A donation address is a long random string that a human pastes once. **If one
character is wrong, the money is gone** — no error, no refund, and no way to
tell. The donor sees a normal-looking address; their wallet either rejects it (the
lucky case) or sends to nowhere.

So every address is **checksum-verified when it is loaded**, and a method whose
address fails is **dropped rather than served**:

> A missing donate button costs nothing. A wrong one costs every donation until
> somebody notices.

---

## 2. Addresses live in the environment, never in git

`data/donate.json` declares *which* methods exist. Each names an environment
variable, and the deployment supplies the address:

| Method | Ticker | Variable | Check |
|---|---|---|---|
| Solana | SOL | `DONATE_SOL_ADDRESS` | **curve-point** (base58, 32 bytes, on the Ed25519 curve) |
| USDC (on Solana) | USDC | `DONATE_SOL_ADDRESS` — the **same** address | **curve-point** |
| Bitcoin | BTC | `DONATE_BTC_ADDRESS` | **full checksum** (bech32 for `bc1…`, base58check for `1…`/`3…`) |
| Litecoin | LTC | `DONATE_LTC_ADDRESS` | **full checksum** (bech32 / base58check) |
| Ethereum | ETH | `DONATE_ETH_ADDRESS` | **full checksum** (EIP-55) |
| Monero | XMR | `DONATE_XMR_ADDRESS` | **full checksum** (Keccak-256 + curve, mainnet only) |

**Why not commit them?** A committed address is a permanent, searchable link
between this repository, its author and a wallet — clones, forks and git history
all keep it, and rotating does not erase the old one. To be clear about what that
buys: a receiving address is **public by design** and appears on the live page
the moment it is configured. Keeping it out of git stops it being *bound to this
codebase*; it does not make it secret.

The environment wins over the file. A method whose variable is unset has no
address, fails validation, and is dropped — the correct default for an
unconfigured deployment.

---

## 3. What each check actually guarantees

| Check | Guarantee |
|---|---|
| **bech32** (BIP-173) | catches any single-character error and most multi-character ones |
| **base58check** | full double-SHA-256 checksum — the same guarantee |
| **EIP-55** | a mixed-case checksum over Keccak-256. **An all-lowercase `0x…` address carries no checksum and is rejected** — paste the checksummed (mixed-case) form your wallet shows |
| **Keccak-256 + curve** (Monero) | block-base58 decode, the **mainnet** network prefix, the exact length for the address type, the 4-byte Keccak-256 checksum, and both public keys verified as real Ed25519 points. A typo **cannot** pass. `lib/monero-address.mjs`. |
| **curve-point** (Solana) | base58, exactly 32 bytes, and the bytes must be a real point on the Ed25519 curve. There is **no checksum in the format**, so this is not a checksum — but the curve test still catches roughly half of all typos, and rejects a token-account (off-curve) address pasted where a wallet address belongs. `lib/ed25519-point.mjs`. |

**Verification strength is stated, not hidden.** Each live method is tagged
`checksum`, `curve-point` or `shape-only`, the admin panel shows it, and the boot
log names anything weaker than a checksum —

```
[donate] no checksum exists for: SOL (curve-point), USDC (curve-point) — send a test transaction before relying on these.
```

**Why the two Keccak coins now differ from the rest by implementation, not
strength:** `node:crypto` ships SHA-3, and **Keccak-256 is not SHA-3** (the
padding differs), so both Ethereum (EIP-55) and Monero need real Keccak. It is
implemented without a dependency in `lib/keccak256.mjs`, and Monero additionally
uses it in `lib/monero-address.mjs`. Monero used to be shape-only *because* that
was missing; it no longer is.

> **Corrected 2026-09-26:** an earlier version of this page listed SOL, USDC and
> XMR as "shape only". Monero is now fully checksum-verified, and Solana is
> curve-point verified. Solana still has no checksum (none exists in the format),
> so a test transaction is still the only proof of ownership for it.

### USDC is not a chain

This entry is **USDC on Solana** — an SPL token — so it validates as the Solana
address it is, and shares one wallet with SOL. They are listed separately so a
donor holding dollars need not know USDC is an SPL token.

> **USDC sent on Ethereum, Base or Polygon to this address is unrecoverable.** The
> method's note names the network for that reason, and the wallet link carries
> the USDC mint (`solana:ADDR?spl-token=MINT`) — without it, a USDC button would
> open a wallet prefilled to send SOL.

### Wallet handoff

Each method carries a URI scheme (`bitcoin:`, `monero:`, `solana:`, …). A wallet
app that registered the scheme opens prefilled; with none installed it is simply
harmless.

### When something is dropped

The boot log says so loudly — `[donate] N method(s) DROPPED: …` — with the
reason for each. **The reason never echoes the address**, so a misconfigured
address cannot leak into a log or a shared terminal.

---

## 4. Operating it

- **Hot reload.** `data/donate.json` is re-read when it changes, like the catalog
  overrides — no restart. (Addresses come from the environment, so changing one
  still means a redeploy on most hosts.)
- **`GET /api/donate`** is the one source every surface reads — the dialog and the
  `/donate` page both use it, so there is exactly one place a wallet address comes
  from. Cached 60 s in the browser, so fixing a bad address propagates quickly.
- **`GET /api/admin/donations`** lists every live method with its verification
  level, and every **dropped** method with the reason. A missing method is
  otherwise silent — this panel is how you find out.
- **No card option, deliberately.** A visitor without a wallet cannot donate.
- **No advertising on `/donate`.** It is deliberately left out of the ad
  registry's native surfaces: running paid ads on the page that asks people to
  fund the site undercuts the ask.
- **Nothing is collected.** The donate flow records no donor, IP, amount or
  session.

Other supported method kinds: `link` (a hosted page such as Ko-fi or Liberapay —
must be `https://`), and validators exist for DOGE, ZEC, Firo and Pirate Chain
(`zs1…`) should you add them to the file.

---

## 5. Swap donations — "pay any coin, settle in Monero" (API only)

> **Status: server-side only.** `GET /api/donate` advertises the swap when it is
> configured, and `POST /api/donate/invoice` creates a deposit address — but **no
> page in `public/` calls it yet.** A donor cannot currently reach it from the
> site. Earlier README text described it as a live feature; it is not.

What it does when called: a donor picks a coin, the server asks a non-custodial
swap provider for a **one-time deposit address**, and the provider converts and
forwards to the operator's `DONATE_XMR_ADDRESS`. Neither side holds the other's
funds, and no account balance exists anywhere in this codebase.

| Setting | Purpose |
|---|---|
| `SWAP_PROVIDER=sideshift` | the only provider implemented |
| `SIDESHIFT_AFFILIATE_ID` | **required** by the provider |
| `SIDESHIFT_SECRET` | optional provider key — never returned to a client, never logged |
| `DONATE_XMR_ADDRESS` | the settlement address — **fully verified** before the swap path turns on |

**The settlement address is checked, not trusted.** Every swapped donation
settles to `DONATE_XMR_ADDRESS`, so it gets the same full Monero verification the
donate page's XMR method gets. If it is unset, malformed, testnet, or contains a
typo, the **entire swap path stays off** and the boot log says why — there is no
fallback address, ever. It used to be used unchecked.

Deposit coins accepted — an **allowlist**, because the value arrives from the
browser and is interpolated into a third-party request: **BTC, LTC, SOL, ETH,
DOGE.**

### Read this before trusting it with privacy

This buys real privacy from **one** party and **none** from another:

| From | Hidden? |
|---|---|
| **The public** | **Yes.** Monero conceals amount, sender and receiver; an observer of the deposit address sees a payment to the provider, not to you |
| **The swap provider** | **No.** They necessarily learn the deposit address, amount, destination and timing, and they keep records. Most are incorporated somewhere, respond to legal process, and screen deposits against sanctions and blockchain-analytics risk scores |

"Non-custodial" and "account-free" describe how funds are held and whether you
register — **not** whether the flow is logged. And because the same collection
address is sent to the provider on every request, hiding the server's IP from
them protects far less than it appears to.

### What is never stored

No invoice table, no session, no cookie, and no row joining a request to a
visitor, an IP or gameplay. `createInvoice` takes **no user identity at all** —
the argument does not exist, which is stronger than remembering not to log it. If
a donor needs support, the provider's own reference (returned to them, not
stored by us) is the only handle.

The rate limiter does see the IP, as every limiter must: an in-memory, decaying
counter — burst 3, then one request per 20 s — never written anywhere.

### Egress proxy (optional)

Outbound calls honour `HTTPS_PROXY` when Node is started with
`--use-env-proxy` (Node 24+). That is an HTTP CONNECT proxy: Tor's default 9050
is **SOCKS5 and will not work directly**; Tor can expose a CONNECT proxy with
`HTTPTunnelPort 9080`. Two honest caveats: swap providers commonly block Tor
exits, so this can turn into "donations silently fail"; and it hides the server's
IP from the provider while changing nothing about the records they keep.

---

## 6. Verification status

The validators and the drop-on-failure behaviour are read from `lib/donate.mjs`
and covered by tests: `test/donate.test.mjs` (20), `test/keccak256.test.mjs`
(now including the real Monero and Solana validators), `test/keccak256.test.mjs`
(known Keccak-256 vectors), `test/address-validation.test.mjs` (every
single-character Monero typo is caught; real Ed25519 keys accepted, random bytes
and off-curve addresses rejected) and `test/swap.test.mjs` (against a stubbed
provider rather than the live one, including that a bad settlement address turns
the path off and that provider error wording never reaches the browser). **Not verified here:** that any configured
address actually receives funds — the checks prove an address is well-formed, not
that you control it. Send a test transaction. The swap path has **not** been
exercised against the live provider from this repository.

---

**Related:** [documentation map](../README.md#-documentation) · [how it fits the site](../guides/HOW-IT-WORKS.md#14-donations) · [where addresses are configured](../guides/GO-LIVE.md#3-environment-variables-set-in-the-host-dashboard--never-commit)
