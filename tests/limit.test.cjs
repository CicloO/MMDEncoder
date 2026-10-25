const test = require("node:test");
const assert = require("node:assert/strict");
const { createLimit } = require("../backend/limit.cjs");

test("at most n tasks run at once, started in order, and a failure stays its own", async () => {
  const limit = createLimit(4);
  let active = 0,
    most = 0;
  const started = [];
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      limit(async () => {
        started.push(i);
        most = Math.max(most, ++active);
        await new Promise((r) => setTimeout(r, 5 + (i % 3)));
        active--;
        if (i === 7) throw Error("bad file");
        return i;
      }),
    ),
  );
  assert.equal(most, 4);
  assert.deepEqual(
    started,
    Array.from({ length: 20 }, (_, i) => i),
  );
  assert.equal(results[7].status, "rejected");
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 19);
  assert.equal(results[19].value, 19);
});
