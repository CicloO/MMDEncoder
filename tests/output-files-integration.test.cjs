require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const { createEncoder } = require("../backend/encode-job.cjs");
const { commit } = require("../backend/commit.cjs");
const { uiState } = require("../backend/ui-state.cjs");
const core = require("../backend/core.cjs");
const { ff } = require("./engines.cjs");

test(
  "real committed outputs project final ordinary, paired, mask-only, partial and collision-numbered filenames",
  { timeout: 60000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-output-paths-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const input = path.join(dir, "User 视频.mkv");
    cp.execFileSync(ff, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red@0.5:s=160x90:r=30:d=0.3,format=yuva444p",
      "-c:v",
      "ffv1",
      input,
    ]);
    const calls = [];
    const run = async (exe, args) => {
      calls.push(args);
      return {
        stdout: cp.execFileSync(exe, args, {
          encoding: "utf8",
          maxBuffer: 1 << 24,
        }),
        stderr: "",
      };
    };
    let failMask = false;
    const encode = createEncoder({
      engineInfo: () => ({ ffmpeg: ff, nvencLossless: false }),
      engines: () => core.ENGINES,
      verification: () => ({}),
      isStopped: () => false,
      jobIndex: () => 1,
      nameSource: (j) => j.path,
      appendEvidence: () => {},
      run,
      commit: async (tmp, dest) => {
        if (failMask && path.basename(dest).includes("_alpha"))
          throw Object.assign(new Error("injected mask commit refusal"), {
            code: "EACCES",
          });
        await commit(tmp, dest);
      },
      emit: () => {},
      emitProgress: () => {},
    });
    const job = (patch = {}) => ({
      id: "job",
      path: input,
      name: "User 视频.mkv",
      status: "ready",
      progress: 0,
      settings: {
        ...core.DEFAULTS,
        encoder: "libx264",
        preset: "veryfast",
        outputMode: "custom",
        outputDir: path.join(dir, "out"),
        ...patch,
      },
      meta: {
        width: 160,
        height: 90,
        fps: 30,
        duration: 0.3,
        hasAlpha: true,
        pixFmt: "yuva444p",
        codec: "ffv1",
      },
    });
    const project = (j) => uiState({ jobs: [j], mediaJobs: [] }).jobs[0];
    const ordinary = job();
    await encode(ordinary);
    assert.equal(ordinary.status, "done", ordinary.log);
    assert.equal(project(ordinary).output, ordinary.output);
    assert.equal(project(ordinary).maskOutput, undefined);
    assert.ok(fs.existsSync(ordinary.output));
    const pair = job({ alphaMask: true });
    await encode(pair);
    assert.equal(pair.status, "done", pair.log);
    assert.match(project(pair).output, /User 视频 \(2\)\.mp4$/);
    assert.match(project(pair).maskOutput, /User 视频 \(2\)_alpha\.mp4$/);
    assert.ok(fs.existsSync(pair.output) && fs.existsSync(pair.maskOutput));
    const mask = job({ alphaMode: "mask" });
    await encode(mask);
    assert.equal(mask.status, "done", mask.log);
    assert.match(project(mask).output, /User 视频_alpha\.mp4$/);
    assert.equal(project(mask).maskOutput, undefined);
    const partial = job({ alphaMask: true });
    failMask = true;
    await encode(partial);
    assert.equal(partial.status, "partial", partial.log);
    assert.ok(fs.existsSync(project(partial).output));
    assert.equal(project(partial).maskOutput, undefined);
    assert.ok(
      partial.maskOutput,
      "the retry retains the planned path internally",
    );
    const colour = fs.readFileSync(partial.output);
    const beforeRetry = calls.length;
    failMask = false;
    await encode(partial);
    assert.equal(partial.status, "done", partial.log);
    assert.equal(calls.length - beforeRetry, 1);
    assert.deepEqual(fs.readFileSync(partial.output), colour);
    assert.ok(fs.existsSync(project(partial).maskOutput));
  },
);
