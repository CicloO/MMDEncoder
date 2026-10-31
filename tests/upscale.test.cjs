const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const core = require("../backend/core.cjs");
const { ff, fp, nv } = require("./engines.cjs");
// Whether this machine can run libplacebo on Vulkan: GPU tests are skipped
// (not passed) without it, and fail for real when it is there.
const vulkan = (() => {
  try {
    execFileSync(
      ff,
      [
        "-v",
        "error",
        "-init_hw_device",
        "vulkan",
        "-f",
        "lavfi",
        "-i",
        "color=black:s=64x64:d=0.1",
        "-vf",
        "format=yuv420p,hwupload,libplacebo=w=128:h=128:format=yuv420p,hwdownload,format=yuv420p",
        "-f",
        "null",
        "-",
      ],
      { stdio: "pipe" },
    );
    return true;
  } catch {
    return false;
  }
})();

async function until(f, ms = 120000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("等待超时");
}
const job = {
  path: "C:/视频 目录/a.mp4",
  meta: {
    width: 1920,
    height: 1080,
    fps: 60,
    hasAlpha: false,
    pixFmt: "yuv420p",
  },
};
const vf = (cmd) => cmd.args[cmd.args.indexOf("-vf") + 1];

test("ArtCNN runs through libplacebo only when enlarging, never for VSR or the mask", () => {
  const up = {
    ...core.DEFAULTS,
    upscaler: "artcnn",
    resizeMode: "custom",
    width: 3840,
    height: 2160,
  };
  const [cmd] = core.buildCommands(
    job,
    up,
    { ffmpeg: "ffmpeg" },
    { output: "o.mp4" },
  );
  assert.ok(cmd.args.indexOf("vulkan") < cmd.args.indexOf("-i"));
  // A YUV source goes to the GPU as it is (untagged counts as BT.709);
  // libplacebo converts matrix and range and returns the output format.
  assert.equal(
    vf(cmd).replace(/custom_shader_path=.*?.glsl/, "SHADER"),
    "setparams=colorspace=bt709,setparams=colorspace=bt709:range=tv,hwupload,libplacebo=w=3840:h=2160:SHADER:colorspace=bt709:range=tv:format=yuv420p,hwdownload,format=yuv420p,setsar=1",
  );
  assert.match(
    vf(cmd),
    /custom_shader_path=[A-Z]\\\\:\/.*\/assets\/shaders\/ArtCNN_C4F16\.glsl:/,
  );
  // RGB (MMD's UtVideo RGBA) becomes YUV in the output's matrix first, or
  // ArtCNN, which works on luma, would do nothing.
  const [rgb] = core.buildCommands(
    { ...job, meta: { ...job.meta, pixFmt: "gbrap", hasAlpha: true } },
    {
      ...up,
      alphaMode: "preserve",
      encoder: "prores_ks",
      container: "mov",
      bitDepth: 10,
      chroma: "444",
    },
    { ffmpeg: "ffmpeg" },
    { output: "o.mov" },
  );
  // Colour goes up without alpha (libplacebo would blend it in); kept
  // alpha is enlarged with Lanczos beside it and merged back.
  assert.equal(
    vf(rgb).replace(/custom_shader_path=.*?.glsl/, "SHADER"),
    "split[c][a];[c]scale=out_range=tv:out_color_matrix=bt709,format=yuv444p,setparams=colorspace=bt709:range=tv,hwupload,libplacebo=w=3840:h=2160:SHADER:colorspace=bt709:range=tv:format=yuv444p10le,hwdownload,format=yuv444p10le[cc];[a]alphaextract,scale=3840:2160:flags=lanczos[aa];[cc][aa]alphamerge,format=yuva444p10le,setsar=1",
  );
  // Same size or smaller: plain Lanczos, no GPU device.
  for (const s of [
    { ...up, resizeMode: "source" },
    { ...up, width: 1280, height: 720 },
  ]) {
    const [c] = core.buildCommands(
      job,
      s,
      { ffmpeg: "ffmpeg" },
      { output: "o.mp4" },
    );
    assert.ok(!c.args.includes("vulkan"));
    assert.ok(!vf(c).includes("libplacebo"));
  }
  // The separate alpha mask is scaled with Lanczos to the same size.
  const cmds = core.buildCommands(
    { ...job, meta: { ...job.meta, hasAlpha: true } },
    { ...up, alphaMask: true },
    { ffmpeg: "ffmpeg" },
    { output: "o.mp4", maskOutput: "m.mp4" },
  );
  assert.ok(vf(cmds[0]).includes("libplacebo"));
  assert.match(vf(cmds[1]), /flags=lanczos/);
  assert.ok(!vf(cmds[1]).includes("libplacebo"));
  // RTX VSR wins: it scales in NVEncC.
  assert.equal(core.usesArtcnn({ ...up, vsr: true }, job.meta), false);
  assert.ok(core.validate({ ...core.DEFAULTS, upscaler: "waifu" }).length);
});

