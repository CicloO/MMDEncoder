import { formatDescriptor } from "./messages.mjs";

// Reasons remain structured until display time; source diagnostics and unknown
// external messages stay available without matching translated text.
export function formatTrimMessage(runtime, value) {
  if (!value || typeof value === "string") return undefined;
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
