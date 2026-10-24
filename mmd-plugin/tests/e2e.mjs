// End-to-end test of the MMD export plugin without MMD: mmd-sim.exe plays MMD's
// part (windows, open AVI, DMO calls); the plugin plans with MMDEncoder.exe in
// Node mode, encodes with FFmpeg, and the finish step cuts the project's WAV.
// Usage: node mmd-plugin/tests/e2e.mjs [path to MMDEncoder.exe]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const core = require(path.join(root, "backend/core.cjs"));
// engines.cjs isolates ordinary service tests. This DLL instead uses Windows'
// known folder, so this one integration test must restore the actual location.
const localAppData = process.env.LOCALAPPDATA;
const { ff, fp, nv } = require(path.join(root, "tests/engines.cjs"));
process.env.LOCALAPPDATA = localAppData;
const appExe = path.resolve(
  process.argv[2] || path.join(root, "release/MMDEncoder/MMDEncoder.exe"),
);
const build = path.join(root, "mmd-plugin/build");
const pluginDir = path.join(
  process.env.LOCALAPPDATA,
  "MMDEncoder",
  "mmd-plugin",
);
const configPath = path.join(pluginDir, "mmd-export.json");
const historyPath = path.join(pluginDir, "exports.jsonl");
const selectionPath = path.join(pluginDir, "mmd-selection.json");
for (const image of ["MMDEncoder.exe", "MikuMikuDance.exe"]) {
  const running = execFileSync(
    "tasklist",
    ["/FI", `IMAGENAME eq ${image}`, "/NH"],
    { encoding: "utf8", windowsHide: true },
  );
  if (running.includes(image))
    throw Error(`Close ${image} before the plugin integration test`);
}

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const probe = (file) =>
  JSON.parse(
    execFileSync(
      fp,
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
      { encoding: "utf8" },
    ),
  );
