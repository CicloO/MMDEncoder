"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const core = require("./core.cjs");
const {
  signature: enhancementSignature,
  probe: probeEnhancements,
} = require("./enhancements.cjs");
const media = require("./media.cjs");
const trim = require("./trim.cjs");
const { createTools, DEFAULT_ROOT } = require("./tools.cjs");
const mmdExport = require("./mmd-export.cjs");
const mmdPlugin = require("./mmd-plugin.cjs");
const sequence = require("./sequence.cjs");
// Frame rate a PNG sequence starts with; it can be changed per sequence.
const SEQUENCE_FPS = 30;
const SEQUENCE_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120];
// The NTSC rates as exact fractions for FFmpeg.
const sequenceRate = (fps) => ({
  fps,
  fpsText:
    { 23.976: "24000/1001", 29.97: "30000/1001", 59.94: "60000/1001" }[fps] ||
    String(fps),
});
// Output names come from the sequence name (frame_0001.png → frame).
const nameSource = (job) =>
  job.sequence
    ? path.join(job.sequence.dir, job.sequence.name + ".png")
    : job.path;
const clone = (x) => JSON.parse(JSON.stringify(x));
function createService({
  engineDir,
  dataDir,
  onUpdate,
  toolsRoot = process.env.MMD_TEST_TOOLS_ROOT,
  toolOptions = {},
  // MMD export plugin DLL shipped with the app (packaged) or built locally (dev).
  mmdPluginDll = [
    path.join(__dirname, "..", "mmd-plugin", "MMDEncoderPlugin.dll"),
    path.join(__dirname, "..", "mmd-plugin", "build", "MMDEncoderPlugin.dll"),
  ].find((p) => fs.existsSync(p)) || "",
  // Program the plugin runs in Node mode for its helper (MMDEncoder.exe when packaged).
  mmdAppExe = process.execPath,
} = {}) {
  dataDir = dataDir || path.join(os.tmpdir(), "mmd-encoder");
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
      message: "启用后请先验证本机 RTX 功能",
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
      presetId: "",
      followMmd: true,
      audioFade: 0,
      // "off" | "with" | "only"; "" until a preset decides (settings from 1.4.1).
      maskMode: "",
      rangeSuffix: true,
      savedAt: "",
      error: "",
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
    // The window reads a video job's log through the "logs" action; leaving
    // the up-to-200 KB logs out keeps each push small however long the queue.
    const s = clone({
      ...state,
      jobs: state.jobs.map(({ log, ...j }) => j),
      // Media logs: only the tail; the window asks for the whole one.
      mediaJobs: state.mediaJobs.map((j) =>
        j.log?.length > 8000 ? { ...j, log: "…" + j.log.slice(-8000) } : j,
      ),
    });
    onUpdate(s);
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
      state.notice = "日志或队列记录保存失败：" + e.message;
    }
  }
  const deletedBuiltins = new Set();
  // Saved entries this version cannot read; written back unchanged so a later
  // version (or a fix) can still use them.
  const unreadable = { presets: [], builtins: {} };
  // Identifies the shipped definition of a built-in preset, so an edit made to
  // one version of it is dropped once an update ships a different definition.
  function builtinFingerprint(p) {
    const shipped = core.BUILTINS.find((b) => b.id === p.id);
    return shipped
      ? crypto
          .createHash("sha256")
          // Settings added later with their off value (hiRes, editFriendly) are left
          // out, so adding a setting does not count as changing every preset.
          .update(
            JSON.stringify([
              shipped.name,
              Object.fromEntries(
                Object.entries(shipped.settings).filter(
                  ([k, v]) =>
                    !(["hiRes", "editFriendly"].includes(k) && v === false),
                ),
              ),
            ]),
          )
          .digest("hex")
          .slice(0, 16)
      : "";
  }
  function sameName(a, b) {
    return a.toLocaleLowerCase() === b.toLocaleLowerCase();
  }
  function persist() {
    fs.mkdirSync(dataDir, { recursive: true });
    const target = path.join(dataDir, "settings.json"),
      tmp = target + "." + crypto.randomUUID() + ".tmp";
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        {
          version: 1,
          settings: state.settings,
          presets: state.presets
            .filter((p) => !p.builtin)
            .map(({ id, name, settings, hidden }) => ({
              id,
              name,
              settings,
              ...(typeof hidden === "boolean" ? { hidden } : {}),
            }))
            .concat(unreadable.presets),
          // Built-in presets are rebuilt from code; only the user's changes are saved.
          builtins: Object.assign(
            {},
            unreadable.builtins,
            Object.fromEntries(
              state.presets
                .filter(
                  (p) =>
                    p.builtin && (p.edited || typeof p.hidden === "boolean"),
                )
                .map((p) => [
                  p.id,
                  {
                    ...(p.edited
                      ? {
                          name: p.name,
                          settings: p.settings,
                          base: builtinFingerprint(p),
                        }
                      : {}),
                    ...(typeof p.hidden === "boolean"
                      ? { hidden: p.hidden }
                      : {}),
                  },
                ]),
            ),
          ),
          deletedBuiltins: [...deletedBuiltins],
          // Unanswered update conflicts survive a restart.
          ...(state.presetConflicts.length
            ? {
                builtinConflicts: state.presetConflicts.map(
                  ({ id, name, settings }) => ({ id, name, settings }),
                ),
              }
            : {}),
          presetOrder: state.presets.map((p) => p.id),
          mmdExport: {
            presetId: state.mmd.presetId,
            followMmd: state.mmd.followMmd,
            audioFade: state.mmd.audioFade,
            maskMode: state.mmd.maskMode,
            rangeSuffix: state.mmd.rangeSuffix,
            savedAt: state.mmd.savedAt,
          },
        },
        null,
        2,
      ),
    );
    fs.renameSync(tmp, target);
    syncMmdExport();
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
    const m = state.mmd;
    m.error = "";
    try {
      adoptMmdSelection();
      mmdExport.writeConfig({
        presets: state.presets.map(({ id, name, settings }) => ({
          id,
          name,
          settings,
        })),
        engines: state.engineInfo,
        appExe: mmdAppExe,
        helper: path.join(__dirname, "mmd-export.cjs"),
      });
    } catch (e) {
      m.error = "无法写入导出设置：" + e.message;
      return;
    }
    const preset = state.presets.find((p) => p.id === m.presetId);
    m.error = !m.presetId
      ? ""
      : !preset
        ? "导出预设已被删除，请重新选择"
        : mmdExport.unsupported(preset.settings, m.maskMode) ||
          (!state.engineInfo.ffmpeg || !state.engineInfo.ffprobe
            ? "请先在“设置与引擎”里安装编码工具"
            : "");
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
    if (state.mmd.error) throw Error(state.mmd.error);
    if (!state.mmd.presetId) throw Error("请先选择导出预设");
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mmdencoder-export-test-"),
    );
    const started = Date.now();
    let snapshot = "";
    try {
      const width = 640,
        height = 360,
        frames = 30;
      const plan = mmdExport.plan({
        avi: path.join(dir, "test.avi"),
        width,
        height,
        bits: 32,
        bottomUp: true,
        avgTimePerFrame: 333333,
      });
      snapshot = mmdExport.snapshotPath(plan.temp);
      const child = spawn(plan.exe, plan.args, {
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
      });
      children.add(child);
      let stderr = "";
      child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
      child.stdin.on("error", () => {});
      // Settles once, whether FFmpeg fails to start, exits early or hangs.
      const exited = new Promise((resolve) => {
        child.once("error", (e) => {
          stderr += "\n" + e.message;
          resolve(-1);
        });
        child.once("close", (code) => resolve(code ?? -1));
      });
      const timer = setTimeout(() => {
        stderr += "\n测试编码超过 60 秒未结束，已停止";
        child.kill();
      }, 60000);
      let gone = false;
      exited.then(() => (gone = true));
      const frame = Buffer.alloc(width * height * 4, 0x80);
      for (let i = 0; i < frames && !gone; i++)
        if (!child.stdin.write(frame))
          // Wait for room in the pipe, or for FFmpeg to be gone.
          await Promise.race([
            new Promise((r) => child.stdin.once("drain", r)),
            exited,
          ]);
      if (!gone) child.stdin.end();
      const code = await exited;
      clearTimeout(timer);
      children.delete(child);
      if (code !== 0)
        throw Error(
          "编码失败（退出码 " +
            code +
            "）：" +
            stderr.trim().split("\n").slice(-3).join(" "),
        );
      if (!fs.existsSync(plan.temp)) throw Error("没有生成测试文件");
      if (plan.maskTemp && !fs.existsSync(plan.maskTemp))
        throw Error("没有生成 Alpha 遮罩测试文件");
      state.mmd.test = {
        ok: true,
        at: new Date().toISOString(),
        message: `测试编码通过${plan.maskTemp ? "（含 Alpha 遮罩）" : ""}（${((Date.now() - started) / 1000).toFixed(1)} 秒）`,
      };
    } catch (e) {
      state.mmd.test = {
        ok: false,
        at: new Date().toISOString(),
        message: e.message,
      };
      throw e;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      if (snapshot) fs.rmSync(snapshot, { force: true });
    }
  }
  function schema(p, full = false) {
    if (!p || typeof p !== "object" || Array.isArray(p))
      throw Error("设置必须是对象");
    if (full && Object.keys(core.DEFAULTS).some((k) => !(k in p)))
      throw Error("预设缺少必要字段");
    for (const [k, v] of Object.entries(p)) {
      if (
        !(k in core.DEFAULTS) ||
        typeof v !== typeof core.DEFAULTS[k] ||
        (typeof v === "number" && !Number.isFinite(v))
      )
        throw Error("无效设置字段：" + k);
      if (typeof v === "string" && v.length > 4096)
        throw Error("设置文本过长：" + k);
    }
    return p;
  }
  function presetValid(p) {
    if (
      !p ||
      typeof p.name !== "string" ||
      !p.name.trim() ||
      p.name.length > 80
    )
      throw Error("预设名称须为 1–80 字符");
    p = {
      ...p,
      settings: {
        ...core.DEFAULTS,
        audioBitrate: 0,
        resizeMode: "source",
        width: 1920,
        height: 1080,
        keepAspect: true,
        resizeAxis: "width",
        ...p.settings,
        presetName: p.name.trim(),
      },
    };
    schema(p.settings, true);
    const s = { ...p.settings, outputMode: "encoded", outputDir: "" };
    const errors = core.validate(s);
    if (errors.length) throw Error("预设参数无效：" + errors.join("；"));
    return {
      id: crypto.randomUUID(),
      name: p.name.trim(),
      builtin: false,
      settings: clone(p.settings),
    };
  }
  try {
    const saved = JSON.parse(
      fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"),
    );
    if (saved.version !== 1) throw Error("版本不支持");
    if (saved.mmdExport && typeof saved.mmdExport === "object") {
      if (typeof saved.mmdExport.presetId === "string")
        state.mmd.presetId = saved.mmdExport.presetId;
      if ([0, 0.5, 1, 2].includes(saved.mmdExport.audioFade))
        state.mmd.audioFade = saved.mmdExport.audioFade;
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
    for (const id of saved.deletedBuiltins || [])
      if (typeof id === "string") deletedBuiltins.add(id);
    // Personal presets always survive an update. A built-in the new version
    // changed (its fingerprint no longer matches) takes the new definition, and
    // the user's edit of it becomes a conflict they resolve in the app: drop it
    // or keep it as a personal preset. A built-in the new version dropped
    // simply disappears.
    const overrides =
      saved.builtins && typeof saved.builtins === "object"
        ? saved.builtins
        : {};
    const conflict = (id, o, builtinName) => {
      try {
        const v = presetValid({
          name: o.name || builtinName,
          settings: o.settings,
        });
        if (!state.presetConflicts.some((c) => c.id === id))
          state.presetConflicts.push({
            id,
            name: v.name,
            settings: v.settings,
            builtinName,
          });
      } catch {}
    };
    state.presets = state.presets
      .filter((p) => !deletedBuiltins.has(p.id))
      .map((p) => {
        const o = overrides[p.id];
        if (!o || typeof o !== "object") return p;
        const r = { ...p };
        if (o.settings && o.base !== builtinFingerprint(p))
          conflict(p.id, o, p.name);
        if (o.settings && o.base === builtinFingerprint(p))
          try {
            const v = presetValid({
              name: o.name || p.name,
              settings: o.settings,
            });
            Object.assign(r, {
              name: v.name,
              settings: v.settings,
              edited: true,
            });
          } catch {
            unreadable.builtins[p.id] = o;
          }
        if (typeof o.hidden === "boolean") r.hidden = o.hidden;
        return r;
      });
    for (const c of Array.isArray(saved.builtinConflicts)
      ? saved.builtinConflicts
      : []) {
      const b = state.presets.find((p) => p.builtin && p.id === c?.id);
      if (b && c.settings) conflict(b.id, c, b.name);
    }
    for (const p of saved.presets || []) {
      let valid;
      try {
        valid = presetValid(p);
      } catch (e) {
        unreadable.presets.push(p);
        state.notice = `个人预设“${p?.name || "未命名"}”暂时无法读取，已原样保留：${e.message}`;
        continue;
      }
      valid.id =
        typeof p.id === "string" && !p.id.startsWith("builtin-")
          ? p.id
          : valid.id;
      if (typeof p.hidden === "boolean") valid.hidden = p.hidden;
      state.presets.push(valid);
    }
    // A built-in that now shares a personal preset's name is the one renamed.
    for (const b of state.presets.filter((p) => p.builtin && !p.edited))
      if (
        state.presets.some(
          (p) => !p.builtin && p.id !== b.id && sameName(p.name, b.name),
        )
      ) {
        b.name += "（内置）";
        b.settings = { ...b.settings, presetName: b.name };
      }
    if (Array.isArray(saved.presetOrder)) {
      const rank = new Map(saved.presetOrder.map((id, i) => [id, i]));
      state.presets = state.presets
        .map((p, i) => [rank.get(p.id) ?? saved.presetOrder.length + i, p])
        .sort((a, b) => a[0] - b[0])
        .map(([, p]) => p);
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      // Keep the unreadable file before the next save replaces it.
      const file = path.join(dataDir, "settings.json");
      const backup = file + ".unreadable-" + Date.now();
      try {
        fs.copyFileSync(file, backup);
      } catch {}
      state.notice =
        "已忽略无法读取的配置：" +
        e.message +
        "；原文件已备份为 " +
        path.basename(backup);
    }
  }
  function run(exe, args, { timeout = 0, onData, encoding = false } = {}) {
    return new Promise((resolve, reject) => {
      if (disposed) return reject(Error("应用已关闭"));
      const child = spawn(exe, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      children.add(child);
      if (encoding) active = child;
      let stdout = "",
        stderr = "",
        timed = false;
      const timer = timeout
        ? setTimeout(() => {
            timed = true;
            child.kill();
          }, timeout)
        : null;
      const data = (stream, b) => {
        const s = b.toString();
        if (stream === "out") stdout = (stdout + s).slice(-1024 * 1024);
        else stderr = (stderr + s).slice(-1024 * 1024);
        onData?.(s, stream);
      };
      child.stdout.on("data", (b) => data("out", b));
      child.stderr.on("data", (b) => data("err", b));
      let settled = false;
      const done = (err, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        children.delete(child);
        if (active === child) active = null;
        if (err || code !== 0) {
          const e = Error(
            timed
              ? "引擎运行超时"
              : err
                ? err.message
                : stderr.trim().slice(-3000) || "编码器退出：" + code,
          );
          e.stdout = stdout;
          e.stderr = stderr;
          e.code = code;
          reject(e);
        } else resolve({ stdout, stderr });
      };
      child.on("error", (e) => done(e));
      child.on("close", (code) => done(null, code));
    });
  }
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
  // Media page queue: each file is processed on its own with the options chosen
  // when the queue starts; the output name is generated per file and never reused.
  function mediaLocation(o) {
    return {
      outputMode: ["source", "encoded", "custom"].includes(o.location)
        ? o.location
        : "source",
      outputDir: o.outputDir || "",
    };
  }
  function requireMediaJob(id) {
    const job = state.mediaJobs.find((j) => j.id === id);
    if (!job) throw Error("文件不在列表中");
    return job;
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
      return {
        videoCodec: v?.codec_name,
        audioCodec: a?.codec_name,
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
  let soxrCache = { key: "", value: false };
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
      const r = await run(ff, ["-hide_banner", "-buildconf"], {
        timeout: 15000,
      });
      value = /--enable-libsoxr/.test(r.stdout + (r.stderr || ""));
    } catch {}
    soxrCache = { key, value };
    return value;
  }
  // File parameters for the media queue, read like the video queue's. Audio-only
  // files get an audio summary; a failed read leaves the file usable.
  const mediaProbes = new Set();
  async function probeMediaJob(job) {
    try {
      await locate();
      if (!state.engineInfo.ffprobe) return;
      const r = await run(
        state.engineInfo.ffprobe,
        [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          job.path,
        ],
        { timeout: 30000 },
      );
      const data = JSON.parse(r.stdout);
      try {
        job.meta = core.metadata(data);
      } catch {
        const a = data.streams?.find((s) => s.codec_type === "audio");
        if (!a) throw Error("未找到音视频轨");
        job.meta = {
          audioOnly: true,
          codec: a.codec_name || "未知",
          duration: Number(data.format?.duration || a.duration) || 0,
          size: Number(data.format?.size) || job.size,
          audio: {
            ...core.audioInfo(a),
            // An audio-only file's overall rate is the audio rate.
            bitRate:
              core.audioInfo(a).bitRate || Number(data.format?.bit_rate) || 0,
          },
        };
      }
    } catch (e) {
      job.metaError = "无法读取文件信息：" + e.message;
    }
    emit();
  }
  async function runMediaJob(job, o) {
    job.status = "running";
    job.error = undefined;
    job.output = undefined;
    job.log = "";
    job.startedAt = Date.now();
    emit();
    let temp;
    try {
      if (o.operation === "merge" && !job.audioPath)
        throw Error("缺少要合并的音频文件");
      if (
        o.hiRes &&
        o.operation !== "video" &&
        !["wav", "flac"].includes(o.audioFormat)
      )
        throw Error("Hi-Res 只支持 WAV / FLAC 输出");
      const p = {
        operation: o.operation,
        input: job.path,
        audioInput: job.audioPath,
        audioFormat: o.audioFormat,
        hiRes: !!o.hiRes && o.operation !== "video",
        audioBitrate: Number(o.audioBitrate) || 0,
        shortest: o.shortest !== false,
        container: o.container === "mkv" ? "mkv" : "mp4",
      };
      const source = await probeMedia(job.path);
      const audioSource =
        o.operation === "merge" ? await probeMedia(job.audioPath) : source;
      p.sourceAudio = {
        codec: audioSource.audioCodec,
        bitRate: audioSource.audioBitRate,
        sampleRate: audioSource.audio?.sampleRate,
        bits: audioSource.audio?.bits,
        float: audioSource.audio?.float,
      };
      let hiResNote = "";
      if (p.hiRes) {
        p.soxr = await hasSoxr();
        const plan = media.hiResPlan(p.audioFormat, p.sourceAudio);
        hiResNote = `# Hi-Res：${plan.from} → ${plan.to}，${plan.reason}${plan.action === "resample" ? (p.soxr ? "（soxr 重采样）" : "（当前 FFmpeg 没有 soxr，用内置重采样）") : ""}
`;
      }
      let note = hiResNote;
      if (o.operation !== "audio") {
        const container = media.mergeContainer(p, {
          videoCodec: source.videoCodec,
          audioCodec: audioSource.audioCodec,
        });
        if (container !== p.container) {
          const audio =
            o.operation !== "merge"
              ? ""
              : " / " +
                (p.audioFormat === "copy"
                  ? audioSource.audioCodec || "未知"
                  : p.audioFormat);
          note = `# MP4 放不下此编码（${source.videoCodec || "未知"}${audio}），已改用 MKV\n`;
        }
        p.container = container;
      }
      p.output = media.suggestOutput(p, mediaLocation(o), fs.existsSync);
      if (!p.output) throw Error("无法生成输出文件名");
      media.command(p, state.engineInfo, p.output);
      fs.mkdirSync(path.dirname(p.output), { recursive: true });
      temp = fs.mkdtempSync(path.join(path.dirname(p.output), ".mmd-media-"));
      const target = path.join(temp, "output" + path.extname(p.output));
      const cmd = media.command(p, state.engineInfo, target);
      job.log = note + core.commandText([cmd]) + "\n";
      await run(cmd.exe, cmd.args, {
        encoding: true,
        onData: (t) => {
          job.log = (job.log + t).slice(-200000);
          emitProgress();
        },
      });
      if (stopped) throw Error("已取消");
      commit(target, p.output);
      job.output = p.output;
      job.status = "done";
    } catch (e) {
      job.status = stopped ? "cancelled" : "failed";
      job.error = e.message;
      job.log += "\n" + e.message;
    } finally {
      if (temp) fs.rmSync(temp, { recursive: true, force: true });
      job.elapsed = (Date.now() - job.startedAt) / 1000;
      try {
        fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
        fs.writeFileSync(
          path.join(dataDir, "logs", "media-" + job.id + ".log"),
          job.log,
        );
      } catch (e) {
        job.error =
          (job.error ? job.error + "；" : "") + "日志保存失败：" + e.message;
      }
      emit();
    }
  }
  // Detection runs real trial encodes, so its result is cached in dataDir and
  // reused until the tools, the display adapters/drivers or the engine list change.
  const cacheFile = () => path.join(dataDir, "engine-cache.json");
  async function displayAdapters() {
    const key =
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";
    const lines = [];
    for (const value of ["DriverDesc", "DriverVersion"]) {
      const { stdout } = await run("reg", ["query", key, "/s", "/v", value], {
        timeout: 10000,
      });
      lines.push(
        ...stdout
          .split(/\r?\n/)
          .filter((l) => /^\s+Driver(?:Desc|Version)\s/.test(l))
          .map((l) => l.trim().replace(/\s+/g, " ")),
      );
    }
    return lines.join("|");
  }
  async function detectionKey() {
    let gpu = "";
    try {
      gpu = await displayAdapters();
    } catch (e) {
      state.detectionLog +=
        "无法读取显卡信息，本次不使用检测缓存：" + e.message + "\n";
    }
    if (!gpu) return "";
    const files = {};
    for (const k of ["ffmpeg", "nvencc"]) {
      const exe = state.engineInfo[k];
      if (!exe) continue;
      const st = fs.statSync(exe);
      files[k] = [exe, st.size, st.mtimeMs];
    }
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          gpu,
          files,
          engines: core.ENGINES.map((e) => [e.id, e.depths]),
        }),
      )
      .digest("hex");
  }
  function readDetectionCache(key) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
      if (c.key !== key || !Array.isArray(c.engines) || !c.engines.length)
        return null;
      const ids = new Set(core.ENGINES.map((e) => e.id));
      return c.engines.every((e) => ids.has(e.id)) ? c : null;
    } catch {
      return null;
    }
  }
  function writeDetectionCache(key, log) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = cacheFile() + "." + crypto.randomUUID() + ".tmp";
      fs.writeFileSync(
        tmp,
        JSON.stringify(
          {
            key,
            detectedAt: new Date().toISOString(),
            engines: state.engines,
            log,
          },
          null,
          2,
        ),
      );
      fs.renameSync(tmp, cacheFile());
    } catch (e) {
      state.detectionLog += "检测缓存保存失败：" + e.message + "\n";
    }
  }
  async function detect({ force = false } = {}) {
    if (detectPromise) return detectPromise;
    state.detecting = true;
    state.engines = [];
    emit();
    detectPromise = (async () => {
      await locate();
      if (!state.engineInfo.ffmpeg) {
        state.notice = "未找到可运行的 FFmpeg，请检查引擎目录";
        return;
      }
      // Hi-Res resampling uses soxr when this FFmpeg has it.
      state.engineInfo.soxr = await hasSoxr();
      const key = await detectionKey();
      const cached = !force && key && readDetectionCache(key);
      if (cached) {
        state.engines = cached.engines;
        state.detectionLog +=
          (cached.log || "") +
          "\n使用 " +
          cached.detectedAt +
          " 的编码器检测结果。工具、显卡或驱动变化后会自动重新检测，也可以手动重新检测。\n";
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
        state.notice = e.message;
        return;
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-detect-"));
      try {
        const fixture = path.join(dir, "probe.mkv");
        if (state.engineInfo.nvencc)
          await run(
            state.engineInfo.ffmpeg,
            [
              "-v",
              "error",
              "-f",
              "lavfi",
              "-i",
              "color=black:s=640x360:r=30:d=0.2",
              "-c:v",
              "ffv1",
              fixture,
            ],
            { timeout: 15000 },
          );
        for (const e of core.ENGINES) {
          if (disposed) break;
          if (
            e.backend === "nvencc"
              ? !state.engineInfo.nvencc
              : !new RegExp("\\b" + e.id + "\\b").test(listing)
          )
            continue;
          const depths = [];
          for (const depth of e.depths) {
            try {
              if (e.backend === "nvencc") {
                await run(
                  state.engineInfo.nvencc,
                  [
                    "--avsw",
                    "-i",
                    fixture,
                    "-o",
                    path.join(dir, e.codec + "-" + depth + ".mkv"),
                    "--codec",
                    e.codec,
                    "--output-depth",
                    String(depth),
                    "--output-csp",
                    "yuv420",
                    "--cqp",
                    "24",
                  ],
                  { timeout: 20000 },
                );
              } else {
                await run(
                  state.engineInfo.ffmpeg,
                  [
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=black:s=640x360:r=30:d=0.2",
                    "-frames:v",
                    "3",
                    "-an",
                    "-c:v",
                    e.id,
                    "-pix_fmt",
                    e.codec === "prores"
                      ? "yuv422p10le"
                      : "yuv420p" + (depth === 10 ? "10le" : ""),
                    ...(e.id === "libsvtav1" ? ["-preset", "12"] : []),
                    "-f",
                    "null",
                    "-",
                  ],
                  { timeout: 20000 },
                );
              }
              depths.push(depth);
            } catch (err) {
              state.detectionLog +=
                e.label +
                " " +
                depth +
                "-bit：" +
                err.message.slice(-800) +
                "\n";
            }
          }
          if (depths.length) {
            let alpha = false;
            if (e.id === "nvencc:hevc") {
              try {
                const source = path.join(dir, "alpha.mkv");
                await run(
                  state.engineInfo.ffmpeg,
                  [
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=red:s=640x360:r=30:d=0.1,format=yuva444p,geq=a=128:lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)'",
                    "-c:v",
                    "ffv1",
                    source,
                  ],
                  { timeout: 15000 },
                );
                const output = path.join(dir, "alpha-hevc.mov");
                await run(
                  state.engineInfo.nvencc,
                  [
                    "--avsw",
                    "-i",
                    source,
                    "-o",
                    output,
                    "--codec",
                    "hevc",
                    "--output-depth",
                    "8",
                    "--output-csp",
                    "yuva420",
                    "--alpha-channel-mode",
                    "straight",
                    "--cqp",
                    "24",
                  ],
                  { timeout: 20000 },
                );
                const traced = await run(
                  state.engineInfo.ffmpeg,
                  [
                    "-i",
                    output,
                    "-map",
                    "0:v:0",
                    "-c",
                    "copy",
                    "-bsf:v",
                    "trace_headers",
                    "-f",
                    "null",
                    "-",
                  ],
                  { timeout: 15000 },
                );
                alpha =
                  /Alpha Channel Information/.test(traced.stderr) &&
                  /alpha_channel_bit_depth_minus8[^\n]*= 0/.test(traced.stderr);
              } catch (err) {
                state.detectionLog +=
                  "HEVC Alpha：" + err.message.slice(-1000) + "\n";
              }
            }
            state.engines.push({ ...e, depths, alpha });
          }
          emit();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      if (key && !disposed && state.engines.length)
        writeDetectionCache(key, state.detectionLog.slice(logStart));
    })()
      .catch((e) => {
        state.notice = "检测未完成：" + e.message;
      })
      .finally(() => {
        state.detecting = false;
        detectPromise = null;
        syncMmdExport();
        emit();
      });
    return detectPromise;
  }
  // Presentation times (seconds, ascending) of about the first 120 frames.
  // Packet timestamps need no decoding (a 4K intermediate took seconds to
  // decode); packets come in decode order, so a few more are read and the
  // last ones dropped in case a reordered frame falls past the sample.
  // Without packet timestamps the frames are decoded as before.
  const SAMPLE = 120,
    REORDER = 16;
  async function sampleTimes(input) {
    const probe = async (entries, extra = []) =>
      JSON.parse(
        (
          await run(
            state.engineInfo.ffprobe,
            [
              "-v",
              "error",
              "-select_streams",
              "v:0",
              "-read_intervals",
              "%+#" + (SAMPLE + REORDER),
              ...extra,
              "-show_entries",
              entries,
              "-of",
              "json",
              input,
            ],
            { timeout: 15000 },
          )
        ).stdout,
      );
    const packets = (await probe("packet=pts_time")).packets || [];
    const pts = packets.map((p) => Number(p.pts_time));
    if (packets.length && pts.every(Number.isFinite)) {
      pts.sort((a, b) => a - b);
      // Fewer packets than asked: the whole file was read, nothing is missing.
      return packets.length < SAMPLE + REORDER ? pts : pts.slice(0, SAMPLE);
    }
    const frames = (await probe("frame=best_effort_timestamp_time")).frames;
    return (frames || [])
      .slice(0, SAMPLE)
      .map((f) => Number(f.best_effort_timestamp_time))
      .filter(Number.isFinite);
  }
  async function add(paths) {
    if (!Array.isArray(paths) || paths.length > 1000)
      throw Error("请选择最多 1000 个视频文件");
    await locate();
    const folders = new Map(); // picked PNGs of one folder: read it once
    for (const input of paths) {
      if (typeof input !== "string" || !path.isAbsolute(input))
        throw Error("素材必须为绝对路径");
      let resolved = path.resolve(input);
      // A PNG, or a folder of them, is read as an image sequence; picking
      // several frames of one sequence adds it once.
      let seq = null,
        isDir = false;
      try {
        isDir = fs.statSync(resolved).isDirectory();
        if (isDir || /\.png$/i.test(resolved))
          seq = sequence.find(resolved, folders);
      } catch {}
      if (isDir && !seq) {
        state.notice = "文件夹里没有 PNG 序列：" + path.basename(input);
        continue;
      }
      if (seq) resolved = seq.first;
      if (
        state.jobs.some(
          (j) =>
            j.path.toLowerCase() === resolved.toLowerCase() ||
            (seq &&
              j.sequence?.pattern.toLowerCase() === seq.pattern.toLowerCase()),
        )
      ) {
        if (!seq || paths.length === 1)
          state.notice =
            "已跳过重复素材：" + (seq ? seq.name : path.basename(input));
        continue;
      }
      const job = {
        id: crypto.randomUUID(),
        path: resolved,
        name: seq ? seq.name + "（PNG 序列）" : path.basename(input),
        status: "probing",
        progress: 0,
        ...(seq ? { sequence: { ...seq, ...sequenceRate(SEQUENCE_FPS) } } : {}),
      };
      state.jobs.push(job);
      emit();
      try {
        if (!state.engineInfo.ffprobe)
          throw Error("未找到 ffprobe，无法读取素材");
        if (/\.png$/i.test(resolved) && !seq)
          throw Error(
            "只有一张 PNG，不是图片序列（需要 name_0001.png 这样带连续编号的文件）",
          );
        if (seq?.missing !== null && seq?.missing !== undefined)
          throw Error(
            `PNG 序列不连续：缺少第 ${seq.missing} 帧（从 ${seq.start} 开始找到 ${seq.total} 张）`,
          );
        if (seq) {
          job.meta = await sequenceMeta(job);
          job.status = "ready";
          emit();
          continue;
        }
        const stat = fs.statSync(input);
        if (!stat.isFile()) throw Error("输入不是文件");
        const r = await run(
          state.engineInfo.ffprobe,
          [
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            input,
          ],
          { timeout: 30000 },
        );
        job.meta = core.metadata(JSON.parse(r.stdout));
        // Stream rates often both say 30/1 even when individual timestamps vary.
        // A bounded sample of the first frames' times establishes positive VFR
        // evidence without scanning an entire multi-hour source during import.
        try {
          const ts = await sampleTimes(input);
          const gaps = ts
            .slice(1)
            .map((v, i) => v - ts[i])
            .filter((v) => v > 0)
            .sort((a, b) => a - b);
          if (gaps.length > 2) {
            const median = gaps[Math.floor(gaps.length / 2)];
            job.meta.vfr ||= gaps.some(
              (g) => Math.abs(g - median) > Math.max(0.002, median * 0.1),
            );
          }
        } catch (e) {
          job.log = "帧时间戳抽样未完成：" + e.message;
        }
        job.meta.size = stat.size;
        job.status = "ready";
      } catch (e) {
        job.status = "invalid";
        job.error = "素材探测失败：" + e.message;
      }
      emit();
    }
    return clone(state);
  }
  // A PNG sequence has no frame rate of its own: the user sets it (default
  // SEQUENCE_FPS), and length and timing follow from it.
  async function sequenceMeta(job) {
    const q = job.sequence;
    const r = await run(
      state.engineInfo.ffprobe,
      [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        ...core.inputArgs(job),
      ],
      { timeout: 30000 },
    );
    return withSequenceRate(core.metadata(JSON.parse(r.stdout)), q);
  }
  function withSequenceRate(meta, q) {
    return {
      ...meta,
      fps: q.fps,
      fpsText: q.fpsText,
      duration: q.count / q.fps,
      size: q.size,
      // Bits per second over the whole sequence, as for a video file.
      videoBitRate: Math.round((q.size * 8 * q.fps) / q.count),
      vfr: false,
      sequence: { count: q.count, start: q.start },
    };
  }
  // Apply a drag-sort result: ids must be exactly the current list's ids.
  function reorder(list, ids) {
    if (
      !Array.isArray(ids) ||
      ids.length !== list.length ||
      new Set(ids).size !== ids.length
    )
      throw Error("排序数据无效，请重试");
    const byId = new Map(list.map((x) => [x.id, x]));
    if (ids.some((id) => !byId.has(id))) throw Error("排序数据无效，请重试");
    return ids.map((id) => byId.get(id));
  }
  function requireJob(id) {
    const j = state.jobs.find((j) => j.id === id);
    if (!j) throw Error("未找到此任务");
    return j;
  }
  function preview(job, s = state.settings) {
    const errors = core.validate(s, job.meta);
    if (
      (s.vsr || s.vfg) &&
      (!state.enhancements.verified ||
        state.enhancements.signature !== enhancementSignature(s))
    )
      errors.push("RTX 设置尚未通过本机验证，请在 RTX 增强页验证所选设置");
    if (!job.meta) errors.push("素材信息尚未读取成功");
    if (!state.engineInfo.ffmpeg) errors.push("未找到 FFmpeg");
    // Mask only encodes with FFmpeg's lossless x264 / VP9, not the chosen encoder.
    const maskOnly = s.alphaMode === "mask";
    if (
      !maskOnly &&
      s.encoder.startsWith("nvencc:") &&
      !state.engineInfo.nvencc
    )
      errors.push("未找到 NVEncC");
    if (
      !maskOnly &&
      !state.detecting &&
      !state.engines.some((e) => e.id === s.encoder)
    )
      errors.push("编码器当前不可用，请重新检测或选择其他编码器");
    const available = state.engines.find((e) => e.id === s.encoder);
    if (!maskOnly && available && !available.depths.includes(s.bitDepth))
      errors.push("此编码器未通过所选位深的实测");
    if (
      s.encoder === "nvencc:hevc" &&
      s.alphaMode === "preserve" &&
      !available?.alpha
    )
      errors.push(
        "本机 NVEncC HEVC Alpha 试编码未通过；请检查显卡支持和驱动，或选择 ProRes 4444 / VP9",
      );
    let paths = { output: "" },
      commands = [];
    try {
      paths = core.outputPaths(
        nameSource(job),
        s,
        state.jobs.indexOf(job) + 1,
        fs.existsSync,
      );
      if (job.meta && errors.length === 0)
        commands = core.buildCommands(job, s, state.engineInfo, paths);
    } catch (e) {
      errors.push(e.message);
    }
    const target = (() => {
      try {
        return core.parseFps(s.fps)?.value;
      } catch {
        return null;
      }
    })();
    const meta = job.meta;
    const summary = !meta
      ? ""
      : maskOnly
        ? `${meta.width} × ${meta.height} · ${meta.fpsText || "未知"}${target ? " → " + s.fps : ""} FPS / 分离 Alpha · 仅黑白遮罩 · ${s.container === "webm" ? "VP9" : "H.264"} 无损 · 无音频 · ${s.container.toUpperCase()}`
        : `${meta.width} × ${meta.height} · ${meta.fpsText || "未知"}${target ? " → " + s.fps : ""} FPS / ${core.ENGINES.find((e) => e.id === s.encoder)?.label || s.encoder} · ${s.bitDepth}-bit · ${s.audio === "none" ? "无音频" : s.audio.toUpperCase()} · ${s.container.toUpperCase()}${target > meta.fps ? "；通过重复帧提高帧率，不生成新的运动细节" : ""}${s.encoder.startsWith("nvencc:") ? "；NVEncC 预处理需要额外临时磁盘空间" : ""}`;
    return {
      ...paths,
      dimensions: meta ? core.dimensions(s, meta) : null,
      summary,
      command: core.commandText(commands, { prepare: true }),
      errors: [...new Set(errors)],
    };
  }
  function commit(tmp, dest) {
    try {
      fs.linkSync(tmp, dest);
    } catch (e) {
      if (!["ENOTSUP", "ENOSYS", "EPERM", "EXDEV", "EINVAL"].includes(e.code))
        throw e;
      // Removable exFAT/FAT volumes have no hard links. COPYFILE_EXCL still
      // refuses existing destinations; Node removes incomplete copies on error.
      fs.copyFileSync(tmp, dest, fs.constants.COPYFILE_EXCL);
    }
    fs.unlinkSync(tmp);
  }
  function append(job, text) {
    job.log = ((job.log || "") + text).slice(-200000);
    const pieces = pendingLogs.get(job.id) || [];
    pieces.push(text);
    pendingLogs.set(job.id, pieces);
  }
  async function encode(job) {
    const s = job.settings;
    const maskOnly =
      job.status === "partial" && job.output && fs.existsSync(job.output);
    job.status = "encoding";
    job.error = undefined;
    job.progress = 0;
    job.startedAt = Date.now();
    job.stage = maskOnly ? "重试 Alpha 遮罩" : "准备";
    emit();
    let tempDir;
    try {
      const errors = core.validate(s, job.meta);
      if (
        (s.vsr || s.vfg) &&
        (!state.enhancements.verified ||
          state.enhancements.signature !== enhancementSignature(s))
      )
        errors.push("RTX 设置未通过本机验证");
      if (errors.length) throw Error(errors.join("；"));
      const engine = state.engines.find((e) => e.id === s.encoder);
      if (
        s.alphaMode !== "mask" &&
        (!engine || !engine.depths.includes(s.bitDepth))
      )
        throw Error("所选编码器或位深未通过本机试编码，请调整参数");
      if (
        s.encoder === "nvencc:hevc" &&
        s.alphaMode === "preserve" &&
        !engine?.alpha
      )
        throw Error("本机未通过 HEVC Alpha 试编码，已停止以避免丢失透明通道");
      let paths = maskOnly
        ? { output: job.output, maskOutput: job.maskOutput }
        : core.outputPaths(
            nameSource(job),
            s,
            state.jobs.indexOf(job) + 1,
            fs.existsSync,
          );
      const dir = path.dirname(paths.output);
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      tempDir = fs.mkdtempSync(path.join(dir, ".mmd-"));
      const temps = {
        output: path.join(tempDir, "video." + s.container),
        maskOutput: s.alphaMask
          ? path.join(tempDir, "mask." + s.container)
          : undefined,
      };
      let commands = core.buildCommands(job, s, state.engineInfo, temps);
      if (maskOnly) commands = commands.filter((c) => c.mask);
      job.output = maskOnly ? job.output : undefined;
      job.maskOutput = paths.maskOutput;
      for (let i = 0; i < commands.length; i++) {
        if (stopped) throw Error("已取消");
        const c = commands[i];
        job.stage = c.stage;
        append(job, "\n" + core.commandText([c]) + "\n");
        emit();
        let progressBuffer = "";
        await run(c.exe, c.args, {
          encoding: true,
          onData: (t, stream) => {
            append(job, t);
            progressBuffer = (progressBuffer + t).slice(-8192);
            const matches = [...progressBuffer.matchAll(/out_time_us=(\d+)/g)];
            if (matches.length && job.meta.duration) {
              const seconds = Number(matches.at(-1)[1]) / 1000000;
              job.progress = Math.min(
                99,
                Math.max(
                  job.progress,
                  (100 * (i + Math.min(1, seconds / job.meta.duration))) /
                    commands.length,
                ),
              );
            } else if (c.exe === state.engineInfo.nvencc) {
              const m = t.match(/(\d+(?:\.\d+)?)%/);
              if (m)
                job.progress = Math.min(
                  99,
                  (100 * (i + Number(m[1]) / 100)) / commands.length,
                );
            }
            job.elapsed = (Date.now() - job.startedAt) / 1000;
            emitProgress();
          },
        });
        if (c.output === temps.output) {
          try {
            commit(temps.output, paths.output);
          } catch (e) {
            if (e.code !== "EEXIST") throw e;
            paths = core.outputPaths(
              nameSource(job),
              s,
              state.jobs.indexOf(job) + 1,
              fs.existsSync,
            );
            commit(temps.output, paths.output);
            job.maskOutput = paths.maskOutput;
          }
          job.output = paths.output;
        }
        if (c.mask) {
          commit(temps.maskOutput, paths.maskOutput);
          job.maskOutput = paths.maskOutput;
        }
      }
      job.status = "done";
      job.progress = 100;
      job.stage = "完成";
    } catch (e) {
      append(job, "\n" + e.message + "\n");
      job.status =
        job.output && fs.existsSync(job.output)
          ? "partial"
          : stopped
            ? "cancelled"
            : "failed";
      job.error = stopped ? "任务已取消" : e.message;
      job.stage =
        job.status === "partial" ? "主视频已完成，遮罩未完成" : "已停止";
    } finally {
      if (tempDir)
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {
          append(job, "临时文件清理失败：" + e.message);
        }
      job.elapsed = (Date.now() - job.startedAt) / 1000;
      emit();
    }
  }
  async function queue(jobs) {
    if (tools.state.busy || state.enhancements.busy)
      throw Error("工具管理或 RTX 验证中，请稍后处理队列");
    if (state.running) throw Error("队列正在运行");
    if (state.trim.running) throw Error("无损剪辑正在导出，请等它结束");
    // Validate the frozen per-job settings first; a bad alpha source must not
    // prevent valid items from continuing, or be mislabeled as an engine fault.
    jobs = jobs.filter((j) => {
      j.settings = clone(j._retrySettings || state.settings);
      const errors = core.validate(j.settings, j.meta);
      if (!errors.length) return true;
      j.status = "invalid";
      j.error = errors.join("；");
      return false;
    });
    if (!jobs.length) {
      state.notice = "没有可编码的待处理任务";
      emit();
      return;
    }
    state.running = true;
    stopped = false;
    emit();
    (async () => {
      await detectPromise;
      state.engineInfo.soxr = await hasSoxr();
      // Take jobs in the queue's current order so drag-sorting during a run applies.
      const pending = new Set(jobs);
      while (pending.size) {
        const job =
          state.jobs.find((j) => pending.has(j)) ||
          pending.values().next().value;
        pending.delete(job);
        // Removed from the queue while waiting: withdrawn, not run.
        if (!state.jobs.includes(job)) continue;
        if (stopped) {
          if (job.status !== "partial") job.status = "cancelled";
          continue;
        }
        await encode(job);
      }
    })()
      .catch((e) => (state.notice = e.message))
      .finally(() => {
        state.running = false;
        flushEvidence();
        emit();
      });
  }
  // ---- lossless trim ----
  // Indexes stay here (they can be large); the window gets what it shows.
  const trimIndexes = new Map(); // clip id -> index
  const indexAborts = new Map(); // clip id -> AbortController while indexing
  let trimAbort = null,
    previewAbort = null;
  // A file's cached copy (non-MP4 H.264 / HEVC) goes once no clip uses it.
  function releaseUnused(file) {
    if (state.trim.clips.some((c) => c.path === file)) return;
    trim.release(file);
    for (const [key, url] of previews)
      if (key.startsWith(file + "|")) {
        previews.delete(key);
        previewBytes -= url.length;
      }
  }
  // Recent preview frames (data URLs), so stepping back to a frame just seen
  // needs no FFmpeg run. Bounded by total size; oldest go first.
  const previews = new Map(); // "path|frame" -> data URL
  const PREVIEW_BYTES = 32 * 1024 * 1024;
  let previewBytes = 0;
  function rememberPreview(key, url) {
    previews.set(key, url);
    previewBytes += url.length;
    for (const [k, v] of previews) {
      if (previewBytes <= PREVIEW_BYTES) break;
      previews.delete(k);
      previewBytes -= v.length;
    }
  }
  function dropClips(clips) {
    for (const c of clips) {
      indexAborts.get(c.id)?.abort();
      indexAborts.delete(c.id);
      trimIndexes.delete(c.id); // other clips of the file keep their own
    }
    state.trim.clips = state.trim.clips.filter((c) => !clips.includes(c));
    for (const file of new Set(clips.map((c) => c.path))) releaseUnused(file);
  }
  const TRIM_KEYS = {
    codec_name: "编码",
    profile: "档次",
    level: "级别",
    width: "宽度",
    height: "高度",
    pix_fmt: "像素格式",
    sample_aspect_ratio: "像素宽高比",
    field_order: "场序",
    color_range: "色彩范围",
    color_space: "色彩矩阵",
    color_primaries: "色域",
    color_transfer: "传输特性",
    time_base: "时间基",
    r_frame_rate: "帧率",
    extradata: "编码参数集",
    rotation: "旋转",
  };
  function requireClip(id) {
    const c = state.trim.clips.find((c) => c.id === id);
    if (!c) throw Error("未找到这个片段");
    return c;
  }
  // Why a clip cannot be smart-cut ("" = it can, or needs no re-encoding).
  function smartBlocker(idx) {
    if (idx.frames.every((f) => f.safe)) return "";
    if (!idx.encoding)
      return "没有记录编码参数（不是 MMDEncoder 1.5.0 起导出的）";
    if (String(idx.encoding.encoder).startsWith("nvencc:"))
      return "NVEncC 编码的文件暂不支持";
    return "";
  }
  // The clip's requested range, snapped to safe cut points (out may be the
  // end) — or, with smart cut on a clip that allows it, exactly as asked.
  function setClipRange(clip, from, to) {
    const idx = trimIndexes.get(clip.id);
    if (!idx) throw Error("片段还没有读取完成");
    const n = idx.frames.length;
    const exact = state.trim.smart && !smartBlocker(idx);
    const clamp = (v) => Math.max(0, Math.min(n, Math.round(Number(v) || 0)));
    const a = exact
      ? Math.min(clamp(from), n - 1)
      : trim.snap(idx, Number(from) || 0);
    const b = exact
      ? to === "end"
        ? n
        : clamp(to)
      : trim.snap(idx, to === "end" ? n : Number(to), { end: true });
    Object.assign(clip, {
      requested: { from: Number(from) || 0, to: to === "end" ? n : Number(to) },
      from: a,
      to: b,
      empty: a >= b,
    });
  }
  async function trimAdd(paths) {
    await locate();
    if (!state.engineInfo.ffmpeg || !state.engineInfo.ffprobe)
      throw Error("请先安装 FFmpeg / ffprobe");
    for (const raw of paths || []) {
      if (typeof raw !== "string" || !path.isAbsolute(raw)) continue;
      const file = path.resolve(raw);
      try {
        if (!fs.statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      const clip = {
        id: crypto.randomUUID(),
        path: file,
        name: path.basename(file),
        status: "indexing",
      };
      state.trim.clips.push(clip);
      emit();
      const ctl = new AbortController();
      indexAborts.set(clip.id, ctl);
      try {
        const idx = await trim.index(state.engineInfo, file, {
          signal: ctl.signal,
        });
        if (!state.trim.clips.includes(clip)) continue; // removed meanwhile
        if (!idx.supported) throw Error(idx.reason);
        trimIndexes.set(clip.id, idx);
        const safe = idx.frames.filter((f) => f.safe).map((f) => f.frame);
        Object.assign(clip, {
          status: "ready",
          codec: idx.codec,
          width: idx.width,
          height: idx.height,
          fps: idx.fps,
          frames: idx.frames.length,
          // Every frame, or the list of frames a cut may start at.
          cuts: safe.length === idx.frames.length ? "all" : safe,
          // MMD frame of the video's first frame (from MMDEncoder's tag or
          // the _0400-0600f name), and whether the encode settings are known.
          mmdStart: idx.mmdStart?.frame ?? null,
          mmdStartFrom: idx.mmdStart?.from || "",
          encoding: idx.encoding,
          smartBlocker: smartBlocker(idx),
          refused:
            safe.length < idx.frames.filter((f) => f.key).length
              ? [
                  ...new Set(
                    idx.frames
                      .filter((f) => f.key && !f.safe)
                      .map((f) => f.why),
                  ),
                ]
              : [],
        });
        setClipRange(clip, 0, "end");
      } catch (e) {
        if (!state.trim.clips.includes(clip)) continue;
        Object.assign(clip, { status: "invalid", error: e.message });
      } finally {
        indexAborts.delete(clip.id);
      }
      emit();
    }
  }
  function trimOutputPath(o) {
    const first = state.trim.clips.find((c) => c.status === "ready");
    let dir = path.dirname(first.path);
    if (o.location === "encoded") dir = path.join(dir, "Encoded");
    if (o.location === "custom") {
      if (typeof o.outputDir !== "string" || !path.isAbsolute(o.outputDir))
        throw Error("请选择有效的自定义输出目录");
      dir = o.outputDir;
    }
    let ext = trim.containerFor(first.codec);
    if (o.audio?.mode !== "none" && o.audio?.codec === "pcm" && ext === "mp4")
      ext = "mkv";
    const base = path.parse(first.path).name + "_剪辑";
    for (let n = 1; n < 100000; n++) {
      const out = path.join(dir, base + (n === 1 ? "" : ` (${n})`) + "." + ext);
      if (!fs.existsSync(out)) return out;
    }
    throw Error("无法分配不重名的输出文件");
  }
  async function trimExport(o) {
    if (state.trim.running) throw Error("正在导出");
    if (state.running) throw Error("请等待当前压制结束后再导出");
    if (state.detecting || tools.state.busy || state.enhancements.busy)
      throw Error("请等待编码器检测或工具管理结束后再导出");
    const clips = state.trim.clips.filter(
      (c) => c.status === "ready" && !c.empty,
    );
    if (!clips.length) throw Error("没有可导出的片段");
    if (state.trim.clips.some((c) => c.status === "indexing"))
      throw Error("请等待片段读取完成");
    const files = [...new Set(clips.map((c) => c.path))];
    if (files.length > 1) {
      const diffs = await trim.compatibility(state.engineInfo, files);
      if (diffs.length) {
        const name = (i) => path.basename(files[i]);
        throw Error(
          "这些片段不能无损拼接：" +
            diffs
              .slice(0, 4)
              .map(
                (d) =>
                  `${name(d.part - 1)} 的${TRIM_KEYS[d.key] || d.key}与 ${name(0)} 不同${d.key === "extradata" ? "" : `（${d.value} / ${d.expected}）`}`,
              )
              .join("；"),
        );
      }
    }
    const audio = {
      mode: ["reencode", "replace", "none"].includes(o.audio?.mode)
        ? o.audio.mode
        : "reencode",
      codec: ["aac", "flac", "pcm"].includes(o.audio?.codec)
        ? o.audio.codec
        : "aac",
      kbps: Number(o.audio?.kbps) || 320,
      file: o.audio?.file,
      offset: Number(o.audio?.offset) || 0,
    };
    const output = trimOutputPath({ ...o, audio });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    trimAbort = new AbortController();
    Object.assign(state.trim, {
      running: true,
      progress: 0,
      stage: "准备",
      output,
      error: "",
    });
    emit();
    (async () => {
      try {
        await trim.cut(
          state.engineInfo,
          clips.map((c) => ({
            file: c.path,
            idx: trimIndexes.get(c.id),
            from: c.from,
            to: c.to,
          })),
          output,
          {
            audio,
            smart: state.trim.smart,
            signal: trimAbort.signal,
            onPart: (i, n) => {
              Object.assign(state.trim, {
                progress: Math.round(
                  (i / (n + (audio.mode === "none" ? 0 : 1))) * 100,
                ),
                stage: `复制第 ${i} / ${n} 段`,
              });
              emitProgress();
            },
          },
        );
        Object.assign(state.trim, { progress: 100, stage: "完成" });
      } catch (e) {
        fs.rmSync(output, { force: true });
        Object.assign(state.trim, {
          stage: e.cancelled ? "已取消" : "失败",
          error: e.cancelled ? "" : e.message,
          output: "",
        });
      } finally {
        state.trim.running = false;
        trimAbort = null;
        emit();
      }
    })();
  }

  async function invoke(action, payload = {}) {
    switch (action) {
      case "state":
        return clone(state);
      case "details": {
        if (tools.state.busy) throw Error("工具安装中，请稍后查看详情");
        // payload.media: a job from the audio / video tools queue
        const job = payload.media
          ? requireMediaJob(payload.id)
          : requireJob(payload.id);
        await locate();
        const result = {};
        for (const [key, file] of payload.media
          ? [
              ["before", job.path],
              ...(job.audioPath ? [["audio", job.audioPath]] : []),
              ["after", job.output],
            ]
          : [
              ["before", job.path],
              ["after", job.output],
              ["mask", job.maskOutput],
            ]) {
          if (!file || !fs.existsSync(file)) {
            result[key] = {
              message: key === "before" ? "源文件不存在" : "尚未生成文件",
            };
            continue;
          }
          try {
            const r = await run(
              state.engineInfo.ffprobe,
              [
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                // A PNG sequence is read as the video it becomes.
                ...(key === "before" && !payload.media && job.sequence
                  ? core.inputArgs(job)
                  : [file]),
              ],
              { timeout: 30000 },
            );
            result[key] = {
              path:
                key === "before" && job.sequence ? job.sequence.pattern : file,
              ...JSON.parse(r.stdout),
            };
          } catch (e) {
            result[key] = {
              path: file,
              message: "无法读取实际文件：" + e.message,
            };
          }
        }
        return result;
      }
      case "mediaSuggest":
        return media.suggestOutput(
          {
            ...(payload || {}),
            // Hi-Res merges go to MKV (see media.mergeContainer).
            ...(payload?.hiRes && payload.operation === "merge"
              ? { container: "mkv" }
              : {}),
          },
          mediaLocation(payload || {}),
          fs.existsSync,
        );
      case "mediaAdd": {
        for (const raw of payload?.paths || []) {
          if (typeof raw !== "string" || !path.isAbsolute(raw)) continue;
          const file = path.resolve(raw); // same separators as the video queue
          let stat;
          try {
            stat = fs.statSync(file);
          } catch {
            continue;
          }
          if (!stat.isFile()) continue;
          if (
            state.mediaJobs.some(
              (j) =>
                j.status === "ready" &&
                j.path.toLowerCase() === file.toLowerCase(),
            )
          )
            continue;
          state.mediaJobs.push({
            id: crypto.randomUUID(),
            path: file,
            name: path.basename(file),
            size: stat.size,
            status: "ready",
          });
          const probe = probeMediaJob(state.mediaJobs.at(-1));
          mediaProbes.add(probe);
          void probe.finally(() => mediaProbes.delete(probe));
        }
        break;
      }
      case "mediaSetAudio": {
        const job = requireMediaJob(payload?.id);
        if (job.status === "running") throw Error("处理中的文件不能更换音频");
        const file = payload?.path || "";
        if (file && (!path.isAbsolute(file) || !fs.statSync(file).isFile()))
          throw Error("请选择有效的音频文件");
        if (file) job.audioPath = file;
        else delete job.audioPath;
        delete job.audioMeta;
        // The replacement audio's own parameters (Hi-Res preview, checks).
        if (file) {
          await locate();
          const info = await probeMedia(file);
          if (job.audioPath === file && info.audio) job.audioMeta = info.audio;
        }
        break;
      }
      case "mediaLog":
        return requireMediaJob(payload?.id).log || "";
      case "mediaRemove": {
        const job = requireMediaJob(payload?.id);
        if (job.status === "running") throw Error("处理中的文件不能移除");
        state.mediaJobs = state.mediaJobs.filter((j) => j !== job);
        break;
      }
      case "trimAdd":
        await trimAdd(payload?.paths);
        break;
      case "trimRemove": {
        const clip = requireClip(payload?.id);
        if (state.trim.running) throw Error("导出时不能移除片段");
        dropClips([clip]);
        break;
      }
      case "trimDuplicate": {
        // Another range of the same file.
        const clip = requireClip(payload?.id);
        if (clip.status !== "ready") throw Error("片段还没有读取完成");
        const copy = { ...clip, id: crypto.randomUUID() };
        trimIndexes.set(copy.id, trimIndexes.get(clip.id));
        state.trim.clips.splice(state.trim.clips.indexOf(clip) + 1, 0, copy);
        break;
      }
      case "trimReorder":
        state.trim.clips = reorder(state.trim.clips, payload.ids);
        break;
      case "trimSet": {
        const clip = requireClip(payload?.id);
        if (payload.mmdStart !== undefined) {
          const n = Number(payload.mmdStart);
          if (!Number.isInteger(n) || n < 0)
            throw Error("MMD 起始帧须为 0 或正整数");
          Object.assign(clip, { mmdStart: n, mmdStartFrom: "manual" });
        }
        if (payload.from !== undefined)
          setClipRange(clip, payload.from, payload.to);
        break;
      }
      case "trimFrame": {
        // One preview at a time: a newer request stops the older one.
        const clip = requireClip(payload?.id);
        const idx = trimIndexes.get(clip.id);
        if (!idx) throw Error("片段还没有读取完成");
        const frame = Number(payload.frame) || 0;
        const key = clip.path + "|" + frame;
        previewAbort?.abort();
        if (previews.has(key)) {
          const url = previews.get(key);
          previews.delete(key); // most recently used goes last
          previews.set(key, url);
          return url;
        }
        const ctl = (previewAbort = new AbortController());
        try {
          const jpeg = await trim.frameJpeg(
            state.engineInfo,
            idx,
            clip.path,
            frame,
            {
              signal: ctl.signal,
            },
          );
          const url = "data:image/jpeg;base64," + jpeg.toString("base64");
          rememberPreview(key, url);
          return url;
        } catch (e) {
          if (e.cancelled) return null;
          throw e;
        }
      }
      case "trimExport":
        await trimExport(payload || {});
        break;
      case "trimSmart": {
        if (state.trim.running) throw Error("导出时不能切换");
        state.trim.smart = !!payload?.smart;
        // Re-apply every clip's requested range under the new rule.
        for (const c of state.trim.clips)
          if (c.status === "ready" && c.requested)
            setClipRange(
              c,
              c.requested.from,
              c.requested.to >= c.frames ? "end" : c.requested.to,
            );
        break;
      }
      case "trimCancel":
        trimAbort?.abort();
        break;
      case "trimClear":
        if (state.trim.running) throw Error("导出时不能清空");
        dropClips([...state.trim.clips]);
        Object.assign(state.trim, {
          output: "",
          error: "",
          stage: "",
          progress: 0,
        });
        break;
      case "mediaClearCompleted":
        state.mediaJobs = state.mediaJobs.filter(
          (j) => !["done", "cancelled"].includes(j.status),
        );
        break;
      case "mediaRequeue": {
        if (state.running) throw Error("请等待当前处理结束后再重新导出");
        const job = requireMediaJob(payload?.id);
        if (!["done", "cancelled", "failed"].includes(job.status))
          throw Error("只有已完成、已取消或失败的文件可以重新导出");
        for (const key of ["output", "error", "log", "elapsed", "startedAt"])
          delete job[key];
        job.status = "ready";
        break;
      }
      case "mediaStart": {
        // File-info reads started by mediaAdd are short; let them finish
        // instead of reporting them as a busy task.
        await Promise.all([...mediaProbes]);
        if (
          state.running ||
          state.trim.running ||
          state.detecting ||
          tools.state.busy ||
          state.enhancements.busy ||
          children.size
        )
          throw Error("请等待当前任务结束");
        const options = payload || {};
        if (!["audio", "video", "merge"].includes(options.operation))
          throw Error("请选择提取音频、提取视频或音视频合并");
        if (
          options.location === "custom" &&
          !(
            typeof options.outputDir === "string" &&
            path.isAbsolute(options.outputDir)
          )
        )
          throw Error("请选择有效的自定义输出目录");
        await locate();
        if (!state.engineInfo.ffmpeg || !state.engineInfo.ffprobe)
          throw Error("请先安装 FFmpeg / ffprobe");
        const jobs = state.mediaJobs.filter((j) => j.status === "ready");
        if (!jobs.length) throw Error("没有待处理的文件");
        state.running = true;
        stopped = false;
        emit();
        (async () => {
          const pending = new Set(jobs);
          while (pending.size) {
            const job =
              state.mediaJobs.find((j) => pending.has(j)) ||
              pending.values().next().value;
            pending.delete(job);
            // Removed from the queue while waiting: withdrawn, not run.
            if (!state.mediaJobs.includes(job)) continue;
            if (stopped) {
              job.status = "cancelled";
              continue;
            }
            await runMediaJob(job, options);
          }
        })()
          .catch((e) => (state.notice = e.message))
          .finally(() => {
            state.running = false;
            emit();
          });
        break;
      }
      case "testEnhancements": {
        if (
          state.running ||
          state.trim.running ||
          state.detecting ||
          tools.state.busy ||
          state.enhancements.busy ||
          children.size
        )
          throw Error("请等待当前任务结束");
        const s = { ...state.settings, ...schema(payload.settings || {}) };
        await locate();
        state.enhancements = {
          busy: true,
          signature: enhancementSignature(s),
          verified: false,
          message: "正在用所选设置执行 RTX 试编码…",
        };
        emit();
        try {
          state.detectionLog +=
            "\n" + (await probeEnhancements(s, state.engineInfo, run));
          state.enhancements.verified = true;
          state.enhancements.message = "所选 RTX 设置已通过本机试编码";
        } catch (e) {
          state.enhancements.message =
            "RTX 验证失败：" +
            e.message +
            "。请检查驱动、NVIDIA VFX SDK 运行库与模型";
          state.detectionLog += "\n" + state.enhancements.message;
          throw e;
        } finally {
          state.enhancements.busy = false;
          emit();
        }
        break;
      }
      case "compatibility":
        return core.compatibility(
          { ...state.settings, ...schema(payload.settings || {}) },
          state.engines,
        );
      case "checkTools":
      case "installTools":
        if (
          state.running ||
          state.trim.running ||
          state.detecting ||
          state.enhancements.busy ||
          children.size
        )
          throw Error("请等待编码、探测和硬件检测结束后管理工具");
        try {
          await tools.run(action === "installTools");
        } finally {
          if (action === "installTools") {
            state.enhancements.verified = false;
            state.enhancements.signature = "";
            state.enhancements.message = "工具已重新检查，请重新验证 RTX 设置";
            locatePromise = null;
            await detect({ force: true });
          }
        }
        break;
      case "setToolsRoot": {
        if (toolsRoot) throw Error("安装位置由环境变量指定，不能在软件中更改");
        if (
          state.running ||
          state.trim.running ||
          state.detecting ||
          state.enhancements.busy ||
          children.size
        )
          throw Error("请等待编码、探测和硬件检测结束后更改安装位置");
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
        if (tools.state.busy) throw Error("工具安装中，请稍后重新检测");
        if (state.trim.running) throw Error("无损剪辑正在导出，请稍后重新检测");
        await detect({ force: true });
        break;
      case "add":
        if (state.enhancements.busy) throw Error("RTX 验证中，请稍后添加素材");
        if (tools.state.busy) throw Error("工具安装中，请稍后添加素材");
        return add(payload.paths);
      case "remove": {
        const job = requireJob(payload.id);
        if (job.status === "encoding" || (state.running && job.settings))
          throw Error("已提交任务不能在运行中移除");
        state.jobs = state.jobs.filter((j) => j.id !== job.id);
        break;
      }
      case "requeue": {
        // Put a finished or cancelled item back in the queue; the next start
        // freezes the current settings, and existing outputs get a numbered name.
        if (state.running) throw Error("请等待当前队列结束后再重新导出");
        const job = requireJob(payload.id);
        if (!["done", "cancelled"].includes(job.status))
          throw Error("只有已完成或已取消的任务可以重新导出");
        if (!job.meta) throw Error("素材探测失败，请重新添加");
        for (const key of [
          "settings",
          "output",
          "maskOutput",
          "error",
          "stage",
          "elapsed",
          "startedAt",
        ])
          delete job[key];
        job.status = "ready";
        job.progress = 0;
        break;
      }
      case "clearCompleted":
        state.jobs = state.jobs.filter(
          (j) => !["done", "cancelled"].includes(j.status),
        );
        break;
      case "settings":
        schema(payload.patch);
        state.settings = { ...state.settings, ...payload.patch };
        if (
          state.enhancements.signature !== enhancementSignature(state.settings)
        ) {
          state.enhancements.verified = false;
          if (state.settings.vsr || state.settings.vfg)
            state.enhancements.message = "RTX 设置已更改，请重新验证本机设置";
        }
        persist();
        break;
      case "preview":
        return preview(requireJob(payload.id));
      case "logs":
        return payload.id
          ? requireJob(payload.id).log || "暂无日志"
          : state.detectionLog;
      case "start":
        if (state.enhancements.busy) throw Error("RTX 验证中，请稍后开始编码");
        if (tools.state.busy) throw Error("工具安装中，请稍后开始编码");
        await locate();
        if (state.detecting) await detectPromise;
        await queue(
          state.jobs.filter(
            (j) => j.status === "ready" || (j.status === "invalid" && j.meta),
          ),
        );
        break;
      case "cancel":
        stopped = true;
        active?.kill();
        break;
      case "retry": {
        if (state.running) throw Error("请等待当前队列停止");
        const j = requireJob(payload.id);
        if (!["failed", "partial", "cancelled", "invalid"].includes(j.status))
          throw Error("此任务不需要重试");
        if (!j.meta) throw Error("素材探测失败，请重新添加");
        let s = clone(j.settings || state.settings);
        if (payload.software) {
          if (s.vsr || s.vfg)
            throw Error(
              "RTX 增强不能软件回退；请修复本机 RTX 功能，或明确关闭增强后重试",
            );
          if (s.alphaMode === "preserve" && s.encoder === "nvencc:hevc")
            throw Error(
              "HEVC Alpha 无软件回退；请修复 NVEncC，或明确改选 ProRes 4444 / VP9 后重试",
            );
          const e = core.ENGINES.find((e) => e.id === s.encoder);
          s.encoder =
            {
              h264: "libx264",
              hevc: "libx265",
              av1: "libsvtav1",
              vp9: "libvpx-vp9",
              prores: "prores_ks",
            }[e?.codec] || "libx264";
          s.quality = 18;
          s.preset = s.encoder === "libsvtav1" ? "6" : "medium";
          s.rateControl = "quality";
          s.lookahead = 0;
          s.lookaheadLevel = 0;
          state.notice = "软件重试使用 CRF 18；CQ 与 CRF 数值不等效";
        } else if (j.status !== "partial") s = clone(state.settings);
        const errors = core.validate(s, j.meta);
        if (errors.length) throw Error(errors.join("；"));
        j._retrySettings = s;
        await queue([j]);
        delete j._retrySettings;
        break;
      }
      case "savePreset": {
        const valid = presetValid({
          name: payload.name,
          settings: state.settings,
        });
        if (
          state.presets.some(
            (p) =>
              p.id !== payload.id &&
              p.name.toLocaleLowerCase() === valid.name.toLocaleLowerCase(),
          )
        )
          throw Error("已存在同名预设，请使用其他名称");
        if (payload.id) {
          const p = state.presets.find((x) => x.id === payload.id);
          if (!p) throw Error("未找到预设");
          Object.assign(valid, {
            id: p.id,
            builtin: p.builtin,
            ...(p.builtin ? { edited: true } : {}),
            ...(typeof p.hidden === "boolean" ? { hidden: p.hidden } : {}),
          });
          state.presets = state.presets.map((x) => (x.id === p.id ? valid : x));
        } else state.presets.push(valid);
        state.settings.presetName = valid.name;
        persist();
        break;
      }
      case "renamePreset": {
        const p = state.presets.find((p) => p.id === payload.id);
        if (!p) throw Error("未找到预设");
        const renamed = presetValid({
          name: payload.name,
          settings: p.settings,
        });
        if (
          state.presets.some(
            (x) =>
              x.id !== p.id &&
              x.name.toLocaleLowerCase() === renamed.name.toLocaleLowerCase(),
          )
        )
          throw Error("已存在同名预设，请使用其他名称");
        p.name = renamed.name;
        p.settings.presetName = renamed.name;
        if (p.builtin) p.edited = true;
        persist();
        break;
      }
      case "applyPreset": {
        const p = state.presets.find((x) => x.id === payload.id);
        if (!p) throw Error("未找到预设");
        const output = {
          outputMode: state.settings.outputMode,
          outputDir: state.settings.outputDir,
        };
        state.settings = { ...clone(p.settings), ...output };
        persist();
        break;
      }
      case "deletePreset": {
        const p = state.presets.find((x) => x.id === payload.id);
        if (!p) throw Error("未找到预设");
        if (p.builtin) deletedBuiltins.add(p.id);
        state.presets = state.presets.filter((x) => x.id !== p.id);
        persist();
        break;
      }
      case "hidePreset": {
        const p = state.presets.find((x) => x.id === payload.id);
        if (!p) throw Error("未找到预设");
        if (typeof payload.hidden !== "boolean") throw Error("参数无效");
        p.hidden = payload.hidden;
        persist();
        break;
      }
      case "reorderPresets":
        state.presets = reorder(state.presets, payload.ids);
        persist();
        break;
      case "resolvePresetConflict": {
        // keep: save the user's old version as a personal preset next to the
        // built-in; otherwise drop it (the new built-in stays either way).
        const c = state.presetConflicts.find((x) => x.id === payload.id);
        if (!c) throw Error("未找到待处理的预设");
        if (payload.keep) {
          let name = c.name + "（我的修改）";
          for (
            let n = 2;
            state.presets.some((p) => sameName(p.name, name));
            n++
          )
            name = `${c.name}（我的修改 ${n}）`;
          const copy = presetValid({ name, settings: c.settings });
          const at = state.presets.findIndex((p) => p.id === c.id);
          state.presets.splice(at < 0 ? state.presets.length : at + 1, 0, copy);
        }
        state.presetConflicts = state.presetConflicts.filter((x) => x !== c);
        persist();
        break;
      }
      case "restoreBuiltinPresets": {
        // Bring back deleted built-ins and undo edits / hide choices on them.
        const defaults = clone(core.BUILTINS);
        for (const p of defaults)
          if (
            !state.presets.some((x) => x.id === p.id) &&
            state.presets.some((x) => sameName(x.name, p.name))
          )
            throw Error("已有同名个人预设：" + p.name + "，请先改名");
        deletedBuiltins.clear();
        const byId = new Map(defaults.map((p) => [p.id, p]));
        state.presets = state.presets.map((p) =>
          p.builtin ? byId.get(p.id) || p : p,
        );
        for (const p of defaults)
          if (!state.presets.some((x) => x.id === p.id)) state.presets.push(p);
        persist();
        break;
      }
      case "reorderJobs":
        state.jobs = reorder(state.jobs, payload.ids);
        break;
      case "setSequenceFps": {
        const job = requireJob(payload?.id);
        if (!job.sequence) throw Error("这个素材不是图片序列");
        if (!SEQUENCE_RATES.includes(payload.fps)) throw Error("帧率无效");
        if (
          ![
            "ready",
            "invalid",
            "done",
            "failed",
            "cancelled",
            "partial",
          ].includes(job.status)
        )
          throw Error("正在处理的素材不能改帧率");
        Object.assign(job.sequence, sequenceRate(payload.fps));
        if (job.meta) job.meta = withSequenceRate(job.meta, job.sequence);
        break;
      }
      case "mediaReorder":
        state.mediaJobs = reorder(state.mediaJobs, payload.ids);
        break;
      case "importPresets": {
        if (!Array.isArray(payload.presets) || payload.presets.length > 200)
          throw Error("预设文件格式无效或超过 200 项");
        const incoming = payload.presets.map(presetValid);
        const names = new Set(
          state.presets.map((p) => p.name.toLocaleLowerCase()),
        );
        for (const p of incoming) {
          const key = p.name.toLocaleLowerCase();
          if (names.has(key)) throw Error("已存在同名预设：" + p.name);
          names.add(key);
        }
        state.presets.push(...incoming);
        persist();
        break;
      }
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
        // Apply the change on top of a choice made meanwhile in MMD.
        adoptMmdSelection();
        if (typeof payload.presetId === "string") {
          if (
            payload.presetId &&
            !state.presets.some((p) => p.id === payload.presetId)
          )
            throw Error("未找到预设");
          // A preset that writes a mask by itself sets the mask choice to
          // match; it can still be changed afterwards.
          const own = mmdExport.presetMask(
            state.presets.find((p) => p.id === payload.presetId)?.settings,
          );
          if (own !== "off" && payload.presetId !== state.mmd.presetId)
            state.mmd.maskMode = own;
          state.mmd.presetId = payload.presetId;
          state.mmd.test = null;
        }
        if (payload.audioFade !== undefined) {
          if (![0, 0.5, 1, 2].includes(payload.audioFade))
            throw Error("淡入淡出时长无效");
          state.mmd.audioFade = payload.audioFade;
        }
        if (typeof payload.followMmd === "boolean")
          state.mmd.followMmd = payload.followMmd;
        if (typeof payload.rangeSuffix === "boolean")
          state.mmd.rangeSuffix = payload.rangeSuffix;
        if (payload.maskMode !== undefined) {
          if (!mmdExport.MASK_MODES.includes(payload.maskMode))
            throw Error("遮罩选项无效");
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
        if (state.running) throw Error("请等待当前压制结束后再测试");
        await testMmdExport();
        break;
      case "mmdRecover":
      case "mmdDiscard": {
        if (typeof payload?.id !== "string") throw Error("无效的导出记录");
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
        throw Error("不支持的操作：" + action);
    }
    emit();
    return clone(state);
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
      state.notice = `有 ${list.length} 个 MMD 导出意外中断，可在“MMD 导出”里补完已导出的部分`;
    emit();
  }
  return {
    invoke,
    getState: () => clone(state),
    dispose() {
      flushEvidence();
      disposed = true;
      stopped = true;
      if (selectionWatched) fs.unwatchFile(mmdExport.selectionPath());
      clearTimeout(pushTimer);
      clearInterval(interruptTimer);
      for (const child of children) child.kill();
      trimAbort?.abort();
      previewAbort?.abort();
      for (const ctl of indexAborts.values()) ctl.abort();
      trim.clearCache();
    },
  };
}
module.exports = { createService };
