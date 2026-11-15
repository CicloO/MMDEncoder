// The FFmpeg that ships inside the release (resources/ffmpeg): gyan.dev's
// full_build-shared, pinned in ffmpeg-bundle.json. Same features as the full
// build (x264/x265/SVT-AV1/VP9/libplacebo/soxr/NVENC) with one shared set of
// DLLs, and without ffplay and the docs. Update it on purpose, when a new
// feature needs a newer FFmpeg: change the pin, then package and test.
//
// Run alone to fill the cache, or import bundleFfmpeg() from package.mjs.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
const root = path.resolve(import.meta.dirname, "..");
const pin = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "ffmpeg-bundle.json"), "utf8"),
);
const cache = path.join(root, ".cache", "ffmpeg-bundle");

const sha256 = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function archive() {
  const file = path.join(cache, path.basename(new URL(pin.url).pathname));
  if (fs.existsSync(file) && sha256(file) === pin.sha256) return file;
  fs.mkdirSync(cache, { recursive: true });
  const response = await fetch(pin.url, {
    headers: { "User-Agent": "MMDEncoder-build" },
  });
  if (!response.ok) throw new Error(`FFmpeg 下载失败：HTTP ${response.status}`);
  const partial = file + ".part";
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(partial),
  );
  if (sha256(partial) !== pin.sha256)
    throw new Error("FFmpeg 校验失败（SHA-256 与 ffmpeg-bundle.json 不符）");
  fs.renameSync(partial, file);
  return file;
}

// Copy the bundle into dir (resources/ffmpeg of a packaged app).
export async function bundleFfmpeg(dir) {
  const file = await archive();
  const unpacked = path.join(cache, "unpacked-" + pin.version);
  if (!fs.existsSync(path.join(unpacked, ".complete"))) {
    fs.rmSync(unpacked, { recursive: true, force: true });
    execFileSync(
      path.join(root, "assets", "7za.exe"),
      ["x", "-y", "-o" + unpacked, file],
      { windowsHide: true, stdio: "ignore" },
    );
    fs.writeFileSync(path.join(unpacked, ".complete"), "");
  }
  const [top] = fs
    .readdirSync(unpacked)
    .filter((n) => fs.statSync(path.join(unpacked, n)).isDirectory());
  const bin = path.join(unpacked, top, "bin");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const files = fs
    .readdirSync(bin)
    .filter((n) => /^(ffmpeg|ffprobe)\.exe$|\.dll$/i.test(n));
  for (const n of ["ffmpeg.exe", "ffprobe.exe"])
    if (!files.includes(n)) throw new Error("FFmpeg 包里缺少 " + n);
  for (const n of files) fs.copyFileSync(path.join(bin, n), path.join(dir, n));
  // Upstream license and build notes (configuration, source links).
  fs.copyFileSync(
    path.join(unpacked, top, "LICENSE"),
    path.join(dir, "LICENSE"),
  );
  fs.copyFileSync(
    path.join(unpacked, top, "README.txt"),
    path.join(dir, "README.txt"),
  );
  fs.writeFileSync(
    path.join(dir, "version.json"),
    JSON.stringify(pin, null, 2) + "\n",
  );
  return pin;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const out = path.join(cache, "preview");
  const result = await bundleFfmpeg(out);
  console.log("FFmpeg", result.version, "→", out);
}
