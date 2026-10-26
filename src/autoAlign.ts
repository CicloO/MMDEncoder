import { localeRuntime, t } from "./i18n";
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
