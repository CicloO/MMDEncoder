require("./isolate.cjs");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  cp = require("node:child_process");
const core = require("../backend/core.cjs");
const { createEncoder } = require("../backend/encode-job.cjs");
const { createRunner } = require("../backend/process-runner.cjs");
const { commit } = require("../backend/commit.cjs");
const { ff, fp, nv } = require("./engines.cjs");
const nop = () => {};
const probe = (file) =>
  JSON.parse(
    cp.execFileSync(
      fp,
      ["-v", "error", "-count_frames", "-show_streams", "-of", "json", file],
      { encoding: "utf8", windowsHide: true },
    ),
  ).streams[0];
function harness(
  dir,
  {
    available = ["libx264", "h264_nvenc", "hevc_nvenc", "nvencc:hevc"],
    fault,
    failCommit = false,
    stopped = false,
  } = {},
) {
  let active,
    calls = [],
    stoppedNow = stopped;
  const children = new Set();
  const runner = createRunner({
    isDisposed: () => false,
    children,
    getActive: () => active,
    setActive: (v) => {
      active = v;
    },
  });
  function options(args) {
    calls.push(args);
    if (args.includes("hevc_nvenc") && fault) {
      if (fault === "gpu") {
        const a = [...args];
        a.splice(a.indexOf("hevc_nvenc") + 1, 0, "-gpu", "99");
        return a;
      }
      if (fault === "cancel") stoppedNow = true;
      throw Object.assign(
        Error("external diagnostic: " + fault),
        fault === "timeout"
          ? { timedOut: true }
          : fault === "colour"
            ? { processIndex: 1 }
            : fault === "mux"
              ? { processIndex: 2 }
              : fault === "cancel"
                ? { cancelled: true }
                : { systemCode: fault },
      );
    }
    return args;
  }
  const run = (exe, args, o) => runner(exe, options(args), o);
  run.piped = (c, o) =>
    runner.piped(
      { ...c, pipeFrom: { ...c.pipeFrom, args: options(c.pipeFrom.args) } },
      o,
    );
  const encode = createEncoder({
    engineInfo: () => ({ ffmpeg: ff, nvencc: nv, nvencLossless: true }),
    engines: () => core.ENGINES.filter((e) => available.includes(e.id)),
    verification: () => ({}),
    isStopped: () => stoppedNow,
    jobIndex: () => 1,
    nameSource: (j) => j.path,
    appendEvidence: nop,
    run,
    commit: async (tmp, out) => {
      if (failCommit && out.includes("_alpha"))
        throw Object.assign(Error("mask commit denied"), { code: "EACCES" });
      await commit(tmp, out);
    },
    emit: nop,
    emitProgress: nop,
  });
  return {
    encode,
    calls,
    children,
    setCommitFailure: (v) => {
      failCommit = v;
    },
    setFault: (v) => {
      fault = v;
    },
  };
}
function job(dir, source, patch = {}) {
  return {
    id: "mask",
    path: source,
    name: "alpha.mkv",
    meta: {
      width: 320,
      height: 180,
      hasAlpha: true,
      fps: 30,
      fpsText: "30/1",
      duration: 0.3,
      codec: "ffv1",
    },
    status: "ready",
    progress: 0,
    settings: {
      ...core.DEFAULTS,
      encoder: "libx264",
      preset: "veryfast",
      container: "mkv",
      alphaMask: true,
      maskFormat: "gpu-lossy",
      audio: "none",
      outputMode: "custom",
      outputDir: dir,
      ...patch,
    },
  };
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mask-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "alpha.mkv");
  cp.execFileSync(
    ff,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=320x180:r=30:d=0.3,format=yuva444p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='X*255/W'",
      "-c:v",
      "ffv1",
      source,
    ],
    { windowsHide: true, stdio: "pipe" },
  );
  return { dir, source };
}
test(
  "actual paired and mask-only lossy GPU encodes, H.264 fallback, and unavailable/size CPU fallback retain coded notes",
  { timeout: 60000 },
  async (t) => {
    const { dir, source } = await fixture(t);
    for (const [name, patch, available, codec, note] of [
      ["hevc", {}, undefined, "hevc"],
      ["only", { alphaMode: "mask", alphaMask: false }, undefined, "hevc"],
      ["h264", {}, ["libx264", "h264_nvenc"], "h264"],
      ["unavailable", {}, ["libx264"], "h264", "MASK_GPU_UNAVAILABLE"],
      [
        "small",
        { resizeMode: "custom", keepAspect: false, width: 64, height: 64 },
        undefined,
        "h264",
        "MASK_GPU_SIZE_FALLBACK",
      ],
      ["x264", { maskFormat: "x264-lossy" }, undefined, "h264"],
      [
        "webm",
        {
          container: "webm",
          encoder: "libvpx-vp9",
          preset: "medium",
          alphaMode: "mask",
          alphaMask: false,
        },
        undefined,
        "vp9",
      ],
    ]) {
      const h = harness(dir, { available }),
        j = job(path.join(dir, name), source, patch);
      await h.encode(j);
      assert.equal(j.status, "done", j.log);
      assert.equal(h.children.size, 0);
      const p = probe(j.maskOutput || j.output);
      assert.equal(p.codec_name, codec);
      assert.equal(p.nb_read_frames, "9");
      assert.equal(j.noteData?.code, note);
      if (note) assert.match(j.log, /CRF 18/);
    }
  },
);
test(
  "a real GPU initialization error retries once with x264, and a subsequent clean run clears the old note",
  { timeout: 30000 },
  async (t) => {
    const { dir, source } = await fixture(t),
      h = harness(dir, { fault: "gpu" }),
      j = job(path.join(dir, "out"), source);
    await h.encode(j);
    assert.equal(j.status, "done", j.log);
    assert.equal(j.noteData.code, "MASK_GPU_RUNTIME_FALLBACK");
    assert.match(j.log, /GPU|device|No capable|Invalid gpu/i);
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls[0].includes("hevc_nvenc"));
    assert.ok(h.calls[1].includes("libx264"));
    assert.equal(probe(j.maskOutput).codec_name, "h264");
    assert.equal(h.children.size, 0);
    h.setFault(undefined);
    j.status = "ready";
    await h.encode(j);
    assert.equal(j.status, "done", j.log);
    assert.equal(j.noteData, undefined);
    assert.equal(probe(j.maskOutput).codec_name, "hevc");
  },
);
test(
  "mask-only GPU retry after a partial commit preserves the already committed colour video",
  { timeout: 30000 },
  async (t) => {
    const { dir, source } = await fixture(t),
      h = harness(dir, { failCommit: true }),
      j = job(path.join(dir, "out"), source);
    await h.encode(j);
    assert.equal(j.status, "partial", j.log);
    assert.equal(h.calls.length, 1);
    const before = fs.readFileSync(j.output),
      stamp = fs.statSync(j.output).mtimeMs;
    h.setCommitFailure(false);
    h.setFault("gpu");
    await h.encode(j);
    assert.equal(j.status, "done", j.log);
    assert.equal(j.noteData.code, "MASK_GPU_RUNTIME_FALLBACK");
    assert.equal(h.calls.length, 3);
    assert.deepEqual(fs.readFileSync(j.output), before);
    assert.equal(fs.statSync(j.output).mtimeMs, stamp);
    assert.equal(probe(j.maskOutput).codec_name, "h264");
  },
);
test(
  "cancel, timeout, storage, missing source and downstream colour/mux errors never trigger the lossy GPU-mask fallback",
  { timeout: 30000 },
  async (t) => {
    const { dir, source } = await fixture(t);
    for (const fault of [
      "cancel",
      "timeout",
      "ENOSPC",
      "ENOENT",
      "EACCES",
      "colour",
      "mux",
    ]) {
      const h = harness(dir, { fault }),
        j = job(path.join(dir, fault), source);
      await h.encode(j);
      assert.equal(
        j.status,
        fault === "cancel" ? "cancelled" : "failed",
        j.log,
      );
      assert.equal(h.calls.length, 1, fault);
      assert.equal(j.noteData, undefined);
      assert.equal(j.output, undefined);
      assert.ok(
        !fs
          .readdirSync(j.settings.outputDir)
          .some((n) => n.startsWith(".mmd-")),
      );
      assert.equal(h.children.size, 0);
    }
  },
);