test("NVEncC reads FFmpeg's frames from a pipe; audio comes from the source", () => {
  const cmds = core.buildCommands(
    { ...job, meta: { ...job.meta, audio: { channels: 2 } } },
    { ...core.DEFAULTS, encoder: "nvencc:h264", preset: "p4" },
    { ffmpeg: "ffmpeg", nvencc: "NVEncC" },
    { output: "o.mp4" },
  );
  assert.equal(cmds.length, 1);
  const [enc] = cmds;
  const mux = enc.pipeTo;
  assert.deepEqual(enc.pipeFrom.args.slice(-2), ["nut", "-"]);
  assert.ok(enc.pipeFrom.args.includes("rawvideo"));
  assert.ok(enc.pipeFrom.args.includes("-an"));
  assert.deepEqual(enc.args.slice(0, 5), [
    "--avsw",
    "--input-format",
    "nut",
    "-i",
    "-",
  ]);
  assert.ok(
    !cmds.some((c) => c.args.some((a) => String(a).endsWith(".prepare.mkv"))),
  );
  // Packaging reads the encoded stream and the original audio (input 1).
  assert.equal(
    mux.args[mux.args.indexOf("-map", mux.args.indexOf("0:v:0")) + 1],
    "1:a:0?",
  );
  assert.match(core.commandText([enc]), /^& 'ffmpeg' .* \| & 'NVEncC' /);
});

