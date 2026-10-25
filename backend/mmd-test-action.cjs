"use strict";
async function testSelection({ error, presetId, children, onResult }) {
  if (error) throw Error(error);
  if (!presetId) throw Error("请先选择导出预设");
  try {
    onResult(await require("./mmd-test.cjs").testExport(undefined, children));
  } catch (e) {
    onResult({
      ok: false,
      at: new Date().toISOString(),
      message: e.message,
    });
    throw e;
  }
}

module.exports = { testSelection };
