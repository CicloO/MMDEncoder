require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createService } = require("../backend/service.cjs");
const { createDetector } = require("../backend/detect.cjs");
const { trusted } = require("../backend/tools.cjs");
const { serializeError, appError } = require("../backend/errors.cjs");
const { load } = require("./load-typescript.cjs");
const source = require("../locales/zh-CN.json");
const scratch = (run) => async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-engine-messages-"));
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("tool-source errors retain their code through JSON while unknown diagnostics stay exact", () => {
  let error;
  try {
    trusted("https://external.invalid/tool.zip");
  } catch (e) {
    error = e;
  }
  const stored = JSON.parse(JSON.stringify(serializeError(error)));
  assert.ok(stored.code && source["error." + stored.code]);
  assert.ok(Object.values(stored.params).includes("external.invalid"));
  const i18n = load("src/i18n.ts");
  i18n.localeRuntime.registerCatalog("en-XA", {
    ["error." + stored.code]: "⟦ Source ··· ⟧",
  });
  i18n.setLocale("en-XA");
  assert.equal(i18n.errorMessage(stored), "⟦ Source ··· ⟧");
  const detail = "7-Zip ERR_ACCESS_DENIED: 舞台{a}.7z";
  assert.equal(i18n.errorMessage({ message: detail, params: {} }), detail);
});

test("management wrappers retain nested error structure and format it at display time", () => {
  const cause = serializeError(
    appError("TOOLS_EXECUTABLE_MISSING", { name: "ffprobe.exe" }),
  );
  const move = JSON.parse(
    JSON.stringify({
      code: "TOOLS_MOVE_FAILED",
      params: { error: cause },
      message: "source fallback",
    }),
  );
  const notice = JSON.parse(
    JSON.stringify({
      code: "ENGINE_DETECTION_INCOMPLETE",
      params: { error: cause },
      message: "source fallback",
    }),
  );
  const i18n = load("src/i18n.ts");
  assert.equal(
    i18n.errorMessage(move),
    "移动编码工具失败，已恢复原位置：工具包缺少 ffprobe.exe",
  );
  assert.equal(
    i18n.summaryMessage(notice),
    "检测未完成：工具包缺少 ffprobe.exe",
  );
  i18n.localeRuntime.registerCatalog("en-XA", {
    "error.TOOLS_EXECUTABLE_MISSING": "⟦ Missing {name} ··· ⟧",
    "error.TOOLS_MOVE_FAILED": "⟦ Move ··· ⟧ {detail}",
    "message.ENGINE_DETECTION_INCOMPLETE": "⟦ Detect ··· ⟧ {detail}",
  });
  i18n.setLocale("en-XA");
  assert.equal(
    i18n.errorMessage(move),
    "⟦ Move ··· ⟧ ⟦ Missing ffprobe.exe ··· ⟧",
  );
  assert.equal(
    i18n.summaryMessage(notice),
    "⟦ Detect ··· ⟧ ⟦ Missing ffprobe.exe ··· ⟧",
  );
  const external =
    "Error invoking remote method 'third-party': Error: 保留 {path}";
  assert.equal(i18n.diagnosticErrorMessage(Error(external)), external);
  move.params.error = { message: external, params: {} };
  assert.equal(i18n.errorMessage(move), "⟦ Move ··· ⟧ " + external);
  assert.equal(i18n.summaryMessage(null), "");
  assert.equal(i18n.summaryMessage(undefined), "");
});

test(
  "missing-engine startup notice and service tool guards use structured records",
  scratch(async (dir) => {
    let rejectCheck;
    const service = createService({
      dataDir: path.join(dir, "data"),
      engineDir: path.join(dir, "missing"),
      toolsRoot: path.join(dir, "tools"),
      toolOptions: {
        resolveReleases: () =>
          new Promise((_resolve, reject) => {
            rejectCheck = reject;
          }),
      },
    });
    try {
      await service.invoke("detect");
      const state = service.getState();
      assert.ok(
        state.noticeData?.code && source["message." + state.noticeData.code],
      );
      assert.equal(state.noticeData.message, state.notice);
      await assert.rejects(
        service.invoke("setToolsRoot", { root: path.join(dir, "other") }),
        (error) => !!error.code && !!source["error." + error.code],
      );
      const checking = service.invoke("checkTools");
      await Promise.resolve();
      assert.equal(service.getState().tools.busy, true);
      await assert.rejects(
        service.invoke("detect"),
        (error) => !!error.code && !!source["error." + error.code],
      );
      rejectCheck(Error("fixture offline"));
      await assert.rejects(checking, /fixture offline/);
      assert.deepEqual(service.getState().tools.errorData, {
        message: "fixture offline",
        params: {},
      });
    } finally {
      service.dispose();
    }
  }),
);

test(
  "detection log wrappers keep the original technical detail and readable cache failures",
  scratch(async (dir) => {
    const raw = "reg ERR_PERMISSION: 外部{value}";
    const logs = { text: "" };
    const detector = createDetector({
      run: async () => {
        throw Error(raw);
      },
      dataDir: path.join(dir, "blocked"),
      info: () => ({}),
      engines: () => [],
      logs,
    });
    assert.equal(await detector.detectionKey(), "");
    assert.equal(
      logs.text,
      "无法读取显卡信息，本次不使用检测缓存：" + raw + "\n",
    );
    fs.writeFileSync(path.join(dir, "blocked"), "not a directory");
    detector.writeDetectionCache("key", "actual engine output\n");
    assert.ok(logs.text.includes("检测缓存保存失败："));
    assert.ok(logs.text.includes("blocked"));
  }),
);
