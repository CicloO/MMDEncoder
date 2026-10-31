const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  { spawnSync } = require("node:child_process");
const { commandText } = require("../backend/command-text.cjs"),
  { createTranslator } = require("../locales/runtime.mjs"),
  source = require("../locales/zh-CN.json");
const literal =
  "Fixture ' \" $env:MMD_INJECTION_TEST $(throw 'executed') ` {literal}";
const catalog = {
  "command.failed": literal,
  "command.outputExists": literal,
  "command.requiresPowerShell7": literal,
  "command.pipeFailed": "Exit {code}: " + literal,
};
const runtime = createTranslator({
  sourceLocale: "zh-CN",
  catalogs: { "zh-CN": source, "en-XA": catalog },
  initialLocale: "en-XA",
});
function execute(t, commands, prefix = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "command-message-")),
    script = path.join(dir, "copy.ps1");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    script,
    "\uFEFF" +
      prefix +
      "try {\r\n" +
      commandText(commands, { prepare: true, text: runtime.t }) +
      "\r\n} catch { [Console]::Error.WriteLine('RESULT:' + $_.Exception.Message); exit 99 }\r\n",
  );
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-File", script],
    {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, MMD_INJECTION_TEST: "EXPANDED_BAD" },
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 99, result.stderr);
  assert.ok(!result.stderr.includes("EXPANDED_BAD"));
  return result.stderr.trim();
}
const nodeStep = (code) => ({ exe: process.execPath, args: ["-e", code] });
test("localized script failure strings remain literal in actual PowerShell", (t) => {
  assert.equal(execute(t, [nodeStep("process.exit(7)")]), "RESULT:" + literal);
  const chain = {
    ...nodeStep(
      'process.stdin.resume();process.stdin.on("end",()=>process.exit(9));',
    ),
    pipeFrom: nodeStep("process.stdout.end(Buffer.from([1]));"),
  };
  assert.equal(execute(t, [chain]), "RESULT:Exit 9: " + literal);
});
test("localized output and runtime guards keep their original refusal semantics", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "command-guard-")),
    output = path.join(dir, "User '{path}.bin"),
    marker = path.join(dir, "must-not-run");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(output, "User original");
  assert.equal(
    execute(t, [
      {
        ...nodeStep(
          `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`,
        ),
        output,
      },
    ]),
    "RESULT:" + literal,
  );
  assert.equal(fs.readFileSync(output, "utf8"), "User original");
  assert.equal(fs.existsSync(marker), false);
  const chain = {
    ...nodeStep("process.stdin.resume()"),
    pipeFrom: nodeStep("process.stdout.end()"),
  };
  assert.equal(
    execute(t, [chain], '$PSVersionTable.PSVersion = [version]"5.1"\r\n'),
    "RESULT:" + literal,
  );
});
