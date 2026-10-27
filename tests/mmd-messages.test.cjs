require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const core = require("../backend/core.cjs");
const mx = require("../backend/mmd-export.cjs");
const pending = path.join(path.dirname(mx.configPath()), "pending");
const { main } = require("../backend/mmd-cli.cjs");
const { createService } = require("../backend/service.cjs");
const { appError, summary, serializeError } = require("../backend/errors.cjs");
const { load } = require("./load-typescript.cjs");

test("MMD plan notes and recovery errors preserve codes, raw paths and original fallback copy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-messages-"));
  const runtime = {
    avi: path.join(dir, "User 用户 {raw}.avi"),
    width: 160,
    height: 90,
    bits: 24,
    avgTimePerFrame: 333333,
  };
  const config = {
    settings: { ...core.DEFAULTS, encoder: "libx264", preset: "ultrafast" },
    presetName: "User 预设",
    followMmd: true,
    engines: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
    maskMode: "only",
  };
  try {
    assert.throws(() => mx.plan(runtime, config), {
      code: "MMD_ALPHA_REQUIRED",
      message: "MMD 没有提供 Alpha 画面，无法只导出遮罩",
    });
    const plan = mx.plan(runtime, { ...config, maskMode: "with" });
    assert.deepEqual(plan.notes, [
      "音频偏移 +0 帧 = 设置 +0 + 起点为 1 自动 +0",
      "MMD 没有提供 Alpha 画面，未导出遮罩",
    ]);
    const warning = plan.notesData.find(
      (data) => data.code === "MMD_MASK_SKIPPED",
    );
    assert.ok(warning);
    assert.equal(plan.maskOutput, undefined);
    const id = fs
      .readdirSync(pending)
      .find((name) => {
        const value = JSON.parse(
          fs.readFileSync(path.join(pending, name), "utf8"),
        );
        return value.avi === runtime.avi;
      })
      .slice(0, -5);
    assert.throws(() => mx.discard(id), { code: "MMD_EXPORT_ACTIVE" });
    await assert.rejects(mx.recover("invalid"), { code: "MMD_RECORD_INVALID" });
    const i18n = load("src/i18n.ts");
    i18n.localeRuntime.registerCatalog("en-XA", {
      "message.MMD_MASK_SKIPPED": "⟦ Missing Alpha ··· ⟧",
      "error.MMD_RECOVERY_EMPTY": "⟦ No video: {path} ⟧",
    });
    i18n.setLocale("en-XA");
    assert.equal(i18n.summaryMessage(warning), "⟦ Missing Alpha ··· ⟧");
    assert.equal(
      i18n.errorMessage(
        serializeError(appError("MMD_RECOVERY_EMPTY", { path: runtime.avi })),
      ),
      `⟦ No video: ${runtime.avi} ⟧`,
    );
  } finally {
    for (const file of fs.readdirSync(pending)) {
      const target = path.join(pending, file);
      if (JSON.parse(fs.readFileSync(target, "utf8")).avi === runtime.avi)
        fs.rmSync(target);
    }
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MMD setting refusals keep exact messages and selections while exposing stable codes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-message-settings-"));
  const svc = createService({ dataDir: dir });
  try {
    await svc.invoke("mmdExportSet", { maskMode: "off" });
    const before = svc.getState().mmd;
    for (const [action, payload, code, message] of [
      ["mmdExportSet", { presetId: "missing" }, "PRESET_MISSING", "未找到预设"],
      [
        "mmdExportSet",
        { audioFade: 3 },
        "MMD_FADE_INVALID",
        "淡入淡出时长无效",
      ],
      [
        "mmdExportSet",
        { maskMode: "invalid" },
        "MMD_MASK_INVALID",
        "遮罩选项无效",
      ],
      ["mmdRecover", { id: 12 }, "MMD_RECORD_INVALID", "无效的导出记录"],
      ["mmdDiscard", { id: "bad" }, "MMD_RECORD_INVALID", "无效的导出记录"],
    ])
      await assert.rejects(svc.invoke(action, payload), { code, message });
    assert.equal(svc.getState().mmd.presetId, before.presetId);
    assert.equal(svc.getState().mmd.audioFade, before.audioFade);
    assert.equal(svc.getState().mmd.maskMode, before.maskMode);
  } finally {
    svc.dispose();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("finish protocol stores structured causes and notes alongside unchanged source diagnostics", async () => {
  const savedMode = process.env.MMD_EXPORT_MODE,
    savedJob = process.env.MMD_EXPORT_JOB,
    savedCode = process.exitCode;
  const records = [];
  process.env.MMD_EXPORT_MODE = "finish";
  process.env.MMD_EXPORT_JOB = JSON.stringify({
    output: "User {output}.mp4",
    temp: "User {temp}.mkv",
    frames: 30,
  });
  const data = summary("MMD_WAV_SOURCE", {
    path: "User 中文 {source}.wav",
    first: 441000,
    end: 485100,
    sampleRate: 44100,
  });
  try {
    await main({
      finish: async (_job, _config, log) => {
        log(data.message, data);
        return { output: "User {output}.mp4" };
      },
      remember: (record) => records.push(record),
    });
    assert.deepEqual(records[0].notes, [
      "音频取自 WAV：User 中文 {source}.wav，采样点 441000–485100（44100 Hz）",
    ]);
    assert.deepEqual(records[0].notesData, [data]);
    await main({
      finish: async (_job, _config, log) => {
        log("Foreign diagnostic {raw}\nnext");
        throw appError("MMD_MUX_FRAMES_LOST", {
          have: 12,
          want: 30,
          path: "User {temp}.mkv",
        });
      },
      remember: (record) => records.push(record),
    });
    assert.equal(process.exitCode, 1);
    assert.equal(records[1].ok, false);
    assert.equal(
      records[1].error,
      "合成音频后只剩 12 / 30 帧，已保留未合成的视频：User {temp}.mkv",
    );
    assert.deepEqual(records[1].errorData.params, {
      have: 12,
      want: 30,
      path: "User {temp}.mkv",
    });
    assert.deepEqual(records[1].notes, ["Foreign diagnostic {raw}\nnext"]);
  } finally {
    if (savedMode === undefined) delete process.env.MMD_EXPORT_MODE;
    else process.env.MMD_EXPORT_MODE = savedMode;
    if (savedJob === undefined) delete process.env.MMD_EXPORT_JOB;
    else process.env.MMD_EXPORT_JOB = savedJob;
    process.exitCode = savedCode;
  }
});

test("plugin registration failures keep exit codes without changing registration calls", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-register-message-"));
  const bundled = path.join(dir, "MMDEncoderPlugin.dll");
  fs.writeFileSync(bundled, "controlled DLL bytes");
  let registrationCode = 5;
  const calls = [];
  t.mock.method(childProcess, "execFile", (exe, args, _options, callback) => {
    calls.push({ exe, args });
    callback(
      path.basename(exe) === "regsvr32.exe" && registrationCode
        ? { code: registrationCode }
        : null,
      "",
    );
  });
  delete require.cache[require.resolve("../backend/mmd-plugin.cjs")];
  const plugin = require("../backend/mmd-plugin.cjs");
  try {
    await assert.rejects(plugin.install(""), {
      code: "MMD_PLUGIN_UNAVAILABLE",
    });
    await assert.rejects(plugin.install(bundled), {
      code: "MMD_PLUGIN_REGISTER_FAILED",
      params: { exitCode: 5 },
      message: "注册插件失败（regsvr32 退出码 5）",
    });
    registrationCode = 0;
    await assert.rejects(plugin.install(bundled), {
      code: "MMD_PLUGIN_REGISTER_MISSING",
    });
    const registration = calls.filter(
      (call) => path.basename(call.exe) === "regsvr32.exe",
    );
    assert.equal(registration.length, 2);
    assert.ok(
      registration.every(
        (call) => call.args[0] === "/s" && call.args.length === 2,
      ),
    );
    assert.ok(
      calls
        .filter((call) => path.basename(call.exe) === "reg.exe")
        .every((call) => call.args[0] === "query"),
    );
  } finally {
    t.mock.restoreAll();
    delete require.cache[require.resolve("../backend/mmd-plugin.cjs")];
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
