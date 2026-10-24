require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { uiState } = require("../backend/ui-state.cjs");
const { createService } = require("../backend/service.cjs");

const queue = (n, log) => ({
  jobs: Array.from({ length: n }, (_, i) => ({ id: "v" + i, log })),
  mediaJobs: Array.from({ length: n }, (_, i) => ({ id: "m" + i, log })),
  settings: { encoder: "libx264" },
});

test("the window's state leaves out video logs and keeps only media log tails", () => {
  const s = uiState(queue(3, "x".repeat(200000)));
  assert.ok(s.jobs.every((j) => !("log" in j)));
  assert.ok(s.mediaJobs.every((j) => j.log.length === 8001));
  assert.ok(s.mediaJobs[0].log.startsWith("…"));
  // A copy: changing it does not touch the service's state.
  const state = queue(1, "short");
  uiState(state).settings.encoder = "changed";
  assert.equal(state.settings.encoder, "libx264");
});

test("action responses and pushes are the window's state, not the full one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-ui-state-"));
  const pushes = [];
  const svc = createService({
    dataDir: path.join(dir, "data"),
    engineDir: path.join(dir, "none"),
    onUpdate: (s) => pushes.push(s),
  });
  try {
    svc.invoke("state");
    const full = svc.getState();
    assert.ok(Array.isArray(full.jobs));
    const response = await svc.invoke("state");
    assert.deepEqual(Object.keys(response).sort(), Object.keys(full).sort());
    for (const s of [response, svc.uiState(), ...pushes])
      assert.ok(s.jobs.every((j) => !("log" in j)));
    assert.equal(typeof svc.isBusy(), "boolean");
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
