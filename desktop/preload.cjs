const { contextBridge, ipcRenderer, webUtils } = require("electron");
const allowed = new Set([
  "quit",
  "state",
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
contextBridge.exposeInMainWorld("encoder", {
  invoke(action, payload) {
    if (!allowed.has(action)) return Promise.reject(new Error("不支持的操作"));
    return ipcRenderer
      .invoke("encoder:action", action, payload)
      .catch((error) => {
        throw new Error(
          String(error.message).replace(
            /^Error invoking remote method '[^']+': Error: /,
            "",
          ),
        );
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
