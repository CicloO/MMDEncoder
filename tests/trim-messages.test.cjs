const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const trim = require("../backend/trim.cjs");
const {
  appError,
  serializeError,
  restoreError,
} = require("../backend/errors.cjs");
const { createTranslator } = require("../locales/runtime.mjs");
const { formatDescriptor } = require("../locales/messages.mjs");
const { formatTrimMessage } = require("../locales/trim-messages.mjs");
const source = require("../locales/zh-CN.json");

test("trim join differences keep technical keys and refresh their complete sentences", () => {
  const runtime = createTranslator({
    sourceLocale: "zh-CN",
    catalogs: {
      "zh-CN": source,
      en: {
        "error.TRIM_JOIN_MISMATCH": "JOIN {detail}",
        "trim.compatibility.value":
          "{name} {field}={value}, {reference}={expected}",
        "trim.compatibility.sets": "{name} {field} differs from {reference}",
        "trim.parameter.width": "WIDTH TEST",
        "trim.parameter.extradata": "SETS TEST",
        "trim.listSeparator": " | ",
      },
    },
  });
  const record = serializeError(
    appError("TRIM_JOIN_MISMATCH", {
      differences: [
        {
          name: "用户 B.mp4",
          reference: "User A.mp4",
          key: "width",
          value: 640,
          expected: 320,
        },
        {
          name: "用户 B.mp4",
          reference: "User A.mp4",
          key: "extradata",
          value: "Source diagnostic",
          expected: "",
        },
        {
          name: "用户 B.mp4",
          reference: "User A.mp4",
          key: "future_field",
          value: "Foreign detail",
          expected: "Expected detail",
        },
      ],
    }),
  );
  runtime.setLocale("en");
  assert.equal(
    formatTrimMessage(runtime, record),
    "JOIN 用户 B.mp4 WIDTH TEST=640, User A.mp4=320 | 用户 B.mp4 SETS TEST differs from User A.mp4 | 用户 B.mp4 future_field=Foreign detail, User A.mp4=Expected detail",
  );
  assert.equal(record.params.differences[0].key, "width");
  runtime.setLocale("zh-CN");
  assert.match(
    formatTrimMessage(runtime, record),
    /用户 B.mp4 的宽度与 User A.mp4 不同（640 \/ 320）/,
  );
});

test("trim cut errors retain nested reason codes across JSON and refresh their display", () => {
  const reason = serializeError(appError("TRIM_OPEN_GOP"));
  const frames = [
    { frame: 0, safe: true, decode: 0, pts: 0 },
    {
      frame: 1,
      safe: false,
      decode: 1,
      pts: 1,
      why: reason.message,
      whyData: reason,
    },
    { frame: 2, safe: true, decode: 2, pts: 2 },
  ];
  let error;
  try {
    trim.segment({ frames }, 1, 3);
  } catch (e) {
    error = e;
  }
  assert.equal(error.code, "TRIM_UNSAFE_IN");
  const record = JSON.parse(JSON.stringify(serializeError(error)));
  assert.equal(record.params.frame, 1);
  assert.equal(record.params.reason.code, "TRIM_OPEN_GOP");
  assert.equal(restoreError(record).code, error.code);
  const runtime = createTranslator({
    sourceLocale: "zh-CN",
    catalogs: {
      "zh-CN": source,
      en: {
        "error.TRIM_UNSAFE_IN": "IN {frame}: {detail}",
        "error.TRIM_OPEN_GOP": "OPEN GOP TEST",
        "error.TRIM_REENCODE_MISMATCH": "MISMATCH {detail}",
        "error.TRIM_CODEC_DATA_MISMATCH": "SPS TEST",
        "error.TRIM_PARAMETER_MISMATCH": "{key}={value}/{expected}",
        "trim.listSeparator": " | ",
      },
    },
  });
  assert.equal(formatTrimMessage(runtime, record), error.message);
  runtime.setLocale("en");
  assert.equal(formatTrimMessage(runtime, record), "IN 1: OPEN GOP TEST");
  const mismatch = serializeError(
    appError("TRIM_REENCODE_MISMATCH", {
      differences: [
        serializeError(appError("TRIM_CODEC_DATA_MISMATCH")),
        serializeError(
          appError("TRIM_PARAMETER_MISMATCH", {
            key: "width",
            value: 640,
            expected: 320,
          }),
        ),
        { message: "Foreign diagnostic stays exact", params: {} },
      ],
    }),
  );
  assert.equal(
    formatTrimMessage(runtime, mismatch),
    "MISMATCH SPS TEST | width=640/320 | Foreign diagnostic stays exact",
  );
  assert.equal(
    formatDescriptor(runtime, "error", {
      code: "UNKNOWN",
      params: {},
      message: "External stderr",
    }),
    "External stderr",
  );
});

test("trim smart rejection has a serializable code and cleans the transaction before any encoder starts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trim-messages-"));
  try {
    await assert.rejects(
      trim.cut(
        {},
        [
          {
            file: path.join(root, "user 原片.mp4"),
            idx: { frames: [{ safe: false }] },
            from: 0,
            to: 1,
          },
        ],
        path.join(root, "output.mp4"),
        { smart: true },
      ),
      (e) => {
        assert.equal(e.code, "TRIM_SMART_TAG_REQUIRED");
        assert.equal(e.params.name, "user 原片.mp4");
        assert.ok(!e.message.includes("1.5.0"));
        return true;
      },
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trim process errors preserve foreign stderr and cancellation has a stable code", async () => {
  await assert.rejects(
    trim.run(process.execPath, [
      "-e",
      "process.stderr.write('FOREIGN STDERR 123');process.exit(2)",
    ]),
    (e) => {
      assert.equal(e.message, "FOREIGN STDERR 123");
      assert.equal(e.stderr, "FOREIGN STDERR 123");
      return true;
    },
  );
  const controller = new AbortController();
  const pending = trim.run(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(pending, (e) => {
    assert.equal(e.code, "TRIM_CANCELLED");
    assert.equal(e.cancelled, true);
    return true;
  });
});
