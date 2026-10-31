"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createRunner } = require("./process-runner.cjs");
const core = require("./core.cjs");
const { probe: probeEnhancements } = require("./enhancements.cjs");
const media = require("./media.cjs");
const trim = require("./trim.cjs");
const { createTools, DEFAULT_ROOT } = require("./tools.cjs");
const mmdExport = require("./mmd-export.cjs");
const { syncConfig, validateAudioShift } = require("./mmd-config.cjs");
const {
  appError,
  serializeError,
  restoreError,
  sourceText,
  summary,
} = require("./errors.cjs");
const mmdPlugin = require("./mmd-plugin.cjs");
const { createFileDetails } = require("./file-details.cjs");
const { referenceTiming, streamDuration } = require("./audio-timing.mjs");
const { createMediaQueue } = require("./media-queue.cjs");
const { createEncodeQueue } = require("./encode-queue.cjs");
const { createLimit } = require("./limit.cjs");
const { uiState } = require("./ui-state.cjs");
const { createDetector } = require("./detect.cjs");
const { createAlignService } = require("./align-service.cjs");
const { createTrimQueue } = require("./trim-queue.cjs");
const { commit } = require("./commit.cjs");
const { createSettingsStore } = require("./settings-store.cjs");
const { createPreferences, normalizeTheme } = require("./preferences.cjs");
const { createPresetOperations } = require("./presets.cjs");
const {
  testEnhancements,
  invalidateSettings,
  invalidateTools,
} = require("./rtx-check.cjs");
const { schema } = require("./settings-schema.cjs");
const clone = (x) => JSON.parse(JSON.stringify(x));
function createService({
  engineDir,
  dataDir,
  onUpdate,
  toolsRoot = process.env.MMD_TEST_TOOLS_ROOT,
  toolOptions = {},
  localeRegistry,
  localeCatalogs,
  systemLanguages = [],
  formatCopiedCommand,
  // MMD export plugin DLL shipped with the app (packaged) or built locally (dev).
  mmdPluginDll = [
    path.join(__dirname, "..", "mmd-plugin", "MMDEncoderPlugin.dll"),
    path.join(__dirname, "..", "mmd-plugin", "build", "MMDEncoderPlugin.dll"),
  ].find((p) => fs.existsSync(p)) || "",
  // Program the plugin runs in Node mode for its helper (MMDEncoder.exe when packaged).
  mmdAppExe = process.execPath,
} = {}) {
  dataDir = dataDir || path.join(os.tmpdir(), "mmd-encoder");
  const settingsStore = createSettingsStore(dataDir);
  const preferences = createPreferences(localeRegistry, systemLanguages);
  const children = new Set();
  const pendingLogs = new Map();
  let evidenceTimer = null,
    hadJobs = false,
    pushTimer = null,
    lastPush = 0;
  let active = null,
    stopped = false,
    disposed = false,
    detectPromise = null,
    locatePromise = null;
  const state = {
    preferences: { locale: null, theme: "light", autoAlignAudio: true },
    locale: preferences.resolve(null),
    systemLocale: preferences.system,
    jobs: [],
    settings: { ...core.DEFAULTS },
    presets: clone(core.BUILTINS),
    engines: [],
    detecting: false,
    located: false,
    running: false,
    enhancements: {
      busy: false,
      signature: "",
      verified: false,
      message: sourceText("message.RTX_INITIAL"),
      messageData: summary("RTX_INITIAL"),
    },
    mediaJobs: [],
    // Lossless trim page: clips in order, each a frame range of a file.
    trim: {
      clips: [],
      running: false,
      // Smart cut: re-encode only around cut points (see trim.pieces).
      smart: false,
      progress: 0,
      stage: "",
      output: "",
      error: "",
    },
    // MMD export plugin: chosen preset, plugin install state, last test / export.
    mmd: {
      // Until the user picks one: the editing intermediate (ProRes 422 HQ),
      // which every editor reads and needs no hardware encoder.
      presetId: "builtin-prores422",
      followMmd: true,
      audioFade: 0,
      audioShiftFrames: 0,
      audioAutoShift: true,
      // "off" | "with" | "only"; "" until a preset decides (settings from 1.4.1).
      maskMode: "",
      rangeSuffix: true,
      savedAt: "",
      error: "",
      errorData: null,
      plugin: { available: false, installed: false, upToDate: false, path: "" },
      test: null,
      lastExport: null,
      // Exports cut off when MMD crashed or closed (see mmd-export interrupted()).
      interrupted: [],
    },
    engineInfo: { ffmpeg: "", ffprobe: "", nvencc: "" },
    detectionLog: "",
    // Built-ins the user had edited that an update changed: the user's version
    // waits here until they choose to drop it or keep it as a personal preset.
    presetConflicts: [],
  };
  function setNotice(message) {
    state.notice = typeof message === "string" ? message : message.message;
    state.noticeData = typeof message === "string" ? undefined : message;
  }
  // A tools folder chosen in the app is remembered in data/tools-location.json;
  // an explicit toolsRoot (environment / tests) always wins.
  const toolsLocationFile = path.join(dataDir, "tools-location.json");
  let chosenToolsRoot;
  try {
    const saved = JSON.parse(fs.readFileSync(toolsLocationFile, "utf8"));
    if (typeof saved.root === "string" && path.isAbsolute(saved.root))
      chosenToolsRoot = saved.root;
  } catch {}
  const tools = createTools({
    ...toolOptions,
    root: toolsRoot || chosenToolsRoot,
    onUpdate: (s) => {
      state.tools = s;
      emit();
    },
  });
  state.tools = tools.state;
  function emit() {
    if (!disposed && !evidenceTimer) {
      evidenceTimer = setTimeout(flushEvidence, 300);
      evidenceTimer.unref();
    }
    hadJobs ||= state.jobs.length > 0;
    if (disposed || typeof onUpdate !== "function") return;
    push();
  }
  // Encoder output: FFmpeg prints progress many times a second, and each push
  // copies the whole state to the window, so these go out at most every
  // 200 ms; the last one is always sent, at most 200 ms late. Status changes
  // use emit() and go out at once.
  function emitProgress() {
    if (disposed || typeof onUpdate !== "function" || pushTimer) return;
    const wait = lastPush + 200 - Date.now();
    if (wait > 0) {
      pushTimer = setTimeout(push, wait);
      pushTimer.unref?.();
    } else push();
  }
  function push() {
    clearTimeout(pushTimer);
    pushTimer = null;
    lastPush = Date.now();
    if (disposed) return;
    onUpdate(uiState(state));
  }
  // Batch writes rather than synchronously touching disk for every encoder line.
  // The renderer receives a bounded tail; the on-disk task log retains every line.
  function flushEvidence() {
    clearTimeout(evidenceTimer);
    evidenceTimer = null;
    try {
      const logsDir = path.join(dataDir, "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      for (const [id, pieces] of pendingLogs) {
        fs.appendFileSync(path.join(logsDir, id + ".log"), pieces.join(""));
        pendingLogs.delete(id);
      }
      if (state.detectionLog)
        fs.writeFileSync(
          path.join(logsDir, "hardware-detection.log"),
          state.detectionLog,
        );
      if (hadJobs) {
        const target = path.join(dataDir, "queue-checkpoint.json");
        const tmp = target + "." + crypto.randomUUID() + ".tmp";
        fs.writeFileSync(
          tmp,
          JSON.stringify(
            {
              version: 1,
              updatedAt: new Date().toISOString(),
              running: state.running,
              jobs: state.jobs.map(({ log, _retrySettings, ...job }) => ({
                ...job,
                logFile: path.join(logsDir, job.id + ".log"),
              })),
            },
            null,
            2,
          ),
        );
        fs.renameSync(tmp, target);
      }
    } catch (e) {
      setNotice(
        summary("EVIDENCE_SAVE_FAILED", {
          detail: e.message,
          error: serializeError(e),
        }),
      );
    }
  }
  const deletedBuiltins = new Set();
  // Saved entries this version cannot read; written back unchanged so a later
  // version (or a fix) can still use them.
  const unreadable = { presets: [], builtins: {} };
  const presetStorage = { deletedBuiltins, unreadable };
  const presetOperations = createPresetOperations({ schema, reorder });
  let unbackedSettings = null;
  function configReadNotice(cause, backup, backupError) {
    state.noticeData = summary(
      backupError ? "SETTINGS_BACKUP_FAILED" : "SETTINGS_UNREADABLE",
      {
        detail: cause.message,
        error: serializeError(cause),
        backup: path.basename(backup),
        ...(backupError
          ? {
              backupDetail: backupError.message,
              backupError: serializeError(backupError),
            }
          : {}),
      },
    );
    state.notice = state.noticeData.message;
  }
  function persist({ syncMmd = true } = {}) {
    if (unbackedSettings) {
      const pending = unbackedSettings;
      try {
        fs.copyFileSync(pending.file, pending.backup);
      } catch (error) {
        throw appError("SETTINGS_BACKUP_FAILED", {
          detail: error.message,
          error: serializeError(error),
        });
      }
      unbackedSettings = null;
      configReadNotice(pending.cause, pending.backup);
    }
    settingsStore.write({
      version: 1,
      preferences: state.preferences,
      settings: state.settings,
      ...presetOperations.serialize(
        { presets: state.presets, presetConflicts: state.presetConflicts },
        presetStorage,
      ),
      mmdExport: {
        presetId: state.mmd.presetId,
        followMmd: state.mmd.followMmd,
        audioFade: state.mmd.audioFade,
        audioShiftFrames: state.mmd.audioShiftFrames,
        audioAutoShift: state.mmd.audioAutoShift,
        maskMode: state.mmd.maskMode,
        rangeSuffix: state.mmd.rangeSuffix,
        savedAt: state.mmd.savedAt,
      },
    });
    if (syncMmd) syncMmdExport();
  }
  // The export choice is shared with the plugin's settings window in MMD through
  // mmd-selection.json; take it over when it was saved there more recently.
  // A choice saved in MMD always beats what this window still shows: it is
  // adopted as soon as the file changes (see the watcher below), and the app
  // only writes the field the user changed on top of it.
  function adoptMmdSelection() {
    const s = mmdExport.readSelection();
    const m = state.mmd;
    // Settings from 1.4.1: the mask follows what the preset did by itself.
    if (!m.maskMode)
      m.maskMode = mmdExport.presetMask(
        state.presets.find((p) => p.id === m.presetId)?.settings,
      );
    if (!s) {
      // First run with a choice from settings.json: publish it for the plugin.
      if (m.presetId) {
        const saved = mmdExport.writeSelection(m);
        m.savedAt = saved.savedAt;
      }
      return false;
    }
    if (s.savedAt <= (m.savedAt || "")) return false;
    Object.assign(m, {
      presetId: s.presetId,
      followMmd: s.followMmd,
      audioFade: s.audioFade,
      audioShiftFrames: s.audioShiftFrames,
      audioAutoShift: s.audioAutoShift,
      maskMode:
        s.maskMode ||
        mmdExport.presetMask(
          state.presets.find((p) => p.id === s.presetId)?.settings,
        ),
      rangeSuffix: s.rangeSuffix,
      savedAt: s.savedAt,
    });
    return true;
  }
  let selectionWatched = false;
  function watchMmdSelection() {
    if (selectionWatched || disposed) return;
    selectionWatched = true;
    fs.watchFile(mmdExport.selectionPath(), { interval: 1000 }, () => {
      if (!disposed && adoptMmdSelection()) {
        persist();
        emit();
      }
    });
  }
  // Keep the plugin's mmd-export.json (tools, helper, every preset) in step:
  // every preset change goes through persist(), tool changes through detect().
  function syncMmdExport() {
    state.mmd.error = "";
    state.mmd.errorData = syncConfig({
      presets: state.presets,
      engines: state.engineInfo,
      appExe: mmdAppExe,
      helper: path.join(__dirname, "mmd-export.cjs"),
      locale: state.locale,
      catalogs: localeCatalogs,
      adoptSelection: adoptMmdSelection,
      getSelection: () => ({
        presetId: state.mmd.presetId,
        maskMode: state.mmd.maskMode,
      }),
    });
    state.mmd.error = state.mmd.errorData?.message || "";
  }
  function lastMmdExport() {
    try {
      const lines = fs
        .readFileSync(mmdExport.historyPath(), "utf8")
        .trim()
        .split("\n");
      return JSON.parse(lines[lines.length - 1]);
    } catch {
      return null;
    }
  }
  async function refreshMmdPlugin() {
    state.mmd.plugin = await mmdPlugin.status(mmdPluginDll);
    state.mmd.lastExport = lastMmdExport();
    state.mmd.interrupted = mmdExport.interrupted();
    watchMmdSelection();
  }
  // Encode a short synthetic clip exactly as an MMD export would.
  async function testMmdExport() {
    syncMmdExport();
    if (state.mmd.error)
      throw state.mmd.errorData
        ? restoreError(state.mmd.errorData)
        : Error(state.mmd.error);
    if (!state.mmd.presetId) throw appError("MMD_PRESET_REQUIRED");
    try {
      state.mmd.test = await require("./mmd-test.cjs").testExport(
        undefined,
        children,
      );
    } catch (e) {
      state.mmd.test = {
        ok: false,
        at: new Date().toISOString(),
        ...serializeError(e),
      };
      throw e;
    }
  }
  try {
    const saved = settingsStore.read();
    if (saved.version !== 1) throw appError("SETTINGS_VERSION_UNSUPPORTED");
    state.preferences.locale = preferences.normalize(saved.preferences?.locale);
    state.preferences.theme = normalizeTheme(saved.preferences?.theme);
    state.preferences.autoAlignAudio =
      saved.preferences?.autoAlignAudio !== false;
    state.locale = preferences.resolve(state.preferences.locale);
    if (saved.mmdExport && typeof saved.mmdExport === "object") {
      if (typeof saved.mmdExport.presetId === "string")
        state.mmd.presetId = saved.mmdExport.presetId;
      if ([0, 0.5, 1, 2].includes(saved.mmdExport.audioFade))
        state.mmd.audioFade = saved.mmdExport.audioFade;
      if (Number.isSafeInteger(saved.mmdExport.audioShiftFrames))
        state.mmd.audioShiftFrames = saved.mmdExport.audioShiftFrames;
      if (typeof saved.mmdExport.audioAutoShift === "boolean")
        state.mmd.audioAutoShift = saved.mmdExport.audioAutoShift;
      if (typeof saved.mmdExport.savedAt === "string")
        state.mmd.savedAt = saved.mmdExport.savedAt;
      if (typeof saved.mmdExport.followMmd === "boolean")
        state.mmd.followMmd = saved.mmdExport.followMmd;
      if (mmdExport.MASK_MODES.includes(saved.mmdExport.maskMode))
        state.mmd.maskMode = saved.mmdExport.maskMode;
      // 1.4.1 only had the "also export the mask" switch.
      else if (saved.mmdExport.alphaMask === true) state.mmd.maskMode = "with";
      if (typeof saved.mmdExport.rangeSuffix === "boolean")
        state.mmd.rangeSuffix = saved.mmdExport.rangeSuffix;
    }
    state.settings = { ...core.DEFAULTS, ...schema(saved.settings) };
    Object.assign(
      state,
      presetOperations.restore(
        saved,
        { presets: state.presets, presetConflicts: state.presetConflicts },
        presetStorage,
      ),
    );
  } catch (e) {
    if (e.code !== "ENOENT") {
      // Keep the unreadable file before the next save replaces it.
      const file = path.join(dataDir, "settings.json");
      const backup = file + ".unreadable-" + Date.now();
      try {
        fs.copyFileSync(file, backup);
        configReadNotice(e, backup);
      } catch (backupError) {
        unbackedSettings = { file, backup, cause: e };
        configReadNotice(e, backup, backupError);
      }
    }
  }
  const run = createRunner({
    isDisposed: () => disposed,
    children,
    getActive: () => active,
    setActive: (value) => {
      active = value;
    },
  });
  async function locate() {
    if (locatePromise) return locatePromise;
    locatePromise = (async () => {
      for (const [key, name] of [
        ["ffmpeg", "ffmpeg.exe"],
        ["ffprobe", "ffprobe.exe"],
        ["nvencc", "NVEncC.exe"],
      ]) {
        state.engineInfo[key] = "";
        const managed = tools.paths()[key];
        const dirs = [engineDir, managed && path.dirname(managed)].filter(
          Boolean,
        );
        for (const dir of [...new Set(dirs)]) {
          const exe =
            managed && dir === path.dirname(managed)
              ? managed
              : path.join(dir, name);
          if (!fs.existsSync(exe)) continue;
          try {
            const r = await run(
              exe,
              [key === "nvencc" ? "--version" : "-version"],
              { timeout: 10000 },
            );
            state.engineInfo[key] = exe;
            // Its configure flags are in there too (hasSoxr).
            if (key === "ffmpeg") versionText = { exe, text: r.stdout || "" };
            state.detectionLog +=
              (r.stdout || r.stderr).split("\n")[0] + "\n" + exe + "\n";
            break;
          } catch (e) {
            state.detectionLog += exe + ": " + e.message + "\n";
          }
        }
      }
      state.located = true;
      emit();
    })();
    return locatePromise;
  }
  // First video / audio stream codecs and the audio bitrate, for the "follow
  // source" bitrate and the MP4 / MKV choice. Unreadable files give {}.
  async function probeMedia(file) {
    try {
      const r = await run(
        state.engineInfo.ffprobe,
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
        { timeout: 30000 },
      );
      const data = JSON.parse(r.stdout);
      const v = data.streams?.find((s) => s.codec_type === "video");
      const a = data.streams?.find((s) => s.codec_type === "audio");
      const timing = referenceTiming(data);
      return {
        hasVideo: timing.hasVideo,
        fpsText: timing.fpsText,
        videoCodec: v?.codec_name,
        audioCodec: a?.codec_name,
        // Stream lengths (for fades), falling back to the file's.
        videoDuration: timing.hasVideo ? timing.duration : 0,
        audioDuration: a ? streamDuration(a, data.format?.duration) : 0,
        audio: a ? core.audioInfo(a) : undefined,
        // Some containers only report the overall rate; use it for audio-only files.
        audioBitRate:
          a?.bit_rate || (!v && a ? data.format?.bit_rate : undefined),
      };
    } catch {
      return {};
    }
  }
  // Whether the installed FFmpeg has the soxr resampler; checked again when
  // FFmpeg changes (path, size or date).
  // The flags are on the "configuration:" line of `ffmpeg -version`, which
  // locate() has already run, so no extra FFmpeg start is needed.
  let soxrCache = { key: "", value: false };
  let versionText = { exe: "", text: "" };
  async function hasSoxr() {
    const ff = state.engineInfo.ffmpeg;
    let key = ff;
    try {
      const st = fs.statSync(ff);
      key += "|" + st.size + "|" + st.mtimeMs;
    } catch {}
    if (soxrCache.key === key) return soxrCache.value;
    let value = false;
    try {
      const text =
        versionText.exe === ff
          ? versionText.text
          : (await run(ff, ["-version"], { timeout: 15000 })).stdout;
      value = /--enable-libsoxr/.test(text);
    } catch {}
    soxrCache = { key, value };
    return value;
  }
  // Encoder detection (detect.cjs): reads the tool paths, writes only the
  // detection log; detect() below puts its results into the state.
  const detector = createDetector({
    run,
    dataDir,
    info: () => state.engineInfo,
    engines: () => state.engines,
    logs: {
      get text() {
        return state.detectionLog;
      },
      set text(v) {
        state.detectionLog = v;
      },
    },
  });
  const {
    hasLibplacebo,
    hasNvencLossless,
    detectionKey,
    readDetectionCache,
    writeDetectionCache,
  } = detector;
  async function detect({ force = false } = {}) {
    if (detectPromise) return detectPromise;
    state.detecting = true;
    state.engines = [];
    emit();
    detectPromise = (async () => {
      await locate();
      if (!state.engineInfo.ffmpeg) {
        setNotice(summary("ENGINE_FFMPEG_MISSING"));
        return;
      }
      // Hi-Res resampling uses soxr when this FFmpeg has it.
      state.engineInfo.soxr = await hasSoxr();
      const key = await detectionKey();
      const cached = !force && key && readDetectionCache(key);
      // ArtCNN upscaling runs in FFmpeg through libplacebo on Vulkan.
      state.engineInfo.libplacebo = cached
        ? cached.libplacebo
        : await hasLibplacebo(force);
      // The Alpha mask goes to NVENC when it encodes lossless.
      state.engineInfo.nvencLossless = cached
        ? cached.nvencLossless
        : await hasNvencLossless(force);
      if (cached) {
        state.engines = cached.engines;
        state.detectionLog +=
          (cached.log || "") +
          sourceText("engine.log.cachedResult", {
            detectedAt: cached.detectedAt,
          });
        return;
      }
      const logStart = state.detectionLog.length;
      let listing = "";
      try {
        listing = (
          await run(state.engineInfo.ffmpeg, ["-hide_banner", "-encoders"], {
            timeout: 10000,
          })
        ).stdout;
      } catch (e) {
        if (e.runnerErrorData) {
          const error = serializeError(e);
          const notice = summary("ENGINE_DETECTION_CAUSE", {
            detail: error.message,
          });
          notice.params = { error };
          setNotice(notice);
        } else setNotice(e.message);
        return;
      }
      await detector.trialEncoders({
        listing,
        stopped: () => disposed,
        // Trials finish out of order: keep the list in ENGINES order.
        found: (e) => {
          state.engines.push(e);
          const at = (x) => core.ENGINES.findIndex((y) => y.id === x.id);
          state.engines.sort((a, b) => at(a) - at(b));
        },
        progress: emit,
      });
      if (key && !disposed && state.engines.length)
        writeDetectionCache(key, state.detectionLog.slice(logStart));
    })()
      .catch((e) => {
        const error = serializeError(e);
        const notice = summary("ENGINE_DETECTION_INCOMPLETE", {
          detail: error.message,
        });
        notice.params = { error };
        setNotice(notice);
      })
      .finally(() => {
        state.detecting = false;
        detectPromise = null;
        syncMmdExport();
        emit();
      });
    return detectPromise;
  }
  // Apply a drag-sort result: ids must be exactly the current list's ids.
  function reorder(list, ids) {
    if (
      !Array.isArray(ids) ||
      ids.length !== list.length ||
      new Set(ids).size !== ids.length
    )
      throw appError("ORDER_INVALID");
    const byId = new Map(list.map((x) => [x.id, x]));
    if (ids.some((id) => !byId.has(id))) throw appError("ORDER_INVALID");
    return ids.map((id) => byId.get(id));
  }
  // Whether anything is using the encoders, the tools or the GPU: encoding
  // or media processing, a trim export, detection, a tool install, the RTX
  // check or another child process. { tools: false } leaves out a tool
  // install (for the tool actions themselves).
  function isBusy({ tools: withTools = true } = {}) {
    return !!(
      state.running ||
      state.trim.running ||
      state.detecting ||
      (withTools && tools.state.busy) ||
      state.enhancements.busy ||
      children.size
    );
  }
  // Shared with the queue modules. `stopped`, `detectPromise` and the running
  // encoder change in several places, so the modules read them through ctx.
  const ctx = {
    state,
    emit,
    emitProgress,
    run,
    locate,
    probeMedia,
    hasSoxr,
    commit,
    reorder,
    flushEvidence,
    schema,
    tools,
    children,
    pendingLogs,
    dataDir,
    // Reading files on import, shared by both queues: 4 at a time.
    probeLimit: createLimit(4),
    // The queues ask these instead of reading other parts' state.
    isBusy,
    trimExporting: () => state.trim.running,
    get stopped() {
      return stopped;
    },
    set stopped(v) {
      stopped = v;
    },
    get detectPromise() {
      return detectPromise;
    },
    killActive: () => active?.kill(),
  };
  const mediaQueue = createMediaQueue({
    getJobs: () => state.mediaJobs,
    setJobs: (jobs) => (state.mediaJobs = jobs),
    engineInfo: () => state.engineInfo,
    isRunning: () => state.running,
    setRunning: (value) => (state.running = value),
    isStopped: () => stopped,
    setStopped: (value) => (stopped = value),
    onNotice: setNotice,
    emit,
    emitProgress,
    run,
    locate,
    probeMedia,
    hasSoxr,
    commit,
    dataDir,
    isBusy,
    probeLimit: ctx.probeLimit,
    reorder,
  });
  const encodeQueue = createEncodeQueue({
    getJobs: () => state.jobs,
    setJobs: (jobs) => (state.jobs = jobs),
    getSettings: () => state.settings,
    engineInfo: () => state.engineInfo,
    engines: () => state.engines,
    verification: () => state.enhancements,
    isDetecting: () => state.detecting,
    isRunning: () => state.running,
    setRunning: (value) => (state.running = value),
    onNotice: setNotice,
    isStopped: () => stopped,
    setStopped: (value) => (stopped = value),
    waitDetection: () => detectPromise,
    toolsBusy: () => tools.state.busy,
    trimExporting: () => state.trim.running,
    getDetectionLog: () => state.detectionLog,
    getUiState: () => uiState(state),
    appendEvidence: (id, text) => {
      const pieces = pendingLogs.get(id) || [];
      pieces.push(text);
      pendingLogs.set(id, pieces);
    },
    run,
    locate,
    probeMedia,
    hasSoxr,
    emit,
    emitProgress,
    commit,
    flushEvidence,
    killActive: ctx.killActive,
    probeLimit: ctx.probeLimit,
    schema,
    reorder,
    formatCopiedCommand:
      formatCopiedCommand &&
      ((commands) => formatCopiedCommand(commands, state.locale)),
  });
  const alignService = createAlignService({
    engineInfo: () => state.engineInfo,
    locate,
  });
  const trimQueue = createTrimQueue({
    getClips: () => state.trim.clips,
    setClips: (clips) => {
      state.trim.clips = clips;
    },
    isRunning: () => state.trim.running,
    isSmart: () => state.trim.smart,
    setSmart: (smart) => {
      state.trim.smart = smart;
    },
    updateExport: (patch) => Object.assign(state.trim, patch),
    engineInfo: () => state.engineInfo,
    isEncoding: () => state.running,
    isResourcesBusy: () =>
      state.detecting || tools.state.busy || state.enhancements.busy,
    emit,
    emitProgress,
    locate,
    reorder,
  });
  const readDetails = createFileDetails({
    isToolsBusy: () => tools.state.busy,
    requireMediaJob: mediaQueue.requireMediaJob,
    requireJob: encodeQueue.requireJob,
    locate,
    ffprobe: () => state.engineInfo.ffprobe,
    run,
    inputArgs: core.inputArgs,
  });
  const modules = [mediaQueue, encodeQueue, alignService, trimQueue];

  async function invoke(action, payload = {}) {
    // Queries return their own answer; actions change state, which is then
    // sent to the window and returned.
    for (const m of modules) {
      if (Object.hasOwn(m.queries, action)) return m.queries[action](payload);
      if (Object.hasOwn(m.actions, action)) {
        await m.actions[action](payload);
        emit();
        return uiState(state);
      }
    }
    switch (action) {
      case "state":
        return uiState(state);
      case "setLocale": {
        const previous = { ...state.preferences };
        state.preferences.locale = preferences.normalize(payload.locale);
        state.locale = preferences.resolve(state.preferences.locale);
        try {
          persist();
        } catch (error) {
          state.preferences = previous;
          state.locale = preferences.resolve(previous.locale);
          throw error;
        }
        break;
      }
      case "setTheme": {
        const previous = state.preferences.theme;
        state.preferences.theme = normalizeTheme(payload.theme);
        try {
          persist({ syncMmd: false });
        } catch (error) {
          state.preferences.theme = previous;
          throw error;
        }
        break;
      }
      case "setAutoAlignAudio": {
        if (typeof payload.enabled !== "boolean")
          throw appError("SETTINGS_FIELD_INVALID", { field: "autoAlignAudio" });
        const previous = state.preferences.autoAlignAudio;
        state.preferences.autoAlignAudio = payload.enabled;
        try {
          persist({ syncMmd: false });
        } catch (error) {
          state.preferences.autoAlignAudio = previous;
          throw error;
        }
        break;
      }
      case "details":
        return readDetails(payload);
      case "testEnhancements": {
        if (isBusy()) throw appError("RTX_TEST_BUSY");
        const s = { ...state.settings, ...schema(payload.settings || {}) };
        await locate();
        await testEnhancements({
          settings: s,
          check: async () => {
            state.detectionLog +=
              "\n" + (await probeEnhancements(s, state.engineInfo, run));
          },
          onStart: (result) => (state.enhancements = result),
          onPatch: (patch) => Object.assign(state.enhancements, patch),
          onLog: (text) => (state.detectionLog += text),
          emit,
        });
        break;
      }
      case "compatibility":
        return core.compatibility(
          { ...state.settings, ...schema(payload.settings || {}) },
          state.engines,
        );
      case "checkTools":
      case "installTools":
      case "installToolsArchive":
        if (isBusy({ tools: false })) throw appError("TOOLS_MANAGE_BUSY");
        try {
          if (action === "installToolsArchive")
            await tools.installLocal(payload?.path);
          else await tools.run(action === "installTools");
        } finally {
          if (action !== "checkTools") {
            invalidateTools(state.enhancements);
            locatePromise = null;
            await detect({ force: true });
          }
        }
        break;
      case "setToolsRoot": {
        if (toolsRoot) throw appError("TOOLS_ROOT_ENV_LOCKED");
        if (isBusy({ tools: false })) throw appError("TOOLS_ROOT_BUSY");
        const target = payload?.root || DEFAULT_ROOT;
        tools.relocate(target);
        if (path.resolve(target) === path.resolve(DEFAULT_ROOT))
          fs.rmSync(toolsLocationFile, { force: true });
        else {
          fs.mkdirSync(dataDir, { recursive: true });
          fs.writeFileSync(
            toolsLocationFile,
            JSON.stringify({ root: path.resolve(target) }, null, 2),
          );
        }
        state.tools = tools.state;
        locatePromise = null;
        await detect({ force: true });
        break;
      }
      case "detect":
        if (tools.state.busy) throw appError("ENGINE_DETECT_INSTALL_BUSY");
        if (state.trim.running) throw appError("ENGINE_DETECT_TRIM_BUSY");
        await detect({ force: true });
        break;
      case "settings":
        schema(payload.patch);
        state.settings = { ...state.settings, ...payload.patch };
        invalidateSettings(state.enhancements, state.settings);
        persist();
        break;
      case "savePreset":
      case "renamePreset":
      case "applyPreset":
      case "deletePreset":
      case "hidePreset":
      case "reorderPresets":
      case "resolvePresetConflict":
      case "restoreBuiltinPresets":
      case "importPresets":
        Object.assign(
          state,
          presetOperations.execute(
            action,
            payload,
            {
              presets: state.presets,
              presetConflicts: state.presetConflicts,
              settings: state.settings,
            },
            presetStorage,
          ),
        );
        persist();
        break;
      case "mmdStatus":
        // Pick up a choice made in MMD since the last look.
        if (adoptMmdSelection()) persist();
        else syncMmdExport();
        await refreshMmdPlugin();
        break;
      case "mmdInstall":
        state.mmd.plugin = await mmdPlugin.install(mmdPluginDll);
        break;
      case "mmdUninstall":
        state.mmd.plugin = await mmdPlugin.uninstall(mmdPluginDll);
        break;
      case "mmdExportSet": {
        if (payload.audioShiftFrames !== undefined)
          validateAudioShift(payload.audioShiftFrames);
        if (
          payload.audioAutoShift !== undefined &&
          typeof payload.audioAutoShift !== "boolean"
        )
          throw appError("MMD_AUDIO_AUTO_SHIFT_INVALID");
        // Apply the change on top of a choice made meanwhile in MMD.
        adoptMmdSelection();
        if (typeof payload.presetId === "string") {
          if (
            payload.presetId &&
            !state.presets.some((p) => p.id === payload.presetId)
          )
            throw appError("PRESET_MISSING");
          // Every MMD export option outranks the preset: picking a preset
          // leaves the mask choice (and the others) as they are.
          state.mmd.presetId = payload.presetId;
          state.mmd.test = null;
        }
        if (payload.audioFade !== undefined) {
          if (![0, 0.5, 1, 2].includes(payload.audioFade))
            throw appError("MMD_FADE_INVALID");
          state.mmd.audioFade = payload.audioFade;
        }
        if (payload.audioShiftFrames !== undefined) {
          state.mmd.audioShiftFrames = payload.audioShiftFrames;
          state.mmd.test = null;
        }
        if (payload.audioAutoShift !== undefined) {
          state.mmd.audioAutoShift = payload.audioAutoShift;
          state.mmd.test = null;
        }
        if (typeof payload.followMmd === "boolean")
          state.mmd.followMmd = payload.followMmd;
        if (typeof payload.rangeSuffix === "boolean")
          state.mmd.rangeSuffix = payload.rangeSuffix;
        if (payload.maskMode !== undefined) {
          if (!mmdExport.MASK_MODES.includes(payload.maskMode))
            throw appError("MMD_MASK_INVALID");
          state.mmd.maskMode = payload.maskMode;
          state.mmd.test = null;
        }
        state.mmd.savedAt = mmdExport.writeSelection({
          ...state.mmd,
          savedAt: undefined,
        }).savedAt;
        persist();
        break;
      }
      case "mmdTest":
        if (state.running) throw appError("MMD_TEST_BUSY");
        await testMmdExport();
        break;
      case "mmdRecover":
      case "mmdDiscard": {
        if (typeof payload?.id !== "string")
          throw appError("MMD_RECORD_INVALID");
        try {
          if (action === "mmdRecover") await mmdExport.recover(payload.id);
          else mmdExport.discard(payload.id);
        } finally {
          state.mmd.interrupted = mmdExport.interrupted();
        }
        state.mmd.lastExport = lastMmdExport();
        break;
      }
      default:
        throw appError("SERVICE_ACTION_UNSUPPORTED", { action });
    }
    emit();
    return uiState(state);
  }
  setImmediate(() => {
    if (disposed) return;
    detect();
    // Exports cut off when MMD crashed or closed: offer to finish them, at
    // start and whenever it happens while the app is open.
    checkInterrupted();
    interruptTimer = setInterval(checkInterrupted, 3000);
    interruptTimer.unref?.();
    watchMmdSelection();
  });
  let interruptTimer = null;
  function checkInterrupted() {
    if (disposed) return;
    let list;
    try {
      list = mmdExport.interrupted();
    } catch {
      return;
    }
    const ids = (l) => l.map((x) => x.id).join();
    if (ids(list) === ids(state.mmd.interrupted)) return;
    const known = new Set(state.mmd.interrupted.map((x) => x.id));
    state.mmd.interrupted = list;
    if (list.some((x) => !known.has(x.id)))
      setNotice(summary("MMD_INTERRUPTED", { count: list.length }));
    emit();
  }
  return {
    invoke,
    getState: () => clone(state),
    // What the window may see (no video logs, media log tails only).
    uiState: () => uiState(state),
    isBusy: () => isBusy(),
    dispose() {
      flushEvidence();
      disposed = true;
      stopped = true;
      if (selectionWatched) fs.unwatchFile(mmdExport.selectionPath());
      clearTimeout(pushTimer);
      clearInterval(interruptTimer);
      for (const child of children) child.kill();
      alignService.stopAll();
      trimQueue.stop();
      trim.clearCache();
    },
  };
}
module.exports = { createService };
