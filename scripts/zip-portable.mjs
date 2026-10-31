import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, ".."),
  folder = process.env.MMD_PACKAGE_DEST
    ? path.resolve(process.env.MMD_PACKAGE_DEST)
    : path.join(root, "release/MMDEncoder");
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json")),
).version;
// All release ZIPs live together in release/archives. Rebuilding a version that
// already has a ZIP needs --replace, so a published ZIP is never overwritten by accident.
const archives = process.env.MMD_ARCHIVE_DEST
  ? path.resolve(process.env.MMD_ARCHIVE_DEST)
  : path.join(root, "release", "archives");
fs.mkdirSync(archives, { recursive: true });
const archive = path.join(archives, `MMDEncoder-${version}-win-x64.zip`);
const appArchive = path.join(archives, `MMDEncoder-${version}-app.zip`);
const manifestFile = path.join(archives, `MMDEncoder-${version}-update.json`);
const outputs = [
  archive,
  archive + ".sha256",
  appArchive,
  appArchive + ".sha256",
  manifestFile,
];
if (
  outputs.some((file) => fs.existsSync(file)) &&
  !process.argv.includes("--replace")
)
  throw Error("发行文件已存在；确认要替换同版本的压缩包时加 --replace");
// Never zip a stale or half-built folder (e.g. after a failed package step).
const pkg = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(folder, "resources", "app", "package.json")),
    );
  } catch {
    return {};
  }
})();
if (
  pkg.version !== version ||
  !fs.existsSync(path.join(folder, "MMDEncoder.exe"))
)
  throw Error(
    `发行目录不是刚打好的 ${version}（目录内为 ${pkg.version || "未知"}），请先运行打包`,
  );
if (
  !/^\d+\.\d+\.\d+$/.test(pkg.electronVersion || "") ||
  pkg.electronVersion !==
    fs.readFileSync(path.join(folder, "version"), "utf8").trim()
)
  throw Error("发行目录的 Electron 版本记录与运行环境不一致，请重新打包");
// The user's data folder and an update in progress stay out of the ZIP.
const LOCAL = ["data", ".update"];
const names = [];
function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (dir === folder && LOCAL.includes(e.name)) continue;
    const file = path.join(dir, e.name);
    if (e.isDirectory()) scan(file);
    else names.push(file);
  }
}
scan(folder);
if (names.some((f) => /[\\/](?:ffmpeg|ffprobe|NVEncC(?:64)?)\.exe$/i.test(f)))
  throw Error("发行目录意外包含编码工具");
if (
  names.some((f) =>
    /[\\/](?:data|node_modules|runtime)[\\/]/i.test(path.relative(folder, f)),
  )
)
  throw Error("发行目录包含本机数据或开发依赖");
const staging = fs.mkdtempSync(path.join(archives, ".package-"));
if (path.dirname(path.resolve(staging)) !== archives)
  throw Error("Invalid staging path");
const seven = path.join(root, "assets/7za.exe");
const run = (args, cwd = staging) =>
  execFileSync(seven, args, { cwd, stdio: "inherit", windowsHide: true });
async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function tree(dir) {
  const result = {};
  async function walk(current) {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, e.name);
      if (e.isDirectory()) await walk(file);
      else result[path.relative(dir, file)] = await digest(file);
    }
  }
  await walk(dir);
  return result;
}
try {
  // A canonical root also makes isolated package destinations produce the
  // same archive layout as the release folder, without changing that folder.
  const canonical = path.join(staging, "MMDEncoder");
  fs.cpSync(folder, canonical, {
    recursive: true,
    filter: (source) =>
      !LOCAL.includes(path.relative(folder, source).split(path.sep)[0]),
  });
  for (const file of outputs) fs.rmSync(file, { force: true });
  run(["a", "-tzip", "-mx=1", archive, "MMDEncoder" + path.sep]);
  run(
    ["a", "-tzip", "-mx=1", appArchive, path.join("resources", "app")],
    canonical,
  );
  for (const zip of [archive, appArchive]) run(["t", zip]);
  const fullCheck = path.join(staging, "full-check"),
    appCheck = path.join(staging, "app-check");
  run(["x", "-y", "-o" + fullCheck, archive]);
  run(["x", "-y", "-o" + appCheck, appArchive]);
  const fullTree = await tree(
    path.join(fullCheck, "MMDEncoder", "resources", "app"),
  );
  const appTree = await tree(path.join(appCheck, "resources", "app"));
  if (JSON.stringify(fullTree) !== JSON.stringify(appTree))
    throw Error("两种包中的 resources/app 不一致");
  if (
    LOCAL.some((name) =>
      fs.existsSync(path.join(fullCheck, "MMDEncoder", name)),
    )
  )
    throw Error("压缩包意外包含本机 data 或 .update");
  const packages = {};
  for (const [kind, file] of [
    ["full", archive],
    ["app", appArchive],
  ]) {
    const sha256 = await digest(file);
    fs.writeFileSync(
      file + ".sha256",
      sha256 + "  " + path.basename(file) + "\n",
    );
    packages[kind] = {
      name: path.basename(file),
      size: fs.statSync(file).size,
      sha256,
    };
  }
  const manifest = {
    schemaVersion: 1,
    version,
    electronVersion: pkg.electronVersion,
    packages,
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  const report = process.env.MMD_ARCHIVE_DEST
    ? path.join(archives, "archive.json")
    : path.join(root, "verification/archive.json");
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(
    report,
    JSON.stringify(
      {
        ...manifest,
        path: archive,
        appPath: appArchive,
        appFiles: Object.keys(appTree).length,
        appTreesIdentical: true,
        enginesIncluded: false,
      },
      null,
      2,
    ),
  );
  console.log(manifestFile, JSON.stringify(packages));
} catch (error) {
  for (const file of outputs) fs.rmSync(file, { force: true });
  throw error;
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
