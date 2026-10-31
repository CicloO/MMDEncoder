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

test("completed media rows reuse output filenames after elapsed time and hide stale paths on waiting rows", () => {
  const i18n = load("src/i18n.ts");
  const presentation = load("src/presentation.ts", { "./i18n": i18n });
  const options = load("src/mediaOptions.ts", { "./i18n": i18n });
  const { MediaQueue } = load("src/MediaQueue.tsx", {
    "./i18n": i18n,
    "./presentation": presentation,
    "./components": {
      PAGE_SIZE: 20,
      Button: ({ children }) => React.createElement("button", {}, children),
    },
    "./OutputFiles": { OutputFiles },
    "./AlignmentIcon": load("src/AlignmentIcon.tsx"),
    "./ReplacementAudio": load("src/ReplacementAudio.tsx"),
    "./FileMeta": { metaSummary: () => "Metadata" },
    "./autoAlign": { offsetText: () => "Offset", frameShiftText: () => "" },
    "./mediaOptions": options,
  });
  const completed = {
    id: "done",
    name: "User input.wav",
    path: "H:/source/User input.wav",
    status: "done",
    size: 0,
    elapsed: 12.5,
    output: "H:/output/User result (2).wav",
  };
  const props = {
    jobs: [completed],
    operation: "audio",
    running: false,
    locked: false,
    clearable: true,
    page: 0,
    pageCount: 1,
    sortJob: () => ({}),
    onSelect: () => {},
    onPage: () => {},
    onPickFiles: () => {},
    onPickAudio: () => {},
    onAlign: () => {},
    onRequeue: () => {},
    onRemove: () => {},
    onClear: () => {},
  };
  const html = renderToStaticMarkup(React.createElement(MediaQueue, props));
  assert.match(html, /已完成 · 用时 00:00:12/);
  assert.match(html, /title="H:\/output\/User result \(2\).wav"/);
  assert.equal((html.match(/class="output-file-name"/g) || []).length, 1);
  for (const status of ["ready", "running", "failed", "cancelled"]) {
    const next = renderToStaticMarkup(
      React.createElement(MediaQueue, {
        ...props,
        jobs: [{ ...completed, status }],
      }),
    );
    assert.ok(!next.includes('class="output-file-name"'));
  }
});

test("500 completed media tasks keep the existing payload size and one copy of each output path", () => {
  const state = {
    jobs: [],
    mediaJobs: Array.from({ length: 500 }, (_, i) => ({
      id: "m" + i,
      name: `用户音频${i}.wav`,
      path: `H:/source/用户音频${i}.wav`,
      status: "done",
      elapsed: 12,
      output: `H:/Encoded/用户音频${i} (2).flac`,
      log: "",
    })),
  };
  const before = Buffer.byteLength(JSON.stringify(state));
  const projected = uiState(state);
  const after = Buffer.byteLength(JSON.stringify(projected));
  assert.equal(after, before);
  assert.ok(
    projected.mediaJobs.every(
      (job) =>
        Object.keys(job).filter((key) => key.toLowerCase().includes("output"))
          .length === 1,
    ),
  );
  console.log(`500 media tasks: output payload ${before} -> ${after} bytes`);
});

test("trim completion reuses the filename view, formats elapsed time and hides uncommitted or stale paths", () => {
  const i18n = load("src/i18n.ts");
  const { TrimFooter } = load("src/TrimFooter.tsx", {
    "./i18n": i18n,
    "./trimOptions": load("src/trimOptions.ts", { "./i18n": i18n }),
    "./trimCoordinates": load("src/trimCoordinates.ts", { "./i18n": i18n }),
    "./presentation": load("src/presentation.ts", { "./i18n": i18n }),
    "./OutputFiles": { OutputFiles },
    "./components": {
      Button: ({ children }) => React.createElement("button", {}, children),
    },
  });
  const props = {
    clipCount: 1,
    totalFrames: 30,
    totalSeconds: 1,
    audioMode: "none",
    audioCodec: "aac",
    location: "source",
    running: false,
    stage: { stage: "trim_completed", params: {} },
    progress: 100,
    output: "H:/用户成品/User result_trimmed (2).mp4",
    elapsed: 12.5,
    canExport: true,
    onReveal() {},
    onCancel() {},
    onExport() {},
  };
  const render = (patch) =>
    renderToStaticMarkup(
      React.createElement(TrimFooter, { ...props, ...patch }),
    );
  assert.match(render({}), /已完成 · 用时 00:00:12/);
  assert.match(
    render({}),
    /title="H:\/用户成品\/User result_trimmed \(2\).mp4"/,
  );
  assert.equal((render({}).match(/class="output-file-name"/g) || []).length, 1);
  assert.match(render({ elapsed: 0.25 }), /已完成 · 用时 不到 1 秒/);
  for (const patch of [
    { running: true },
    { output: "" },
    { stage: { stage: "trim_cancelled", params: {} } },
    { stage: { stage: "trim_failed", params: {} } },
  ])
    assert.ok(!render(patch).includes('class="output-file-name"'));
  i18n.localeRuntime.registerCatalog("en-XA", {
    "trim.completed": "COMPLETE TEST",
    "queue.completedTime": " / TIME {time}",
  });
  i18n.setLocale("en-XA");
  assert.match(render({}), /COMPLETE TEST \/ TIME 00:00:12/);
  assert.match(render({}), /User result_trimmed/);
});

test("one trim elapsed value adds a bounded payload to 500 tasks without repeating output paths", () => {
  const state = {
    jobs: Array.from({ length: 500 }, (_, id) => ({
      id,
      output: `H:/output/User ${id}.mp4`,
    })),
    mediaJobs: [],
    trim: { output: "H:/output/User_trimmed.mp4" },
  };
  const before = Buffer.byteLength(JSON.stringify(uiState(state)));
  state.trim.elapsed = 12.5;
  const projected = uiState(state);
  const after = Buffer.byteLength(JSON.stringify(projected));
  assert.equal(projected.trim.elapsed, 12.5);
  assert.equal(
    (JSON.stringify(projected).match(/User_trimmed\.mp4/g) || []).length,
    1,
  );
  assert.ok(
    after - before <= 32,
    `unexpected payload growth: ${after - before}`,
  );
  console.log(`500 tasks + trim elapsed: ${before} -> ${after} bytes`);
});
