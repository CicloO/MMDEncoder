// Pure parameters for the media output picker. Main owns the native window,
// sender checks and the dialog result.
function mediaOutputDialogOptions(payload) {
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
    title: "选择新的输出文件",
    defaultPath: "output." + ext,
    filters: [{ name: "输出文件", extensions: [ext] }],
  };
}
module.exports = { mediaOutputDialogOptions };
