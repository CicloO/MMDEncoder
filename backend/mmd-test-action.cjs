"use strict";
const { appError, serializeError, restoreError } = require("./errors.cjs");
async function testSelection({
  error,
  errorData,
  presetId,
  children,
  onResult,
}) {
  if (error) throw errorData ? restoreError(errorData) : Error(error);
  if (!presetId) throw appError("MMD_PRESET_REQUIRED");
  try {
    onResult(await require("./mmd-test.cjs").testExport(undefined, children));
  } catch (e) {
    onResult({
      ok: false,
      at: new Date().toISOString(),
      ...serializeError(e),
    });
    throw e;
  }
}

module.exports = { testSelection };
