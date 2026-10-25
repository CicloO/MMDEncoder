const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("MMD pipeline drains the source, waits for remux and removes intermediates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-pipe-"));
  const temp = path.join(dir, "encoded.tmp");
  const output = path.join(dir, "final.txt");
  const step = (script, ...args) => ({
    exe: process.execPath,
    args: ["-e", script, ...args],
  });
  try {
    const result = spawnSync(
      process.execPath,
      [path.resolve("backend/mmd-pipe.cjs")],
      {
        timeout: 10000,
        encoding: "utf8",
        env: {
          ...process.env,
          MMD_PIPE_JOB: JSON.stringify({
            steps: [
              {
                ...step(
                  "let n=0; process.stdin.on('data', b=>n+=b.length); process.stdin.on('end',()=>require('fs').writeFileSync(process.argv[1],String(n)));",
                  temp,
                ),
                pipeFrom: step("process.stdout.end(Buffer.alloc(2<<20));"),
              },
              step(
                "require('fs').copyFileSync(process.argv[1],process.argv[2]);",
                temp,
                output,
              ),
            ],
            temporary: [temp],
          }),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(fs.readFileSync(output, "utf8"), String(2 << 20));
    assert.equal(fs.existsSync(temp), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MMD pipeline propagates producer and consumer failures and skips remux", () => {
  for (const failing of ["source", "encoder"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-pipe-fail-"));
    const temp = path.join(dir, "encoded.tmp");
    const output = path.join(dir, "must-not-exist");
    fs.writeFileSync(temp, "temporary");
    const step = (script) => ({ exe: process.execPath, args: ["-e", script] });
    try {
      const result = spawnSync(
        process.execPath,
        [path.resolve("backend/mmd-pipe.cjs")],
        {
          timeout: 10000,
          encoding: "utf8",
          env: {
            ...process.env,
            MMD_PIPE_JOB: JSON.stringify({
              steps: [
                {
                  ...step(
                    failing === "encoder"
                      ? "process.exit(9)"
                      : "process.stdin.resume()",
                  ),
                  pipeFrom: step(
                    failing === "source"
                      ? "process.exit(7)"
                      : "setInterval(()=>process.stdout.write(Buffer.alloc(4096)),1)",
                  ),
                },
                step(
                  `require('fs').writeFileSync(${JSON.stringify(output)},'bad')`,
                ),
              ],
              temporary: [temp],
            }),
          },
        },
      );
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(output), false);
      assert.equal(fs.existsSync(temp), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
