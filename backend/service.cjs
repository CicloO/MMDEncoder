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
const { createMediaQueue } = require("./media-queue.cjs");
const { createEncodeQueue } = require("./encode-queue.cjs");
const { createLimit } = require("./limit.cjs");
const { uiState } = require("./ui-state.cjs");
const { createDetector } = require("./detect.cjs");
const { createAlignService } = require("./align-service.cjs");
const { createTrimQueue } = require("./trim-queue.cjs");
const { commit } = require("./commit.cjs");
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
                    !(
                      (["hiRes", "editFriendly"].includes(k) && v === false) ||
                      (k === "audioFade" && v === 0) ||
                      (k === "artcnnModel" && v === "C4F16") ||
                      (k === "upscaler" && v === "lanczos")
                    ),
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
        // NVEncC presets run MMDEncoder.exe in Node mode (mmd-pipe.cjs).
        ...(plan.env ? { env: { ...process.env, ...plan.env } } : {}),
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
  function run(
    exe,
    args,
    { timeout = 0, onData, encoding = false, stdin } = {},
  ) {
    return new Promise((resolve, reject) => {
      if (disposed) return reject(Error("应用已关闭"));
      const child = spawn(exe, args, {
        windowsHide: true,
        stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
        shell: false,
      });
      children.add(child);
      if (stdin) {
        // The reader may stop early (error, cancel); the writer then fails.
        child.stdin.on("error", () => {});
        stdin.pipe(child.stdin);
      }
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
  // A command fed by another program's output (FFmpeg -> NVEncC). Fails if
  // either side fails: a writer that stops early would otherwise look like
  // a short but complete video to the reader.
  function runPiped(c, options) {
    if (disposed) return Promise.reject(Error("应用已关闭"));
    const writer = spawn(c.pipeFrom.exe, c.pipeFrom.args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    children.add(writer);
    let stderr = "",
      failure = null;
    writer.stderr.on("data", (b) => {
      const s = b.toString();
      stderr = (stderr + s).slice(-64 * 1024);
      options.onData?.(s, "err");
    });
    writer.on("error", (e) => (failure = e));
    const written = new Promise((resolve) =>
      writer.on("close", (code) => {
        children.delete(writer);
        resolve(code);
      }),
    );
    const read = run(c.exe, c.args, { ...options, stdin: writer.stdout });
    read.catch(() => writer.kill());
    return Promise.allSettled([read, written]).then(([r, code]) => {
      if (r.status === "rejected") throw r.reason;
      if (failure || code.value !== 0)
        throw Error(
          failure?.message ||
            stderr.trim().slice(-3000) ||
            "预处理退出：" + code.value,
        );
      return r.value;
    });
  }
  run.piped = runPiped; // for callers that only get run (RTX check)
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
      const seconds = (x) => Number(x) || Number(data.format?.duration) || 0;
      return {
        videoCodec: v?.codec_name,
        audioCodec: a?.codec_name,
        // Stream lengths (for fades), falling back to the file's.
        videoDuration: v ? seconds(v.duration) : 0,
        audioDuration: a ? seconds(a.duration) : 0,
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
        state.notice = "未找到可运行的 FFmpeg，请检查引擎目录";
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
  const mediaQueue = createMediaQueue(ctx);
  const encodeQueue = createEncodeQueue(ctx);
  const alignService = createAlignService({
    engineInfo: () => state.engineInfo,
    locate,
  });
  const trimQueue = createTrimQueue(ctx);
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
      case "details": {
        if (tools.state.busy) throw Error("工具安装中，请稍后查看详情");
        // payload.media: a job from the audio / video tools queue
        const job = payload.media
          ? mediaQueue.requireMediaJob(payload.id)
          : encodeQueue.requireJob(payload.id);
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
      case "testEnhancements": {
        if (isBusy()) throw Error("请等待当前任务结束");
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
        if (isBusy({ tools: false }))
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
        if (isBusy({ tools: false }))
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
      case "savePreset": {
        // payload.settings: a video's own settings ("单独设置"), saved
        // without changing the page's.
        const own = payload.settings
          ? { ...state.settings, ...schema(payload.settings) }
          : null;
        const valid = presetValid({
          name: payload.name,
          settings: own || state.settings,
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
        if (!own) state.settings.presetName = valid.name;
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
          // Every MMD export option outranks the preset: picking a preset
          // leaves the mask choice (and the others) as they are.
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
      state.notice = `有 ${list.length} 个 MMD 导出意外中断，可在“MMD 导出”里补完已导出的部分`;
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
