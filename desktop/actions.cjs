// Shared IPC boundary for renderer actions.
function registerAction(ipcMain, handler) {
  // Electron strips custom Error properties when rejecting an invoke. Carry
  // them as data, and recreate the Error in preload for existing consumers.
  ipcMain.handle("encoder:action", async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return {
        __mmdError: {
          message: String(error?.message ?? error),
          ...(typeof error?.code === "string" ? { code: error.code } : {}),
          ...(error?.params ? { params: error.params } : {}),
        },
      };
    }
  });
}
module.exports = { registerAction };
