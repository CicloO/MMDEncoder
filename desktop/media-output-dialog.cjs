// Pure parameters for the media output picker. Main owns the native window,
// sender checks and the dialog result.
const { sourceText } = require("../backend/errors.cjs");
function mediaOutputDialogOptions(payload, text = sourceText) {
  const extensions = {
    wav: "wav",
    flac: "flac",
    aac: "m4a",
    opus: "opus",
    copy: "mka",
  };
  const ext =
    payload?.operation === "audio"
      ? extensions[payload.audioFormat] || "wav"
      : "mkv";
  return {
    title: text("dialog.output.pick"),
    defaultPath: "output." + ext,
    filters: [{ name: text("dialog.output.files"), extensions: [ext] }],
  };
}
module.exports = { mediaOutputDialogOptions };
