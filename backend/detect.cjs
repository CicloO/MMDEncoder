"use strict";
// Encoder detection: which encoders and bit depths run on this machine (real
// trial encodes), the FFmpeg capabilities checked alongside (libplacebo on
// Vulkan, NVENC lossless), and the cache that keeps the result until the
// tools or the display drivers change. Reads the tool paths through info()
// and writes only to the detection log (logs.text); the service puts the
// results into its state.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("./core.cjs");
const { createLimit } = require("./limit.cjs");

function createDetector({ run, dataDir, info, engines, logs }) {
  // Whether FFmpeg can run libplacebo on a Vulkan GPU (ArtCNN upscaling):
  // a tiny real run. Kept with the encoder detection (same FFmpeg, GPU and
  // driver); "重新检测" (force) always runs it again.
  let placeboCache = { key: "", value: false };
  async function hasLibplacebo(force = false) {
    const ff = info().ffmpeg;
    let key = ff;
    try {
      const st = fs.statSync(ff);
      key += "|" + st.size + "|" + st.mtimeMs;
    } catch {}
    if (!force && placeboCache.key === key) return placeboCache.value;
    let value = false;
    try {
      await run(
        ff,
        [
          "-hide_banner",
          "-v",
          "error",
          "-init_hw_device",
          "vulkan",
          "-f",
          "lavfi",
          "-i",
          "color=black:s=64x64:d=0.1",
          "-vf",
          "format=yuv444p16le,hwupload,libplacebo=w=128:h=128:format=yuv444p16le,hwdownload,format=yuv444p16le",
          "-f",
          "null",
          "-",
        ],
        { timeout: 20000 },
      );
      value = true;
    } catch {}
    placeboCache = { key, value };
    return value;
  }
  // Whether this machine's NVENC encodes lossless H.264 (the GPU Alpha
  // mask): a tiny real run, kept with the encoder detection like Vulkan.
  let nvencLosslessCache = { key: "", value: false };
  async function hasNvencLossless(force = false) {
    const ff = info().ffmpeg;
    let key = ff;
    try {
      const st = fs.statSync(ff);
      key += "|" + st.size + "|" + st.mtimeMs;
    } catch {}
    if (!force && nvencLosslessCache.key === key)
      return nvencLosslessCache.value;
    let value = false;
    try {
      await run(
        ff,
        [
          "-hide_banner",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=white:s=256x256:d=0.2",
          "-c:v",
          "h264_nvenc",
          "-preset",
          "p1",
          "-tune",
          "lossless",
          "-pix_fmt",
          "yuv420p",
          "-f",
          "null",
          "-",
        ],
        { timeout: 20000 },
      );
      value = true;
    } catch {}
    nvencLosslessCache = { key, value };
    return value;
  }
  // Detection runs real trial encodes, so its result is cached in dataDir and
  // reused until the tools, the display adapters/drivers or the engine list change.
  const cacheFile = () => path.join(dataDir, "engine-cache.json");
  async function displayAdapters() {
    const key =
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";
    const lines = [];
    for (const value of ["DriverDesc", "DriverVersion"]) {
      const { stdout } = await run("reg", ["query", key, "/s", "/v", value], {
        timeout: 10000,
      });
      lines.push(
        ...stdout
          .split(/\r?\n/)
          .filter((l) => /^\s+Driver(?:Desc|Version)\s/.test(l))
          .map((l) => l.trim().replace(/\s+/g, " ")),
      );
    }
    return lines.join("|");
  }
  async function detectionKey() {
    let gpu = "";
    try {
      gpu = await displayAdapters();
    } catch (e) {
      logs.text += "无法读取显卡信息，本次不使用检测缓存：" + e.message + "\n";
    }
    if (!gpu) return "";
    const files = {};
    for (const k of ["ffmpeg", "nvencc"]) {
      const exe = info()[k];
      if (!exe) continue;
      const st = fs.statSync(exe);
      files[k] = [exe, st.size, st.mtimeMs];
    }
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          gpu,
          files,
          engines: core.ENGINES.map((e) => [e.id, e.depths]),
        }),
      )
      .digest("hex");
  }
  function readDetectionCache(key) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
      if (c.key !== key || !Array.isArray(c.engines) || !c.engines.length)
        return null;
      const ids = new Set(core.ENGINES.map((e) => e.id));
      return c.engines.every((e) => ids.has(e.id)) ? c : null;
    } catch {
      return null;
    }
  }
  function writeDetectionCache(key, log) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = cacheFile() + "." + crypto.randomUUID() + ".tmp";
      fs.writeFileSync(
        tmp,
        JSON.stringify(
          {
            key,
            detectedAt: new Date().toISOString(),
            engines: engines(),
            libplacebo: !!info().libplacebo,
            nvencLossless: !!info().nvencLossless,
            log,
          },
          null,
          2,
        ),
      );
      fs.renameSync(tmp, cacheFile());
    } catch (e) {
      logs.text += "检测缓存保存失败：" + e.message + "\n";
    }
  }
  // A trial encode of every encoder FFmpeg lists (and NVEncC's), per bit
  // depth; found() gets each that works, progress() follows each encoder.
  async function trialEncoders({ listing, stopped, found, progress }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-detect-"));
    try {
      const fixture = path.join(dir, "probe.mkv");
      if (info().nvencc)
        await run(
          info().ffmpeg,
          [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=black:s=640x360:r=30:d=0.2",
            "-c:v",
            "ffv1",
            fixture,
          ],
          { timeout: 15000 },
        );
      const available = core.ENGINES.filter((e) =>
        e.backend === "nvencc"
          ? !!info().nvencc
          : new RegExp("\\b" + e.id + "\\b").test(listing),
      );
      const tryOne = async (e) => {
        if (stopped()) return;
        const depths = [];
        for (const depth of e.depths) {
          try {
            if (e.backend === "nvencc") {
              await run(
                info().nvencc,
                [
                  "--avsw",
                  "-i",
                  fixture,
                  "-o",
                  path.join(dir, e.codec + "-" + depth + ".mkv"),
                  "--codec",
                  e.codec,
                  "--output-depth",
                  String(depth),
                  "--output-csp",
                  "yuv420",
                  "--cqp",
                  "24",
                ],
                { timeout: 20000 },
              );
            } else {
              await run(
                info().ffmpeg,
                [
                  "-v",
                  "error",
                  "-f",
                  "lavfi",
                  "-i",
                  "color=black:s=640x360:r=30:d=0.2",
                  "-frames:v",
                  "3",
                  "-an",
                  "-c:v",
                  e.id,
                  "-pix_fmt",
                  e.codec === "prores"
                    ? "yuv422p10le"
                    : "yuv420p" + (depth === 10 ? "10le" : ""),
                  ...(e.id === "libsvtav1" ? ["-preset", "12"] : []),
                  "-f",
                  "null",
                  "-",
                ],
                { timeout: 20000 },
              );
            }
            depths.push(depth);
          } catch (err) {
            logs.text +=
              e.label + " " + depth + "-bit：" + err.message.slice(-800) + "\n";
          }
        }
        if (depths.length) {
          let alpha = false;
          if (e.id === "nvencc:hevc") {
            try {
              const source = path.join(dir, "alpha.mkv");
              await run(
                info().ffmpeg,
                [
                  "-v",
                  "error",
                  "-f",
                  "lavfi",
                  "-i",
                  "color=red:s=640x360:r=30:d=0.1,format=yuva444p,geq=a=128:lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)'",
                  "-c:v",
                  "ffv1",
                  source,
                ],
                { timeout: 15000 },
              );
              const output = path.join(dir, "alpha-hevc.mov");
              await run(
                info().nvencc,
                [
                  "--avsw",
                  "-i",
                  source,
                  "-o",
                  output,
                  "--codec",
                  "hevc",
                  "--output-depth",
                  "8",
                  "--output-csp",
                  "yuva420",
                  "--alpha-channel-mode",
                  "straight",
                  "--cqp",
                  "24",
                ],
                { timeout: 20000 },
              );
              const traced = await run(
                info().ffmpeg,
                [
                  "-i",
                  output,
                  "-map",
                  "0:v:0",
                  "-c",
                  "copy",
                  "-bsf:v",
                  "trace_headers",
                  "-f",
                  "null",
                  "-",
                ],
                { timeout: 15000 },
              );
              alpha =
                /Alpha Channel Information/.test(traced.stderr) &&
                /alpha_channel_bit_depth_minus8[^\n]*= 0/.test(traced.stderr);
            } catch (err) {
              logs.text += "HEVC Alpha：" + err.message.slice(-1000) + "\n";
            }
          }
          found({ ...e, depths, alpha });
        }
        progress();
      };
      // CPU encoders are tried 3 at a time beside the GPU ones, which go one
      // at a time (encode sessions, video memory); found() gets each as it
      // finishes.
      const cpu = createLimit(3);
      const gpu = async () => {
        for (const e of available.filter((e) => e.backend !== "cpu"))
          await tryOne(e);
      };
      await Promise.all([
        gpu(),
        ...available
          .filter((e) => e.backend === "cpu")
          .map((e) => cpu(() => tryOne(e))),
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return {
    hasLibplacebo,
    hasNvencLossless,
    detectionKey,
    readDetectionCache,
    writeDetectionCache,
    trialEncoders,
  };
}
module.exports = { createDetector };
