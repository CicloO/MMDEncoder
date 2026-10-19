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
const { ff, fp } = require(path.join(root, "tests/engines.cjs"));
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
    alphaMask: true,
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
  const mp4 = path.join(dir, "导出 test.mp4");
  for (let i = 0; i < 120 && (fs.existsSync(avi) || !fs.existsSync(mp4)); i++)
    await new Promise((r) => setTimeout(r, 500));
  check(fs.existsSync(mp4), "MP4 created next to the AVI with the AVI's name");
  check(!fs.existsSync(avi), "placeholder AVI deleted");
  check(
    !fs.readdirSync(dir).some((n) => n.includes(".mmdencoder-")),
    "temporary video and mask removed",
  );
  const mask = path.join(dir, "导出 test_alpha.mp4");
  if (fs.existsSync(mask)) {
    const m = probe(mask).streams;
    check(
      m.length === 1 && m[0].profile === "High 4:4:4 Predictive" && Number(m[0].nb_frames) === 120,
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
} finally {
  if (savedConfig) fs.writeFileSync(configPath, savedConfig);
  else fs.rmSync(configPath, { force: true });
  if (savedSelection) fs.writeFileSync(selectionPath, savedSelection);
  else fs.rmSync(selectionPath, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `E2E FAILED (${failures})` : "E2E OK");
process.exit(failures ? 1 : 0);
