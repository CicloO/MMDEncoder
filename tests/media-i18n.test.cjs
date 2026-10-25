const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { load } = require("./load-typescript.cjs");
const { appError, serializeError, summary } = require("../backend/errors.cjs");
const { command } = require("../backend/media.cjs");

test("media validation preserves stable codes and extension parameters across display locales", () => {
  const i18n = load("src/i18n.ts");
  let error;
  try {
    command(
      {
        operation: "audio",
        input: path.join(os.tmpdir(), "User source.mkv"),
        output: path.join(os.tmpdir(), "User output.mp4"),
        audioFormat: "wav",
      },
      {},
      "temporary",
    );
  } catch (e) {
    error = serializeError(e);
  }
  assert.equal(error.code, "MEDIA_AUDIO_EXTENSION");
  assert.deepEqual(error.params, { extension: "wav" });
  assert.equal(i18n.errorMessage(error), "所选音频格式需要 .wav 输出文件");
  i18n.localeRuntime.registerCatalog("en-XA", {
    "error.MEDIA_AUDIO_EXTENSION": "Expanded extension .{extension}",
  });
  i18n.setLocale("en-XA");
  assert.equal(i18n.errorMessage(error), "Expanded extension .wav");
});

test("media option labels and Hi-Res display refresh while technical values and defaults remain fixed", () => {
  const i18n = load("src/i18n.ts");
  const options = load("src/mediaOptions.ts", { "./i18n": i18n });
  const before = JSON.stringify(options.DEFAULT_OPTIONS);
  const values = Object.keys(options.FORMATS());
  assert.equal(
    options.hiResText({ sampleRate: 44100, bits: 16 }),
    "44.1 kHz / 16-bit → 88.2 kHz / 24-bit",
  );
  i18n.localeRuntime.registerCatalog("en-XA", {
    "media.operation.merge": "Expanded merge",
    "media.format.copy": "Expanded copy",
    "media.status.cancelled": "Expanded cancelled",
    "media.hiresFloat": "Expanded float",
  });
  i18n.setLocale("en-XA");
  assert.equal(options.OPERATIONS().merge, "Expanded merge");
  assert.equal(options.FORMATS().copy, "Expanded copy");
  assert.equal(options.STATUS().cancelled, "Expanded cancelled");
  assert.match(
    options.hiResText({ sampleRate: 48000, float: true }),
    /Expanded float/,
  );
  assert.deepEqual(Object.keys(options.FORMATS()), values);
  assert.equal(JSON.stringify(options.DEFAULT_OPTIONS), before);
  assert.equal(options.DEFAULT_OPTIONS.audioBitrate, 0);
  assert.equal("autoAlign" in options.DEFAULT_OPTIONS, false);
});

test("removed media auto-align switch is dropped from stored options without resetting remaining settings", () => {
  const options = load("src/mediaOptions.ts", {
    "./i18n": load("src/i18n.ts"),
  });
  let stored = JSON.stringify({
    autoAlign: false,
    operation: "merge",
    audioFormat: "flac",
    audioBitrate: 192,
    hiRes: true,
    outputDir: "H:/User output",
  });
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };
  try {
    const result = options.loadOptions();
    assert.equal("autoAlign" in result, false);
    assert.equal("autoAlign" in JSON.parse(stored), false);
    assert.equal(result.operation, "merge");
    assert.equal(result.audioFormat, "flac");
    assert.equal(result.audioBitrate, 192);
    assert.equal(result.hiRes, true);
    assert.equal(result.outputDir, "H:/User output");
    global.localStorage.setItem = () => {
      throw Error("read only storage");
    };
    assert.deepEqual(options.loadOptions(), result);
  } finally {
    delete global.localStorage;
  }
});

test("auto-alignment and media error wrappers keep nested errors for later formatting", async () => {
  const i18n = load("src/i18n.ts");
  const cause = serializeError(appError("ALIGN_TOO_SHORT", { seconds: 1 }));
  const wrapped = serializeError(
    appError("MEDIA_META_FAILED", { detail: cause.message, error: cause }),
  );
  assert.equal(
    i18n.errorMessage(wrapped),
    "无法读取文件信息：自动对齐失败：音频太短，至少需要 1 秒",
  );
  const { autoAlign, offsetText } = load("src/autoAlign.ts", {
    "./i18n": i18n,
    "./ipc": {
      invoke: async () => {
        throw Object.assign(new Error(cause.message), cause);
      },
    },
  });
  const note = await autoAlign("video", "audio", async () =>
    assert.fail("failed alignment must not apply"),
  );
  assert.equal(note.code, "AUTO_ALIGN_FAILED");
  assert.deepEqual(note.params.error, cause);
  i18n.localeRuntime.registerCatalog("en-XA", {
    "error.ALIGN_TOO_SHORT": "Expanded minimum {seconds}",
    "error.MEDIA_META_FAILED": "Expanded read: {detail}",
    "message.AUTO_ALIGN_FAILED": "Expanded not applied: {detail}",
    "message.MEDIA_BATCH_FAILED": "Expanded batch: {detail}",
    "media.offsetSeconds": "{sign}{seconds} expanded seconds",
  });
  i18n.setLocale("en-XA");
  assert.equal(i18n.errorMessage(wrapped), "Expanded read: Expanded minimum 1");
  assert.equal(
    i18n.summaryMessage(note),
    "Expanded not applied: Expanded minimum 1",
  );
  assert.equal(
    i18n.summaryMessage(
      summary("MEDIA_BATCH_FAILED", { detail: cause.message, error: cause }),
    ),
    "Expanded batch: Expanded minimum 1",
  );
  assert.equal(
    i18n.summaryMessage({
      ...note,
      params: {
        error: { message: "Foreign diagnostic stays exact", params: {} },
      },
    }),
    "Expanded not applied: Foreign diagnostic stays exact",
  );
  assert.equal(offsetText(-1.25), "-1.250 expanded seconds");
  const low = load("src/autoAlign.ts", {
    "./i18n": i18n,
    "./ipc": { invoke: async () => ({ reliable: false, offset: 12 }) },
  });
  assert.equal(
    (
      await low.autoAlign("video", "audio", async () =>
        assert.fail("unreliable result must not apply"),
      )
    ).code,
    "AUTO_ALIGN_LOW_CONFIDENCE",
  );
});
