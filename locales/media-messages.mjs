import { formatDescriptor } from "./messages.mjs";

// Media wrappers retain the underlying error until display time. The source
// message remains a diagnostic fallback; an unknown external detail stays exact.
export function formatMediaMessage(runtime, namespace, value) {
  const codes =
    namespace === "error"
      ? ["MEDIA_META_FAILED"]
      : ["AUTO_ALIGN_FAILED", "MEDIA_BATCH_FAILED"];
  if (!codes.includes(value?.code) || !value.params?.error) return undefined;
  return runtime.t(`${namespace}.${value.code}`, {
    detail: formatDescriptor(runtime, "error", value.params.error),
  });
}
