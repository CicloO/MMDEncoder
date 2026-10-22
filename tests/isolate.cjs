// Every service a test creates writes the MMD plugin's settings to
// %LOCALAPPDATA%\MMDEncoder\mmd-plugin (mmd-export.json, mmd-selection.json):
// point LOCALAPPDATA at a scratch folder so the user's real plugin keeps its
// settings. The tools already installed there stay in use through
// MMD_TEST_TOOLS_ROOT. Tests that need their own folder still set it.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (!process.env.MMD_TEST_ISOLATED) {
  const real =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const tools = path.join(real, "MMDEncoder", "tools");
  if (!process.env.MMD_TEST_TOOLS_ROOT && fs.existsSync(tools))
    process.env.MMD_TEST_TOOLS_ROOT = tools;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-local-"));
  process.env.LOCALAPPDATA = scratch;
  process.env.MMD_TEST_ISOLATED = scratch;
  process.on("exit", () => {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {}
  });
}
