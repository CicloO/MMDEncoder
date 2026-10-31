const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFileDetails } = require("../backend/file-details.cjs");
const { load } = require("./load-typescript.cjs");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

test("file details preserve source/output probe data and structured absence or external failures", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-details-"));
  try {
    const file = path.join(dir, "User 输入.png");
    fs.writeFileSync(file, "fixture");
    const job = { path: file, sequence: { pattern: "User %04d.png" } };
    const calls = [];
    let busy = false,
      failure = false;
    const raw = {
      streams: [{ codec_name: "rgba", index: 0 }],
      format: { duration: "3.25" },
    };
    const read = createFileDetails({
      isToolsBusy: () => busy,
      requireMediaJob: () => job,
      requireJob: () => job,
      locate: async () => {},
      ffprobe: () => "ffprobe.exe",
      inputArgs: () => ["-framerate", "30000/1001", "-i", "User %04d.png"],
      run: async (...args) => {
        calls.push(args);
        if (failure) throw Error("External diagnostic stays exact");
        return { stdout: JSON.stringify(raw) };
      },
    });
    let result = await read({ id: "video" });
    assert.deepEqual(result.before, { path: job.sequence.pattern, ...raw });
    assert.deepEqual(calls[0], [
      "ffprobe.exe",
      [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        "-framerate",
        "30000/1001",
        "-i",
        "User %04d.png",
      ],
      { timeout: 30000 },
    ]);
    assert.equal(result.after.code, "DETAILS_OUTPUT_MISSING");
    assert.equal(result.after.message, "尚未生成文件");
    assert.deepEqual(result.after.params, {});
    assert.equal(result.mask.code, "DETAILS_OUTPUT_MISSING");
    result = await read({ id: "media", media: true });
    assert.equal(result.mask, undefined);
    assert.equal(calls.at(-1)[1].at(-1), file);
    failure = true;
    result = await read({ id: "media", media: true });
    assert.equal(result.before.code, "DETAILS_READ_FAILED");
    assert.deepEqual(result.before.params, {
      detail: "External diagnostic stays exact",
    });
    fs.unlinkSync(file);
    result = await read({ id: "media", media: true });
    assert.equal(result.before.code, "DETAILS_SOURCE_MISSING");
    busy = true;
    await assert.rejects(read({ id: "media", media: true }), {
      code: "DETAILS_TOOLS_BUSY",
      params: {},
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("metadata presentation refreshes labels, counts, units and stored detail errors without changing raw data", () => {
  const i18n = load("src/i18n.ts");
  const presentation = load("src/presentation.ts", { "./i18n": i18n });
  const { FileMeta, metaSummary } = load("src/FileMeta.tsx", {
    "./i18n": i18n,
    "./presentation": presentation,
  });
  const { MediaDetails } = load("src/MediaDetails.tsx", {
    "./i18n": i18n,
    "./presentation": presentation,
  });
  const meta = {
    width: 1920,
    height: 1080,
    fpsText: "30000/1001",
    duration: 3.25,
    size: 1024,
    codec: "png",
    pixFmt: "rgba",
    bitDepth: 8,
    hasAlpha: true,
    sequence: { count: 1001 },
    audio: { codec: "flac", sampleRate: 48000, channels: 2 },
  };
  const details = {
    before: {
      path: "C:/User 文件.mov",
      format: { duration: "10.033333", bit_rate: "10081000", size: "1024" },
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "h264",
          width: 1920,
          height: 1080,
          pix_fmt: "yuv420p",
        },
      ],
    },
    after: {
      code: "DETAILS_OUTPUT_MISSING",
      params: {},
      message: "尚未生成文件",
    },
    mask: { message: "Foreign diagnostic stays exact" },
  };
  const before = JSON.stringify({ meta, details });
  const renderMeta = () =>
    renderToStaticMarkup(React.createElement(FileMeta, { meta }));
  const renderDetails = () =>
    renderToStaticMarkup(React.createElement(MediaDetails, { details }));
  assert.match(metaSummary(meta), /1920×1080 · 29\.97 FPS · 1001 张 PNG/);
  assert.match(renderMeta(), /PNG 序列 · 1001 帧/);
  assert.match(renderMeta(), /立体声/);
  assert.match(renderDetails(), /00:00:10\.033/);
  assert.match(renderDetails(), /10,081 kbps/);
  i18n.localeRuntime.registerCatalog("en-XA", {
    "meta.pngFrames": { one: "Single {count}", other: "Many {count}" },
    "meta.stereo": "Stereo expanded",
    "meta.alpha": "Alpha expanded",
    "details.before": "Before expanded",
    "details.codec": "Codec expanded",
    "error.DETAILS_OUTPUT_MISSING": "Missing output expanded",
    "details.bitrate": "Rate {rate}",
  });
  i18n.setLocale("en-XA");
  assert.match(renderMeta(), /Many 1001/);
  assert.match(renderMeta(), /Stereo expanded/);
  assert.match(renderMeta(), /Alpha expanded/);
  assert.match(renderDetails(), /Before expanded/);
  assert.match(renderDetails(), /Codec expanded/);
  assert.match(renderDetails(), /Missing output expanded/);
  assert.match(renderDetails(), /Foreign diagnostic stays exact/);
  assert.match(renderDetails(), /User 文件.mov/);
  assert.equal(JSON.stringify({ meta, details }), before);
});

test("details name MP4 by extension and line up before/after stream rows", () => {
  const i18n = load("src/i18n.ts");
  const presentation = load("src/presentation.ts", { "./i18n": i18n });
  const { MediaDetails, containerName } = load("src/MediaDetails.tsx", {
    "./i18n": i18n,
    "./presentation": presentation,
  });
  const family = { format_name: "mov,mp4,m4a,3gp,3g2,mj2" };
  assert.equal(containerName(family, "C:/a.mp4"), "MP4");
  assert.equal(containerName(family, "C:/a.MOV"), "QuickTime / MOV");
  assert.equal(
    containerName({ ...family, tags: { major_brand: "qt  " } }, "C:/a.bin"),
    "QuickTime / MOV",
  );
  assert.equal(
    containerName({
      format_name: "matroska,webm",
      format_long_name: "Matroska / WebM",
    }),
    "Matroska / WebM",
  );
  const side = (file, colour) => ({
    path: file,
    format: { ...family, size: "1", duration: "1", bit_rate: "1000" },
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264", ...colour },
      {
        index: 1,
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        bits_per_sample: 0,
        avg_frame_rate: "0/0",
        r_frame_rate: "0/0",
      },
    ],
  });
  const html = renderToStaticMarkup(
    React.createElement(MediaDetails, {
      details: {
        before: side("C:/in.mp4", {}),
        after: side("C:/out.mp4", { color_space: "bt709", color_range: "tv" }),
      },
      media: true,
    }),
  );
  const [before, after] = html.split("<section").slice(1);
  const rows = (part) => (part.match(/<dt>/g) || []).length;
  assert.equal(rows(before), rows(after));
  assert.match(before, /<dd>—<\/dd>/);
  assert.match(html, /MP4 ·/);
  // Audio's "0" bit depth and "0/0" frame rate are hidden (raw JSON keeps them).
  assert.doesNotMatch(html, /<dd>0\/0/);
  assert.doesNotMatch(html, /<dd>0<\/dd>/);
});
