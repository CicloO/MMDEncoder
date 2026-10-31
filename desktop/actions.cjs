// Shared IPC boundary for renderer actions.
const { serializeError } = require("../backend/errors.cjs");
function registerAction(ipcMain, handler) {
  // Electron strips custom Error properties when rejecting an invoke. Carry
  // them as data, and recreate the Error in preload for existing consumers.
  ipcMain.handle("encoder:action", async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return {
        __mmdError: serializeError(error),
      };
    }
  });
}
module.exports = { registerAction };
