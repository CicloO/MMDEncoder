import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const dest = process.env.MMD_PACKAGE_DEST
  ? path.resolve(process.env.MMD_PACKAGE_DEST)
  : path.resolve(root, "release/MMDEncoder");
const version = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
).version;
// The latest build always lives in release/MMDEncoder; an older build found there is
// kept beside it as release/MMDEncoder-<its version>.
async function archivePrevious() {
  let previous;
  try {
    previous = JSON.parse(
      await fs.readFile(
        path.join(dest, "resources", "app", "package.json"),
        "utf8",
      ),
    ).version;
  } catch {
    throw new Error("无法识别发行目录中的版本，请手动处理：" + dest);
  }
  if (previous === version)
    throw new Error(
      `发行目录已是 ${version}，请先提升 package.json 版本号再打包`,
    );
  const archived = path.join(path.dirname(dest), "MMDEncoder-" + previous);
  try {
    await fs.access(archived);
    throw new Error("旧版本目录已存在：" + archived);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.rename(dest, archived);
  console.log("Previous build kept at:", archived);
}
try {
  await fs.access(dest);
  if (process.env.MMD_PACKAGE_DEST)
    throw new Error("发行目录已存在，请选择新的空路径");
  await archivePrevious();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await fs.mkdir(dest, { recursive: true });
const electronExe = require("electron");
const electronDir = path.dirname(electronExe);
await fs.cp(electronDir, dest, {
  recursive: true,
  filter: (source) =>
    !source.endsWith("resources" + path.sep + "default_app.asar"),
});
await fs.rename(
  path.join(dest, "electron.exe"),
  path.join(dest, "MMD Encoder.exe"),
);
const appDir = path.join(dest, "resources", "app");
for (const [from, to] of [
  ["README.md", "README.md"],
  ["docs/CHANGELOG.md", "CHANGELOG.md"],
  ["docs/THIRD-PARTY-NOTICES.md", "THIRD-PARTY-NOTICES.md"],
])
  await fs.copyFile(path.join(root, from), path.join(dest, to));
await fs.mkdir(appDir, { recursive: true });
const generatedDist = path.resolve(appDir, "dist");
if (
  generatedDist !== path.join(appDir, "dist") ||
  !generatedDist.startsWith(dest + path.sep)
)
  throw new Error("Invalid generated path");
await fs.rm(generatedDist, { recursive: true, force: true });
for (const name of ["desktop", "backend", "dist", "assets"])
  await fs.cp(path.join(root, name), path.join(appDir, name), {
    recursive: true,
  });
await fs.writeFile(
  path.join(appDir, "package.json"),
  JSON.stringify({
    name: "mmd-encoder",
    version,
    main: "desktop/main.cjs",
  }),
);
console.log("Portable app:", path.join(dest, "MMD Encoder.exe"));
