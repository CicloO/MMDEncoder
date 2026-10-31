const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-typescript.cjs");
const i18n = load("src/i18n.ts");
const { createAlignmentTasks } = load("src/alignmentTasks.ts", {
  "./i18n": i18n,
  "./alignRequests": {
    isCancelled: (error) => error?.code === "ALIGN_CANCELLED",
  },
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("disabled automatic matching still replaces audio in both workflows without applying or clearing a new offset", async () => {
  const { createAudioReplacement, createMediaAudioReplacement } = load(
    "src/audioReplacement.ts",
    { "./i18n": i18n },
  );
  for (const mode of ["video", "media"]) {
    const calls = [];
    const row = {
      id: "selected",
      path: "source.mp4",
      hasAudio: true,
      isSequence: false,
      meta: { audio: {} },
    };
    const response = {
      [mode === "video" ? "jobs" : "mediaJobs"]: [
        { ...row, audioPath: "second.wav" },
      ],
    };
    const request = async (action, payload) => {
      calls.push([action, payload]);
      return response;
    };
    let finished = 0;
    const options = {
      call: request,
      run: request,
      notify: () => assert.fail("No automatic result notice"),
      actions: { replace: "replace", offset: "offset" },
      autoAlign: false,
      tasks: {
        begin: () => ({
          current: () => true,
          finish: () => finished++,
          run: () => assert.fail("Automatic matching disabled"),
        }),
      },
    };
    if (mode === "video")
      await createAudioReplacement(options).replaceAudio(row, "second.wav");
    else await createMediaAudioReplacement(options).setAudio(row, "second.wav");
    assert.deepEqual(calls, [
      ["replace", { id: "selected", path: "second.wav" }],
    ]);
    assert.equal(finished, 1);
  }
});

test("automatic alignment tracks independent tasks and clears success, low-confidence, failure and cancellation", async () => {
  const runs = new Map(),
    busy = [],
    applied = [];
  const tasks = createAlignmentTasks({
    prefix: "video",
    changed: (ids) => busy.push([...ids].sort()),
    request: async (action, payload) => {
      assert.equal(action, "alignRun");
      const pending = deferred();
      runs.set(payload.slot, pending);
      return pending.promise;
    },
  });
  const first = tasks
    .begin("one")
    .run("video1", "audio1", async (offset) => applied.push(offset));
  const second = tasks
    .begin("two")
    .run("video2", "audio2", async () =>
      assert.fail("unreliable result applied"),
    );
  await tick();
  assert.deepEqual(busy.at(-1), ["one", "two"]);
  runs.get("auto-align:video:one").resolve({ reliable: true, offset: 0.125 });
  assert.equal(await first, "");
  assert.deepEqual(applied, [0.125]);
  assert.deepEqual(busy.at(-1), ["two"]);
  runs.get("auto-align:video:two").resolve({ reliable: false });
  assert.equal((await second).code, "AUTO_ALIGN_LOW_CONFIDENCE");
  assert.deepEqual(busy.at(-1), []);
  for (const [id, error, expected] of [
    [
      "failure",
      { code: "ALIGN_TOO_SHORT", params: { seconds: 1 }, message: "external" },
      "AUTO_ALIGN_FAILED",
    ],
    ["cancelled", { code: "ALIGN_CANCELLED" }, null],
  ]) {
    const result = tasks
      .begin(id)
      .run("video", "audio", async () => assert.fail());
    await tick();
    runs.get(`auto-align:video:${id}`).reject(error);
    const notice = await result;
    assert.equal(notice?.code || null, expected);
    if (notice) assert.equal(notice.params.error.code, "ALIGN_TOO_SHORT");
    assert.deepEqual(busy.at(-1), []);
  }
});

test("replacing a task rejects stale results and waits for delayed old cancellation before reusing the slot", async () => {
  const calls = [],
    old = deferred(),
    latest = deferred(),
    closing = deferred();
  let runs = 0;
  const tasks = createAlignmentTasks({
    prefix: "media",
    changed: () => {},
    request: async (action, payload) => {
      calls.push([action, payload]);
      return action === "alignCancel"
        ? closing.promise
        : ++runs === 1
          ? old.promise
          : latest.promise;
    },
  });
  const applied = [];
  const one = tasks
    .begin("same")
    .run("video", "old.wav", async (value) => applied.push(["old", value]));
  await tick();
  const two = tasks
    .begin("same")
    .run("video", "new.wav", async (value) => applied.push(["new", value]));
  await tick();
  assert.equal(runs, 1, "new work waits for the old cancel");
  old.resolve({ reliable: true, offset: 99 });
  assert.equal(await one, null);
  closing.resolve();
  await tick();
  assert.equal(runs, 2);
  latest.resolve({ reliable: true, offset: 0.25 });
  assert.equal(await two, "");
  assert.deepEqual(applied, [["new", 0.25]]);
  assert.deepEqual(
    calls.map(([action]) => action),
    ["alignRun", "alignCancel", "alignRun"],
  );
});

test("removing a task, replacing its target and unmounting cancel its slot and clear busy immediately", async () => {
  const calls = [],
    pending = new Map(),
    states = [];
  const tasks = createAlignmentTasks({
    prefix: "media",
    changed: (ids) => states.push([...ids]),
    request: async (action, payload) => {
      calls.push([action, payload]);
      if (action === "alignCancel") return;
      const item = deferred();
      pending.set(payload.target, item);
      return item.promise;
    },
  });
  const results = [];
  for (const id of ["removed", "changed", "closed"])
    results.push(
      tasks
        .begin(id)
        .run("reference", id, async () => assert.fail("stale result applied")),
    );
  await tick();
  tasks.retain([
    { id: "changed", target: "new.wav" },
    { id: "closed", target: "closed" },
  ]);
  assert.deepEqual(states.at(-1), ["closed"]);
  tasks.cancelAll();
  assert.deepEqual(states.at(-1), []);
  for (const item of pending.values())
    item.resolve({ reliable: true, offset: 1 });
  assert.deepEqual(await Promise.all(results), [null, null, null]);
  await tick();
  assert.equal(calls.filter(([action]) => action === "alignCancel").length, 3);
});

test("video and media replacements always align new audio, guard its identity and suppress superseded requests", async () => {
  const { createAudioReplacement, createMediaAudioReplacement } = load(
    "src/audioReplacement.ts",
    { "./i18n": i18n },
  );
  for (const mode of ["video", "media"]) {
    const calls = [],
      notices = [],
      sets = new Map();
    const request = async (action, payload) => {
      calls.push([action, payload]);
      return { reliable: true, offset: 0.125 };
    };
    const tasks = createAlignmentTasks({
      prefix: mode,
      request,
      changed: () => {},
    });
    const run = async (action, payload) => {
      calls.push([action, payload]);
      if (action.endsWith("SetAudio") || action === "setAudio") {
        const item = deferred();
        sets.set(payload.path, item);
        return item.promise;
      }
      return {};
    };
    const api =
      mode === "video"
        ? createAudioReplacement({
            call: run,
            notify: (n) => notices.push(n),
            tasks,
            actions: { replace: "setAudio", offset: "setAudioOffset" },
          })
        : createMediaAudioReplacement({
            run,
            call: run,
            notify: (n) => notices.push(n),
            tasks,
            actions: {
              replace: "mediaSetAudio",
              offset: "mediaSetAudioOffset",
            },
          });
    const choose = mode === "video" ? api.replaceAudio : api.setAudio;
    const row = {
      id: "job",
      path: "video.mp4",
      hasAudio: true,
      isSequence: false,
      meta: { audio: {} },
    };
    const first = choose(row, "old.wav"),
      second = choose(row, "new.wav");
    const response = (file) => ({
      [mode === "video" ? "jobs" : "mediaJobs"]: [{ ...row, audioPath: file }],
    });
    sets.get("new.wav").resolve(response("new.wav"));
    await second;
    sets.get("old.wav").resolve(response("old.wav"));
    await first;
    const aligns = calls.filter(([action]) => action === "alignRun");
    assert.equal(aligns.length, 1);
    assert.equal(aligns[0][1].target, "new.wav");
    const offset = calls.find(([action]) =>
      action.toLowerCase().endsWith("audiooffset"),
    )[1];
    assert.deepEqual(offset, {
      id: "job",
      offset: 0.125,
      expectedAudioPath: "new.wav",
    });
    assert.equal(
      "shiftFrames" in offset,
      false,
      "auto-match only updates the waveform offset",
    );
    assert.equal(
      notices.some((n) => n.code === "AUTO_ALIGN_FAILED"),
      false,
    );
  }
});

test("replacement adapters preserve their reference, response, feedback and error policies", async () => {
  const { createAudioReplacement, createMediaAudioReplacement } = load(
    "src/audioReplacement.ts",
    { "./i18n": i18n },
  );
  for (const mode of ["video", "media"]) {
    const events = [],
      row = {
        id: "job",
        path: "original.mp4",
        hasAudio: true,
        isSequence: false,
        meta: { audio: {} },
      },
      response = {
        [mode === "video" ? "jobs" : "mediaJobs"]: [
          { ...row, path: "updated.mp4", audioPath: "new.wav" },
        ],
      },
      error = new Error("replacement failed");
    let failed = false;
    const request = async (action, payload, notice) => {
      events.push([action, payload, notice?.code]);
      if (failed) throw error;
      return response;
    };
    const options = {
      call: request,
      run: request,
      actions: { replace: "replace", offset: "offset" },
      notify: (notice) => events.push(["notice", notice.code]),
      tasks: {
        begin: () => ({
          current: () => true,
          finish: () => events.push(["finish"]),
          run: async (reference, target, apply) => {
            events.push(["align", reference, target]);
            await apply(0.125);
            return "";
          },
        }),
      },
    };
    const replace =
      mode === "video"
        ? createAudioReplacement(options).replaceAudio
        : createMediaAudioReplacement(options).setAudio;
    assert.equal(
      await replace(row, "new.wav"),
      mode === "video" ? undefined : response,
    );
    assert.deepEqual(events, [
      [
        "replace",
        { id: "job", path: "new.wav" },
        mode === "video" ? "VIDEO_AUDIO_REPLACED" : undefined,
      ],
      ["align", mode === "video" ? "updated.mp4" : "original.mp4", "new.wav"],
      [
        "offset",
        { id: "job", offset: 0.125, expectedAudioPath: "new.wav" },
        undefined,
      ],
      ...(mode === "video" ? [["notice", "VIDEO_AUDIO_ALIGNED"]] : []),
    ]);
    events.length = 0;
    failed = true;
    if (mode === "video") {
      assert.equal(await replace(row, "new.wav"), undefined);
      assert.deepEqual(events.at(-1), ["finish"]);
    } else {
      await assert.rejects(
        replace(row, "new.wav"),
        (caught) => caught === error,
      );
      assert.equal(
        events.some(([event]) => event === "finish"),
        false,
      );
    }
  }
});
