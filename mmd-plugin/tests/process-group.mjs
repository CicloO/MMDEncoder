import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-job-"));
const childScript = path.join(dir, "children.cjs");
const helper = path.join(dir, "helper.cjs");
const pidFile = path.join(dir, "pids.json");
fs.writeFileSync(
  childScript,
  "process.stdin.resume();setInterval(()=>{},1000);",
);
fs.writeFileSync(
  helper,
  `const {spawn}=require('node:child_process');const children=Array.from({length:3},()=>spawn(process.execPath,[${JSON.stringify(childScript)}],{stdio:'ignore',windowsHide:true}));require('fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,...children.map(c=>c.pid)]));setInterval(()=>{},1000);`,
);
const fixture = spawn(
  path.resolve("mmd-plugin/build/process-check.exe"),
  [process.execPath, helper],
  { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
let output = "";
fixture.stdout.on("data", (b) => (output += b));
fixture.stderr.on("data", (b) => (output += b));
const ended = new Promise((resolve, reject) => {
  fixture.on("error", reject);
  fixture.on("exit", (code) => resolve(code));
});
try {
  for (let i = 0; i < 300 && !fs.existsSync(pidFile); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(fs.existsSync(pidFile), output);
  const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
  for (const pid of pids) process.kill(pid, 0);
  fixture.stdin.end("\n");
  assert.equal(await ended, 0, output);
  for (let i = 0; i < 300; i++) {
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!alive.length) break;
    if (i === 299) assert.fail("orphan PIDs " + alive);
    await new Promise((r) => setTimeout(r, 10));
  }
  console.log(
    "Explicit TerminateJobObject: helper + three descendants exited",
    JSON.stringify(pids),
  );
} finally {
  fixture.kill();
  await ended;
  fs.rmSync(dir, { recursive: true, force: true });
}
// The opposite boundary: losing the owner must deliver EOF and keep a
// recoverable trailer, rather than force-killing the same descendants.
await import("./crash-recovery.mjs");
