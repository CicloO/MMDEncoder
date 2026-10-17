const fs = require("node:fs"),
  path = require("node:path"),
  { execFileSync } = require("node:child_process"),
  { createTools } = require("../backend/tools.cjs");
const evidence = path.resolve(__dirname, "../verification"),
  root = process.env.MMD_TEST_TOOLS_ROOT || path.join(evidence, "tools-live");
(async () => {
  const tools = createTools({ root });
  await tools.run(false);
  const paths = tools.paths(),
    versions = {};
  for (const [name, exe] of Object.entries(paths))
    versions[name] = execFileSync(
      exe,
      [name === "nvencc" ? "--version" : "-version"],
      { encoding: "utf8", windowsHide: true, timeout: 15000 },
    ).split("\n")[0];
  if (!paths.ffmpeg || !paths.ffprobe || !paths.nvencc)
    throw Error("工具安装不完整");
  fs.writeFileSync(
    path.join(evidence, "tools-check.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        message: tools.state.message,
        installed: tools.state.installed,
        available: tools.state.available,
        paths,
        versions,
      },
      null,
      2,
    ),
  );
  console.log(tools.state.message, versions);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
