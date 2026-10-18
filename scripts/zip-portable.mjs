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
const archives = path.join(root, "release", "archives");
fs.mkdirSync(archives, { recursive: true });
const archive = path.join(archives, `MMDEncoder-${version}-win-x64.zip`);
if (fs.existsSync(archive)) {
  if (!process.argv.includes("--replace"))
    throw Error("发行 ZIP 已存在；确认要替换同版本的压缩包时加 --replace");
  fs.rmSync(archive);
  fs.rmSync(archive + ".sha256", { force: true });
}
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
execFileSync(
  path.join(root, "assets/7za.exe"),
  [
    "a",
    "-tzip",
    "-mx=1",
    archive,
    path.basename(folder) + path.sep,
    ...LOCAL.map((n) => "-x!" + path.join(path.basename(folder), n)),
  ],
  { cwd: path.dirname(folder), stdio: "inherit", windowsHide: true },
);
execFileSync(path.join(root, "assets/7za.exe"), ["t", archive], {
  stdio: "inherit",
  windowsHide: true,
});
const listed = execFileSync(
  path.join(root, "assets/7za.exe"),
  ["l", "-slt", archive],
  { encoding: "utf8", windowsHide: true },
);
const local = new RegExp(
  "^Path = [^\\\\/]+[\\\\/](?:" + LOCAL.map((n) => n.replace(".", "\\.")).join("|") + ")(?:[\\\\/]|$)",
  "m",
);
if (local.test(listed)) {
  fs.rmSync(archive);
  throw Error("压缩包意外包含本机 data 或 .update，已删除");
}
const hash = crypto.createHash("sha256");
for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
const sha256 = hash.digest("hex");
fs.writeFileSync(
  archive + ".sha256",
  sha256 + "  " + path.basename(archive) + "\n",
);
fs.mkdirSync(path.join(root, "verification"), { recursive: true });
fs.writeFileSync(
  path.join(root, "verification/archive.json"),
  JSON.stringify(
    {
      version,
      path: archive,
      size: fs.statSync(archive).size,
      sha256,
      enginesIncluded: false,
    },
    null,
    2,
  ),
);
console.log(archive, sha256);
