import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const dest = process.env.MMD_PACKAGE_DEST
  ? path.resolve(process.env.MMD_PACKAGE_DEST)
  : path.resolve(root, "release/MMDEncoder");
const version = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
).version;
// The latest build always lives in release/MMDEncoder and replaces the previous
// one (old versions are kept only as ZIPs in release/archives). The user's data
// folder there is moved aside during the build and put back afterwards.
const keep = path.join(path.dirname(dest), ".data-keep");
let keptData = false;
// Builds before the rename shipped "MMD Encoder.exe"; both names count as ours.
const EXE_NAMES = ["MMDEncoder.exe", "MMD Encoder.exe"];
async function replacePrevious() {
  for (const name of EXE_NAMES) {
    const running = execFileSync(
      "tasklist",
      ["/FI", `IMAGENAME eq ${name}`, "/NH"],
      { encoding: "utf8", windowsHide: true },
    );
    if (running.includes(name))
      throw new Error("MMDEncoder 正在运行，请先关闭再打包");
  }
  const entries = await fs.readdir(dest);
  // An empty folder (or one holding only data) is fine; anything else must be our build.
  if (
    entries.some((n) => n !== "data" && n !== ".update") &&
    !entries.some((n) => EXE_NAMES.includes(n))
  )
    throw new Error("发行目录不是 MMDEncoder 便携版，请手动处理：" + dest);
  try {
    await fs.access(keep);
    throw new Error("上次打包保留的数据还在，请先处理：" + keep);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await fs.rename(path.join(dest, "data"), keep);
    keptData = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // Empty the folder instead of removing it: an Explorer window showing it keeps
  // the folder itself locked, but not its contents.
  for (const name of await fs.readdir(dest))
    await fs.rm(path.join(dest, name), {
      recursive: true,
      force: true,
      maxRetries: 5,
    });
}
try {
  await fs.access(dest);
  if (process.env.MMD_PACKAGE_DEST)
    throw new Error("发行目录已存在，请选择新的空路径");
  await replacePrevious();
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
  path.join(dest, "MMDEncoder.exe"),
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
// MMD export plugin DLL (built by mmd-plugin/build.cmd with VS Build Tools).
const pluginDll = path.join(
  root,
  "mmd-plugin",
  "build",
  "MMDEncoderPlugin.dll",
);
try {
  await fs.access(pluginDll);
} catch {
  throw new Error(
    "缺少 MMD 导出插件，请先运行 mmd-plugin\\build.cmd：" + pluginDll,
  );
}
await fs.mkdir(path.join(appDir, "mmd-plugin"), { recursive: true });
await fs.copyFile(
  pluginDll,
  path.join(appDir, "mmd-plugin", "MMDEncoderPlugin.dll"),
);
await fs.writeFile(
  path.join(appDir, "package.json"),
  JSON.stringify({
    name: "mmd-encoder",
    version,
    main: "desktop/main.cjs",
  }),
);
// Electron's release files carry the ZIP epoch (1980-01-01) as their date;
// stamp every packaged file with the build time instead.
const builtAt = new Date();
async function touch(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await touch(file);
    await fs.utimes(file, builtAt, builtAt);
  }
}
await touch(dest);
if (keptData) {
  await fs.rename(keep, path.join(dest, "data"));
  console.log("User data kept:", path.join(dest, "data"));
}
console.log("Portable app:", path.join(dest, "MMDEncoder.exe"));
