"use strict";
const { signature } = require("./enhancements.cjs");

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
    message: "正在用所选设置执行 RTX 试编码…",
  });
  emit();
  try {
    await check();
    onPatch({ verified: true, message: "所选 RTX 设置已通过本机试编码" });
  } catch (e) {
    const message =
      "RTX 验证失败：" +
      e.message +
      "。请检查驱动、NVIDIA VFX SDK 运行库与模型";
    onPatch({ message });
    onLog("\n" + message);
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
      status.message = "RTX 设置已更改，请重新验证本机设置";
  }
}
function invalidateTools(status) {
  status.verified = false;
  status.signature = "";
  status.message = "工具已重新检查，请重新验证 RTX 设置";
}
module.exports = { testEnhancements, invalidateSettings, invalidateTools };
