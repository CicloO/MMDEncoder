// Serializable contracts shared by Node, helpers and the renderer. Formatting
// belongs to the display layer; a stored fallback is never reverse-translated.
export function messageDescriptor(code, params = {}, message = "") {
  return { code, params, message };
}

export function stageDescriptor(stage, params = {}) {
  return { stage, params };
}

export function serializeError(error) {
  return {
    message: String(error?.message ?? error),
    ...(typeof error?.code === "string" ? { code: error.code } : {}),
    params: error?.params || {},
    ...(Array.isArray(error?.issues)
      ? { issues: error.issues.map(serializeError) }
      : {}),
  };
}

export function restoreError(data) {
  return Object.assign(new Error(data.message), data);
}

export function formatDescriptor(runtime, namespace, value) {
  if (typeof value === "string") return value;
  const id = namespace === "stage" ? value?.stage : value?.code;
  const key = `${namespace}.${id}`;
  return runtime.has(key)
    ? runtime.t(key, value?.params)
    : String(value?.message || id || "");
}
