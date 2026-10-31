import { formatDescriptor } from "./messages.mjs";

const parameters = new Set([
  "codec_name",
  "profile",
  "level",
  "width",
  "height",
  "pix_fmt",
  "sample_aspect_ratio",
  "field_order",
  "color_range",
  "color_space",
  "color_primaries",
  "color_transfer",
  "time_base",
  "r_frame_rate",
  "extradata",
  "rotation",
]);

export function formatTrimDifferences(runtime, differences) {
  return differences
    .map((d) =>
      runtime.t(
        d.key === "extradata"
          ? "trim.compatibility.sets"
          : "trim.compatibility.value",
        {
          ...d,
          field: parameters.has(d.key)
            ? runtime.t(`trim.parameter.${d.key}`)
            : d.key,
        },
      ),
    )
    .join(runtime.t("trim.listSeparator"));
}

// Reasons remain structured until display time; source diagnostics and unknown
// external messages stay available without matching translated text.
export function formatTrimMessage(runtime, value) {
  if (!value || typeof value === "string") return undefined;
  if (
    value.code === "TRIM_JOIN_MISMATCH" &&
    Array.isArray(value.params?.differences)
  )
    return runtime.t("error.TRIM_JOIN_MISMATCH", {
      detail: formatTrimDifferences(runtime, value.params.differences),
    });
  if (
    ["TRIM_UNSAFE_IN", "TRIM_UNSAFE_OUT"].includes(value.code) &&
    value.params?.reason
  )
    return runtime.t(`error.${value.code}`, {
      ...value.params,
      detail: formatDescriptor(runtime, "error", value.params.reason),
    });
  if (
    value.code === "TRIM_REENCODE_MISMATCH" &&
    Array.isArray(value.params?.differences)
  )
    return runtime.t(`error.${value.code}`, {
      detail: value.params.differences
        .map((d) => formatDescriptor(runtime, "error", d))
        .join(runtime.t("trim.listSeparator")),
    });
  return undefined;
}
