const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { execFileSync } = require("node:child_process");
const {
  assetsFor,
  checkForUpdate,
  RELEASES_URL,
} = require("../backend/update.cjs");
const { createUpdater } = require("../backend/selfupdate.cjs");
const { installUpdate } = require("../backend/install-update.cjs");
const seven = path.resolve(__dirname, "../assets/7za.exe");
const runtime = "40.10.6",
  version = "1.6.3";
const sha = (buffer) =>
  crypto.createHash("sha256").update(buffer).digest("hex");
function write(dir, name, content) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function fixture(root, appChanges = {}) {
  const files = {
    "resources/app/package.json": JSON.stringify({
      version,
      electronVersion: runtime,
    }),
    "resources/app/backend/install-update.cjs": "// test helper",
    "resources/app/dist/index.html": "new complete application",
  };
  const packages = {},
    assets = [],
    data = {};
  for (const kind of ["app", "full"]) {
    const dir = path.join(root, kind);
    const payload = kind === "app" ? dir : path.join(dir, "MMDEncoder");
    for (const [name, content] of Object.entries({
      ...files,
      ...(kind === "app" ? appChanges : { "MMDEncoder.exe": "new runtime" }),
    }))
      write(payload, name, content);
    const name = `MMDEncoder-${version}-${kind === "app" ? "app" : "win-x64"}.zip`;
    const zip = path.join(root, name);
    execFileSync(
      seven,
      ["a", "-tzip", zip, kind === "app" ? "resources" : "MMDEncoder"],
      { cwd: dir, windowsHide: true, stdio: "pipe" },
    );
    const body = fs.readFileSync(zip);
    packages[kind] = { name, size: body.length, sha256: sha(body) };
    data[name] = body;
    data[name + ".sha256"] = Buffer.from(sha(body) + "  " + name);
    for (const suffix of ["", ".sha256"])
      assets.push({
        name: name + suffix,
        size: data[name + suffix].length,
        browser_download_url: `${RELEASES_URL}/download/v${version}/${name}${suffix}`,
      });
  }
  const manifest = {
    schemaVersion: 1,
    version,
    electronVersion: runtime,
    packages,
  };
  const name = `MMDEncoder-${version}-update.json`;
  data[name] = Buffer.from(JSON.stringify(manifest));
  assets.push({
    name,
    browser_download_url: `${RELEASES_URL}/download/v${version}/${name}`,
  });
  const release = { tag_name: "v" + version, assets };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/releases/latest"))
      return { ok: true, status: 200, json: async () => release };
    const body = data[url.split("/").at(-1)];
    return {
      ok: !!body,
      status: body ? 200 : 404,
      json: async () => JSON.parse(body),
      text: async () => body.toString(),
      body: body && Readable.from([body]),
      headers: { get: () => String(body?.length || 0) },
    };
  };
  return { release, manifest, data, calls, fetchImpl };
}
function installed(root) {
  const dir = path.join(root, "installed");
  for (const [name, content] of Object.entries({
    "MMDEncoder.exe": "original runtime",
    version: runtime,
    "resources/app/package.json": JSON.stringify({
      version: "1.6.1",
      electronVersion: runtime,
    }),
    "resources/app/removed.cjs": "old program only",
    "data/settings.json": '{"user":"保留{a}"}',
    ".update/old/preserved.txt": "earlier recovery copy",
  }))
    write(dir, name, content);
  return dir;
}
function updater(dir, fetchImpl) {
  return createUpdater({
    appDir: dir,
    version: "1.6.1",
    electronVersion: runtime,
    extractor: seven,
    logDir: path.join(dir, "data/logs"),
    fetchImpl,
  });
}
function unchanged(dir) {
  assert.equal(
    fs.readFileSync(path.join(dir, "MMDEncoder.exe"), "utf8"),
    "original runtime",
  );
  assert.equal(
    fs.readFileSync(path.join(dir, "resources/app/removed.cjs"), "utf8"),
    "old program only",
  );
  assert.equal(
    fs.readFileSync(path.join(dir, "data/settings.json"), "utf8"),
    '{"user":"保留{a}"}',
  );
  assert.equal(
    fs.readFileSync(path.join(dir, ".update/old/preserved.txt"), "utf8"),
    "earlier recovery copy",
  );
}
function scratch(run) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-incremental-"));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    try {
      await run(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  "manifest selects the complete app tree only for a matching runtime and valid release assets",
  scratch(async (root) => {
    const f = fixture(root);
    const pick = (
      manifest = f.manifest,
      electronVersion = runtime,
      release = f.release,
    ) => assetsFor(release, version, { manifest, electronVersion });
    assert.equal(pick().kind, "app");
    assert.equal(pick().fallback.kind, "full");
    for (const manifest of [
      null,
      {},
      { ...f.manifest, schemaVersion: 2 },
      { ...f.manifest, version: "1.6.2" },
      {
        ...f.manifest,
        packages: {
          ...f.manifest.packages,
          app: { ...f.manifest.packages.app, sha256: "bad" },
        },
      },
      {
        ...f.manifest,
        packages: {
          ...f.manifest.packages,
          app: { ...f.manifest.packages.app, size: 1 },
        },
      },
    ])
      assert.equal(pick(manifest).kind, "full");
    assert.equal(pick(f.manifest, "41.0.0").kind, "full");
    assert.equal(
      pick(f.manifest, runtime, {
        assets: f.release.assets.filter(
          (a) => a.name !== f.manifest.packages.app.name,
        ),
      }).kind,
      "full",
    );
    assert.equal(
      pick(f.manifest, runtime, {
        assets: f.release.assets.map((a) =>
          a.name.includes("-app.zip")
            ? { ...a, browser_download_url: "https://example.com/" + a.name }
            : a,
        ),
      }).kind,
      "full",
    );
  }),
);

