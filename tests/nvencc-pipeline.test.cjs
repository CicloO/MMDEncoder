require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createRunner } = require("../backend/process-runner.cjs");
const core = require("../backend/core.cjs");
const step = (script) => ({ exe: process.execPath, args: ["-e", script] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function chain(dir, failing, forever = false) {
  const make = (i, script) =>
    step(
      `require('fs').writeFileSync(${JSON.stringify(path.join(dir, i + ".pid"))}, String(process.pid));` +
        (failing === i
          ? "setTimeout(()=>process.exit(23),100);process.stdin.resume();"
          : script),
    );
  return {
    ...make(1, "process.stdin.pipe(process.stdout);"),
    pipeFrom: make(
      0,
      forever
        ? "setInterval(()=>process.stdout.write(Buffer.alloc(4096)),10);"
        : "process.stdout.end(Buffer.alloc(2<<20, 173));",
    ),
    pipeTo: make(
      2,
      "let n=0;process.stdin.on('data',b=>n+=b.length).on('end',()=>process.stdout.write(String(n)));",
    ),
  };
}
function noOrphans(dir) {
  for (const name of fs.readdirSync(dir).filter((x) => x.endsWith(".pid"))) {
    const pid = Number(fs.readFileSync(path.join(dir, name), "utf8"));
    assert.equal(alive(pid), false, "surviving pipeline PID " + pid);
  }
}
test(
  "three-process runner drains bytes; every failure, spawn error, timeout and cancellation reaps the entire chain",
  { timeout: 30000 },
  async () => {
    for (const mode of ["ok", 0, 1, 2, "spawn", "timeout", "cancel"]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-life-"));
      const children = new Set();
      let active;
      const run = createRunner({
        isDisposed: () => false,
        children,
        getActive: () => active,
        setActive: (v) => {
          active = v;
        },
      });
      try {
        const c = chain(dir, mode, mode !== "ok");
        if (mode === "spawn") c.exe = path.join(dir, "missing-executable");
        const result = run.piped(c, {
          encoding: true,
          timeout: mode === "timeout" ? 350 : 5000,
        });
        const checked = mode === "ok" ? result : assert.rejects(result);
        if (mode === "cancel") {
          for (let i = 0; i < 200 && fs.readdirSync(dir).length < 3; i++)
            await wait(10);
          assert.equal(fs.readdirSync(dir).length, 3);
          active.kill();
        }
        const value = await checked;
        if (mode === "ok") assert.equal(value.stdout, String(2 << 20));
        assert.equal(children.size, 0);
        assert.equal(active, null);
        noOrphans(dir);
      } finally {
        active?.kill();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);
test(
  "PowerShell copied command runs all three byte streams and kills peers on failures",
  { timeout: 60000 },
  () => {
    for (const mode of ["ok", 0, 1, 2]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-copy-"));
      try {
        const c = chain(dir, mode, mode !== "ok");
        const script = path.join(dir, "copy.ps1");
        fs.writeFileSync(
          script,
          "\uFEFF" + core.commandText([c], { prepare: true }),
        );
        const r = spawnSync("pwsh", ["-NoProfile", "-File", script], {
          encoding: "utf8",
          timeout: 15000,
          windowsHide: true,
        });
        assert.equal(r.error, undefined, r.error?.message);
        if (mode === "ok") {
          assert.equal(r.status, 0, r.stderr);
          assert.match(r.stdout, /2097152/);
        } else assert.notEqual(r.status, 0);
        noOrphans(dir);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);
test(
  "copied scripts publish only complete files and preserve an output created during encoding",
  { timeout: 30000 },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-publish-"));
    try {
      for (const mode of ["ok", "failure", "collision"]) {
        const output = path.join(dir, mode + ".bin"),
          script = path.join(dir, mode + ".ps1");
        const c = {
          ...step("process.stdin.pipe(process.stdout);"),
          output,
          pipeFrom: step("process.stdout.end(Buffer.alloc(2<<20,173));"),
          pipeTo: {
            exe: process.execPath,
            args: [
              "-e",
              `const fs=require('fs');process.stdin.pipe(fs.createWriteStream(process.argv[1]));` +
                (mode === "failure"
                  ? "setTimeout(()=>process.exit(9),50);"
                  : mode === "collision"
                    ? `fs.writeFileSync(${JSON.stringify(output)},'user output');`
                    : ""),
              output,
            ],
          },
        };
        fs.writeFileSync(
          script,
          "\uFEFF" + core.commandText([c], { prepare: true }),
        );
        const r = spawnSync("pwsh", ["-NoProfile", "-File", script], {
          encoding: "utf8",
          timeout: 10000,
          windowsHide: true,
        });
        assert.equal(r.error, undefined, r.error?.message);
        if (mode === "ok") {
          assert.equal(r.status, 0, r.stderr);
          assert.deepEqual(fs.readFileSync(output), Buffer.alloc(2 << 20, 173));
        } else {
          assert.notEqual(r.status, 0);
          if (mode === "failure") assert.equal(fs.existsSync(output), false);
          else assert.equal(fs.readFileSync(output, "utf8"), "user output");
        }
        assert.ok(!fs.readdirSync(dir).some((n) => n.startsWith(".mmd-")));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  "real NVEncC and mux failures leave no committed video; the queue's software retry still succeeds",
  { timeout: 60000 },
  async () => {
    const { ff, fp, nv } = require("./engines.cjs");
    const { commit } = require("../backend/commit.cjs");
    const { createEncodeQueue } = require("../backend/encode-queue.cjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-real-fault-"));
    let active;
    const children = new Set();
    const native = createRunner({
      isDisposed: () => false,
      children,
      getActive: () => active,
      setActive: (v) => (active = v),
    });
    const source = path.join(dir, "source.mkv");
    try {
      let r = spawnSync(
        ff,
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=320x180:r=30:d=0.5",
          "-c:v",
          "ffv1",
          source,
        ],
        { windowsHide: true, encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      const data = JSON.parse(
        spawnSync(
          fp,
          [
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            source,
          ],
          { encoding: "utf8", windowsHide: true },
        ).stdout,
      );
      for (const fault of ["encoder", "mux"]) {
        const settings = {
          ...core.DEFAULTS,
          encoder: "nvencc:h264",
          preset: "p4",
          audio: "none",
          outputMode: "custom",
          outputDir: path.join(dir, fault),
        };
        const jobs = [
          {
            id: fault,
            path: source,
            meta: core.metadata(data),
            status: "ready",
          },
        ];
        const info = { ffmpeg: ff, ffprobe: fp, nvencc: nv };
        const run = (...args) => native(...args);
        run.piped = (c, o) =>
          native.piped(
            fault === "encoder"
              ? { ...c, args: [...c.args, "--test-invalid-option"] }
              : {
                  ...c,
                  pipeTo: {
                    ...c.pipeTo,
                    args: ["-test-invalid-option", ...c.pipeTo.args],
                  },
                },
            o,
          );
        let running = false,
          stopped = false;
        const queue = createEncodeQueue({
          getJobs: () => jobs,
          getSettings: () => settings,
          engineInfo: () => info,
          engines: () => core.ENGINES,
          verification: () => ({}),
          isRunning: () => running,
          isDetecting: () => false,
          locate: async () => {},
          setRunning: (v) => (running = v),
          isStopped: () => stopped,
          setStopped: (v) => (stopped = v),
          toolsBusy: () => false,
          trimExporting: () => false,
          waitDetection: async () => {},
          hasSoxr: async () => true,
          appendEvidence: () => {},
          run,
          commit,
          emit: () => {},
          emitProgress: () => {},
          flushEvidence: () => {},
          onNotice: () => {},
        });
        await queue.actions.start();
        while (running) await wait(10);
        const j = jobs[0];
        assert.equal(j.status, "failed", j.log);
        assert.equal(j.output, undefined);
        assert.equal(j.softwareRetry, true);
        assert.equal(children.size, 0);
        assert.ok(
          !fs
            .readdirSync(
              path.dirname(
                core.outputPaths(source, settings, 1, () => false).output,
              ),
            )
            .some((n) => n.startsWith(".mmd-")),
        );
        await queue.actions.retry({ id: j.id, software: true });
        while (running) await wait(10);
        assert.equal(j.status, "done", j.log);
        assert.equal(j.settings.encoder, "libx264");
        assert.ok(fs.existsSync(j.output));
      }
    } finally {
      active?.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
