// lib/png-stats.mjs — decode a PNG far enough to answer "is this blank?"
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// The first version of the blank-frame detector sampled bytes of the COMPRESSED
// PNG stream and counted distinct values. That is not a measure of image
// content: deflate output is high-entropy by construction, so a solid black
// frame and a busy game scene both look "varied". It passed 9 out of 9
// candidates whose frames were, on inspection, entirely black with Chrome's
// broken-content gear in the middle.
//
// Uniformity has to be measured on PIXELS. Cross-origin frames cannot be read
// with canvas (the canvas is tainted), so the only route is: screenshot the
// frame's box, decode it here, and look at the actual luminance distribution.
//
// Dependency-free on purpose — zlib is in Node, and adding an image library to
// the production tree for one histogram is not a trade worth making.
// ---------------------------------------------------------------------------
import { inflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}

/**
 * Decode an 8-bit RGB/RGBA PNG to raw bytes.
 * Returns null for anything else — an undecodable image must read as
 * "inconclusive", never as "fine".
 */
function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;

  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let off = 8;

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }

  if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels) return null;

  let raw;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return null; }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  // Undo per-scanline filtering in place.
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    line.copy(cur);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      if (filter === 1) cur[i] = (cur[i] + a) & 0xff;
      else if (filter === 2) cur[i] = (cur[i] + b) & 0xff;
      else if (filter === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) cur[i] = (cur[i] + paeth(a, b, c)) & 0xff;
    }
    prev = cur;
  }
  return { width, height, channels, pixels: out };
}

/**
 * Luminance statistics for a screenshot.
 *
 * `dominantShare` is the fraction of pixels sharing the single most common
 * luminance bin — the number that actually separates a blank frame from a game.
 * A black frame with a small spinner still lands around 0.99; a real game, even
 * a dark one, spreads far wider.
 *
 * @returns {{ok: boolean, width?: number, height?: number, dominantShare?: number,
 *            meaningfulTones?: number, meanLuma?: number, reason?: string}}
 */
export function imageStats(buf) {
  const img = decode(buf);
  if (!img) return { ok: false, reason: 'undecodable' };

  const { width, height, channels, pixels } = img;
  const hist = new Uint32Array(256);
  let total = 0, sum = 0;

  // Sample on a grid — full decode is already done, but touching every pixel of
  // a 1280x800 frame per candidate is pointless when a grid answers the same
  // question to the same precision.
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 200000)));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = y * width * channels + x * channels;
      // Rec. 601 luma; alpha ignored because screenshots are composited already.
      const l = (pixels[i] * 299 + pixels[i + 1] * 587 + pixels[i + 2] * 114) / 1000 | 0;
      hist[l]++; total++; sum += l;
    }
  }
  if (!total) return { ok: false, reason: 'empty' };

  let dominant = 0, meaningful = 0;
  for (const c of hist) {
    if (c > dominant) dominant = c;
    if (c / total >= 0.001) meaningful++;
  }

  return {
    ok: true,
    width, height,
    dominantShare: dominant / total,
    meaningfulTones: meaningful,
    meanLuma: sum / total,
  };
}

/**
 * Is this frame effectively blank?
 *
 * Two independent signals, both of which a real game clears comfortably:
 *   • >=97% of sampled pixels share one luminance bin, or
 *   • fewer than 6 luminance bins hold even 0.1% of the image.
 *
 * Deliberately NOT keyed on darkness (spec §16). A dark game is a game; the
 * question is whether the frame has structure, not whether it is bright.
 */
export function isBlankImage(buf, { dominantShareMax = 0.97, minTones = 6 } = {}) {
  const s = imageStats(buf);
  if (!s.ok) return { blank: null, stats: s };
  return {
    blank: s.dominantShare >= dominantShareMax || s.meaningfulTones < minTones,
    stats: s,
  };
}

/**
 * How much did two screenshots of the same region actually change?
 *
 * Returns the fraction of sampled pixels whose luminance moved by more than
 * `threshold`. Used for two distinct questions the verifier has to keep apart:
 * whether a frame is animating at all, and whether it changed MORE after an
 * input than it was already changing on its own.
 *
 * That second question is why this returns a magnitude rather than a boolean.
 * A game with an idle animation is always "changing", so a bare did-it-change
 * test would report every animated title as responding to input regardless of
 * whether it did. The caller compares against a measured idle baseline.
 *
 * Differently-sized images return `ok: false` rather than a number: a resized
 * canvas is a real event, but it is not evidence about input handling, and
 * silently rescaling to compare anyway would manufacture a difference.
 *
 * @returns {{ok: boolean, changed?: number, sampled?: number, reason?: string}}
 */
export function imageDelta(bufA, bufB, { threshold = 12 } = {}) {
  const a = decode(bufA), b = decode(bufB);
  if (!a || !b) return { ok: false, reason: 'undecodable' };
  if (a.width !== b.width || a.height !== b.height) return { ok: false, reason: 'size_changed' };

  const { width, height } = a;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 60000)));
  let changed = 0, sampled = 0;
  const luma = (px, i) => (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const ia = y * width * a.channels + x * a.channels;
      const ib = y * width * b.channels + x * b.channels;
      if (Math.abs(luma(a.pixels, ia) - luma(b.pixels, ib)) > threshold) changed++;
      sampled++;
    }
  }
  return sampled ? { ok: true, changed: changed / sampled, sampled } : { ok: false, reason: 'empty' };
}
