"use strict";
const trim = require("./trim.cjs");
const { appError } = require("./errors.cjs");
const { createTrimClips } = require("./trim-clips.cjs");
const { createTrimPreview } = require("./trim-preview.cjs");
const { createTrimExport } = require("./trim-export.cjs");
// Composition only. No application State, resource object or copied flags.
function createTrimQueue({
  getClips,
  setClips,
  isRunning,
  isSmart,
  setSmart,
  updateExport,
  engineInfo,
  isEncoding,
  isResourcesBusy,
  emit,
  emitProgress,
  locate,
  reorder,
}) {
  const clips = createTrimClips({
    getClips,
    setClips,
    isRunning,
    isSmart,
    setSmart,
    engineInfo,
    locate,
    emit,
    reorder,
    onUnusedFile(file) {
      trim.release(file);
      preview.release(file);
    },
  });
  const preview = createTrimPreview({
    engineInfo,
    requireClip: clips.requireClip,
    getIndex: clips.getIndex,
  });
  const exporting = createTrimExport({
    getClips,
    getIndex: clips.getIndex,
    engineInfo,
    isRunning,
    isEncoding,
    isResourcesBusy,
    isSmart,
    updateExport,
    emit,
    emitProgress,
  });
  const actions = {
    ...clips.actions,
    async trimExport(payload) {
      await exporting.start(payload || {});
    },
    async trimCancel(payload) {
      exporting.cancel();
    },
    async trimClear(payload) {
      if (isRunning()) throw appError("TRIM_CLEAR_BUSY");
      clips.dropClips([...getClips()]);
      updateExport({
        output: "",
        error: "",
        errorData: null,
        stage: "",
        progress: 0,
      });
    },
  };
  return {
    actions,
    queries: { trimFrame: preview.frame },
    stop() {
      exporting.cancel();
      preview.stop();
      clips.stop();
    },
  };
}
module.exports = { createTrimQueue };
