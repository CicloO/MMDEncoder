"use strict";
const { signature } = require("./enhancements.cjs");
const { summary, serializeError, diagnosticMessage } = require("./errors.cjs");
const statusMessage = (code, params) => {
  const messageData = summary(code, params);
  return { message: messageData.message, messageData };
};

// The service owns the result and log. This operation only receives the
// selected settings, the probe operation and explicit status/log callbacks.
async function testEnhancements({
  settings,
  check,
  onStart,
  onPatch,
  onLog,
  emit,
}) {
  onStart({
    busy: true,
    signature: signature(settings),
    verified: false,
    errorData: undefined,
    ...statusMessage("RTX_CHECKING"),
  });
  emit();
  try {
    await check();
    onPatch({ verified: true, ...statusMessage("RTX_VERIFIED") });
  } catch (e) {
    const result = statusMessage("RTX_FAILED", {
      detail: diagnosticMessage(e),
    });
    onPatch({ ...result, errorData: serializeError(e) });
    onLog("\n" + result.message);
    throw e;
  } finally {
    onPatch({ busy: false });
    emit();
  }
}

function invalidateSettings(status, settings) {
  if (status.signature !== signature(settings)) {
    status.verified = false;
    if (settings.vsr || settings.vfg)
      Object.assign(status, statusMessage("RTX_SETTINGS_CHANGED"));
  }
}
function invalidateTools(status) {
  status.verified = false;
  status.signature = "";
  Object.assign(status, statusMessage("RTX_TOOLS_CHANGED"));
}
module.exports = { testEnhancements, invalidateSettings, invalidateTools };
