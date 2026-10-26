const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ff, fp } = require("./engines.cjs");
const trim = require("../backend/trim.cjs");
const { check } = require("../scripts/trim-check.cjs");

const tools = { ffmpeg: ff, ffprobe: fp };
const make = async (file, args, src = "testsrc2=s=160x90:r=30:d=4") =>
  trim.run(ff, ["-y", "-v", "error", "-f", "lavfi", "-i", src, ...args, file]);
const x264 = (bf) => [
  "-c:v",
  "libx264",
  "-g",
  "30",
  "-keyint_min",
  "30",
  "-sc_threshold",
  "0",
  "-bf",
  String(bf),
];

test(
  "lossless trim: B-frames in MP4 and MKV, intra ProRes, cross-file joins, frame-exact and packet-exact",
  { skip: !fs.existsSync(ff), timeout: 180000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-"));
    try {
      const b3 = path.join(dir, "b3.mp4"),
        mkv = path.join(dir, "b3.mkv"),
        other = path.join(dir, "other.mp4"),
        prores = path.join(dir, "p.mov");
      await make(b3, x264(3));
      await make(mkv, x264(3));
      // Same settings, different picture: joinable with b3.mp4.
      await make(other, x264(3), "testsrc=s=160x90:r=30:d=4,format=yuv420p");
      await make(prores, ["-c:v", "prores_ks", "-profile:v", "3"]);

      const idx = await trim.index(tools, b3);
      assert.deepEqual(
        idx.frames.filter((f) => f.safe).map((f) => f.frame),
        [0, 30, 60, 90],
      );
      // Snapping: nearest safe point, ties to the earlier one; end of file.
      assert.equal(trim.snap(idx, 44), 30);
      assert.equal(trim.snap(idx, 45), 30);
      assert.equal(trim.snap(idx, 46), 60);
      assert.equal(trim.snap(idx, 999, { end: true }), 120);
      assert.equal(trim.snap(idx, 110, { end: true }), 120);
      assert.throws(() => trim.segment(idx, 31, 60), /不能作为入点/);

      for (const [ranges, ext] of [
        [
          [
            { file: b3, from: 30, to: 60 },
            { file: b3, from: 90, to: Infinity },
          ],
          "mp4",
        ],
        [[{ file: mkv, from: 31, to: 89 }], "mp4"],
        [
          [
            { file: b3, from: 0, to: 30 },
            { file: other, from: 60, to: 90 },
          ],
          "mp4",
        ],
        [
          [
            { file: prores, from: 7, to: 19 },
            { file: prores, from: 101, to: Infinity },
          ],
          "mov",
        ],
      ]) {
        const out = path.join(
          dir,
          `out-${Math.random().toString(36).slice(2)}.${ext}`,
        );
        const r = await check(tools, ranges, out);
        assert.ok(r.ok, JSON.stringify(r, null, 1));
      }
      // ProRes cuts at the exact frames asked for.
      const r = await check(
        tools,
        [{ file: prores, from: 7, to: 19 }],
        path.join(dir, "p7.mov"),
      );
      assert.deepEqual(r.segments[0].snapped, [7, 19]);
      assert.equal(r.checks.frames.got, 12);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "lossless trim refuses what it cannot do exactly: open GOP, other parameter sets, other sizes",
  { skip: !fs.existsSync(ff), timeout: 180000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-no-"));
    try {
      const open = path.join(dir, "open.mp4"),
        a = path.join(dir, "a.mp4"),
        crf = path.join(dir, "crf.mp4"),
        small = path.join(dir, "small.mp4");
      await make(open, [
        "-c:v",
        "libx264",
        "-x264-params",
        "open-gop=1:keyint=30:min-keyint=30:scenecut=0",
      ]);
      const idx = await trim.index(tools, open);
      const refused = idx.frames.filter((f) => f.key && !f.safe);
      assert.ok(refused.length >= 3);
      assert.match(refused[0].why, /开放 GOP/);
      assert.equal(refused[0].whyData.code, "TRIM_OPEN_GOP");
      assert.equal(refused[0].whyData.message, refused[0].why);
      assert.equal(trim.snap(idx, 60), 0, "only the start can be cut");

      await make(a, x264(3));
      // Same codec and size, different encoder settings → different SPS/PPS.
      await make(crf, [...x264(0), "-crf", "30", "-x264-params", "ref=1"]);
      let r = await check(
        tools,
        [
          { file: a, from: 0, to: 30 },
          { file: crf, from: 0, to: 30 },
        ],
        path.join(dir, "x.mp4"),
      );
      assert.notEqual(r.checks.compatible, true);
      assert.ok(r.checks.compatible.some((d) => d.key === "extradata"));
      assert.equal(
        fs.existsSync(path.join(dir, "x.mp4")),
        false,
        "nothing written",
      );

      await make(small, x264(3), "testsrc2=s=80x46:r=30:d=4");
      r = await check(
        tools,
        [
          { file: a, from: 0, to: 30 },
          { file: small, from: 0, to: 30 },
        ],
        path.join(dir, "y.mp4"),
      );
      assert.ok(r.checks.compatible.some((d) => d.key === "width"));

      const vp9 = path.join(dir, "v.webm");
      await make(vp9, [
        "-c:v",
        "libvpx-vp9",
        "-b:v",
        "0",
        "-crf",
        "40",
        "-deadline",
        "realtime",
      ]);
      const v = await trim.index(tools, vp9);
      assert.equal(v.supported, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "joined audio: each segment sample-exact to its source, silence where audio runs out, length equals the video",
  { skip: !fs.existsSync(ff), timeout: 180000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-audio-"));
    try {
      // A rising tone: any shift of the audio shows up as a sample difference.
      const tone = (d) =>
        `aevalsrc=sin(2*PI*(200+300*t)*t)|sin(2*PI*(300+200*t)*t):s=48000:d=${d}`;
      const withAudio = async (file, seconds, args) =>
        trim.run(ff, [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=160x90:r=30:d=4",
          "-f",
          "lavfi",
          "-i",
          tone(seconds),
          ...args,
          file,
        ]);
      const prores = path.join(dir, "p.mov"),
        h264 = path.join(dir, "h.mp4"),
        short = path.join(dir, "s.mp4"),
        music = path.join(dir, "music.wav");
      await withAudio(prores, 4, ["-c:v", "prores_ks", "-c:a", "pcm_s16le"]);
      await withAudio(h264, 4, [...x264(3), "-c:a", "aac", "-b:a", "320k"]);
      await withAudio(short, 1, [...x264(3), "-c:a", "aac"]);
      await trim.run(ff, ["-v", "error", "-f", "lavfi", "-i", tone(10), music]);
      const pcm = { mode: "reencode", codec: "pcm" };
      for (const [ranges, out] of [
        [
          [
            { file: prores, from: 7, to: 19 },
            { file: prores, from: 101, to: Infinity },
          ],
          "a.mov",
        ],
        [
          [
            { file: h264, from: 30, to: 60 },
            { file: h264, from: 90, to: Infinity },
          ],
          "b.mkv",
        ],
        // Second segment lies past the end of the 1 s of audio: silence.
        [
          [
            { file: short, from: 0, to: 30 },
            { file: short, from: 60, to: Infinity },
          ],
          "c.mkv",
        ],
      ]) {
        const r = await check(tools, ranges, path.join(dir, out), pcm);
        assert.ok(r.ok, JSON.stringify(r.checks));
        assert.equal(r.checks.audio.maxDifference, 0);
      }
      // AAC output and replacement audio: the video sets the length.
      for (const audio of [
        { mode: "reencode", codec: "aac" },
        { mode: "replace", codec: "aac", file: music, offset: 2.5 },
        { mode: "replace", codec: "flac", file: music, offset: -0.5 },
      ]) {
        const out = path.join(
          dir,
          `r${Math.random().toString(36).slice(2)}.mp4`,
        );
        const r = await check(
          tools,
          [{ file: h264, from: 30, to: 90 }],
          out,
          audio,
        );
        assert.ok(r.ok, JSON.stringify(r.checks));
        const a = JSON.parse(
          (
            await trim.run(fp, [
              "-v",
              "error",
              "-select_streams",
              "a:0",
              "-show_entries",
              "stream=duration,codec_name",
              "-of",
              "json",
              out,
            ])
          ).stdout,
        ).streams[0];
        assert.ok(
          Math.abs(Number(a.duration) - 2) < 0.03,
          audio.mode + " " + a.duration,
        );
      }
      await assert.rejects(
        check(
          tools,
          [{ file: h264, from: 0, to: 30 }],
          path.join(dir, "x.mp4"),
          { mode: "reencode", codec: "pcm" },
        ),
        /PCM/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "edit friendly encodes: a cut point every second, x265 with a closed GOP",
  { skip: !fs.existsSync(ff), timeout: 180000 },
  async () => {
    const core = require("../backend/core.cjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-gop-"));
    try {
      const src = path.join(dir, "src.mkv");
      await trim.run(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=30:d=4",
        "-c:v",
        "ffv1",
        src,
      ]);
      const meta = core.metadata(
        JSON.parse(
          (
            await trim.run(fp, [
              "-v",
              "error",
              "-show_streams",
              "-show_format",
              "-of",
              "json",
              src,
            ])
          ).stdout,
        ),
      );
      const encode = async (encoder, editFriendly) => {
        const out = path.join(dir, `${encoder}-${editFriendly}.mp4`);
        const s = {
          ...core.DEFAULTS,
          encoder,
          container: "mp4",
          audio: "none",
          preset: "medium",
          editFriendly,
        };
        const [cmd] = core.buildCommands({ path: src, meta }, s, tools, {
          output: out,
        });
        await trim.run(
          cmd.exe,
          cmd.args.filter(
            (a, i, all) => a !== "-progress" && all[i - 1] !== "-progress",
          ),
        );
        const idx = await trim.index(tools, out);
        return idx.frames.filter((f) => f.safe).map((f) => f.frame);
      };
      assert.deepEqual(await encode("libx264", true), [0, 30, 60, 90]);
      assert.deepEqual(await encode("libx265", true), [0, 30, 60, 90]);
      // Off: encoder defaults (about 250 frames), still closed for x265.
      assert.deepEqual(await encode("libx265", false), [0]);
      const args = core.buildCommands(
        { path: src, meta },
        {
          ...core.DEFAULTS,
          encoder: "libx265",
          container: "mp4",
          preset: "medium",
        },
        tools,
        {
          output: path.join(dir, "x.mp4"),
        },
      )[0].args;
      assert.equal(args[args.indexOf("-x265-params") + 1], "open-gop=0");
      // A GOP set by hand wins over edit friendly.
      const manual = core.buildCommands(
        { path: src, meta },
        {
          ...core.DEFAULTS,
          encoder: "libx264",
          container: "mp4",
          preset: "medium",
          gop: 12,
          editFriendly: true,
        },
        tools,
        {
          output: path.join(dir, "y.mp4"),
        },
      )[0].args;
      assert.equal(manual[manual.indexOf("-g") + 1], "12");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "smart cut: exact frames, copied runs byte-identical, edges re-encoded in place with the recorded settings",
  { skip: !fs.existsSync(ff), timeout: 240000 },
  async () => {
    const core = require("../backend/core.cjs");
    const { execFile } = require("node:child_process");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-smart-"));
    try {
      const src = path.join(dir, "src.mkv");
      await trim.run(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x180:r=30:d=6",
        "-c:v",
        "ffv1",
        src,
      ]);
      const meta = core.metadata(
        JSON.parse(
          (
            await trim.run(fp, [
              "-v",
              "error",
              "-show_streams",
              "-show_format",
              "-of",
              "json",
              src,
            ])
          ).stdout,
        ),
      );
      const encode = async (encoder, file) => {
        const s = {
          ...core.DEFAULTS,
          encoder,
          preset: "medium",
          container: "mp4",
          audio: "none",
          editFriendly: true,
        };
        const [cmd] = core.buildCommands({ path: src, meta }, s, tools, {
          output: file,
        });
        await trim.run(
          cmd.exe,
          cmd.args.filter(
            (a, i, all) => a !== "-progress" && all[i - 1] !== "-progress",
          ),
        );
      };
      const gray = (file) =>
        new Promise((res, rej) =>
          execFile(
            ff,
            [
              "-v",
              "error",
              "-i",
              file,
              "-map",
              "0:v:0",
              "-pix_fmt",
              "gray",
              "-f",
              "rawvideo",
              "-",
            ],
            { encoding: "buffer", maxBuffer: 1 << 28 },
            (e, o) => (e ? rej(e) : res(o)),
          ),
        );
      const F = 320 * 180;
      const psnr = (a, i, b, j) => {
        let se = 0;
        for (let p = 0; p < F; p++) se += (a[i * F + p] - b[j * F + p]) ** 2;
        return se ? 10 * Math.log10((255 * 255 * F) / se) : 99;
      };
      for (const encoder of ["libx264", "libx265"]) {
        const file = path.join(dir, encoder + ".mp4");
        await encode(encoder, file);
        const idx = await trim.index(tools, file);
        assert.equal(idx.encoding.encoder, encoder);
        const ranges = [
          { file, idx, from: 7, to: 52 },
          { file, idx, from: 95, to: idx.frames.length },
        ];
        // Cut points every 30 frames: 7–52 holds no whole run (all
        // re-encoded); 95–end copies 120–end and re-encodes 95–119.
        const plan = (r) =>
          trim.pieces(r, true).map((p) => [p.copy, p.from, p.to]);
        assert.deepEqual(plan(ranges[0]), [[false, 7, 52]]);
        assert.deepEqual(plan(ranges[1]), [
          [false, 95, 120],
          [true, 120, 180],
        ]);
        const out = path.join(dir, encoder + "-smart.mp4");
        await trim.cut(tools, ranges, out, { smart: true });
        const a = await gray(out),
          b = await gray(file);
        const map = [...Array(45)]
          .map((_, i) => 7 + i)
          .concat([...Array(85)].map((_, i) => 95 + i));
        assert.equal(a.length / F, map.length, "frame count");
        let at = 0;
        for (const r of ranges)
          for (const p of trim.pieces(r, true))
            for (let k = p.from; k < p.to; k++, at++) {
              const here = psnr(a, at, b, k);
              if (p.copy)
                assert.equal(
                  here,
                  99,
                  `${encoder} copied frame ${k} identical`,
                );
              else {
                assert.ok(
                  here > 35,
                  `${encoder} re-encoded frame ${k}: ${here.toFixed(1)} dB`,
                );
                assert.ok(
                  here > psnr(a, at, b, k - 1) &&
                    (k + 1 >= b.length / F || here > psnr(a, at, b, k + 1)),
                  `${encoder} frame ${k} in place`,
                );
              }
            }
      }
      // A file without recorded settings: refused, nothing written.
      const plain = path.join(dir, "plain.mp4");
      await trim.run(ff, [
        "-v",
        "error",
        "-i",
        src,
        "-c:v",
        "libx264",
        "-g",
        "30",
        plain,
      ]);
      const pidx = await trim.index(tools, plain);
      await assert.rejects(
        trim.cut(
          tools,
          [{ file: plain, idx: pidx, from: 7, to: 52 }],
          path.join(dir, "no.mp4"),
          { smart: true },
        ),
        (error) => {
          assert.equal(error.code, "TRIM_SMART_TAG_REQUIRED");
          assert.equal(error.params.name, "plain.mp4");
          return true;
        },
      );
      assert.equal(fs.existsSync(path.join(dir, "no.mp4")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "timestamps that do not start at zero cut correctly; variable frame rate is refused; long all-IDR index stays fast",
  { skip: !fs.existsSync(ff), timeout: 240000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-edge-"));
    try {
      // Timeline starting at 5 s (both streams).
      const base = path.join(dir, "base.mp4"),
        offset = path.join(dir, "offset.mp4");
      await make(base, x264(3), "testsrc2=s=160x90:r=30:d=3");
      await trim.run(ff, [
        "-v",
        "error",
        "-i",
        base,
        "-c",
        "copy",
        "-output_ts_offset",
        "5",
        offset,
      ]);
      const idx = await trim.index(tools, offset);
      assert.ok(idx.startTime > 4.9);
      for (const [from, to] of [
        [0, Infinity],
        [30, 60],
      ]) {
        const r = await check(
          tools,
          [{ file: offset, from, to }],
          path.join(dir, `o-${from}.mp4`),
        );
        assert.ok(r.ok, JSON.stringify(r.checks));
      }
      // 1 s at 30 fps then 2 s at 15 fps: refused with a reason.
      const vfr = path.join(dir, "vfr.mkv");
      await trim.run(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=30:d=3",
        "-vf",
        "select='lt(t\,1)+not(mod(n\,2))'",
        "-fps_mode",
        "vfr",
        "-c:v",
        "libx264",
        vfr,
      ]);
      const v = await trim.index(tools, vfr);
      assert.equal(v.supported, false);
      assert.match(v.reason, /可变帧率/);
      assert.equal(v.reasonData.code, "TRIM_VFR_UNSUPPORTED");
      assert.equal(v.reasonData.message, v.reason);
      // 24 000 frames, every one an IDR: the safe-point check is linear.
      const many = path.join(dir, "many.mp4");
      await trim.run(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=gray:s=64x64:r=60:d=400",
        "-c:v",
        "libx264",
        "-g",
        "1",
        "-preset",
        "ultrafast",
        many,
      ]);
      const t0 = Date.now();
      const big = await trim.index(tools, many);
      const seconds = (Date.now() - t0) / 1000;
      assert.equal(big.frames.length, 24000);
      assert.ok(big.frames.every((f) => f.safe));
      assert.ok(seconds < 5, `index took ${seconds} s`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