const pixel = (file, y) =>
  execFileSync(ff, [
    "-v",
    "error",
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    `crop=w=2:h=2:x=0:y=${y}`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-e2e-"));
const savedSelection = fs.existsSync(selectionPath)
  ? fs.readFileSync(selectionPath)
  : null;
const savedConfig = fs.existsSync(configPath)
  ? fs.readFileSync(configPath)
  : null;
const savedHistory = fs.existsSync(historyPath)
  ? fs.readFileSync(historyPath)
  : null;
try {
  // Project music under a Chinese folder; the .pmm stores the path in GBK.
  const musicDir = path.join(dir, "测试");
  fs.mkdirSync(musicDir);
  const wav = path.join(musicDir, "music.wav");
  execFileSync(ff, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100:duration=30",
    wav,
  ]);
  const pmm = path.join(dir, "scene.pmm");
  fs.writeFileSync(
    pmm,
    Buffer.concat([
      Buffer.from("Polygon Movie maker 0002\0\0\0\0", "latin1"),
      Buffer.from(dir + "\\", "latin1"),
      Buffer.from([0xb2, 0xe2, 0xca, 0xd4]),
      Buffer.from("\\music.wav\0\0\0\0", "latin1"),
    ]),
  );
  // Placeholder AVI template: FFV1 with its FOURCC patched to MMDE, like MMD's output.
  const template = path.join(dir, "template.avi");
  execFileSync(ff, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=black:s=16x16:r=60:d=1",
    "-c:v",
    "ffv1",
    template,
  ]);
  const bytes = fs.readFileSync(template);
  for (
    let i = bytes.indexOf("FFV1");
    i >= 0 && i < 4096;
    i = bytes.indexOf("FFV1", i + 4)
  )
    bytes.write("MMDE", i, "latin1");
  fs.writeFileSync(template, bytes);

  // What the app will write when the user picks an export preset.
  const settings = {
    ...core.BUILTINS.find((p) => p.id === "builtin-1080-sw").settings,
    resizeMode: "source",
  };
  require(path.join(root, "backend/mmd-export.cjs")).writeConfig({
    settings,
    presetName: "默认 1080p · CPU",
    presetId: "builtin-1080-sw",
    maskMode: "with",
    engines: { ffmpeg: ff, ffprobe: fp },
    appExe,
    helper: path.join(root, "backend/mmd-export.cjs"),
  });
  const historyBefore = fs.existsSync(historyPath)
    ? fs.readFileSync(historyPath, "utf8").length
    : 0;

  const avi = path.join(dir, "导出 test.avi");
  const out = execFileSync(
    path.join(build, "mmd-sim.exe"),
    [
      path.join(build, "MMDEncoderPlugin.dll"),
      template,
      avi,
      pmm,
      "320",
      "240",
      "60",
      "300",
      "359",
    ],
    { encoding: "utf8" },
  );
  check(
    /frames=120 placeholders=120/.test(out),
    "MMD side: 120 frames in, 120 placeholders back (" + out.trim() + ")",
  );

  // The finish step runs in the background after the render.
  // MMD frames 300–359 in the name (rangeSuffix is on by default).
  const mp4 = path.join(dir, "导出 test_0300-0359f.mp4");
  for (let i = 0; i < 120 && (fs.existsSync(avi) || !fs.existsSync(mp4)); i++)
    await new Promise((r) => setTimeout(r, 500));
  check(fs.existsSync(mp4), "MP4 created next to the AVI with the AVI's name");
  check(!fs.existsSync(avi), "placeholder AVI deleted");
  check(
    !fs.readdirSync(dir).some((n) => n.includes(".mmdencoder-")),
    "temporary video and mask removed",
  );
  const mask = path.join(dir, "导出 test_0300-0359f_alpha.mp4");
  if (fs.existsSync(mask)) {
    const m = probe(mask).streams;
    check(
      m.length === 1 &&
        m[0].profile === "High 4:4:4 Predictive" &&
        Number(m[0].nb_frames) === 120,
      "lossless alpha mask with 120 frames next to the MP4",
    );
  } else check(false, "alpha mask written");
  if (fs.existsSync(mp4)) {
    const info = probe(mp4);
    const v = info.streams.find((s) => s.codec_type === "video");
    const a = info.streams.find((s) => s.codec_type === "audio");
    check(
      v?.codec_name === "h264" && v.width === 320 && v.height === 240,
      "H.264 320x240 with the preset",
    );
    check(
      Number(v?.nb_frames) === 120 && v?.r_frame_rate === "60/1",
      "120 frames at 60 fps",
    );
    check(
      a?.codec_name === "aac" && Math.abs(Number(a.duration) - 2) < 0.05,
      "AAC audio cut to 2 s (" + a?.duration + ")",
    );
    // Bottom-up frames must come out upright: red bottom half, not red top.
    check(
      pixel(mp4, 0)[0] < 60 && pixel(mp4, 238)[0] > 200,
      "picture upright (vflip applied)",
    );
  }
  const history = fs.existsSync(historyPath)
    ? fs.readFileSync(historyPath, "utf8").slice(historyBefore)
    : "";
  const entry = history.trim()
    ? JSON.parse(history.trim().split("\n").pop())
    : {};
  check(
    entry.ok === true && entry.audio === "wav",
    "export recorded with audio taken from the WAV",
  );
  check(
    (entry.notes || []).some((n) => n.includes("采样点 441000–529200")),
    "WAV cut from frame 300 for 120 frames at 60 fps",
  );

  // An NVEncC preset: FFmpeg → NVEncC → container, run by mmd-pipe.cjs.
  if (fs.existsSync(nv)) {
    require(path.join(root, "backend/mmd-export.cjs")).writeConfig({
      settings: {
        ...settings,
        encoder: "nvencc:hevc",
        preset: "P4",
        quality: 28,
        rateControl: "quality",
      },
      presetName: "NVEncC HEVC",
      presetId: "nvencc-test",
      maskMode: "with",
      engines: { ffmpeg: ff, ffprobe: fp, nvencc: nv },
      appExe,
      helper: path.join(root, "backend/mmd-export.cjs"),
    });
    // A running MMDEncoder rewrites this file with its own (packaged) helper.
    check(
      JSON.parse(fs.readFileSync(configPath, "utf8")).helper ===
        path.join(root, "backend/mmd-export.cjs"),
      "NVEncC: plugin config points at this checkout (MMDEncoder closed)",
    );
    const nvAvi = path.join(dir, "NVEncC test.avi");
    const nvOut = execFileSync(
      path.join(build, "mmd-sim.exe"),
      [
        path.join(build, "MMDEncoderPlugin.dll"),
        template,
        nvAvi,
        pmm,
        "320",
        "240",
        "60",
        "300",
        "359",
      ],
      { encoding: "utf8" },
    );
    check(/frames=120/.test(nvOut), "NVEncC: MMD side sent 120 frames");
    const nvMp4 = path.join(dir, "NVEncC test_0300-0359f.mp4");
    for (
      let i = 0;
      i < 120 && (fs.existsSync(nvAvi) || !fs.existsSync(nvMp4));
      i++
    )
      await new Promise((r) => setTimeout(r, 500));
    if (fs.existsSync(nvMp4)) {
      const info = probe(nvMp4);
      const v = info.streams.find((s) => s.codec_type === "video");
      const a = info.streams.find((s) => s.codec_type === "audio");
      check(
        v?.codec_name === "hevc" && Number(v.nb_frames) === 120,
        "NVEncC: HEVC with all 120 frames",
      );
      check(a?.codec_name === "aac", "NVEncC: sound added by finish");
      check(
        pixel(nvMp4, 0)[0] < 60 && pixel(nvMp4, 238)[0] > 200,
        "NVEncC: picture upright",
      );
      const nvMask = path.join(dir, "NVEncC test_0300-0359f_alpha.mp4");
      check(
        fs.existsSync(nvMask) &&
          Number(probe(nvMask).streams[0].nb_frames) === 120,
        "NVEncC: alpha mask with 120 frames",
      );
    } else check(false, "NVEncC: MP4 created");
    check(
      !fs
        .readdirSync(dir)
        .some((n) => n.includes(".mmdencoder-") || n.includes(".nvenc.")),
      "NVEncC: temporary files removed",
    );
  } else console.log("SKIP NVEncC export (NVEncC not installed)");

  const mx = require(path.join(root, "backend/mmd-export.cjs"));
  const configure = (patch = {}) =>
    mx.writeConfig({
      settings,
      presetName: "Encoding test",
      presetId: "test",
      maskMode: "off",
      engines: { ffmpeg: ff, ffprobe: fp, nvencc: nv },
      appExe,
      helper: path.join(root, "backend/mmd-export.cjs"),
      ...patch,
    });
  configure();
  // An obsolete field must no longer select a mask in the new DLL.
  const oldSelection = { ...mx.readSelection(), alphaMask: true };
  delete oldSelection.maskMode;
  fs.writeFileSync(selectionPath, JSON.stringify(oldSelection));
  const beforeTest = fs.readFileSync(selectionPath, "utf8");
  const dialog = (mask, save = false) =>
    execFileSync(
      path.join(build, "mmd-sim.exe"),
      [
        "--dialog-test",
        path.join(build, "MMDEncoderPlugin.dll"),
        String(mask),
        save ? "save" : "cancel",
      ],
      { encoding: "utf8", timeout: 100000 },
    );
  const cancelled = dialog(1);
  check(
    /initialMask=0/.test(cancelled),
    "settings: legacy alphaMask no longer read",
  );
  check(
    /测试编码通过.*含 Alpha 遮罩/.test(cancelled),
    "settings: encoding test uses unsaved mask choice",
  );
  check(
    fs.readFileSync(selectionPath, "utf8") === beforeTest,
    "settings: Cancel after testing leaves selection unchanged",
  );
  const saved = dialog(2, true);
  const selection = JSON.parse(fs.readFileSync(selectionPath, "utf8"));
  check(
    /测试编码通过/.test(saved) && selection.maskMode === "only",
    "settings: test then OK saves mask-only choice",
  );
  check(
    !Object.hasOwn(selection, "alphaMask"),
    "settings: obsolete alphaMask no longer written",
  );
  const broken = JSON.parse(fs.readFileSync(configPath, "utf8"));
  broken.engines.ffmpeg = path.join(dir, "missing-ffmpeg.exe");
  fs.writeFileSync(configPath, JSON.stringify(broken));
  check(
    /编码测试失败/.test(dialog(0)),
    "settings: encoding failure is shown and dialog remains usable",
  );

  if (fs.existsSync(nv)) {
    for (const [name, enhancement, expected] of [
      [
        "VSR",
        { vsr: true, vsrScale: 2, vsrQuality: 1 },
        { width: 1280, height: 720, frames: 30, fps: 30 },
      ],
      [
        "VFG",
        { vfg: true, vfgMultiplier: 2, vfgMode: "medium" },
        // Interpolation supplies the points between 30 originals: 29 * 2 + 1.
        { width: 640, height: 360, frames: 59, fps: 60 },
      ],
    ]) {
      configure({
        settings: {
          ...settings,
          encoder: "nvencc:hevc",
          preset: "P4",
          resizeMode: "source",
          ...enhancement,
        },
        followMmd: false,
      });
      const result = JSON.parse(
        execFileSync(appExe, [path.join(root, "backend/mmd-export.cjs")], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            MMD_EXPORT_MODE: "test",
            MMD_EXPORT_JOB: "{}",
          },
          encoding: "utf8",
          timeout: 90000,
          windowsHide: true,
        }),
      );
      const [num, den] = (result.video?.avg_frame_rate || "0/1")
        .split("/")
        .map(Number);
      check(
        result.ok &&
          result.video.width === expected.width &&
          result.video.height === expected.height &&
          Number(result.video.nb_read_frames) === expected.frames &&
          // The Matroska intermediate uses millisecond timestamps; use the
          // same 0.1 fps tolerance as enhancements.probe on this short clip.
          Math.abs(num / den - expected.fps) < 0.1,
        `shared test: ${name} actual dimensions, frames and FPS (${JSON.stringify(result)})`,
      );
    }
  }
} finally {
  if (savedConfig) fs.writeFileSync(configPath, savedConfig);
  else fs.rmSync(configPath, { force: true });
  if (savedSelection) fs.writeFileSync(selectionPath, savedSelection);
  else fs.rmSync(selectionPath, { force: true });
  if (savedHistory) fs.writeFileSync(historyPath, savedHistory);
  else fs.rmSync(historyPath, { force: true });
  const pending = path.join(pluginDir, "pending");
  for (const name of fs.existsSync(pending) ? fs.readdirSync(pending) : []) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(pending, name);
    const entry = JSON.parse(fs.readFileSync(file, "utf8"));
    if (entry.temp && path.dirname(entry.temp) === dir) fs.rmSync(file);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `E2E FAILED (${failures})` : "E2E OK");
process.exit(failures ? 1 : 0);
