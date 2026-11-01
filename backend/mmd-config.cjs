"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { appError, serializeError } = require("./errors.cjs");
const { pluginMessages } = require("./plugin-messages.cjs");
const { createTranslator } = require("../locales/runtime.mjs");
const { presetDisplayName } = require("../locales/preset-names.mjs");
const source = require("../locales/zh-CN.json");

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
// -1 follows the preset's own audio fade (the default).
const FOLLOW_FADE = -1;
const FADES = [FOLLOW_FADE, 0, 0.5, 1, 2];
// Alpha mask: none, next to the video (<name>_alpha.<ext>), or the mask alone.
// "preset" (the default) follows what the preset does by itself; the others
// override the preset's own alpha setting.
const MASK_MODES = ["preset", "off", "with", "only"];
// What a preset would do by itself.
const presetMask = (s) =>
  s?.alphaMode === "mask" ? "only" : s?.alphaMask ? "with" : "off";
const resolveMask = (mode, s) => (mode === "preset" || !mode ? presetMask(s) : mode);

function validateAudioShift(frames) {
  if (!Number.isSafeInteger(frames)) throw appError("MMD_AUDIO_SHIFT_INVALID");
  return frames;
}

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
      audioFade: FADES.includes(s.audioFade) ? s.audioFade : FOLLOW_FADE,
      audioShiftFrames: Number.isSafeInteger(s.audioShiftFrames)
        ? s.audioShiftFrames
        : 0,
      maskMode: MASK_MODES.includes(s.maskMode) ? s.maskMode : "preset",
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
  audioShiftFrames = 0,
  maskMode = "preset",
  rangeSuffix = true,
  savedAt,
}) {
  const selection = {
    presetId,
    followMmd,
    audioFade,
    audioShiftFrames: validateAudioShift(audioShiftFrames),
    rangeSuffix: rangeSuffix !== false,
    maskMode: MASK_MODES.includes(maskMode) ? maskMode : "preset",
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
  audioShiftFrames = 0,
  maskMode = "",
  rangeSuffix = true,
  engines,
  appExe,
  helper,
  locale,
  catalogs,
}) {
  if (!presets) {
    const id = presetId || "export";
    presets = [{ id, name: presetName, settings }];
    writeSelection({
      rangeSuffix,
      presetId: id,
      followMmd,
      audioFade,
      audioShiftFrames,
      maskMode: maskMode || "preset",
    });
  }
  const snapshot = pluginMessages(locale, catalogs);
  const runtime = createTranslator({
    sourceLocale: "zh-CN",
    catalogs: { "zh-CN": source, ...catalogs },
    initialLocale: snapshot.locale,
  });
  const config = {
    version: 2,
    ...snapshot,
    presets: presets.map((p) => ({
      id: p.id,
      name: p.name,
      displayName: presetDisplayName(runtime, p, presets),
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
  if (config.version !== 2) throw appError("MMD_CONFIG_VERSION");
  if (!selection?.presetId) throw appError("MMD_SELECTION_REQUIRED");
  const preset = config.presets.find((p) => p.id === selection.presetId);
  if (!preset) throw appError("MMD_PRESET_MISSING");
  const maskMode = resolveMask(selection.maskMode, preset.settings);
  // The mask alone does not use the preset's encoder.
  if (maskMode !== "only" && preset.unsupported)
    throw Error(preset.unsupported);
  if (!config.engines?.ffmpeg || !config.engines?.ffprobe)
    throw appError("MMD_TOOLS_REQUIRED");
  return {
    ...config,
    presetId: preset.id,
    presetName: preset.name,
    settings: preset.settings,
    followMmd: selection.followMmd,
    audioFade:
      selection.audioFade === FOLLOW_FADE
        ? preset.settings?.audioFade || 0
        : selection.audioFade,
    audioShiftFrames: validateAudioShift(selection.audioShiftFrames ?? 0),
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
  locale,
  catalogs,
}) {
  try {
    adoptSelection();
    writeConfig({
      presets,
      engines: engines,
      appExe,
      helper,
      locale,
      catalogs,
    });
  } catch (e) {
    return serializeError(appError("MMD_CONFIG_WRITE", { detail: e.message }));
  }
  const m = getSelection();
  const preset = presets.find((p) => p.id === m.presetId);
  return !m.presetId
    ? null
    : !preset
      ? serializeError(appError("MMD_PRESET_REMOVED"))
      : unsupported(preset.settings, m.maskMode) ||
        (!engines.ffmpeg || !engines.ffprobe
          ? serializeError(appError("MMD_SYNC_TOOLS_REQUIRED"))
          : null);
}

module.exports = {
  baseDir,
  configPath,
  selectionPath,
  FADES,
  FOLLOW_FADE,
  MASK_MODES,
  presetMask,
  resolveMask,
  validateAudioShift,
  writeAtomic,
  readSelection,
  writeSelection,
  writeConfig,
  readConfig,
  unsupported,
  syncConfig,
};
