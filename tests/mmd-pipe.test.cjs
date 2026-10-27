require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const step = (script) => ({ exe: process.execPath, args: ["-e", script] });
test(
  "MMD helper streams all three stages; failures stop peers, remove partial outputs and skip later steps",
  { timeout: 30000 },
  () => {
    for (const failing of [-1, 0, 1, 2]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-chain-"));
      const output = path.join(dir, "video.bin"),
        mask = path.join(dir, "mask.bin"),
        after = path.join(dir, "after");
      const make = (i, script) =>
        step(
          `require('fs').writeFileSync(${JSON.stringify(path.join(dir, i + ".pid"))},String(process.pid));` +
            (failing === i
              ? "setTimeout(()=>process.exit(9),100);process.stdin.resume();"
              : script),
        );
      try {
        const c = {
          ...make(1, "process.stdin.pipe(process.stdout);"),
          pipeFrom: make(
            0,
            `require('fs').writeFileSync(${JSON.stringify(mask)},'partial');process.stdin.pipe(process.stdout);`,
          ),
          pipeTo: make(
            2,
            `process.stdin.pipe(require('fs').createWriteStream(${JSON.stringify(output)}));`,
          ),
        };
        const r = spawnSync(
          process.execPath,
          [path.resolve("backend/mmd-pipe.cjs")],
          {
            env: {
              ...process.env,
              MMD_PIPE_JOB: JSON.stringify({
                steps: [
                  c,
                  step(
                    `require('fs').writeFileSync(${JSON.stringify(after)},'done');`,
                  ),
                ],
                outputs: [output, mask],
              }),
            },
            input: Buffer.alloc(2 << 20, 173),
            encoding: "utf8",
            timeout: 10000,
            windowsHide: true,
          },
        );
        assert.equal(r.error, undefined, r.error?.message);
        if (failing === -1) {
          assert.equal(r.status, 0, r.stderr);
          assert.deepEqual(fs.readFileSync(output), Buffer.alloc(2 << 20, 173));
          assert.ok(fs.existsSync(after));
        } else {
          assert.notEqual(r.status, 0);
          for (const f of [output, mask, after])
            assert.equal(fs.existsSync(f), false);
        }
        for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".pid"))) {
          const pid = Number(fs.readFileSync(path.join(dir, f), "utf8"));
          assert.throws(
            () => process.kill(pid, 0),
            "surviving MMD child " + pid,
          );
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);

test(
  "MMD helper registered cancellation handlers reap every peer, remove partial outputs and skip the finish step",
  { timeout: 30000 },
  async () => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-helper-cancel-"));
      assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
      let helper;
      const output = path.join(dir, "video.bin"),
        mask = path.join(dir, "mask.bin"),
        after = path.join(dir, "after"),
        fired = path.join(dir, "cancel-fired.json");
      const pidFiles = [0, 1, 2].map((i) => path.join(dir, i + ".pid"));
      const make = (i, script) =>
        step(
          `require('fs').writeFileSync(${JSON.stringify(pidFiles[i])},String(process.pid));` +
            script,
        );
      const alive = (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (e) {
          if (e.code === "ESRCH") return false;
          throw e;
        }
      };
      try {
        const command = {
          ...make(1, "process.stdin.pipe(process.stdout)"),
          pipeFrom: make(
            0,
            `require('fs').writeFileSync(${JSON.stringify(mask)},'partial');setInterval(()=>process.stdout.write('bytes'),20)`,
          ),
          pipeTo: make(
            2,
            `process.stdin.pipe(require('fs').createWriteStream(${JSON.stringify(output)}))`,
          ),
        };
        // Windows kill(SIGTERM) may terminate Node without running a JS handler.
        // A test bootstrap emits the registered event after all real peers and
        // both output files exist; this verifies the handler, not OS delivery.
        const bootstrap = `
const fs=require('node:fs');
const timer=setInterval(()=>{if(${JSON.stringify([...pidFiles, output, mask])}.every(f=>fs.existsSync(f))){clearInterval(timer);const listeners=process.listenerCount(${JSON.stringify(signal)});const handled=process.emit(${JSON.stringify(signal)});fs.writeFileSync(${JSON.stringify(fired)},JSON.stringify({signal:${JSON.stringify(signal)},listeners,handled}));}},10);timer.unref();
require(${JSON.stringify(path.resolve("backend/mmd-pipe.cjs"))});`;
        helper = spawn(process.execPath, ["-e", bootstrap], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            MMD_PIPE_JOB: JSON.stringify({
              steps: [
                command,
                step(
                  `require('fs').writeFileSync(${JSON.stringify(after)},'done')`,
                ),
              ],
              outputs: [output, mask],
            }),
          },
        });
        let stderr = "";
        helper.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        const code = await new Promise((resolve, reject) => {
          helper.once("error", reject);
          helper.once("close", resolve);
        });
        assert.equal(code, 1, stderr);
        const emitted = JSON.parse(fs.readFileSync(fired));
        assert.equal(emitted.signal, signal);
        assert.ok(emitted.listeners > 0);
        assert.equal(emitted.handled, true);
        for (const file of [output, mask, after])
          assert.equal(fs.existsSync(file), false);
        for (const file of pidFiles) {
          const pid = Number(fs.readFileSync(file, "utf8"));
          for (let i = 0; i < 100 && alive(pid); i++)
            await new Promise((r) => setTimeout(r, 10));
          assert.equal(alive(pid), false, "surviving helper child " + pid);
        }
      } finally {
        if (helper?.exitCode === null) helper.kill();
        for (const file of pidFiles)
          if (fs.existsSync(file)) {
            const pid = Number(fs.readFileSync(file, "utf8"));
            if (alive(pid)) process.kill(pid);
          }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);
