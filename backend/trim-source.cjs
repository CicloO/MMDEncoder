"use strict";
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { run } = require("./trim-probe.cjs");

// H.264 / HEVC outside MP4 / MOV: the same packets copied into an MP4, which
// gives exact packet positions (index) and reliable seeking (cut). Kept per
// source (path, size, date) for the session, so indexing and exporting copy
// the stream once; release() / clearCache() remove them.
const remuxCache = new Map();
// key -> { file, promise }
const cacheDir = () => path.join(os.tmpdir(), "mmdencoder-trim-cache");

function sourceKey(file) {
  const st = fs.statSync(file);
  return `${path.resolve(file).toLowerCase()}|${st.size}|${st.mtimeMs}`;
}

function needsRemux(file, codec) {
  return (
    (codec === "h264" || codec === "hevc") &&
    ![".mp4", ".mov", ".m4v"].includes(path.extname(file).toLowerCase())
  );
}

async function remuxed(tools, file, signal) {
  const key = sourceKey(file);
  let entry = remuxCache.get(key);
  if (!entry) {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const out = path.join(
      cacheDir(),
      require("node:crypto")
        .createHash("sha1")
        .update(key)
        .digest("hex")
        .slice(0, 16) + ".mp4",
    );
    entry = {
      file: out,
      promise: (async () => {
        fs.rmSync(out, { force: true });
        await run(
          tools.ffmpeg,
          [
            "-v",
            "error",
            "-i",
            file,
            "-map",
            "0:v:0",
            "-c",
            "copy",
            "-f",
            "mp4",
            out,
          ],
          { signal },
        );
        return out;
      })(),
    };
    remuxCache.set(key, entry);
    entry.promise.catch(() => {
      remuxCache.delete(key);
      fs.rmSync(out, { force: true });
    });
  }
  return entry.promise;
}

function release(file) {
  for (const [key, entry] of remuxCache)
    if (key.startsWith(path.resolve(file).toLowerCase() + "|")) {
      remuxCache.delete(key);
      entry.promise
        .finally(() => fs.rmSync(entry.file, { force: true }))
        .catch(() => {});
    }
}

function clearCache() {
  for (const [, entry] of remuxCache)
    entry.promise
      .finally(() => fs.rmSync(entry.file, { force: true }))
      .catch(() => {});
  remuxCache.clear();
}
module.exports = { needsRemux, remuxed, release, clearCache };
