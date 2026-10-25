"use strict";
const path = require("node:path");
const quote = (v) => "'" + String(v).replace(/'/g, "''") + "'";
function commandText(commands, { prepare = false } = {}) {
  const lines = [];
  if (prepare && commands.length) {
    lines.push('$ErrorActionPreference = "Stop"');
    const files = commands.map((c) => c.output || c.temporary).filter(Boolean);
    for (const file of files)
      lines.push(
        `if (Test-Path -LiteralPath ${quote(file)}) { throw "输出已存在，停止以避免覆盖" }`,
      );
    for (const dir of new Set(files.map((file) => path.dirname(file))))
      lines.push(`[void][System.IO.Directory]::CreateDirectory(${quote(dir)})`);
  }
  // FFmpeg -> NVEncC: a PowerShell pipe would turn the video into text in
  // Windows PowerShell 5.1 and only reports the last program's exit code,
  // so the script copies the bytes itself and checks both programs.
  const piped = commands.some((c) => c.pipeFrom);
  if (prepare && piped)
    lines.push(
      'if ($PSVersionTable.PSVersion.Major -lt 7) { throw "请用 PowerShell 7（pwsh）运行这段命令" }',
      "function Invoke-Piped([string]$Writer, [string[]]$WriterArgs, [string]$Reader, [string[]]$ReaderArgs) {",
      "  $w = [Diagnostics.ProcessStartInfo]::new($Writer); foreach ($a in $WriterArgs) { $w.ArgumentList.Add($a) }",
      "  $w.UseShellExecute = $false; $w.RedirectStandardOutput = $true",
      "  $r = [Diagnostics.ProcessStartInfo]::new($Reader); foreach ($a in $ReaderArgs) { $r.ArgumentList.Add($a) }",
      "  $r.UseShellExecute = $false; $r.RedirectStandardInput = $true",
      "  $wp = [Diagnostics.Process]::Start($w); $rp = [Diagnostics.Process]::Start($r)",
      "  try { $wp.StandardOutput.BaseStream.CopyTo($rp.StandardInput.BaseStream) } catch { } finally { $rp.StandardInput.Close() }",
      "  $wp.WaitForExit(); $rp.WaitForExit()",
      '  if ($wp.ExitCode -ne 0) { throw "预处理失败（退出码 $($wp.ExitCode)）" }',
      '  if ($rp.ExitCode -ne 0) { throw "编码失败（退出码 $($rp.ExitCode)）" }',
      "}",
    );
  const list = (args) => "@(" + args.map(quote).join(", ") + ")";
  for (const c of commands) {
    const call = (x) => "& " + [x.exe, ...x.args].map(quote).join(" ");
    if (c.pipeFrom && prepare) {
      lines.push(
        `Invoke-Piped ${quote(c.pipeFrom.exe)} ${list(c.pipeFrom.args)} ${quote(c.exe)} ${list(c.args)}`,
      );
      continue;
    }
    // In the job log: what ran, the two programs joined by a pipe.
    lines.push((c.pipeFrom ? call(c.pipeFrom) + " | " : "") + call(c));
    lines.push('if ($LASTEXITCODE -ne 0) { throw "编码失败" }');
  }
  if (prepare)
    for (const c of commands.filter((c) => c.temporary))
      lines.push(`Remove-Item -LiteralPath ${quote(c.temporary)}`);
  return lines.join("\r\n");
}
module.exports = { quote, commandText };
