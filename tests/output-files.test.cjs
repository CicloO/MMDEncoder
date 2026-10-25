require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { load } = require("./load-typescript.cjs");
const { OutputFiles } = load("src/OutputFiles.tsx");
const { uiState } = require("../backend/ui-state.cjs");

test("output filenames render ordinary, paired, mask-only and numbered paths with complete accessible text and path titles", () => {
  for (const paths of [
    { output: "H:/成品/用户视频.mp4" },
    {
      output: "H:/成品/用户视频.mp4",
      maskOutput: "H:/成品/用户视频_alpha.mp4",
    },
    { output: "H:/成品/仅遮罩_alpha.webm" },
    { output: "H:/成品/用户视频 (2).mp4" },
  ]) {
    const html = renderToStaticMarkup(React.createElement(OutputFiles, paths));
    for (const p of Object.values(paths))
      assert.ok(html.includes(`title="${p}"`));
    assert.equal(
      (html.match(/class="output-file-name"/g) || []).length,
      Object.values(paths).length,
    );
    // The lead and tail retain the complete name; truncation is CSS-only.
    const names = [
      ...html.matchAll(
        /class="output-file-lead">([^<]*)<\/span><span class="output-file-tail">([^<]*)/g,
      ),
    ].map((m) => m[1] + m[2]);
    assert.deepEqual(
      names,
      Object.values(paths).map((p) => p.split("/").pop()),
    );
  }
  assert.equal(renderToStaticMarkup(React.createElement(OutputFiles, {})), "");
});

test("partial output projection hides uncommitted or foreign mask paths and preserves the retry's planned path", () => {
  const state = {
    jobs: [
      {
        id: "partial",
        status: "partial",
        output: "H:/out/video.mp4",
        maskOutput: "H:/out/video_alpha.mp4",
        _maskReady: false,
      },
    ],
    mediaJobs: [],
  };
  const first = uiState(state).jobs[0];
  assert.equal(first.output, state.jobs[0].output);
  assert.equal(first.maskOutput, undefined);
  assert.equal(state.jobs[0].maskOutput, "H:/out/video_alpha.mp4");
  state.jobs[0]._maskReady = true;
  const complete = uiState(state).jobs[0];
  assert.equal(complete.maskOutput, state.jobs[0].maskOutput);
  assert.equal("_maskReady" in complete, false);
});

test("500 completed video tasks retain the existing payload size without duplicating output paths", () => {
  const state = {
    jobs: Array.from({ length: 500 }, (_, i) => ({
      id: "v" + i,
      name: `用户视频${i}.mov`,
      status: "done",
      progress: 100,
      elapsed: 10,
      output: `H:/Encoded/用户视频${i} (2).mp4`,
      maskOutput: `H:/Encoded/用户视频${i} (2)_alpha.mp4`,
      _maskReady: true,
      log: "x".repeat(200000),
    })),
    mediaJobs: [],
  };
  const before = {
    ...state,
    jobs: state.jobs.map(({ log, _maskReady, ...job }) => job),
  };
  const projected = uiState(state);
  const beforeBytes = Buffer.byteLength(JSON.stringify(before));
  const afterBytes = Buffer.byteLength(JSON.stringify(projected));
  assert.equal(afterBytes, beforeBytes);
  assert.ok(
    projected.jobs.every(
      (j) => j.output && j.maskOutput && !("log" in j) && !("_maskReady" in j),
    ),
  );
  console.log(
    `500 video tasks: output payload ${beforeBytes} -> ${afterBytes} bytes`,
  );
});
