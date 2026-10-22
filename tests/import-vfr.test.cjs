const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ff } = require("./engines.cjs");

async function until(f, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("等待超时");
}

test(
  "import tells VFR from CFR by packet times, also with B-frames and in MKV",
  { skip: !fs.existsSync(ff), timeout: 120000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "import-vfr-"));
    delete require.cache[require.resolve("../backend/service.cjs")];
    const { createService } = require("../backend/service.cjs");
    const svc = createService({
      dataDir: path.join(dir, "data"),
      mmdPluginDll: "",
    });
    try {
      const make = (name, vf, extra = []) => {
        const out = path.join(dir, name);
        execFileSync(ff, [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=160x90:r=60:d=5",
          ...(vf ? ["-vf", vf, "-fps_mode", "vfr"] : []),
          "-c:v",
          "libx264",
          "-bf",
          "3",
          ...extra,
          out,
        ]);
        return out;
      };
      const vfrSelect = "select='if(lt(n,40),1,not(mod(n,2)))'";
      const files = {
        "cfr.mp4": make("cfr.mp4"),
        "cfr.mkv": make("cfr.mkv"),
        "vfr.mp4": make("vfr.mp4", vfrSelect),
        "vfr.mkv": make("vfr.mkv", vfrSelect),
      };
      await until(() => svc.getState().located && !svc.getState().detecting);
      await svc.invoke("add", { paths: Object.values(files) });
      const vfr = Object.fromEntries(
        svc.getState().jobs.map((j) => [j.name, j.meta?.vfr]),
      );
      assert.deepEqual(vfr, {
        "cfr.mp4": false,
        "cfr.mkv": false,
        "vfr.mp4": true,
        "vfr.mkv": true,
      });
    } finally {
      svc.dispose();
      await new Promise((r) => setTimeout(r, 300));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