test(
  "release checking fetches the manifest and tolerates an unavailable or invalid one",
  scratch(async (root) => {
    const f = fixture(root);
    const selected = await checkForUpdate("1.6.1", f.fetchImpl, runtime);
    assert.equal(selected.assets.kind, "app");
    const manifestUrl = f.calls.at(-1);
    for (const failure of [
      async () => {
        throw Error("offline");
      },
      async () => ({ ok: false, status: 404 }),
      async () => ({
        ok: true,
        json: async () => {
          throw Error("malformed JSON");
        },
      }),
    ]) {
      const result = await checkForUpdate(
        "1.6.1",
        (url) => (url === manifestUrl ? failure() : f.fetchImpl(url)),
        runtime,
      );
      assert.equal(result.assets.kind, "full");
    }
    f.calls.length = 0;
    await checkForUpdate(version, f.fetchImpl, runtime);
    assert.equal(
      f.calls.length,
      1,
      "no manifest request for an already installed release",
    );
  }),
);

test(
  "app update skips versions, replaces the whole app and preserves runtime, data and recovery copies",
  scratch(async (root) => {
    const f = fixture(root),
      dir = installed(root),
      u = updater(dir, f.fetchImpl);
    const info = await checkForUpdate("1.6.1", f.fetchImpl, runtime);
    await u.download(info);
    unchanged(dir);
    assert.equal(u.state.packageKind, "app");
    assert.equal(u.state.total, f.manifest.packages.app.size);
    assert.equal(
      f.calls.some((url) => url.endsWith("-win-x64.zip")),
      false,
    );
    await installUpdate({
      appDir: dir,
      newDir: path.join(dir, ".update/new"),
      backup: path.join(dir, ".update/old-2"),
      kind: "app",
      pid: 0,
      log: path.join(dir, "data/logs/update.log"),
      relaunch: false,
    });
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, "resources/app/package.json")))
        .version,
      version,
    );
    assert.equal(
      fs.existsSync(path.join(dir, "resources/app/removed.cjs")),
      false,
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "MMDEncoder.exe"), "utf8"),
      "original runtime",
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "data/settings.json"), "utf8"),
      '{"user":"保留{a}"}',
    );
    assert.equal(
      fs.readFileSync(path.join(dir, ".update/old/preserved.txt"), "utf8"),
      "earlier recovery copy",
    );
  }),
);

for (const failure of [
  "checksum",
  "manifest-checksum",
  "interrupted",
  "layout",
  "version",
  "runtime",
]) {
  test(
    `app ${failure} failure falls back to the full package before changing installed files`,
    scratch(async (root) => {
      const changes =
        failure === "version" || failure === "runtime"
          ? {
              "resources/app/package.json": JSON.stringify({
                version: failure === "version" ? "1.6.2" : version,
                electronVersion: failure === "runtime" ? "41.0.0" : runtime,
              }),
            }
          : {};
      const f = fixture(root, changes),
        dir = installed(root);
      const info = await checkForUpdate("1.6.1", f.fetchImpl, runtime);
      if (failure === "checksum")
        f.data[f.manifest.packages.app.name] = Buffer.from("corrupt app");
      if (failure === "manifest-checksum")
        f.data[f.manifest.packages.app.name + ".sha256"] = Buffer.from(
          "0".repeat(64),
        );
      if (failure === "layout") {
        // A correctly hashed archive of the wrong shape must also be rejected.
        f.data[f.manifest.packages.app.name] =
          f.data[f.manifest.packages.full.name];
        info.assets.sha256 = sha(f.data[f.manifest.packages.app.name]);
        info.assets.size = f.data[f.manifest.packages.app.name].length;
        f.data[f.manifest.packages.app.name + ".sha256"] = Buffer.from(
          info.assets.sha256,
        );
      }
      const u = updater(dir, async (url) => {
        const response = await f.fetchImpl(url);
        if (failure === "interrupted" && url.endsWith("-app.zip"))
          response.body = Readable.from(
            (async function* () {
              yield Buffer.from("part");
              throw Error("ECONNRESET original diagnostic");
            })(),
          );
        return response;
      });
      await u.download(info);
      assert.equal(u.state.phase, "ready");
      assert.equal(u.state.packageKind, "full");
      assert.ok(u.state.fallbackData.message);
      if (failure === "interrupted")
        assert.equal(
          u.state.fallbackData.message,
          "ECONNRESET original diagnostic",
        );
      assert.equal(u.state.total, f.manifest.packages.full.size);
      assert.ok(f.calls.some((url) => url.endsWith("-win-x64.zip")));
      unchanged(dir);
    }),
  );
}

test(
  "if both downloads fail, the previous version and earlier recovery copy remain usable",
  scratch(async (root) => {
    const f = fixture(root),
      dir = installed(root);
    const info = await checkForUpdate("1.6.1", f.fetchImpl, runtime);
    const u = updater(dir, async (url) => {
      if (url.endsWith("-app.zip")) throw Error("app network interrupted");
      if (url.endsWith("-win-x64.zip")) throw Error("full network interrupted");
      return f.fetchImpl(url);
    });
    await assert.rejects(u.download(info), /full network interrupted/);
    assert.equal(u.state.phase, "failed");
    assert.equal(u.state.fallbackData.message, "app network interrupted");
    assert.equal(u.state.errorData.message, "full network interrupted");
    assert.throws(() => u.install(), { code: "UPDATE_NOT_READY" });
    unchanged(dir);
  }),
);
