require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const trim = require("../backend/trim.cjs");
const { engineDir } = require("./engines.cjs");

// trim.index replaced: counts reads, finishes when told, honours the abort.
function stubIndex() {
  const calls = [];
  const real = trim.index;
  trim.index = (tools, file, { signal } = {}) =>
    new Promise((resolve, reject) => {
      const call = { file, aborted: false, finish: null };
      calls.push(call);
      call.finish = () =>
        resolve({
          supported: true,
          codec: "h264",
          width: 64,
          height: 64,
          fps: 30,
          frames: Array.from({ length: 30 }, (_, f) => ({
            frame: f,
            key: f % 10 === 0,
            safe: f % 10 === 0,
          })),
        });
      signal?.addEventListener("abort", () => {
        call.aborted = true;
        reject(Object.assign(Error("cancelled"), { cancelled: true }));
      });
    });
  return { calls, restore: () => (trim.index = real) };
}
const until = async (f, ms = 5000) => {
  for (const end = Date.now() + ms; !f();)
    if (Date.now() > end) throw Error("timed out");
    else await new Promise((r) => setTimeout(r, 10));
};

test("a file added again shares its index, finished or still being read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-share-"));
  const file = path.join(dir, "a.mp4");
  const other = path.join(dir, "b.mp4");
  fs.writeFileSync(file, "x");
  fs.writeFileSync(other, "y");
  const stub = stubIndex();
  delete require.cache[require.resolve("../backend/service.cjs")];
  const { createService } = require("../backend/service.cjs");
  const svc = createService({
    dataDir: path.join(dir, "data"),
    engineDir,
    mmdPluginDll: "",
  });
  const clips = () => svc.getState().trim.clips;
  try {
    // Two adds of one file at once: one read.
    const first = svc.invoke("trimAdd", { paths: [file] });
    const second = svc.invoke("trimAdd", { paths: [file] });
    await until(() => stub.calls.length === 1 && clips().length === 2);
    stub.calls[0].finish();
    await Promise.all([first, second]);
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(
      clips().map((c) => c.status),
      ["ready", "ready"],
    );
    // Added again later: the finished index is used, no read.
    await svc.invoke("trimAdd", { paths: [file] });
    assert.equal(stub.calls.length, 1);
    assert.equal(clips()[2].status, "ready");
    // Another file is read; removing one of two clips waiting for it does
    // not stop the read, removing both does.
    const b1 = svc.invoke("trimAdd", { paths: [other] });
    const b2 = svc.invoke("trimAdd", { paths: [other] });
    await until(() => stub.calls.length === 2 && clips().length === 5);
    const waiting = clips().filter((c) => c.path === other);
    await svc.invoke("trimRemove", { id: waiting[0].id });
    assert.equal(stub.calls[1].aborted, false);
    await svc.invoke("trimRemove", { id: waiting[1].id });
    assert.equal(stub.calls[1].aborted, true);
    await Promise.all([b1, b2]);
    assert.equal(clips().filter((c) => c.path === other).length, 0);
  } finally {
    stub.restore();
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
