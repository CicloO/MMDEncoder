"use strict";
// Putting a finished output in place: the encoder writes to a temporary
// file beside the destination, which is then linked (or copied) to its real
// name without ever overwriting an existing file.
const fs = require("node:fs");

// Asynchronous, so copying a large file (no hard links on the volume) does
// not hold up the app while it runs.
async function commit(tmp, dest) {
  try {
    await fs.promises.link(tmp, dest);
  } catch (e) {
    if (!["ENOTSUP", "ENOSYS", "EPERM", "EXDEV", "EINVAL"].includes(e.code))
      throw e;
    // Removable exFAT/FAT volumes have no hard links. COPYFILE_EXCL still
    // refuses existing destinations; Node removes incomplete copies on error.
    await fs.promises.copyFile(tmp, dest, fs.constants.COPYFILE_EXCL);
  }
  await fs.promises.unlink(tmp);
}
module.exports = { commit };
