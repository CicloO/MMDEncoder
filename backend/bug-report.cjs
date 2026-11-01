"use strict";
// The error report the log window exports for bug reports: where it ran
// (app, Windows, CPU, memory, GPU and driver, encoding tools and the
// encoders found), what the task was (source, settings, error) and its log.
// Plain text, readable in any editor; the header stays in English so a
// report reads the same whatever the interface language.
const os = require("node:os");

function line(label, value) {
  return value === undefined || value === null || value === ""
    ? ""
    : `${label}: ${value}\n`;
}
function gpuLines(gpu) {
  return (gpu?.gpuDevice || [])
    .map(
      (d, i) =>
        `GPU ${i + 1}: vendor 0x${(d.vendorId || 0).toString(16)} device 0x${(
          d.deviceId || 0
        ).toString(16)}` +
        (d.driverVersion ? ` driver ${d.driverVersion}` : "") +
        (d.active ? " (active)" : "") +
        "\n",
    )
    .join("");
}
// "9.0.2 (C:\…\ffmpeg.exe)": the installed version, then where it runs from.
function tool(installed, exe) {
  return [installed?.version, exe && (installed?.version ? `(${exe})` : exe)]
    .filter(Boolean)
    .join(" ");
}
function buildReport({
  version,
  versions = process.versions,
  gpu,
  locale,
  engineInfo = {},
  tools = {},
  engines = [],
  job,
  log = "",
  now = new Date(),
}) {
  const cpus = os.cpus();
  let text =
    "MMDEncoder error report\n" +
    "=======================\n" +
    line("Created", now.toISOString()) +
    line("App", version) +
    line("Electron", versions.electron) +
    line("Chromium", versions.chrome) +
    line("Node", versions.node) +
    line(
      "Windows",
      `${os.version?.() || os.type()} ${os.release()} (${os.arch()})`,
    ) +
    line("CPU", cpus[0] && `${cpus[0].model.trim()} × ${cpus.length}`) +
    line("Memory", `${Math.round(os.totalmem() / 2 ** 30)} GB`) +
    gpuLines(gpu) +
    line("Interface language", locale) +
    line("FFmpeg", tool(tools.installed?.ffmpeg, engineInfo.ffmpeg)) +
    line("ffprobe", engineInfo.ffprobe) +
    line("NVEncC", tool(tools.installed?.nvencc, engineInfo.nvencc)) +
    line("Encoders", engines.map((e) => e.id).join(", "));
  if (job) {
    const { log: _log, ...rest } = job;
    text +=
      "\nTask\n----\n" +
      line("Status", rest.status) +
      line("Source", rest.path) +
      line("Output", rest.output) +
      line("Error", rest.error) +
      line("Error code", rest.errorData?.code) +
      (rest.meta ? "Source info: " + JSON.stringify(rest.meta) + "\n" : "") +
      (rest.settings
        ? "Settings: " + JSON.stringify(rest.settings) + "\n"
        : "");
  }
  return text + "\nLog\n---\n" + log + (log.endsWith("\n") ? "" : "\n");
}
module.exports = { buildReport };
