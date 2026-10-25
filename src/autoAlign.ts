// "选择音频后自动对齐": once an audio file is chosen for a video (a merge,
// a replacement), line it up with the video's own sound when the match is
// clear. Returns what to tell the user when it was not applied ("" when it
// was). Errors stay here: a video without sound is not a failure of the
// page, so the window-wide error banner is not used.
import { localeRuntime, notification, t, errorMessage } from "./i18n";
import { serializeError } from "../locales/messages.mjs";
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
    if (!r.reliable) return notification("AUTO_ALIGN_LOW_CONFIDENCE");
    await apply(r.offset);
    return "";
  } catch (e) {
    return notification("AUTO_ALIGN_FAILED", {
      detail: errorMessage(e),
      error: serializeError(e),
    });
  }
}
// "+1.234 秒" / "-0.500 秒" for queue rows.
export const offsetText = (offset: number) =>
  t("media.offsetSeconds", {
    sign: offset >= 0 ? "+" : "",
    seconds: localeRuntime.number(offset, {
      useGrouping: false,
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    }),
  });

export const frameShiftText = (frames = 0) =>
  frames
    ? t("align.shiftSummary", {
        sign: frames > 0 ? "+" : "",
        frames: localeRuntime.number(frames, { useGrouping: false }),
      })
    : "";
