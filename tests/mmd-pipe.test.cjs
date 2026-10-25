require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
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
