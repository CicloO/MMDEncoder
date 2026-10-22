require("./isolate.cjs");
const fs = require("node:fs"),
  path = require("node:path"),
  { promisify } = require("node:util"),
  { execFile } = require("node:child_process");
const { createTools } = require("../backend/tools.cjs"),
  { probe } = require("../backend/enhancements.cjs"),
  { DEFAULTS } = require("../backend/core.cjs");
const exec = promisify(execFile),
  root = path.resolve(__dirname, "../verification");
fs.mkdirSync(root, { recursive: true });
const tools = createTools({
  root: process.env.MMD_TEST_TOOLS_ROOT || path.join(root, "tools-live"),
}).paths();
(async () => {
  const results = [];
  const cases = process.env.MMD_RTX_FPS
    ? [
        [
          "vsr-custom-fps",
          {
            vsr: true,
            vsrQuality: 1,
            vsrScale: 2,
            fps: process.env.MMD_RTX_FPS,
          },
        ],
      ]
    : [
        [
          "vsr",
          {
            vsr: true,
            vsrQuality: Number(process.env.MMD_VSR_QUALITY || 1),
            vsrScale: 2,
          },
        ],
        ["vfg", { vfg: true, vfgMultiplier: 2, vfgMode: "medium" }],
      ];
  const run = (exe, args, options = {}) =>
    exec(exe, args, {
      timeout: options.timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  run.piped = (c, options) =>
    new Promise((resolve, reject) => {
      const { spawn } = require("node:child_process");
      const a = spawn(c.pipeFrom.exe, c.pipeFrom.args, { windowsHide: true }),
        b = spawn(c.exe, c.args, { windowsHide: true });
      let log = "",
        remaining = 2,
        failed = false;
      const timer = setTimeout(() => {
        a.kill();
        b.kill();
        reject(Error("pipeline timeout"));
      }, options.timeout);
      for (const child of [a, b]) {
        child.stderr.on("data", (d) => (log += d));
        child.on("error", (e) => {
          clearTimeout(timer);
          a.kill();
          b.kill();
          reject(e);
        });
        child.on("close", (code) => {
          failed ||= code !== 0;
          if (--remaining === 0) {
            clearTimeout(timer);
            failed ? reject(Error(log)) : resolve({ stdout: "", stderr: log });
          }
        });
      }
      a.stdout.pipe(b.stdin);
      b.stdin.on("error", () => {});
      b.stdout.resume();
    });
  for (const [name, patch] of cases) {
    let log = "";
    try {
      log = await probe(
        { ...DEFAULTS, encoder: "nvencc:hevc", preset: "p4", ...patch },
        tools,
        run,
      );
      results.push({ name, status: "passed", settings: patch });
    } catch (e) {
      log =
        String(e.message) + "\n" + (e.stdout || "") + "\n" + (e.stderr || "");
      results.push({
        name,
        status: "failed",
        settings: patch,
        error: e.killed ? "timeout" : e.message,
      });
    }
    fs.writeFileSync(path.join(root, `rtx-${name}.log`), log);
    console.log(name, results.at(-1).status);
  }
  fs.writeFileSync(
    path.join(
      root,
      process.env.MMD_RTX_FPS ? "rtx-custom-fps.json" : "rtx-live.json",
    ),
    JSON.stringify({ date: new Date().toISOString(), tools, results }, null, 2),
  );
  if (results.some((r) => r.status !== "passed")) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
