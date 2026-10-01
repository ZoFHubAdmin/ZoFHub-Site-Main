// Round-trip every QR this site can generate through a decoder we did NOT write.
//
// WHY THIS TEST IS NOT OPTIONAL. These codes encode wallet addresses. A subtly
// wrong encoder still produces a plausible-looking square of dots, and the only
// way anyone finds out is that a donation lands somewhere unrecoverable. A
// self-check written against the same assumptions as the encoder would not catch
// that, so the decoder here is jsqr — a separate implementation, dev-only, never
// shipped (render.yaml installs with --omit=dev).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import jsQRModule from 'jsqr';
import { qrMatrix, qrSvg } from '../public/js/qr.js';

const jsQR = jsQRModule.default || jsQRModule;

/** Render a matrix to an RGBA buffer, big enough that the decoder sees crisp modules. */
function raster(modules, size, scale = 8, quiet = 4) {
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const px = ((r + quiet) * scale + y) * dim + ((c + quiet) * scale + x);
          data[px * 4] = 0; data[px * 4 + 1] = 0; data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data, dim };
}

const roundTrip = (text, ecl = 'M') => {
  const { modules, size } = qrMatrix(text, ecl);
  const { data, dim } = raster(modules, size);
  const out = jsQR(data, dim, dim);
  return out && out.data;
};

// The real shapes this site encodes: a BIP-21 URI, a Monero URI (95-character
// address, the longest payload here), an EIP-55 address and a Solana Pay URI
// with an SPL token parameter.
const PAYLOADS = [
  ['short', 'HELLO'],
  ['bitcoin bech32', 'bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
  ['bitcoin legacy', 'bitcoin:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'],
  ['litecoin', 'litecoin:ltc1qg9bs5cnt9lcpnfzqtjcpnhvpcwhkr7z4pcrmwl'],
  ['ethereum EIP-55', 'ethereum:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
  ['solana', 'solana:7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs'],
  ['solana + spl-token', 'solana:7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs?spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  ['monero 95-char', 'monero:44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A'],
];

describe('QR encoding round-trips through an independent decoder', () => {
  for (const [name, text] of PAYLOADS) {
    test(`${name} (${text.length} chars)`, () => {
      const decoded = roundTrip(text);
      assert.equal(decoded, text, `decoded to ${JSON.stringify(decoded)}`);
    });
  }

  test('every error-correction level round-trips', () => {
    const text = 'monero:44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
    for (const ecl of ['L', 'M', 'Q', 'H']) {
      assert.equal(roundTrip(text, ecl), text, `level ${ecl} did not round-trip`);
    }
  });

  test('a one-character change produces a different code', () => {
    // Guards against an encoder that quietly ignores part of its input — which
    // would make two different wallets render the same square.
    const a = qrMatrix('bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
    const b = qrMatrix('bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdX');
    assert.notDeepEqual(a.modules, b.modules);
  });
});

describe('QR structure', () => {
  test('the version grows with the payload and the size follows it', () => {
    const small = qrMatrix('hi');
    const big = qrMatrix('x'.repeat(200));
    assert.ok(big.version > small.version);
    assert.equal(small.size, small.version * 4 + 17);
    assert.equal(big.size, big.version * 4 + 17);
  });

  test('finder patterns sit in the three corners', () => {
    const { modules, size } = qrMatrix('test');
    for (const [r, c] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      assert.equal(modules[r][c], true, 'finder corner is not dark');
      assert.equal(modules[r + 1][c + 1], false, 'finder ring is not light');
      assert.equal(modules[r + 3][c + 3], true, 'finder centre is not dark');
    }
  });

  test('an over-long payload is refused rather than silently truncated', () => {
    assert.throws(() => qrMatrix('x'.repeat(5000)), /too long/i);
  });

  test('svg output carries the module path and a label', () => {
    const svg = qrSvg('bitcoin:bc1qtest', { label: 'Bitcoin address' });
    assert.match(svg, /^<svg /);
    assert.match(svg, /viewBox="0 0 \d+ \d+"/);
    assert.match(svg, /aria-label="Bitcoin address"/);
    assert.ok(svg.includes('<path d="M'), 'no modules drawn');
  });
});
