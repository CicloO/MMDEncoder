"use strict";
// Audio alignment for the windows (音频对齐): the waveform preview of a file
// and the automatic alignment of two (align.cjs), each in a worker process
// (align-worker.cjs).
// Every request is a task the service keeps track of: a request with the
// same `slot` (e.g. the dialog's reference track) stops the older one, at
// most 3 workers run at once, each has a time limit, alignCancel stops a
// dialog's tasks when it closes, and stopAll() all of them when the app
// quits. They are not the service's `children`: a few seconds of alignment
// must not hold up starting a queue (isBusy).
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createLimit } = require("./limit.cjs");
const { appError } = require("./errors.cjs");
const { createWorkerErrorReader } = require("./worker-protocol.cjs");

const WORKER = path.join(__dirname, "align-worker.cjs");
// Preview: mono 16-bit at this rate, up to this long (as the dialog draws).
const PREVIEW_RATE = 24000;
const PREVIEW_LENGTH = 20 * 60;
const PREVIEW_TIMEOUT = 2 * 60 * 1000;
const ALIGN_TIMEOUT = 5 * 60 * 1000;
// The window treats this message as "replaced or closed", not an error.
const CANCELLED = appError("ALIGN_CANCELLED").message;

// engineInfo(): the tool paths; locate(): finds the tools first.
function createAlignService({ engineInfo, locate }) {
  const running = new Set();
  const slots = new Map();
  const limit = createLimit(3);
  function task(slot) {
    const t = {
      cancelled: false,
      timedOut: false,
      child: null,
      cancel() {
        t.cancelled = true;
        const child = t.child;
        if (!child || child.exitCode !== null) return;
        // The worker stops its FFmpeg itself; kill it if it does not.
        try {
          child.stdin.write("cancel\n");
        } catch {}
        setTimeout(() => child.exitCode === null && child.kill(), 2000).unref();
      },
    };
    if (slot) {
      slots.get(slot)?.cancel();
      slots.set(slot, t);
    }
    return t;
  }
  function worker(t, job, timeout) {
    return new Promise((resolve, reject) => {
      if (t.cancelled) return reject(appError("ALIGN_CANCELLED"));
      const child = spawn(process.execPath, [WORKER], {
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          MMD_ALIGN_JOB: JSON.stringify(job),
        },
      });
      t.child = child;
      running.add(t);
      const timer = setTimeout(() => {
        t.timedOut = true;
        t.cancel();
      }, timeout);
      const chunks = [];
      const errors = createWorkerErrorReader();
      child.stdin.on("error", () => {});
      child.stdout.on("data", (b) => chunks.push(b));
      child.stderr.on("data", (b) => errors.write(b));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        running.delete(t);
        if (t.timedOut) return reject(appError("ALIGN_TIMEOUT"));
        if (t.cancelled) return reject(appError("ALIGN_CANCELLED"));
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(errors.finish(code));
      });
    });
  }
  function start(slot, job, timeout) {
    const t = task(typeof slot === "string" ? slot : "");
    return limit(() => worker(t, job, timeout)).finally(() => {
      if (slots.get(slot) === t) slots.delete(slot);
    });
  }
  const queries = {
    // The sound of a file for the dialog's waveform and playback.
    async alignPreview(payload) {
      const file = payload?.path;
      if (typeof file !== "string" || !path.isAbsolute(file))
        throw appError("ALIGN_INPUT_INVALID");
      await locate();
      let buf = await start(
        payload.slot,
        {
          mode: "preview",
          ffmpeg: engineInfo().ffmpeg,
          file,
          rate: PREVIEW_RATE,
          length: PREVIEW_LENGTH,
        },
        PREVIEW_TIMEOUT,
      );
      if (!buf.length) throw appError("ALIGN_NO_AUDIO");
      // An Int16Array over the bytes needs an even offset.
      if (buf.byteOffset % 2) buf = Buffer.from(buf);
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
      return { rate: PREVIEW_RATE, duration: pcm.length / PREVIEW_RATE, pcm };
    },
    // Where the reference starts in the target (see align.cjs).
    async alignRun(payload) {
      for (const f of [payload?.reference, payload?.target])
        if (typeof f !== "string" || !path.isAbsolute(f))
          throw appError("ALIGN_TRACKS_REQUIRED");
      await locate();
      const out = await start(
        payload.slot,
        {
          mode: "align",
          ffmpeg: engineInfo().ffmpeg,
          reference: payload.reference,
          target: payload.target,
        },
        ALIGN_TIMEOUT,
      );
      return JSON.parse(out.toString());
    },
    // Stops the tasks of these slots (a dialog that closed).
    alignCancel(payload) {
      for (const slot of Array.isArray(payload?.slots) ? payload.slots : [])
        slots.get(slot)?.cancel();
      return null;
    },
  };
  return {
    actions: {},
    queries,
    stopAll() {
      for (const t of slots.values()) t.cancel();
      for (const t of running) t.cancel();
    },
    // For tests: how many workers run now.
    runningCount: () => running.size,
  };
}
module.exports = { createAlignService, CANCELLED };
