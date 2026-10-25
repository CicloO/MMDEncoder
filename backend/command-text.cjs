"use strict";
const path = require("node:path");
const { commandProcesses } = require("./command-processes.cjs");
const quote = (v) => "'" + String(v).replace(/'/g, "''") + "'";
// Copy both binary links concurrently; a full pipe must not block the other.
const invokePiped = String.raw`function Invoke-Piped([object[]]$Commands) {
  $ps = [Collections.Generic.List[Diagnostics.Process]]::new()
  $copies = [Collections.Generic.List[object]]::new()
  try {
    for ($i = 0; $i -lt $Commands.Count; $i++) {
      $c = $Commands[$i]
      $s = [Diagnostics.ProcessStartInfo]::new($c.Exe)
      foreach ($a in $c.Args) { $s.ArgumentList.Add($a) }
      $s.UseShellExecute = $false
      $s.RedirectStandardInput = $i -gt 0
      $s.RedirectStandardOutput = $i -lt ($Commands.Count - 1)
      $ps.Add([Diagnostics.Process]::Start($s))
    }
    for ($i = 0; $i -lt ($ps.Count - 1); $i++) {
      $copies.Add(@{ Task = $ps[$i].StandardOutput.BaseStream.CopyToAsync($ps[$i+1].StandardInput.BaseStream); Reader = $ps[$i+1]; Closed = $false })
    }
    while ($true) {
      foreach ($p in $ps) {
        if ($p.HasExited -and $p.ExitCode -ne 0) { throw "管道进程失败（退出码 $($p.ExitCode)）" }
      }
      foreach ($copy in $copies) {
        if (!$copy.Closed -and $copy.Task.IsCompleted) {
          $copy.Task.GetAwaiter().GetResult()
          $copy.Reader.StandardInput.Close()
          $copy.Closed = $true
        }
      }
      if (@($ps | Where-Object { !$_.HasExited }).Count -eq 0 -and @($copies | Where-Object { !$_.Closed }).Count -eq 0) { break }
      Start-Sleep -Milliseconds 20
    }
    foreach ($p in $ps) {
      $p.WaitForExit()
      if ($p.ExitCode -ne 0) { throw "管道进程失败（退出码 $($p.ExitCode)）" }
    }
  } finally {
    foreach ($p in $ps) { if (!$p.HasExited) { $p.Kill($true) } }
    foreach ($p in $ps) { $p.WaitForExit(); $p.Dispose() }
  }
}`;
function commandText(commands, { prepare = false } = {}) {
  const lines = [];
  const files = [
    ...new Set(
      commands.flatMap((c) => [c.output, c.maskOutput]).filter(Boolean),
    ),
  ];
  if (prepare && commands.length) {
    lines.push('$ErrorActionPreference = "Stop"');
    for (const file of files)
      lines.push(
        `if (Test-Path -LiteralPath ${quote(file)}) { throw "输出已存在，停止以避免覆盖" }`,
      );
    for (const dir of new Set(files.map((file) => path.dirname(file))))
      lines.push(`[void][System.IO.Directory]::CreateDirectory(${quote(dir)})`);
  }
  const piped = commands.some((c) => commandProcesses(c).length > 1);
  const staged = prepare && piped && files.length;
  const arg = (value) =>
    staged && files.includes(value)
      ? `$targets[${quote(value)}]`
      : quote(value);
  if (prepare && piped)
    lines.push(
      'if ($PSVersionTable.PSVersion.Major -lt 7) { throw "请用 PowerShell 7（pwsh）运行这段命令" }',
      invokePiped,
    );
  if (staged) {
    lines.push("$targets = @{}", "$workdirs = @{}", "try {");
    for (const dir of new Set(files.map((file) => path.dirname(file)))) {
      lines.push(
        `$workdirs[${quote(dir)}] = Join-Path ${quote(dir)} ('.mmd-' + [Guid]::NewGuid().ToString('N'))`,
      );
      lines.push(
        `[void][IO.Directory]::CreateDirectory($workdirs[${quote(dir)}])`,
      );
    }
    for (const file of files)
      lines.push(
        `$targets[${quote(file)}] = Join-Path $workdirs[${quote(path.dirname(file))}] ${quote(path.basename(file))}`,
      );
  }
  for (const c of commands) {
    const processes = commandProcesses(c);
    const call = (x) => "& " + quote(x.exe) + " " + x.args.map(arg).join(" ");
    if (processes.length > 1 && prepare) {
      const list = (args) => "@(" + args.map(arg).join(", ") + ")";
      lines.push(
        `Invoke-Piped -Commands @( ${processes.map((p) => `@{ Exe = ${quote(p.exe)}; Args = ${list(p.args)} }`).join("; ")} )`,
      );
    } else {
      lines.push(processes.map(call).join(" | "));
      lines.push('if ($LASTEXITCODE -ne 0) { throw "编码失败" }');
    }
  }
  if (staged) {
    for (const file of files)
      lines.push(`[IO.File]::Move($targets[${quote(file)}], ${quote(file)})`);
    lines.push(
      "} finally {",
      "  foreach ($dir in $workdirs.Values) { if ([IO.Directory]::Exists($dir)) { [IO.Directory]::Delete($dir, $true) } }",
      "}",
    );
  }
  return lines.join("\r\n");
}
module.exports = { quote, commandText };
