const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { appError } = require("../backend/errors.cjs");
const {
  workerErrorRecord,
  createWorkerErrorReader,
  ERROR_PREFIX,
} = require("../backend/worker-protocol.cjs");
const { createAlignService } = require("../backend/align-service.cjs");
const { decodeS16 } = require("../backend/align.cjs");
const { ff } = require("./engines.cjs");

test("worker errors preserve full JSON and split UTF-8 independently of diagnostic limits", () => {
  const reader = createWorkerErrorReader();
  const error = appError("FUTURE_WORKER", {
    count: 120,
    detail: "日文と中文".repeat(1200),
  });
  error.message = "future fallback";
  const bytes = Buffer.from("external diagnostic\n" + workerErrorRecord(error));
  for (let i = 0; i < bytes.length; i++) reader.write(bytes.subarray(i, i + 1));
  const result = reader.finish(1);
  assert.equal(result.code, "FUTURE_WORKER");
  assert.equal(result.params.count, 120);
  assert.equal(
    result.params.detail,
    error.params.detail + "\nexternal diagnostic",
  );
  assert.equal(result.message, "future fallback");
  const plain = createWorkerErrorReader();
  plain.write(
    Buffer.from(
      "x".repeat(80000) + "\n" + ERROR_PREFIX + "{bad json}\nraw diagnostic",
    ),
  );
  const fallback = plain.finish(9);
  assert.equal(fallback.code, "ALIGN_FAILED");
  assert.ok(fallback.params.detail.includes("{bad json}"));
  assert.ok(fallback.params.detail.endsWith("raw diagnostic"));
  assert.ok(fallback.params.detail.length <= 4000);
});

function runWorker(job) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve("backend/align-worker.cjs")],
      {
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          MMD_ALIGN_JOB: typeof job === "string" ? job : JSON.stringify(job),
        },
      },
    );
    const out = [],
      err = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("Worker timed out"));
    }, 15000);
    child.on("error", reject);
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

test("real worker emits untouched PCM on success and structured stderr on malformed requests or alignment failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-worker-contract-"));
  try {
    const file = path.join(dir, "短音频.wav");
    execFileSync(ff, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=d=0.2:r=24000",
      file,
    ]);
    const success = await runWorker({
      mode: "preview",
      ffmpeg: ff,
      file,
      rate: 24000,
    });
    assert.equal(success.code, 0);
    assert.deepEqual(success.stdout, await decodeS16(ff, file, 24000));
    assert.equal(success.stderr.length, 0);
    const short = await runWorker({
      mode: "align",
      ffmpeg: ff,
      reference: file,
      target: file,
    });
    assert.equal(short.code, 1);
    assert.equal(short.stdout.length, 0);
    const reader = createWorkerErrorReader();
    reader.write(short.stderr);
    const error = reader.finish(short.code);
    assert.equal(error.code, "ALIGN_TOO_SHORT");
    assert.deepEqual(error.params, { seconds: 1 });
    const malformed = await runWorker("{broken");
    assert.equal(malformed.code, 1);
    assert.equal(malformed.stdout.length, 0);
    const invalid = createWorkerErrorReader();
    invalid.write(malformed.stderr);
    assert.equal(invalid.finish(1).code, "ALIGN_REQUEST_INVALID");
    const svc = createAlignService({
      engineInfo: () => ({ ffmpeg: ff }),
      locate: async () => {},
    });
    try {
      await assert.rejects(
        svc.queries.alignRun({ reference: file, target: file }),
        (e) => e.code === "ALIGN_TOO_SHORT" && e.params.seconds === 1,
      );
      await assert.rejects(
        svc.queries.alignPreview({ path: path.join(dir, "不存在.wav") }),
        (e) =>
          e.code === "ALIGN_DECODE_FAILED" &&
          /No such file|Error opening/.test(e.params.detail),
      );
    } finally {
      svc.stopAll();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
