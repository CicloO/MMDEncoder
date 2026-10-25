"use strict";
const fs = require("node:fs");
const path = require("node:path");

const baseDir = () =>
  path.join(
    process.env.LOCALAPPDATA ||
      path.join(require("node:os").homedir(), "AppData", "Local"),
    "MMDEncoder",
    "mmd-plugin",
  );
const configPath = () => path.join(baseDir(), "mmd-export.json");

// The choice of preset and options. Both MMDEncoder and the plugin's settings
// window in MMD ("詳細設定") write it; the newer savedAt wins, and MMDEncoder
// picks up a choice saved in MMD as soon as it lands.
const selectionPath = () => path.join(baseDir(), "mmd-selection.json");
const FADES = [0, 0.5, 1, 2];
// Alpha mask: none, next to the video (<name>_alpha.<ext>), or the mask alone.
// The choice overrides the preset's own alpha setting.
const MASK_MODES = ["off", "with", "only"];
// What a preset would do by itself; the default when a preset is picked.
const presetMask = (s) =>
  s?.alphaMode === "mask" ? "only" : s?.alphaMask ? "with" : "off";

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readSelection() {
  try {
    const s = JSON.parse(fs.readFileSync(selectionPath(), "utf8"));
    return {
      presetId: typeof s.presetId === "string" ? s.presetId : "",
      // Use the size and frame rate set in MMD instead of the preset ones.
      followMmd: s.followMmd !== false,
      // Seconds of audio fade-in and fade-out (0 = off).
      audioFade: FADES.includes(s.audioFade) ? s.audioFade : 0,
      // "" = the preset decides.
      maskMode: MASK_MODES.includes(s.maskMode) ? s.maskMode : "",
      // Add the MMD frame range to the file name (_0400-0600f).
      rangeSuffix: s.rangeSuffix !== false,
      savedAt: typeof s.savedAt === "string" ? s.savedAt : "",
    };
  } catch {
    return null;
  }
}

function writeSelection({
  presetId = "",
  followMmd = true,
  audioFade = 0,
  maskMode = "off",
  rangeSuffix = true,
  savedAt,
}) {
  const selection = {
    presetId,
    followMmd,
    audioFade,
    rangeSuffix: rangeSuffix !== false,
    maskMode: MASK_MODES.includes(maskMode) ? maskMode : "off",
    savedAt: savedAt || new Date().toISOString(),
  };
  writeAtomic(selectionPath(), selection);
  return selection;
}

// mmd-export.json: tools, the helper to run, and every preset the settings
// window may offer. The single-preset form ({settings, presetName, …}) also
// writes the selection, for scripts and tests.
function writeConfig({
  presets,
  settings,
  presetName,
  presetId = "",
  followMmd = true,
  audioFade = 0,
  maskMode = "",
  rangeSuffix = true,
  engines,
  appExe,
  helper,
}) {
  if (!presets) {
    const id = presetId || "export";
    presets = [{ id, name: presetName, settings }];
    writeSelection({
      rangeSuffix,
      presetId: id,
      followMmd,
      audioFade,
      maskMode: maskMode || presetMask(settings),
    });
  }
  const config = {
    version: 2,
    presets: presets.map((p) => ({
      id: p.id,
      name: p.name,
      settings: { ...p.settings, presetName: p.name },
      unsupported: unsupported(p.settings),
    })),
    engines: {
      ffmpeg: engines.ffmpeg,
      ffprobe: engines.ffprobe,
      // NVEncC presets (mmd-pipe.cjs).
      nvencc: engines.nvencc || "",
      soxr: !!engines.soxr,
    },
    appExe,
    helper,
    writtenAt: new Date().toISOString(),
  };
  writeAtomic(configPath(), config);
  return config;
}

// The effective export settings: config + current selection.
function readConfig(selection = readSelection()) {
  const config = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  if (config.version !== 2)
    throw Error("导出设置版本不支持，请打开 MMDEncoder 重新选择导出预设");
  if (!selection?.presetId)
    throw Error(
      "还没有选择导出预设：请在 MMDEncoder 的“预设管理”或 MMD 的“詳細設定”里选择",
    );
  const preset = config.presets.find((p) => p.id === selection.presetId);
  if (!preset) throw Error("所选导出预设已不存在，请重新选择");
  const maskMode = selection.maskMode || presetMask(preset.settings);
  // The mask alone does not use the preset's encoder.
  if (maskMode !== "only" && preset.unsupported)
    throw Error(preset.unsupported);
  if (!config.engines?.ffmpeg || !config.engines?.ffprobe)
    throw Error("请先在 MMDEncoder 的“设置与引擎”里安装编码工具");
  return {
    ...config,
    presetId: preset.id,
    presetName: preset.name,
    settings: preset.settings,
    followMmd: selection.followMmd,
    audioFade: selection.audioFade,
    maskMode,
    rangeSuffix: selection.rangeSuffix,
  };
}

// Why a preset cannot be used for a live MMD export (empty string = usable).
// Every preset can be now (NVEncC since 1.6.1, see mmd-pipe.cjs); this stays
// the one place for such rules, which the app and the plugin both show.
function unsupported() {
  return "";
}

function syncConfig({
  presets,
  engines,
  appExe,
  helper,
  adoptSelection,
  getSelection,
}) {
  try {
    adoptSelection();
    writeConfig({
      presets: presets.map(({ id, name, settings }) => ({
        id,
        name,
        settings,
      })),
      engines: engines,
      appExe,
      helper,
    });
  } catch (e) {
    return "无法写入导出设置：" + e.message;
  }
  const m = getSelection();
  const preset = presets.find((p) => p.id === m.presetId);
  return !m.presetId
    ? ""
    : !preset
      ? "导出预设已被删除，请重新选择"
      : unsupported(preset.settings, m.maskMode) ||
        (!engines.ffmpeg || !engines.ffprobe
          ? "请先在“设置与引擎”里安装编码工具"
          : "");
}

module.exports = {
  baseDir,
  configPath,
  selectionPath,
  FADES,
  MASK_MODES,
  presetMask,
  writeAtomic,
  readSelection,
  writeSelection,
  writeConfig,
  readConfig,
  unsupported,
  syncConfig,
};