test(
  "ArtCNN and the NVEncC pipe in real encodes; a cancelled piped encode leaves nothing running",
  { skip: !vulkan && "no Vulkan for libplacebo", timeout: 300000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upscale-"));
    delete require.cache[require.resolve("../backend/service.cjs")];
    const { createService } = require("../backend/service.cjs");
    const svc = createService({
      dataDir: path.join(dir, "data"),
      mmdPluginDll: "",
    });
    const st = () => svc.getState();
    try {
      const src = path.join(dir, "源 视频.mkv");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x180:r=30:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=2",
        "-c:v",
        "ffv1",
        "-c:a",
        "flac",
        src,
      ]);
      await until(() => st().located && !st().detecting);
      assert.equal(st().engineInfo.libplacebo, true, "Vulkan check");
      const probe = (f) =>
        JSON.parse(
          execFileSync(fp, [
            "-v",
            "error",
            "-count_packets",
            "-show_streams",
            "-of",
            "json",
            f,
          ]),
        ).streams;
      const encode = async (patch) => {
        await svc.invoke("settings", {
          patch: {
            upscaler: "artcnn",
            resizeMode: "custom",
            keepAspect: false,
            width: 640,
            height: 360,
            container: "mkv",
            audio: "aac",
            ...patch,
          },
        });
        await svc.invoke("add", { paths: [src] });
        const id = st().jobs.at(-1).id;
        await svc.invoke("start");
        await until(() => !st().running);
        const j = st().jobs.find((x) => x.id === id);
        assert.equal(j.status, "done", j.log);
        await svc.invoke("remove", { id });
        return j;
      };
      // FFmpeg encoder.
      let j = await encode({ encoder: "libx264", preset: "veryfast" });
      let [v, a] = probe(j.output);
      assert.deepEqual(
        [v.width, v.height, v.nb_read_packets],
        [640, 360, "60"],
      );
      assert.equal(a.codec_name, "aac");
      assert.match(j.log, /libplacebo=w=640:h=360/);
      // NVEncC: ArtCNN in FFmpeg, frames piped to NVEncC, no intermediate file.
      const nvenc = st().engines.find((e) => e.id === "nvencc:h264");
      if (fs.existsSync(nv) && nvenc) {
        j = await encode({ encoder: "nvencc:h264", preset: "p4", quality: 23 });
        [v, a] = probe(j.output);
        assert.deepEqual(
          [v.width, v.height, v.nb_read_packets],
          [640, 360, "60"],
        );
        assert.equal(a.codec_name, "aac");
        assert.match(j.log, /\| & '.*NVEncC/);

        // Cancel a long piped encode: both programs stop, no output remains.
        const long = path.join(dir, "long.mkv");
        execFileSync(ff, [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=1280x720:r=60:d=60",
          "-c:v",
          "ffv1",
          long,
        ]);
        await svc.invoke("settings", {
          patch: {
            upscaler: "lanczos",
            resizeMode: "source",
            encoder: "nvencc:h264",
            audio: "none",
          },
        });
        await svc.invoke("add", { paths: [long] });
        await svc.invoke("start");
        await until(
          () =>
            st().jobs.at(-1).status === "encoding" &&
            st().jobs.at(-1).progress > 0,
        );
        await svc.invoke("cancel");
        await until(() => !st().running);
        assert.equal(st().jobs.at(-1).status, "cancelled");
        assert.deepEqual(
          fs
            .readdirSync(path.join(dir, "Encoded"))
            .filter((n) => n.startsWith("long")),
          [],
        );
      }
    } finally {
      svc.dispose();
      await new Promise((r) => setTimeout(r, 500));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "ArtCNN keeps colour and alpha of a transparent source like Lanczos does",
  { skip: !vulkan && "no Vulkan for libplacebo", timeout: 120000 },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upscale-alpha-"));
    try {
      // Half-transparent picture, 12-bit 4:4:4 with alpha like ProRes 4444.
      const src = path.join(dir, "a.mov");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x180:r=30:d=0.5,format=yuva444p12le,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='X*4095/W'",
        "-c:v",
        "prores_ks",
        "-profile:v",
        "4444",
        src,
      ]);
      const meta = core.metadata(
        JSON.parse(
          execFileSync(fp, [
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            src,
          ]),
        ),
      );
      const avg = (file, vf) => {
        const v = [
          ...execFileSync(ff, [
            "-v",
            "error",
            "-i",
            file,
            "-vf",
            vf +
              ",signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
            "-f",
            "null",
            "-",
          ])
            .toString()
            .matchAll(/YAVG=([0-9.]+)/g),
        ].map((m) => Number(m[1]));
        return v.reduce((a, b) => a + b, 0) / v.length;
      };
      const result = {};
      for (const upscaler of ["lanczos", "artcnn"]) {
        const out = path.join(dir, upscaler + ".mov");
        const [cmd] = core.buildCommands(
          { path: src, meta },
          {
            ...core.DEFAULTS,
            encoder: "prores_ks",
            container: "mov",
            bitDepth: 10,
            chroma: "444",
            alphaMode: "preserve",
            quality: 12,
            audio: "none",
            upscaler,
            resizeMode: "custom",
            keepAspect: false,
            width: 640,
            height: 360,
          },
          { ffmpeg: ff },
          { output: out },
        );
        execFileSync(
          cmd.exe,
          cmd.args.filter(
            (a, i, all) => a !== "-progress" && all[i - 1] !== "-progress",
          ),
          { stdio: "pipe" },
        );
        result[upscaler] = {
          luma: avg(out, "format=yuv444p16le"),
          alpha: avg(out, "alphaextract,format=gray16le"),
        };
      }
      // libplacebo would darken colour where transparent; must match Lanczos.
      for (const k of ["luma", "alpha"])
        assert.ok(
          Math.abs(result.artcnn[k] / result.lanczos[k] - 1) < 0.02,
          JSON.stringify(result),
        );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("untagged YUV sources are read as BT.709; tagged and RGB sources keep theirs", () => {
  const first = (meta) =>
    vf(
      core.buildCommands(
        { path: "a.mp4", meta: { width: 640, height: 360, fps: 30, ...meta } },
        core.DEFAULTS,
        { ffmpeg: "ffmpeg" },
        { output: "o.mp4" },
      )[0],
    ).split(",")[0];
  assert.equal(first({ pixFmt: "yuv420p" }), "setparams=colorspace=bt709");
  assert.equal(
    first({ pixFmt: "yuv420p", colorSpace: "unknown" }),
    "setparams=colorspace=bt709",
  );
  assert.match(
    first({ pixFmt: "yuv420p", colorSpace: "smpte170m" }),
    /^scale=/,
  );
  assert.match(first({ pixFmt: "gbrap" }), /^scale=/);
});

test("U01/U05: ArtCNN only where its 2x shader really runs; mask-only needs no GPU", () => {
  const meta = { width: 1920, height: 1080, fps: 30, pixFmt: "yuv420p" };
  const up = {
    ...core.DEFAULTS,
    upscaler: "artcnn",
    resizeMode: "custom",
    keepAspect: false,
  };
  const at = (width, height, extra = {}) => ({
    ...up,
    width,
    height,
    ...extra,
  });
  // The shader's own //!WHEN: both sides more than 1.3x.
  assert.equal(core.usesArtcnn(at(3840, 2160), meta), true);
  assert.equal(core.usesArtcnn(at(2560, 1440), meta), true);
  for (const [w, h] of [
    [2304, 1296], // 1.2x
    [3840, 1080], // one side only
  ]) {
    assert.equal(core.usesArtcnn(at(w, h), meta), false);
    assert.match(core.artcnnSkipped(at(w, h), meta), /1\.3 倍.*Lanczos/);
    const [cmd] = core.buildCommands(
      { path: "a", meta },
      at(w, h),
      { ffmpeg: "ffmpeg" },
      { output: "o.mp4" },
    );
    assert.ok(!cmd.args.includes("vulkan"));
    assert.match(vf(cmd), /flags=lanczos/);
  }
  // Mask only: Lanczos, no Vulkan device, no ArtCNN requirement.
  const alpha = { ...meta, hasAlpha: true };
  const mask = at(3840, 2160, { alphaMode: "mask" });
  assert.equal(core.usesArtcnn(mask, alpha), false);
  const [m] = core.buildCommands(
    { path: "a", meta: alpha },
    mask,
    { ffmpeg: "ffmpeg" },
    { output: "o.mp4" },
  );
  assert.ok(!m.args.includes("vulkan"));
  // Colour + separate mask: only the colour command opens the device.
  const both = core.buildCommands(
    { path: "a", meta: alpha },
    at(3840, 2160, { alphaMask: true }),
    { ffmpeg: "ffmpeg" },
    { output: "o.mp4", maskOutput: "m.mp4" },
  );
  assert.deepEqual(
    both.map((c) => c.args.includes("vulkan")),
    [true, false],
  );
});

test(
  "U01/U02: the shader changes the picture, also from a folder named with ' , [ ] and spaces",
  { skip: !vulkan && "no Vulkan for libplacebo", timeout: 120000 },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upscale-path-"));
    try {
      // A copy of the app's backend and shader in an awkward folder.
      const app = path.join(dir, "Bob's copy, 测试 [1]");
      fs.cpSync(
        path.join(__dirname, "..", "backend"),
        path.join(app, "backend"),
        {
          recursive: true,
        },
      );
      fs.cpSync(
        path.join(__dirname, "..", "locales"),
        path.join(app, "locales"),
        { recursive: true },
      );
      fs.mkdirSync(path.join(app, "assets", "shaders"), { recursive: true });
      fs.copyFileSync(
        path.join(__dirname, "..", "assets", "shaders", "ArtCNN_C4F16.glsl"),
        path.join(app, "assets", "shaders", "ArtCNN_C4F16.glsl"),
      );
      const copied = require(path.join(app, "backend", "core.cjs"));
      const src = path.join(dir, "src.mkv");
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x180:r=30:d=0.2",
        "-c:v",
        "ffv1",
        src,
      ]);
      const meta = copied.metadata(
        JSON.parse(
          execFileSync(fp, [
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            src,
          ]),
        ),
      );
      const frames = (vfText) =>
        execFileSync(
          ff,
          [
            "-v",
            "error",
            "-init_hw_device",
            "vulkan",
            "-i",
            src,
            "-vf",
            vfText,
            "-f",
            "rawvideo",
            "-",
          ],
          {
            maxBuffer: 1 << 28,
          },
        );
      const [cmd] = copied.buildCommands(
        { path: src, meta },
        {
          ...copied.DEFAULTS,
          upscaler: "artcnn",
          resizeMode: "custom",
          keepAspect: false,
          width: 640,
          height: 360,
        },
        { ffmpeg: ff },
        { output: path.join(dir, "o.mp4") },
      );
      const withShader = vf(cmd);
      // Escaped for both of FFmpeg's parsing levels.
      assert.ok(withShader.includes(String.raw`Bob\\\'s copy\, 测试 \[1\]`));
      // Runs from that folder, and differs from the same chain without the shader.
      const a = frames(withShader);
      const b = frames(withShader.replace(/custom_shader_path=.*?\.glsl:/, ""));
      assert.equal(a.length, b.length);
      assert.notDeepEqual(a, b);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

const pwsh = (() => {
  try {
    execFileSync("pwsh", ["-NoProfile", "-Command", "exit 0"], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
})();
test(
  "U03: the copied script pipes bytes intact and stops when either program fails",
  { skip: !pwsh && "PowerShell 7 not installed", timeout: 120000 },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipe-script-"));
    try {
      const node = process.execPath;
      const writer = (code) => ({
        exe: node,
        args: [
          "-e",
          `const b=Buffer.alloc(1<<20);for(let i=0;i<b.length;i++)b[i]=i&255;process.stdout.write(b,()=>process.exit(${code}))`,
        ],
      });
      const reader = (code, out) => ({
        exe: node,
        args: [
          "-e",
          `let n=0,ok=true;process.stdin.on("data",d=>{for(const x of d){if(x!==(n&255))ok=false;n++}}).on("end",()=>{require("fs").writeFileSync(${JSON.stringify(out)},n+" "+ok);process.exit(${code})})`,
        ],
      });
      const run = (name, w, r) => {
        const out = path.join(dir, name + ".txt");
        const script = path.join(dir, name + ".ps1");
        fs.writeFileSync(
          script,
          "﻿" +
            core.commandText([{ ...reader(r, out), pipeFrom: writer(w) }], {
              prepare: true,
            }),
        );
        let code = 0;
        try {
          execFileSync("pwsh", ["-NoProfile", "-File", script], {
            stdio: "pipe",
          });
        } catch (e) {
          code = e.status;
        }
        return {
          code,
          got: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "",
        };
      };
      assert.deepEqual(run("ok", 0, 0), { code: 0, got: "1048576 true" });
      assert.notEqual(run("writer", 23, 0).code, 0);
      assert.notEqual(run("reader", 0, 5).code, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "U04: the Vulkan check is cached with detection and redone by 重新检测",
  { skip: !vulkan && "no Vulkan for libplacebo", timeout: 300000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "placebo-cache-"));
    const data = path.join(dir, "data");
    const start = async () => {
      delete require.cache[require.resolve("../backend/service.cjs")];
      const { createService } = require("../backend/service.cjs");
      const svc = createService({ dataDir: data, mmdPluginDll: "" });
      await until(() => svc.getState().located && !svc.getState().detecting);
      return svc;
    };
    try {
      let svc = await start();
      assert.equal(svc.getState().engineInfo.libplacebo, true);
      svc.dispose();
      // A failed check recorded in the cache (e.g. a driver hiccup)…
      const file = fs
        .readdirSync(data)
        .map((n) => path.join(data, n))
        .find((p) => /engine-cache\.json$/.test(p));
      const cache = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(cache.libplacebo, true);
      fs.writeFileSync(file, JSON.stringify({ ...cache, libplacebo: false }));
      // …is used as is on the next start…
      svc = await start();
      assert.equal(svc.getState().engineInfo.libplacebo, false);
      // …and 重新检测 really checks again.
      await svc.invoke("detect");
      assert.equal(svc.getState().engineInfo.libplacebo, true);
      svc.dispose();
    } finally {
      await new Promise((r) => setTimeout(r, 300));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
