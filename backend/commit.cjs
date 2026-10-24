"use strict";
// Putting a finished output in place: the encoder writes to a temporary
// file beside the destination, which is then linked (or copied) to its real
// name without ever overwriting an existing file.
const fs = require("node:fs");

function commit(tmp, dest) {
  try {
    fs.linkSync(tmp, dest);
  } catch (e) {
    if (!["ENOTSUP", "ENOSYS", "EPERM", "EXDEV", "EINVAL"].includes(e.code))
      throw e;
    // Removable exFAT/FAT volumes have no hard links. COPYFILE_EXCL still
    // refuses existing destinations; Node removes incomplete copies on error.
    fs.copyFileSync(tmp, dest, fs.constants.COPYFILE_EXCL);
  }
  fs.unlinkSync(tmp);
}
module.exports = { commit };
