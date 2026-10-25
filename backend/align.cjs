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
// Whitening the cross spectrum leaves only phase, so level, EQ and lossy
// coding matter little. Two ways to find the offset roughly:
// - The waveforms (4 kHz, up to a minute of the reference against all of
//   the target): sure and exact when both carry the same recording (a
//   render and its song).
// - Onset strength (how fast the loudness rises, 100 frames a second, the
//   whole of both), then again at 1000 frames a second around the answer:
//   the beat is shared by two versions of a song where the vocals or the
//   mix differ (an original and a cover on the same backing track), which
//   the waveforms are not.
// The waveforms are used when they match clearly, else the onsets. Then the
// waveforms at 48 kHz around the answer give it to the sample.
const { spawn } = require("node:child_process");

const DECODE_RATE = 4000;
// How much of the reference the waveform pass uses (seconds); the onset
// pass compares up to LONGEST of each.
const WAVE_REFERENCE = 60;
const LONGEST = 20 * 60;
const FINE_RATE = 48000;
// The fine pass compares this much (seconds) around the rough answer.
const FINE_WINDOW = 8;
// Peak over the next best peak at least this: the two recordings line up.
// Waveforms: unrelated songs measured 1.00–1.01, matches 1.5 and up.
// Onsets: unrelated up to 1.4, versions of one song 2.8 and up.
const RELIABLE = 1.25;
const RELIABLE_ONSETS = 2;

// Mono samples at `rate` from `start` for `length` seconds (whole file when
// length is 0). Any file FFmpeg reads; a video's first audio track.
async function decode(ffmpeg, file, rate, options) {
  const buf = await decodeRaw(ffmpeg, file, rate, "f32le", options);
  const out = new Float32Array(buf.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}
// The same as 16-bit samples, the raw bytes (the dialog's preview): FFmpeg
// converts and clips them, so they need no pass of their own.
function decodeS16(ffmpeg, file, rate, options) {
  return decodeRaw(ffmpeg, file, rate, "s16le", options);
}
function decodeRaw(
  ffmpeg,
  file,
  rate,
  format,
  { start = 0, length = 0, signal } = {},
) {
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
      format,
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
      resolve(Buffer.concat(chunks));
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

// Onset strength per frame of `hop` samples: the rise of the log energy.
// Silence is floored a hundred thousand times below the loudest frame, so
// the moment sound starts does not outweigh the music itself.
function onsets(x, hop) {
  const n = Math.floor(x.length / hop);
  const e = new Float64Array(n);
  let top = 0;
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) s += x[i] * x[i];
    e[f] = s / hop;
    if (e[f] > top) top = e[f];
  }
  const floor = top * 1e-5 || 1e-12;
  const o = new Float32Array(n);
  let prev = Math.log(Math.max(e[0] || 0, floor));
  for (let f = 1; f < n; f++) {
    const v = Math.log(Math.max(e[f], floor));
    o[f] = Math.max(0, v - prev);
    prev = v;
  }
  return o;
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
  const [ref, tgt] = await Promise.all([
    decode(ff, reference, DECODE_RATE, { length: LONGEST, signal }),
    decode(ff, target, DECODE_RATE, { length: LONGEST, signal }),
  ]);
  if (ref.length < DECODE_RATE || tgt.length < DECODE_RATE)
    throw Error("音频太短，至少需要 1 秒");
  // Waveforms first.
  const wave = gccPhat(ref.subarray(0, WAVE_REFERENCE * DECODE_RATE), tgt);
  const w = peak(wave, wave.min, wave.max, DECODE_RATE / 20);
  let offset, confidence, reliable;
  // The rough answer is good to 1 ms; the fine pass looks this far either side.
  const search = 0.003;
  if (w.ratio >= RELIABLE) {
    offset = w.lag / DECODE_RATE;
    [confidence, reliable] = [w.ratio, true];
  } else {
    // Onsets: every offset in 10 ms frames, then within 30 ms in 1 ms frames.
    const coarse = gccPhat(
      onsets(ref, DECODE_RATE / 100),
      onsets(tgt, DECODE_RATE / 100),
    );
    const c = peak(coarse, coarse.min, coarse.max, 10);
    const mid = gccPhat(
      onsets(ref, DECODE_RATE / 1000),
      onsets(tgt, DECODE_RATE / 1000),
    );
    const centre = Math.round(c.lag * 10);
    const m = peak(
      mid,
      Math.max(mid.min, centre - 30),
      Math.min(mid.max, centre + 30),
      2,
    );
    offset = m.lag / 1000;
    [confidence, reliable] = [c.ratio, c.ratio >= RELIABLE_ONSETS];
  }
  // To the sample: windows of the reference where it has sound, and the
  // target's matching stretch with `search` either side. For two versions
  // the peak in one window can be a few ms off where their sounds differ,
  // so up to four windows are compared and the clearest peak counts (the
  // same recording is clear at once), or the rough answer stays when none is.
  const start = Math.max(firstSound(ref, DECODE_RATE), search - offset);
  const end =
    Math.min(ref.length, tgt.length - offset * DECODE_RATE) / DECODE_RATE;
  const room = Math.max(0, end - FINE_WINDOW - start);
  let best = null;
  for (const share of [0, 0.25, 0.5, 0.75]) {
    if (best?.ratio >= 5) break;
    const from = start + room * share;
    const at = from + offset - search;
    if (at < 0) continue;
    const [r, tw] = await Promise.all([
      decode(ff, reference, FINE_RATE, {
        start: from,
        length: FINE_WINDOW,
        signal,
      }),
      decode(ff, target, FINE_RATE, {
        start: at,
        length: FINE_WINDOW + 2 * search,
        signal,
      }),
    ]);
    if (r.length < FINE_RATE / 2 || tw.length < FINE_RATE / 2) continue;
    const fine = gccPhat(r, tw);
    const reach = Math.round(2 * search * FINE_RATE);
    const p = peak(fine, 0, Math.min(reach, fine.max), FINE_RATE / 1000);
    // Lag in the fine window counts from `at`.
    if (!best || p.ratio > best.ratio)
      best = { offset: at + p.lag / FINE_RATE - from, ratio: p.ratio };
  }
  if (best?.ratio >= 2) offset = best.offset;
  // confidence: how clearly the match stands out; when not reliable the two
  // may not be the same song (or one has another tempo or arrangement).
  return { offset, confidence, reliable };
}

module.exports = { align, decode, decodeS16, gccPhat, fft, onsets, RELIABLE };
