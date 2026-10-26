"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const trim = require("./trim.cjs"),
  media = require("./media.cjs");
const { containerFor } = trim;
const { appError, serializeError, sourceText, stage } = require("./errors.cjs");
const { formatTrimDifferences } = require("../locales/trim-messages.mjs");

// Naming only: the queue chooses the first ready clip and supplies its
// filesystem collision check. No queue, application state or output writes.
function trimOutputPath(first, o, exists) {
  let dir = path.dirname(first.path);
  if (o.location === "encoded") dir = path.join(dir, "Encoded");
  if (o.location === "custom") {
    if (typeof o.outputDir !== "string" || !path.isAbsolute(o.outputDir))
      throw appError("TRIM_OUTPUT_DIR_INVALID");
    dir = o.outputDir;
  }
  let ext = containerFor(first.codec);
  if (o.audio?.mode !== "none" && o.audio?.codec === "pcm" && ext === "mp4")
    ext = "mkv";
  const base = path.parse(first.path).name + "_trimmed";
  for (let n = 1; n < 100000; n++) {
    const out = path.join(dir, base + (n === 1 ? "" : ` (${n})`) + "." + ext);
    if (!exists(out)) return out;
  }
  throw appError("TRIM_OUTPUT_NAME_FAILED");
}

// Owns one export's controller and transaction; the shared flags and UI
// fields have one owner in the service, reached through narrow callbacks.
function createTrimExport({
  getClips,
  getIndex,
  engineInfo,
  isRunning,
  isEncoding,
  isResourcesBusy,
  isSmart,
  updateExport,
  emit,
  emitProgress,
}) {
  let trimAbort = null;
  async function trimExport(o) {
    if (isRunning()) throw appError("TRIM_ALREADY_EXPORTING");
    if (isEncoding()) throw appError("TRIM_ENCODING_BUSY");
    if (isResourcesBusy()) throw appError("TRIM_RESOURCES_BUSY");
    const clips = getClips().filter((c) => c.status === "ready" && !c.empty);
    if (!clips.length) throw appError("TRIM_NO_EXPORTABLE_CLIPS");
    if (getClips().some((c) => c.status === "indexing"))
      throw appError("TRIM_INDEXING_BUSY");
    const files = [...new Set(clips.map((c) => c.path))];
    if (files.length > 1) {
      const diffs = await trim.compatibility(engineInfo(), files);
      if (diffs.length) {
        const name = (i) => path.basename(files[i]);
        const differences = diffs
          .slice(0, 4)
          .map((d) => ({ ...d, name: name(d.part - 1), reference: name(0) }));
        throw appError("TRIM_JOIN_MISMATCH", {
          differences,
          detail: formatTrimDifferences({ t: sourceText }, differences),
        });
      }
    }
    const audio = {
      mode: ["reencode", "replace", "none"].includes(o.audio?.mode)
        ? o.audio.mode
        : "reencode",
      codec: ["aac", "flac", "pcm"].includes(o.audio?.codec)
        ? o.audio.codec
        : "aac",
      kbps: Number(o.audio?.kbps) || 320,
      file: o.audio?.file,
      offset: Number(o.audio?.offset) || 0,
      fade: media.FADES.includes(Number(o.audio?.fade))
        ? Number(o.audio.fade)
        : 0,
    };
    const output = trimOutputPath(
      getClips().find((c) => c.status === "ready"),
      { ...o, audio },
      fs.existsSync,
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    trimAbort = new AbortController();
    const startedAt = Date.now();
    updateExport({
      running: true,
      progress: 0,
      stage: stage("trim_preparing"),
      output,
      error: "",
      errorData: null,
      elapsed: undefined,
    });
    emit();
    (async () => {
      try {
        await trim.cut(
          engineInfo(),
          clips.map((c) => ({
            file: c.path,
            idx: getIndex(c.id),
            from: c.from,
            to: c.to,
          })),
          output,
          {
            audio,
            smart: isSmart(),
            signal: trimAbort.signal,
            onPart: (i, n) => {
              updateExport({
                progress: Math.round(
                  (i / (n + (audio.mode === "none" ? 0 : 1))) * 100,
                ),
                stage: stage("trim_copying_segment", { current: i, total: n }),
              });
              emitProgress();
            },
          },
        );
        updateExport({
          progress: 100,
          stage: stage("trim_completed"),
          elapsed: (Date.now() - startedAt) / 1000,
        });
      } catch (e) {
        fs.rmSync(output, { force: true });
        updateExport({
          stage: stage(e.cancelled ? "trim_cancelled" : "trim_failed"),
          error: e.cancelled ? "" : e.message,
          errorData: e.cancelled ? null : serializeError(e),
          output: "",
        });
      } finally {
        updateExport({ running: false });
        trimAbort = null;
        emit();
      }
    })();
  }

  return {
    start: trimExport,
    cancel() {
      trimAbort?.abort();
    },
  };
}
module.exports = { createTrimExport, trimOutputPath };
