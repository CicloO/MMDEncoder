const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ff } = require("./engines.cjs");

const until = async (fn, ms = 120000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw Error("timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
};

test(
  "MMD export settings: shared with the plugin window, presets listed, choices validated, test encode works",
  { skip: !fs.existsSync(ff), timeout: 240000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-service-"));
    const savedLocal = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = path.join(root, "local");
    for (const m of ["../backend/service.cjs", "../backend/mmd-export.cjs"])
      delete require.cache[require.resolve(m)];
    const { createService } = require("../backend/service.cjs");
    const mx = require("../backend/mmd-export.cjs");
    const dataDir = path.join(root, "data");
    let svc = createService({ dataDir, mmdPluginDll: "" });
    const state = () => svc.getState();
    const config = () => JSON.parse(fs.readFileSync(mx.configPath(), "utf8"));
    try {
      await until(() => state().located && !state().detecting);
      // Nothing chosen yet: the editing intermediate, published for the plugin.
      assert.equal(state().mmd.presetId, "builtin-prores422");
      assert.equal(state().mmd.followMmd, true, "follow MMD is on by default");
      // The plugin window needs the preset list even before anything is chosen.
      const c = config();
      assert.equal(c.version, 2);
      assert.equal(c.appExe, process.execPath);
      assert.ok(c.helper.endsWith(path.join("backend", "mmd-export.cjs")));
      assert.ok(c.engines.ffmpeg && c.engines.ffprobe);
      assert.ok(c.presets.some((p) => p.id === "builtin-4k" && !p.unsupported));
      assert.equal(
        c.presets.find((p) => p.id === "builtin-alpha-mask").unsupported,
        "",
        "split alpha works in the live export",
      );
      assert.equal(mx.readConfig().presetId, "builtin-prores422");

      await svc.invoke("mmdExportSet", { presetId: "builtin-1080-sw" });
      assert.equal(mx.readSelection().presetId, "builtin-1080-sw");
      assert.equal(
        mx.readConfig().presetName,
        state().presets.find((p) => p.id === "builtin-1080-sw").name,
      );

      await svc.invoke("mmdExportSet", { followMmd: false });
      assert.equal(mx.readSelection().followMmd, false);
      assert.equal(
        mx.readSelection().presetId,
        "builtin-1080-sw",
        "partial change keeps the preset",
      );
      // With follow off the preset's long-edge scaling applies; with it on, MMD's size.
      const runtime = {
        avi: path.join(root, "x.avi"),
        width: 1000,
        height: 1300,
        bits: 32,
        bottomUp: true,
        avgTimePerFrame: 333333,
      };
      assert.match(mx.plan(runtime).args.join(" "), /scale=w=1476:h=1920/);
      await svc.invoke("mmdExportSet", { followMmd: true, audioFade: 1 });
      assert.doesNotMatch(mx.plan(runtime).args.join(" "), /scale=w=/);
      assert.equal(mx.readConfig().audioFade, 1);
      await assert.rejects(
        svc.invoke("mmdExportSet", { audioFade: 3 }),
        /淡入淡出/,
      );

      // Test encode with the chosen preset.
      await svc.invoke("mmdTest");
      assert.equal(state().mmd.test.ok, true, state().mmd.test.message);

      // A choice made in MMD's settings window (newer selection) is taken over.
      await new Promise((r) => setTimeout(r, 20));
      mx.writeSelection({
        presetId: "builtin-4k",
        followMmd: false,
        audioFade: 0.5,
      });
      await svc.invoke("mmdStatus");
      assert.equal(state().mmd.presetId, "builtin-4k");
      assert.equal(state().mmd.followMmd, false);
      assert.equal(state().mmd.audioFade, 0.5);
      // ...and a later change in the app wins over it.
      await svc.invoke("mmdExportSet", { audioFade: 2 });
      assert.deepEqual(
        [mx.readSelection().presetId, mx.readSelection().audioFade],
        ["builtin-4k", 2],
      );

      // The alpha mask choice is shared with the plugin and reaches the plan.
      assert.equal(state().mmd.maskMode, "off", "mask is off by default");
      await svc.invoke("mmdExportSet", { maskMode: "with" });
      assert.equal(mx.readSelection().maskMode, "with");
      assert.equal(mx.readSelection().alphaMask, undefined);
      assert.equal(mx.readConfig().maskMode, "with");
      assert.ok(mx.plan(runtime).maskOutput.endsWith("x_alpha.mp4"));
      await svc.invoke("mmdTest");
      assert.match(state().mmd.test.message, /含 Alpha 遮罩/);
      // Mask only: one output, the mask, named _alpha.
      await svc.invoke("mmdExportSet", { maskMode: "only" });
      const only = mx.plan(runtime);
      assert.ok(only.output.endsWith("x_alpha.mp4") && !only.maskOutput);
      await svc.invoke("mmdTest");
      assert.equal(state().mmd.test.ok, true, state().mmd.test.message);
      await assert.rejects(
        svc.invoke("mmdExportSet", { maskMode: "maybe" }),
        /遮罩选项无效/,
      );
      // The choice outranks the preset: picking a split-alpha preset leaves
      // it as it is, and set to "off" no mask is written.
      await svc.invoke("mmdExportSet", { presetId: "builtin-alpha-mask" });
      assert.equal(state().mmd.error, "");
      assert.equal(state().mmd.maskMode, "only", "preset does not change it");
      await svc.invoke("mmdExportSet", { maskMode: "off" });
      assert.equal(mx.plan(runtime).maskOutput, undefined);
      assert.ok(!mx.plan(runtime).output.endsWith("_alpha.mp4"));
      // A choice saved in MMD reaches the app without asking (file watcher).
      await new Promise((r) => setTimeout(r, 20));
      mx.writeSelection({
        ...mx.readSelection(),
        maskMode: "only",
        savedAt: undefined,
      });
      await until(() => state().mmd.maskMode === "only", 5000);
      await svc.invoke("mmdExportSet", { maskMode: "off" });

      // A personal preset that gets renamed, then deleted.
      await svc.invoke("savePreset", { name: "我的导出" });
      const mine = state().presets.find((p) => p.name === "我的导出").id;
      await svc.invoke("mmdExportSet", { presetId: mine });
      assert.equal(mx.readConfig().presetName, "我的导出");
      await svc.invoke("renamePreset", { id: mine, name: "我的导出 2" });
      assert.equal(
        mx.readConfig().presetName,
        "我的导出 2",
        "rename reaches the plugin config",
      );
      await svc.invoke("deletePreset", { id: mine });
      assert.match(state().mmd.error, /已被删除/);
      assert.throws(() => mx.readConfig(), /已不存在/);
      await assert.rejects(
        svc.invoke("mmdExportSet", { presetId: "nope" }),
        /未找到预设/,
      );

      // The choice survives a restart.
      await svc.invoke("mmdExportSet", {
        presetId: "builtin-4k",
        followMmd: false,
        audioFade: 0,
      });
      svc.dispose();
      svc = createService({ dataDir, mmdPluginDll: "" });
      await until(() => state().located && !state().detecting);
      assert.equal(state().mmd.presetId, "builtin-4k");
      assert.equal(state().mmd.followMmd, false);
    } finally {
      svc.dispose();
      process.env.LOCALAPPDATA = savedLocal;
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
