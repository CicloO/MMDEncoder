const { contextBridge, ipcRenderer, webUtils } = require("electron");
const allowed = new Set([
  "quit",
  "state",
  "setLocale",
  "setTheme",
  "setAutoAlignAudio",
  "pickToolsArchive",
  "installToolsArchive",
  "compatibility",
  "testEnhancements",
  "mediaStart",
  "mediaSuggest",
  "mediaAdd",
  "mediaSetAudio",
  "trimAdd",
  "trimRemove",
  "trimDuplicate",
  "trimReorder",
  "trimSet",
  "trimFrame",
  "trimExport",
  "trimSmart",
  "trimCancel",
  "trimClear",
  "mediaLog",
  "mediaRemove",
  "mediaClearCompleted",
  "mediaRequeue",
  "hidePreset",
  "reorderPresets",
  "restoreBuiltinPresets",
  "resolvePresetConflict",
  "reorderJobs",
  "setSequenceFps",
  "mediaReorder",
  "mediaSetAlign",
  "mediaSetAudioOffset",
  "setAudioOffset",
  "alignPreview",
  "alignReferenceInfo",
  "alignRun",
  "alignCancel",
  "mmdStatus",
  "mmdInstall",
  "mmdUninstall",
  "mmdExportSet",
  "mmdTest",
  "mmdRecover",
  "mmdDiscard",
  "setToolsRoot",
  "details",
  "pickMedia",
  "pickMediaOutput",
  "detect",
  "checkTools",
  "installTools",
  "add",
  "remove",
  "setAudio",
  "setJobSettings",
  "clearCompleted",
  "settings",
  "start",
  "cancel",
  "retry",
  "requeue",
  "appVersion",
  "checkAppUpdate",
  "openReleasePage",
  "aboutInfo",
  "openProjectPage",
  "appUpdateStatus",
  "downloadAppUpdate",
  "installAppUpdate",
  "savePreset",
  "applyPreset",
  "deletePreset",
  "renamePreset",
  "preview",
  "logs",
  "pickFiles",
  "pickDirectory",
  "importPresetsFile",
  "exportPresetsFile",
  "copyCommand",
  "reveal",
  "engineFolder",
  "openDataFolder",
  "mmdOpenLog",
  "mmdOpenLatest",
]);
const initialTheme = process.argv.includes("--mmd-theme=dark")
  ? "dark"
  : "light";
const applyInitialTheme = () => {
  if (!document.documentElement) return false;
  document.documentElement.dataset.theme = initialTheme;
  return true;
};
if (!applyInitialTheme()) {
  const observer = new MutationObserver(() => {
    if (applyInitialTheme()) observer.disconnect();
  });
  observer.observe(document, { childList: true });
}
contextBridge.exposeInMainWorld("encoder", {
  initialTheme,
  // Structured replies cross contextBridge as plain data. Custom properties
  // on a rejected Error do not reliably survive that second Electron boundary.
  invokeResult(action, payload) {
    if (!allowed.has(action))
      return Promise.resolve({
        __mmdError: {
          code: "DESKTOP_ACTION_UNSUPPORTED",
          params: {},
          message: "Unsupported action",
        },
      });
    return ipcRenderer.invoke("encoder:action", action, payload);
  },
  invoke(action, payload) {
    if (!allowed.has(action))
      return Promise.reject(new Error("Unsupported action"));
    return ipcRenderer
      .invoke("encoder:action", action, payload)
      .then((result) => {
        if (result?.__mmdError) {
          const { message, code, params, issues } = result.__mmdError;
          throw Object.assign(new Error(message), { code, params, issues });
        }
        return result;
      })
      .catch((error) => {
        error.message = String(error.message).replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        );
        throw error;
      });
  },
  onCloseRequest(fn) {
    const cb = () => fn();
    ipcRenderer.on("encoder:close-request", cb);
    return () => ipcRenderer.removeListener("encoder:close-request", cb);
  },
  onUpdate(fn) {
    const cb = (_event, state) => fn(state);
    ipcRenderer.on("encoder:state", cb);
    return () => ipcRenderer.removeListener("encoder:state", cb);
  },
  getPaths(files) {
    return files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
  },
});
