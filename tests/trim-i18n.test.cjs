const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-typescript.cjs");
const { appError, serializeError } = require("../backend/errors.cjs");

test("trim labels and plural forms refresh without changing stored options or technical values", () => {
  const i18n = load("src/i18n.ts");
  const options = load("src/trimOptions.ts", { "./i18n": i18n });
  const defaults = JSON.stringify(options.DEFAULT_OPTIONS);
  const values = [
    Object.keys(options.AUDIO_MODES()),
    Object.keys(options.AUDIO_CODECS()),
    Object.keys(options.LOCATIONS()),
  ];
  i18n.localeRuntime.registerCatalog("en-XA", {
    "trim.audioMode.reencode": "Long retained audio (test)",
    "trim.codec.pcm": "PCM long lossless test",
    "trim.location.custom": "Long chosen folder test",
    "trim.segmentCount": { one: "ONE {value}", other: "MANY {value}" },
  });
  i18n.setLocale("en-XA");
  assert.equal(options.AUDIO_MODES().reencode, "Long retained audio (test)");
  assert.equal(options.AUDIO_CODECS().pcm, "PCM long lossless test");
  assert.equal(options.LOCATIONS().custom, "Long chosen folder test");
  assert.equal(i18n.t("trim.segmentCount", { count: 1, value: "1" }), "ONE 1");
  assert.equal(i18n.t("trim.segmentCount", { count: 2, value: "2" }), "MANY 2");
  assert.deepEqual(
    [
      Object.keys(options.AUDIO_MODES()),
      Object.keys(options.AUDIO_CODECS()),
      Object.keys(options.LOCATIONS()),
    ],
    values,
  );
  assert.equal(JSON.stringify(options.DEFAULT_OPTIONS), defaults);
  i18n.setLocale("unsupported");
  assert.equal(
    options.AUDIO_MODES().reencode,
    "保留原音频（重新编码，精确到采样点）",
  );
});

test("trim display timecodes retain frame coordinates and canonical zero while locale changes", () => {
  const i18n = load("src/i18n.ts");
  const coordinates = load("src/trimCoordinates.ts", { "./i18n": i18n });
  const clip = { fps: { num: 30000, den: 1001 }, mmdStart: 400 };
  const position = coordinates.parsePosition("00:00:41.133", clip, true);
  const result = [0, 1, 1234.5678, -1].map(coordinates.clock);
  assert.deepEqual(result, [
    "00:00:00.000",
    "00:00:01.000",
    "00:20:34.568",
    "-1:-1:-1.000",
  ]);
  i18n.localeRuntime.registerCatalog("en-XA", {});
  i18n.setLocale("en-XA");
  assert.deepEqual([0, 1, 1234.5678, -1].map(coordinates.clock), result);
  assert.equal(coordinates.parsePosition("00:00:41.133", clip, true), position);
  assert.equal(coordinates.mmdFrame(clip, 30), 430);
});

test("trim stored reasons and cancellation refresh by codes while unknown diagnostics remain exact", () => {
  const i18n = load("src/i18n.ts");
  const reason = JSON.parse(
    JSON.stringify(serializeError(appError("TRIM_SMART_SETTINGS_MISSING"))),
  );
  i18n.localeRuntime.registerCatalog("en-XA", {
    "error.TRIM_SMART_SETTINGS_MISSING": "Long unrecorded settings test",
    "stage.trim_cancelled": "Localized stop test",
  });
  i18n.setLocale("en-XA");
  assert.equal(i18n.errorMessage(reason), "Long unrecorded settings test");
  assert.equal(
    i18n.stageMessage({
      stage: "trim_cancelled",
      params: {},
      message: "Source diagnostic",
    }),
    "Localized stop test",
  );
  assert.equal(
    i18n.errorMessage({
      code: "UNKNOWN_FUTURE",
      params: {},
      message: "Foreign diagnostic stays exact",
    }),
    "Foreign diagnostic stays exact",
  );
  assert.match(i18n.t("trim.smartHint"), /默认最多约 1 秒/);
  assert.match(i18n.t("trim.smartHint"), /NVEncC 编码的文件除外/);
  assert.doesNotMatch(i18n.t("trim.smartHint"), /1\.5\.0|几帧/);
});
