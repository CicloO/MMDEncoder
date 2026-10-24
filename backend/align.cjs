"use strict";
// Audio alignment: where a reference recording (an MMD render's sound, a
// video's own track) starts inside a target recording (the original song),
// so the target can be cut or padded to line up with the reference.
//
// Result: offset in seconds, target time = reference time + offset. Positive:
// the target has that much more at its start (cut it off); negative: the
// target starts later (pad that much silence before it).
//
// Method: generalised cross-correlation with phase transform (GCC-PHAT).
// Whitening the cross spectrum leaves only phase, so differences in level,
// EQ and lossy coding between the two versions matter little. A coarse pass
// on low-rate audio searches every possible offset; a second pass at a high
// rate around the coarse answer gives it to the sample.
const { spawn } = require("node:child_process");

const COARSE_RATE = 4000;
const FINE_RATE = 48000;
// How much of the reference the coarse pass uses (seconds): enough to be
// unambiguous, small enough to stay fast on long targets.
const COARSE_REFERENCE = 60;
// The fine pass compares this much (seconds) around the coarse offset.
const FINE_WINDOW = 8;
const FINE_SEARCH = 0.02;
// Peak over the next best peak at least this: the two recordings line up.
const RELIABLE = 1.25;

// Mono samples at `rate` from `start` for `length` seconds (whole file when
// length is 0). Any file FFmpeg reads; a video's first audio track.
function decode(ffmpeg, file, rate, { start = 0, length = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-i",
      file,
      // Decoded from the start and the part before dropped: seeking in the
      // input lands up to an AAC frame off (13 ms measured), too coarse here.
      ...(start > 0 ? ["-ss", start.toFixed(6)] : []),
      ...(length > 0 ? ["-t", length.toFixed(6)] : []),
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      String(rate),
      "-f",
      "f32le",
      "-",
    ];
    const child = spawn(ffmpeg, args, { windowsHide: true, signal });
    const chunks = [];
    let err = "";
    child.stdout.on("data", (b) => chunks.push(b));
    child.stderr.on("data", (b) => (err = (err + b).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0)
        return reject(
          Error("无法读取音频：" + (err.trim() || "退出码 " + code)),
        );
      const buf = Buffer.concat(chunks);
      const out = new Float32Array(buf.length >> 2);
      for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
      resolve(out);
    });
  });
}

// In-place iterative radix-2 FFT (inverse: conjugate trick, unscaled).
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang),
      wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1,
        ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k,
          b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

// GCC-PHAT of reference and target: corr[k] for lag k (target[t + k] lines
// up with reference[t]), for every lag from -(reference length - 1) to
// target length - 1. Returns a function lag -> value and the lag range.
function gccPhat(reference, target) {
  let n = 1;
  while (n < reference.length + target.length) n <<= 1;
  const ar = new Float64Array(n),
    ai = new Float64Array(n),
    br = new Float64Array(n),
    bi = new Float64Array(n);
  ar.set(reference);
  br.set(target);
  fft(ar, ai);
  fft(br, bi);
  // conj(A) · B, whitened to unit magnitude.
  for (let i = 0; i < n; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const m = ar[i] * bi[i] - ai[i] * br[i];
    const mag = Math.hypot(r, m) || 1;
    ar[i] = r / mag;
    ai[i] = m / mag;
  }
  fft(ar, ai, true);
  return {
    at: (k) => ar[(k + n) % n] / n,
    min: -(reference.length - 1),
    max: target.length - 1,
  };
}

// The best lag in [from, to] and how clearly it stands out: its value over
// the best one at least `gap` lags away.
function peak(corr, from, to, gap) {
  let best = from;
  for (let k = from; k <= to; k++) if (corr.at(k) > corr.at(best)) best = k;
  let second = 0;
  for (let k = from; k <= to; k++)
    if (Math.abs(k - best) > gap) second = Math.max(second, corr.at(k));
  // Sub-sample position from the parabola through the peak and its neighbours.
  const y0 = corr.at(best - 1),
    y1 = corr.at(best),
    y2 = corr.at(best + 1);
  const d = y0 - 2 * y1 + y2;
  const frac = d < 0 ? (0.5 * (y0 - y2)) / d : 0;
  return {
    lag: best + Math.max(-0.5, Math.min(0.5, frac)),
    value: y1,
    ratio: second > 0 ? y1 / second : Infinity,
  };
}

// Where the reference's sound is: its first second above a fifth of its
// loudest second, so the fine pass does not compare silence.
function firstSound(samples, rate) {
  const energy = [];
  for (let s = 0; s + rate <= samples.length; s += rate) {
    let e = 0;
    for (let i = s; i < s + rate; i++) e += samples[i] * samples[i];
    energy.push(e);
  }
  const top = Math.max(0, ...energy);
  const i = energy.findIndex((e) => e >= top / 5);
  return i > 0 ? i : 0;
}

async function align(tools, reference, target, { signal } = {}) {
  const ff = tools.ffmpeg;
  // Coarse: up to a minute of the reference against all of the target.
  const [ref, tgt] = await Promise.all([
    decode(ff, reference, COARSE_RATE, { length: COARSE_REFERENCE, signal }),
    decode(ff, target, COARSE_RATE, { signal }),
  ]);
  if (ref.length < COARSE_RATE / 2 || tgt.length < COARSE_RATE / 2)
    throw Error("音频太短，至少需要半秒");
  const coarse = gccPhat(ref, tgt);
  const c = peak(coarse, coarse.min, coarse.max, COARSE_RATE / 20);
  let offset = c.lag / COARSE_RATE;
  // Fine: a window of the reference where it has sound, and the target's
  // matching stretch with a little room either side.
  // (When the target starts later, the window moves on until the target has
  // begun.)
  const from = Math.max(
    firstSound(ref, COARSE_RATE),
    Math.ceil(FINE_SEARCH - offset),
  );
  const at = from + offset - FINE_SEARCH;
  if (at >= 0) {
    const [r, t] = await Promise.all([
      decode(ff, reference, FINE_RATE, {
        start: from,
        length: FINE_WINDOW,
        signal,
      }),
      decode(ff, target, FINE_RATE, {
        start: at,
        length: FINE_WINDOW + 2 * FINE_SEARCH,
        signal,
      }),
    ]);
    if (r.length > FINE_RATE / 2 && t.length > FINE_RATE / 2) {
      const fine = gccPhat(r, t);
      const reach = Math.round(2 * FINE_SEARCH * FINE_RATE);
      const f = peak(fine, 0, Math.min(reach, fine.max), FINE_RATE / 1000);
      // Lag in the fine window counts from `at`.
      offset = at + f.lag / FINE_RATE - from;
    }
  }
  return {
    offset,
    // How clearly the match stands out; below RELIABLE the two may not be
    // the same recording (another mix, a changed tempo, unrelated audio).
    confidence: c.ratio,
    reliable: c.ratio >= RELIABLE,
  };
}

module.exports = { align, decode, gccPhat, fft, RELIABLE };
