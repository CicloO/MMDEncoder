const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { appError } = require("../backend/errors.cjs");
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
