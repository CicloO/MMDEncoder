const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm");
const { load } = require("./load-typescript.cjs"),
  { serializeError, appError } = require("../backend/errors.cjs");
const source = require("../locales/zh-CN.json");
test("command-copy failures retain independent validation causes and exact legacy fallback", () => {
  const i = load("src/i18n.ts");
  const causes = [
    serializeError(appError("AUDIO_BITRATE_INVALID")),
    serializeError(appError("ENCODER_INVALID")),
  ];
  const value = JSON.parse(
    JSON.stringify(
      serializeError(
        appError("VIDEO_COMMAND_INVALID", {
          detail: causes.map((x) => x.message).join("\n"),
          errors: causes,
        }),
      ),
    ),
  );
  assert.equal(i.errorMessage(value), value.message);
  i.localeRuntime.registerCatalog("en-XA", {
    "error.VIDEO_COMMAND_INVALID": "{detail}",
    "error.AUDIO_BITRATE_INVALID": "Bitrate fixture",
    "error.ENCODER_INVALID": "Encoder fixture",
  });
  i.setLocale("en-XA");
  assert.equal(i.errorMessage(value), "Bitrate fixture\nEncoder fixture");
  const raw =
    "Error invoking remote method 'external': Error: User {raw} 原诊断";
  value.params.errors = [{ message: raw, params: {} }];
  assert.equal(i.errorMessage(value), raw);
  assert.equal(i.errorMessage(Error(raw)), "User {raw} 原诊断");
  value.params.errors = [];
  value.params.detail = "legacy command failure";
  assert.equal(i.errorMessage(value), "legacy command failure");
});
test("native rejection records retain resource coverage and path parameters across JSON and locale", () => {
  const i = load("src/i18n.ts");
  for (const code of [
    "DESKTOP_UNTRUSTED_UI",
    "DESKTOP_ACTION_UNSUPPORTED",
    "PROJECT_PAGE_UNKNOWN",
    "RELEASE_PAGE_UNTRUSTED",
    "REVEAL_PATH_UNTRUSTED",
    "MMD_HISTORY_EMPTY",
    "MMD_HISTORY_DIRECTORY_MISSING",
  ]) {
    const value = JSON.parse(
      JSON.stringify(
        serializeError(appError(code, { path: "C:/User 中文 {path}" })),
      ),
    );
    assert.equal(i.errorMessage(value), value.message);
    assert.ok(source["error." + code]);
    i.localeRuntime.registerCatalog("en-XA", {
      ["error." + code]: "Native fixture {path}",
    });
    i.setLocale("en-XA");
    assert.equal(i.errorMessage(value), "Native fixture C:/User 中文 {path}");
    i.setLocale("zh-CN");
  }
});
test("sandbox preload denies unknown actions locally and preserves supported IPC results", async () => {
  let bridge;
  const calls = [];
  const context = {
    require: (id) => {
      assert.equal(id, "electron");
      return {
        contextBridge: { exposeInMainWorld: (_key, value) => (bridge = value) },
        ipcRenderer: {
          invoke: async (...args) => {
            calls.push(args);
            return { fixture: true };
          },
        },
        webUtils: {},
      };
    },
    Promise,
    Error,
    Set,
    process: { argv: [] },
    document: { documentElement: { dataset: {} } },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../desktop/preload.cjs"), "utf8"),
    context,
  );
  const failed = JSON.parse(
    JSON.stringify(await bridge.invokeResult("unlisted-fixture")),
  );
  assert.deepEqual(failed, {
    __mmdError: {
      code: "DESKTOP_ACTION_UNSUPPORTED",
      params: {},
      message: "Unsupported action",
    },
  });
  assert.deepEqual(calls, []);
  await assert.rejects(bridge.invoke("unlisted-fixture"), /Unsupported action/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await bridge.invokeResult("state"), { fixture: true });
  assert.equal(calls[0][0], "encoder:action");
  assert.equal(calls[0][1], "state");
});
