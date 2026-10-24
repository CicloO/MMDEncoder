// Shared IPC boundary for renderer actions.
function registerAction(ipcMain, handler) {
  ipcMain.handle("encoder:action", handler);
}
module.exports = { registerAction };
