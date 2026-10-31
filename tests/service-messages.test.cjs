require("./isolate.cjs");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createService } = require("../backend/service.cjs"),
  core = require("../backend/core.cjs"),
  { serializeError } = require("../backend/errors.cjs"),
  { load } = require("./load-typescript.cjs");
function fixture(t, saved, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "service-messages-"));
  if (saved)
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(saved));
  const svc = createService({
    dataDir: dir,
    engineDir: path.join(dir, "no-engine"),
    toolsRoot: path.join(dir, "no-tools"),
    mmdPluginDll: "",
    ...options,
  });
  t.after(() => {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, svc };
}
test("initial RTX and unsupported configuration version retain descriptors and original fallback", (t) => {
  const { dir, svc } = fixture(t, { version: 999, settings: core.DEFAULTS }),
    s = svc.getState(),
    i = load("src/i18n.ts");
  assert.equal(s.enhancements.messageData.code, "RTX_INITIAL");
  assert.equal(s.enhancements.message, "启用后请先验证本机 RTX 功能");
  assert.equal(s.noticeData.params.error.code, "SETTINGS_VERSION_UNSUPPORTED");
  assert.equal(fs.existsSync(path.join(dir, s.noticeData.params.backup)), true);
  assert.equal(i.summaryMessage(s.noticeData), s.notice);
  i.localeRuntime.registerCatalog("en-XA", {
    "message.RTX_INITIAL": "Initial RTX fixture",
    "error.SETTINGS_VERSION_UNSUPPORTED": "Version fixture",
    "message.SETTINGS_UNREADABLE": "Read {detail}; backup {backup}",
  });
  i.setLocale("en-XA");
  assert.equal(
    i.summaryMessage(s.enhancements.messageData),
    "Initial RTX fixture",
  );
  assert.equal(
    i.summaryMessage(s.noticeData),
    "Read Version fixture; backup " + s.noticeData.params.backup,
  );
});
test("evidence write failure retains its actual filesystem cause after JSON", (t) => {
  const { dir, svc } = fixture(t),
    mkdir = fs.mkdirSync,
    raw = "Error invoking remote method 'external': Error: EACCES {raw}";
  let notice;
  fs.mkdirSync = (target, ...args) => {
    if (target === path.join(dir, "logs"))
      throw Object.assign(Error(raw), { code: "EACCES" });
    return mkdir(target, ...args);
  };
  try {
    svc.dispose();
    notice = JSON.parse(JSON.stringify(svc.getState().noticeData));
  } finally {
    fs.mkdirSync = mkdir;
  }
  assert.equal(notice.code, "EVIDENCE_SAVE_FAILED");
  assert.equal(notice.params.error.code, "EACCES");
  assert.equal(notice.params.error.message, raw);
  assert.equal(notice.message, "日志或队列记录保存失败：" + raw);
  const i = load("src/i18n.ts");
  i.localeRuntime.registerCatalog("en-XA", {
    "message.EVIDENCE_SAVE_FAILED": "Evidence fixture: {detail}",
  });
  i.setLocale("en-XA");
  assert.equal(i.summaryMessage(notice), "Evidence fixture: " + raw);
});
test("sort and unknown service actions preserve data while exposing stable failure parameters", async (t) => {
  const { svc } = fixture(t),
    before = svc.getState();
  await assert.rejects(
    svc.invoke("reorderJobs", { ids: ["missing"] }),
    (e) => e.code === "ORDER_INVALID" && e.message === "排序数据无效，请重试",
  );
  await assert.rejects(
    svc.invoke("reorderPresets", { ids: ["missing"] }),
    (e) => e.code === "PRESET_ORDER_INVALID",
  );
  await assert.rejects(
    svc.invoke("User unknown {action}"),
    (e) =>
      e.code === "SERVICE_ACTION_UNSUPPORTED" &&
      e.params.action === "User unknown {action}" &&
      e.message === "不支持的操作：User unknown {action}",
  );
  assert.deepEqual(svc.getState().jobs, before.jobs);
  assert.deepEqual(svc.getState().presets, before.presets);
});
test("RTX busy rejection still uses the existing tool/check lifecycle", async (t) => {
  let rejectCheck, started;
  const ready = new Promise((resolve) => (started = resolve)),
    { svc } = fixture(t, null, {
      toolOptions: {
        resolveReleases: () =>
          new Promise((_resolve, reject) => {
            rejectCheck = reject;
            started();
          }),
      },
    });
  await svc.invoke("detect");
  const checking = svc.invoke("checkTools");
  try {
    await ready;
    await assert.rejects(
      svc.invoke("testEnhancements"),
      (e) => e.code === "RTX_TEST_BUSY" && e.message === "请等待当前任务结束",
    );
  } finally {
    rejectCheck(Error("fixture offline"));
    await assert.rejects(checking, /fixture offline/);
  }
});
test("core output allocation and no-video failures retain codes through JSON and renderer display", () => {
  const errors = [];
  for (const operation of [
    () => core.metadata({ streams: [{ codec_type: "audio" }] }),
    () =>
      core.outputPaths(
        "C:/User source.mov",
        { ...core.DEFAULTS, outputMode: "custom", outputDir: "C:/output" },
        1,
        () => true,
      ),
  ]) {
    try {
      operation();
      assert.fail("expected failure");
    } catch (e) {
      errors.push(JSON.parse(JSON.stringify(serializeError(e))));
    }
  }
  assert.deepEqual(
    errors.map((e) => e.code),
    ["VIDEO_STREAM_MISSING", "OUTPUT_NAME_EXHAUSTED"],
  );
  assert.deepEqual(
    errors.map((e) => e.message),
    ["未找到视频轨", "无法分配不重名的输出文件"],
  );
  const i = load("src/i18n.ts");
  i.localeRuntime.registerCatalog("en-XA", {
    "error.VIDEO_STREAM_MISSING": "Missing stream fixture",
    "error.OUTPUT_NAME_EXHAUSTED": "No name fixture",
  });
  i.setLocale("en-XA");
  assert.deepEqual(errors.map(i.errorMessage), [
    "Missing stream fixture",
    "No name fixture",
  ]);
});
