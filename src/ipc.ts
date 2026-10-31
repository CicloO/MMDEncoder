import { errorMessage } from "./i18n";

// Migrated callers construct their Error on the renderer side so code/params
// survive Electron's IPC and contextBridge boundaries.
export async function invoke(action: string, payload?: unknown) {
  const result = await window.encoder.invokeResult(action, payload);
  if (result?.__mmdError) {
    const error = result.__mmdError;
    throw Object.assign(new Error(errorMessage(error)), {
      code: error.code,
      params: error.params,
      issues: error.issues,
    });
  }
  return result;
}
