"use strict";
// PNG image sequences (name_0001.png, name_0002.png, …) as video sources.
// FFmpeg reads them with its image2 demuxer from a printf-style pattern; this
// finds the sequence a picked file or folder belongs to.
const fs = require("node:fs");
const path = require("node:path");

const PNG = /^(.*?)(\d+)\.png$/i;

// Sequences in a folder, keyed by name prefix and digit layout. Read
// without blocking: a long MMD sequence is tens of thousands of files.
async function scan(dir) {
  const groups = new Map();
  for (const file of await fs.promises.readdir(dir)) {
    const m = PNG.exec(file);
    if (!m) continue;
    const [, prefix, digits] = m;
    // Zero-padded names (0001) all share one width; unpadded ones (1, 10) vary.
    const padded = digits.length > 1 && digits[0] === "0";
    const key = prefix.toLowerCase() + "\0" + (padded ? digits.length : "*");
    let g = groups.get(key);
    if (!g)
      groups.set(
        key,
        (g = { prefix, padded, width: digits.length, frames: [] }),
      );
    g.frames.push({ n: Number(digits), file, width: digits.length });
  }
  // "frame_1.png … frame_9.png" and "frame_0010.png" style mixes: a padded
  // group also takes unpadded names of the same width (frame_1000.png).
  for (const g of groups.values())
    if (!g.padded) {
      const same = [...groups.values()].find(
        (o) => o.padded && o.prefix.toLowerCase() === g.prefix.toLowerCase(),
      );
      if (same) {
        const fits = g.frames.filter((f) => f.width === same.width);
        same.frames.push(...fits);
        g.frames = g.frames.filter((f) => f.width !== same.width);
      }
    }
  return [...groups.values()].filter((g) => g.frames.length);
}

function describe(dir, g) {
  const frames = [...g.frames].sort((a, b) => a.n - b.n);
  // Zero-padded names share one width (%04d); others are plain numbers (%d).
  const fixed = g.padded;
  const width = frames[0].width;
  const start = frames[0].n;
  let count = 1;
  while (count < frames.length && frames[count].n === start + count) count++;
  // image2 stops at the first missing number, so a gap must be reported.
  const missing = count < frames.length ? start + count : null;
  const base = g.prefix.replace(/[\s._-]+$/, "");
  const result = {
    dir,
    first: path.join(dir, frames[0].file),
    // %% keeps a literal percent sign in folder or file names.
    pattern: path.join(
      dir.replace(/%/g, "%%"),
      g.prefix.replace(/%/g, "%%") + (fixed ? `%0${width}d` : "%d") + ".png",
    ),
    start,
    count,
    total: frames.length,
    missing,
    // Output name: the prefix without its trailing separator, or the folder.
    name: base || path.basename(dir),
    // Total size: added up afterwards by size() (one stat per frame).
    size: undefined,
  };
  frameFiles.set(
    result,
    frames.slice(0, count).map((f) => path.join(dir, f.file)),
  );
  return result;
}
// The frame files of a described sequence, kept out of the result itself
// (which is copied into the job and sent to the window).
const frameFiles = new WeakMap();
// Total size of a sequence's frames, 32 files at a time; `alive()` false
// stops early (the sequence was removed) and gives undefined.
async function size(seq, alive = () => true) {
  const files = frameFiles.get(seq) || [];
  let total = 0;
  for (let i = 0; i < files.length; i += 32) {
    if (!alive()) return undefined;
    const sizes = await Promise.all(
      files.slice(i, i + 32).map((file) =>
        fs.promises.stat(file).then(
          (s) => s.size,
          () => 0,
        ),
      ),
    );
    for (const s of sizes) total += s;
  }
  return total;
}

// The sequence a PNG file belongs to, or the largest one in a folder; null
// when there is no sequence of at least two frames. Pass the same memo (a
// Map) for many picks at once: each folder is then read and described once.
async function find(target, memo = new Map()) {
  const scanned = (dir) => {
    if (!memo.has(dir)) memo.set(dir, scan(dir));
    return memo.get(dir);
  };
  const described = (dir, g) => (g.described ||= describe(dir, g));
  const stat = await fs.promises.stat(target);
  if (stat.isDirectory()) {
    const groups = [...(await scanned(target))].sort(
      (a, b) => b.frames.length - a.frames.length,
    );
    const g = groups.find((g) => g.frames.length >= 2);
    return g ? described(target, g) : null;
  }
  const dir = path.dirname(target);
  const m = PNG.exec(path.basename(target));
  if (!m) return null;
  const g = (await scanned(dir)).find((g) =>
    g.frames.some(
      (f) => f.file.toLowerCase() === path.basename(target).toLowerCase(),
    ),
  );
  return g && g.frames.length >= 2 ? described(dir, g) : null;
}

module.exports = { find, size };
