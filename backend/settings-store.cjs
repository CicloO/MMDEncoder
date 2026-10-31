"use strict";
// Owns settings.json I/O only. The service owns the persisted schema and state.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function createSettingsStore(dataDir) {
  const target = path.join(dataDir, "settings.json");
  return {
    read() {
      return JSON.parse(fs.readFileSync(target, "utf8"));
    },
    write(snapshot) {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = target + "." + crypto.randomUUID() + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
      fs.renameSync(tmp, target);
    },
  };
}
module.exports = { createSettingsStore };
