// "选择音频后自动对齐": once an audio file is chosen for a video (a merge,
// a replacement), line it up with the video's own sound when the match is
// clear. Returns what to tell the user when it was not applied ("" when it
// was). Errors stay here: a video without sound is not a failure of the
// page, so the window-wide error banner is not used.
import { errorMessage } from "./i18n";
import { invoke } from "./ipc";
export async function autoAlign(
  video: string,
  audio: string,
  apply: (offset: number) => Promise<unknown>,
) {
  try {
    const r = await invoke("alignRun", {
      reference: video,
      target: audio,
    });
    if (!r.reliable) return "自动对齐可信度低，未应用；可点波形按钮检视对齐";
    await apply(r.offset);
    return "";
  } catch (e) {
    return "没有自动对齐：" + errorMessage(e);
  }
}
// "+1.234 秒" / "-0.500 秒" for queue rows.
export const offsetText = (offset: number) =>
  `${offset >= 0 ? "+" : ""}${offset.toFixed(3)} 秒`;
