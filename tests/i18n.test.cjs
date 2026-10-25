const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const {
  appError,
  validationIssue,
  validationError,
  summary,
} = require("../backend/errors.cjs");
const { registerAction } = require("../desktop/actions.cjs");
function load(file, dependencies = {}) {
  const filename = path.resolve(file);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      resolveJsonModule: true,
      esModuleInterop: true,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  const original = Module.createRequire(filename);
  loaded.require = (id) => dependencies[id] || original(id);
  loaded._compile(compiled, filename);
  return loaded.exports;
}
test("translation, interpolation and unknown error fallback use the shared Chinese catalog", () => {
  const { t, errorMessage } = load("src/i18n.ts");
  assert.equal(t("background.label"), "背景颜色");
  assert.equal(
    errorMessage({
      code: "ALIGN_FAILED",
      params: { detail: "test" },
      message: "fallback",
    }),
    "自动对齐失败：test",
  );
  assert.equal(
    errorMessage({ code: "FUTURE_CODE", message: "engine detail" }),
    "engine detail",
  );
  assert.equal(errorMessage(Error("plain error")), "plain error");
});
test("coded errors cross the IPC boundary and are reconstructed in the renderer", async () => {
  const i18n = load("src/i18n.ts");
  let handler;
  registerAction(
    {
      handle: (name, fn) => {
        assert.equal(name, "encoder:action");
        handler = fn;
      },
    },
    async () => {
      throw appError("ALIGN_INPUT_INVALID");
    },
  );
  const result = await handler();
  assert.equal(result.__mmdError.code, "ALIGN_INPUT_INVALID");
  global.window = { encoder: { invokeResult: async () => result } };
  try {
    const { invoke } = load("src/ipc.ts", { "./i18n": i18n });
    await assert.rejects(
      invoke("alignPreview", {}),
      (error) =>
        error.code === "ALIGN_INPUT_INVALID" &&
        error.message === "请选择有效的音频或视频文件",
    );
  } finally {
    delete global.window;
  }
});

test("validation issues keep separate codes and structured params through IPC and locale changes", async () => {
  const i18n = load("src/i18n.ts");
  const issues = [
    validationIssue("ALIGN_TOO_SHORT", { seconds: 1 }),
    {
      code: "FUTURE_ISSUE",
      params: { paths: ["舞台.wav", "a{b}.wav"], retry: false, empty: null },
      message: "raw future detail",
    },
  ];
  let handler;
  registerAction(
    {
      handle: (_name, fn) => {
        handler = fn;
      },
    },
    async () => {
      throw validationError(issues);
    },
  );
  const result = JSON.parse(JSON.stringify(await handler()));
  assert.deepEqual(result.__mmdError.issues, issues);
  global.window = { encoder: { invokeResult: async () => result } };
  try {
    const { invoke } = load("src/ipc.ts", { "./i18n": i18n });
    let received;
    await assert.rejects(invoke("validate"), (error) => {
      received = error;
      return (
        error.code === "VALIDATION_FAILED" &&
        error.message ===
          "请检查以下设置\n自动对齐失败：音频太短，至少需要 1 秒\nraw future detail"
      );
    });
    assert.deepEqual(received.issues, issues);
    i18n.localeRuntime.registerCatalog("en-XA", {
      "error.VALIDATION_FAILED": "⟦ Check ··· ⟧",
      "error.ALIGN_TOO_SHORT": "⟦ {seconds} s ··· ⟧",
    });
    i18n.setLocale("en-XA");
    assert.equal(
      i18n.errorMessage(received),
      "⟦ Check ··· ⟧\n⟦ 1 s ··· ⟧\nraw future detail",
    );
  } finally {
    delete global.window;
  }
});

test("stage and history descriptors format at display time and preserve legacy or unknown messages", () => {
  const i18n = load("src/i18n.ts");
  const { stageDescriptor } = require("../locales/messages.mjs");
  const stage = stageDescriptor("copying_segment", { current: 2, total: 5 });
  const history = summary("FUTURE_SUMMARY", { frames: 120 });
  history.message = "saved fallback";
  const stored = JSON.parse(JSON.stringify({ stage, history }));
  assert.equal(i18n.stageMessage(stored.stage), "copying_segment");
  assert.equal(i18n.summaryMessage(stored.history), "saved fallback");
  assert.equal(i18n.stageMessage("准备"), "准备");
  assert.equal(i18n.summaryMessage("旧的中文记录"), "旧的中文记录");
  i18n.localeRuntime.registerCatalog("en-XA", {
    "stage.copying_segment": "⟦ {current}/{total} ··· ⟧",
    "message.FUTURE_SUMMARY": "⟦ {frames} frames ··· ⟧",
  });
  i18n.setLocale("en-XA");
  assert.equal(i18n.stageMessage(stored.stage), "⟦ 2/5 ··· ⟧");
  assert.equal(i18n.summaryMessage(stored.history), "⟦ 120 frames ··· ⟧");
  assert.equal(stored.history.message, "saved fallback");
});
