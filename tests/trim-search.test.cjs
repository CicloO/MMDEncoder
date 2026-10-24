const test = require("node:test");
const assert = require("node:assert/strict");
const trim = require("../backend/trim.cjs");

// The lookups as they were before the safe points were cached and searched.
function oldSnap(idx, frame, { end = false } = {}) {
  const n = idx.frames.length;
  frame = Math.max(0, Math.min(n, Math.round(frame)));
  if (end && frame >= n) return n;
  const points = idx.frames.filter((f) => f.safe).map((f) => f.frame);
  if (end) points.push(n);
  if (!points.length) throw Error("这个文件没有可以无损切开的位置");
  let best = points[0];
  for (const p of points)
    if (Math.abs(p - frame) < Math.abs(best - frame)) best = p;
  return best;
}
function oldEnds(idx, from, to) {
  const n = idx.frames.length;
  const safe = idx.frames.filter((f) => f.safe).map((f) => f.frame);
  return [
    safe.find((x) => x >= from) ?? n,
    to === n ? n : ([...safe].reverse().find((x) => x <= to) ?? 0),
  ];
}
let seed = 1;
const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const index = (n, every) => ({
  frames: Array.from({ length: n }, (_, f) => ({
    frame: f,
    safe: every === 0 ? false : random() < 1 / every,
  })),
});

test("cut point lookups give what the old full scans gave", () => {
  for (const [n, every] of [
    [1, 1],
    [5, 0],
    [40, 3],
    [500, 30],
    [3000, 250],
  ]) {
    const idx = index(n, every);
    for (let k = 0; k < 300; k++) {
      const frame = Math.floor(random() * (n + 3)) - 1;
      for (const end of [false, true]) {
        let expected, actual;
        try {
          expected = oldSnap(idx, frame, { end });
        } catch (e) {
          expected = e.message;
        }
        try {
          actual = trim.snap(idx, frame, { end });
        } catch (e) {
          actual = e.message;
        }
        assert.equal(actual, expected, `n=${n} frame=${frame} end=${end}`);
      }
      // Smart cut: the copied middle of a range [from, to).
      const from = Math.floor(random() * n);
      const to = from + 1 + Math.floor(random() * (n - from));
      const [a, b] = oldEnds(idx, from, to);
      const parts = trim.pieces({ idx, from, to }, true);
      if (idx.frames.every((f) => f.safe)) continue;
      const copy = parts.find((p) => p.copy);
      if (a >= b) assert.ok(!copy, `n=${n} ${from}-${to}`);
      else
        assert.deepEqual([copy.from, copy.to], [a, b], `n=${n} ${from}-${to}`);
    }
  }
});
