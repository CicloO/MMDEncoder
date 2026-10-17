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
const archive = path.join(root, "release", `MMDEncoder-${version}-win-x64.zip`);
if (fs.existsSync(archive))
  throw Error("发行 ZIP 已存在，请先选择新版本或保留旧文件后再构建");
const names = [];
function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
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
  ["a", "-tzip", "-mx=1", archive, path.basename(folder) + path.sep],
  { cwd: path.dirname(folder), stdio: "inherit", windowsHide: true },
);
execFileSync(path.join(root, "assets/7za.exe"), ["t", archive], {
  stdio: "inherit",
  windowsHide: true,
});
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
