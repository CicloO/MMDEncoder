"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { Readable, Transform } = require("node:stream");
const {
  appError,
  serializeError,
  sourceText,
  summary,
} = require("./errors.cjs");
const HOSTS = new Set([
  "www.gyan.dev",
  "api.github.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
function trusted(url) {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    !HOSTS.has(u.hostname) ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443")
  )
    throw appError("TOOLS_UNTRUSTED_HOST", { host: u.hostname });
  return u.href;
}
async function request(url, options = {}, count = 0) {
  trusted(url);
  const response = await fetch(url, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(options.download ? 3600000 : 120000),
    headers: { "User-Agent": "MMDEncoder/1.1.0", ...options.headers },
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (count >= 5) throw appError("TOOLS_TOO_MANY_REDIRECTS");
    await response.body?.cancel();
    return request(
      new URL(response.headers.get("location"), url).href,
      options,
      count + 1,
    );
  }
  if (!response.ok)
    throw appError("TOOLS_HTTP_STATUS", { status: response.status });
  return response;
}
async function releases() {
  const base = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z";
  const version = (await (await request(base + ".ver")).text()).trim();
  const hash = (await (await request(base + ".sha256")).text()).match(
    /\b[a-f0-9]{64}\b/i,
  )?.[0];
  if (!hash || !version || version.length > 100)
    throw appError("TOOLS_FFMPEG_RELEASE_INVALID");
  const release = await (
    await request("https://api.github.com/repos/rigaya/NVEnc/releases/latest")
  ).json();
  const asset = release.assets?.find((a) =>
    /^NVEncC.*x64.*\.7z$/i.test(a.name),
  );
  if (!asset || !release.tag_name) throw appError("TOOLS_NVENCC_ASSET_MISSING");
  trusted(asset.browser_download_url);
  return [
    { id: "ffmpeg", version, url: base, sha256: hash.toLowerCase() },
    {
      id: "nvencc",
      version: release.tag_name,
      url: asset.browser_download_url,
      sha256: asset.digest?.startsWith("sha256:")
        ? asset.digest.slice(7).toLowerCase()
        : null,
    },
  ];
}
function execute(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => child.kill(), 120000);
    let overflow = false;
    const collect = (b) => {
      out += b;
      if (out.length > 8 * 1024 * 1024) {
        overflow = true;
        child.kill();
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      overflow
        ? reject(appError("TOOLS_OUTPUT_OVERFLOW"))
        : code === 0
          ? resolve(out)
          : reject(
              out
                ? Error(out.slice(-20000))
                : appError("TOOLS_VERIFY_EXIT", { exitCode: code }),
            );
    });
  });
}
function find(root, name) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isSymbolicLink()) throw appError("TOOLS_UNSUPPORTED_LINK");
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
    if (e.isDirectory()) {
      const result = find(p, name);
      if (result) return result;
    }
  }
}
const DEFAULT_ROOT = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "MMDEncoder",
  "tools",
);
function createTools({
  root = DEFAULT_ROOT,
  onUpdate = () => {},
  resolveReleases = releases,
  downloadRequest = request,
  extract = execute,
  verify = execute,
  extractor,
} = {}) {
  let busy = false;
  root = path.resolve(root);
  function messagePatch(code, params = {}) {
    const messageData = summary(code, params);
    return { message: messageData.message, messageData, errorData: null };
  }
  const state = {
    busy: false,
    phase: "idle",
    ...messagePatch("TOOLS_FIRST_USE"),
    received: 0,
    total: 0,
    installed: {},
    available: [],
    root,
  };
  try {
    state.installed = JSON.parse(
      fs.readFileSync(path.join(root, "active.json"), "utf8"),
    );
  } catch {}
  if (Object.keys(state.installed).length)
    Object.assign(state, messagePatch("TOOLS_INSTALLED_OFFLINE"));
  function paths() {
    const result = {};
    for (const [id, item] of Object.entries(state.installed)) {
      if (!/^[a-zA-Z0-9-]+$/.test(item.directory)) continue;
      const dir = path.join(root, item.directory);
      for (const name of id === "ffmpeg" ? ["ffmpeg", "ffprobe"] : ["nvencc"]) {
        const exe =
          name === "nvencc"
            ? findSafe(dir, "NVEncC64.exe") || findSafe(dir, "NVEncC.exe")
            : findSafe(dir, name + ".exe");
        if (exe) result[name] = exe;
      }
    }
    return result;
  }
  function findSafe(dir, name) {
    try {
      return find(dir, name);
    } catch {
      return null;
    }
  }
  function emit(patch) {
    Object.assign(state, patch);
    onUpdate({ ...state });
  }
  async function installArchive(stage, archive, release, digest) {
    emit({
      phase: "extracting",
      ...messagePatch("TOOLS_EXTRACTING", { id: release.id }),
    });
    const unpack = path.join(stage, "unpacked");
    fs.mkdirSync(unpack);
    const seven = extractor || path.resolve(__dirname, "../assets/7za.exe");
    // List first: reject traversal/link entries before any archive data is extracted.
    const listing = await extract(seven, ["l", "-slt", archive]);
    for (const line of String(listing).split(/\r?\n/)) {
      if (line.startsWith("Path = ")) {
        const entry = line.slice(7);
        if (entry === archive) continue;
        if (
          path.win32.isAbsolute(entry) ||
          entry.includes(":") ||
          entry.split(/[\\/]/).includes("..")
        )
          throw appError("TOOLS_UNSAFE_ARCHIVE_PATH");
      }
      if (/^(Symbolic Link|Hard Link) = /i.test(line))
        throw appError("TOOLS_ARCHIVE_LINK");
    }
    await extract(seven, ["x", "-y", "-o" + unpack, archive]);
    for (const name of release.id === "ffmpeg"
      ? ["ffmpeg.exe", "ffprobe.exe"]
      : ["NVEncC.exe"]) {
      const exe =
        find(unpack, name) ||
        (name === "NVEncC.exe" && find(unpack, "NVEncC64.exe"));
      if (!exe) throw appError("TOOLS_EXECUTABLE_MISSING", { name });
      await verify(exe, [name === "NVEncC.exe" ? "--version" : "-version"]);
    }
    const directory = release.id + "-" + crypto.randomUUID();
    fs.renameSync(unpack, path.join(root, directory));
    const installed = {
      ...state.installed,
      [release.id]: {
        version: release.version,
        directory,
        sha256: digest,
        verifiedHash: !!release.sha256,
        url: release.url,
      },
    };
    const temporary = path.join(
      root,
      "active-" + crypto.randomUUID() + ".json",
    );
    fs.writeFileSync(temporary, JSON.stringify(installed, null, 2));
    fs.renameSync(temporary, path.join(root, "active.json"));
    emit({ installed });
  }
  async function run(install = false) {
    if (busy) throw appError("TOOLS_BUSY");
    busy = true;
    emit({
      busy: true,
      phase: "checking",
      ...messagePatch("TOOLS_CHECKING"),
      received: 0,
      total: 0,
    });
    try {
      const available = await resolveReleases();
      emit({ available });
      if (!install) {
        emit({
          phase: "ready",
          ...messagePatch(
            available.some((r) => state.installed[r.id]?.version !== r.version)
              ? "TOOLS_UPDATE_AVAILABLE"
              : "TOOLS_UP_TO_DATE",
          ),
        });
        return;
      }
      fs.mkdirSync(root, { recursive: true });
      for (const release of available) {
        if (
          state.installed[release.id]?.version === release.version &&
          (release.id === "ffmpeg"
            ? paths().ffmpeg && paths().ffprobe
            : paths().nvencc)
        )
          continue;
        const stage = fs.mkdtempSync(path.join(root, "staging-"));
        try {
          emit({
            phase: "downloading",
            ...messagePatch("TOOLS_DOWNLOADING", {
              id: release.id,
              version: release.version,
            }),
            received: 0,
            total: 0,
          });
          trusted(release.url);
          const response = await downloadRequest(release.url, {
            download: true,
          });
          const total = Number(response.headers.get("content-length")) || 0;
          let received = 0;
          const hash = crypto.createHash("sha256");
          const archive = path.join(stage, "package.7z");
          await pipeline(
            Readable.fromWeb(response.body),
            new Transform({
              transform(chunk, _encoding, cb) {
                received += chunk.length;
                hash.update(chunk);
                emit({ received, total });
                cb(null, chunk);
              },
            }),
            fs.createWriteStream(archive, { flags: "wx" }),
          );
          const digest = hash.digest("hex");
          if (release.sha256 && digest !== release.sha256)
            throw appError("TOOLS_CHECKSUM_MISMATCH");
          await installArchive(stage, archive, release, digest);
        } finally {
          fs.rmSync(stage, { recursive: true, force: true });
        }
      }
      emit({ phase: "ready", ...messagePatch("TOOLS_INSTALLED") });
    } catch (e) {
      const errorData = serializeError(e);
      emit({
        phase: "error",
        message: sourceText("engine.failureRetry", {
          detail: errorData.message,
        }),
        messageData: null,
        errorData,
      });
      throw e;
    } finally {
      busy = false;
      emit({ busy: false });
    }
  }
  function load() {
    try {
      state.installed = JSON.parse(
        fs.readFileSync(path.join(root, "active.json"), "utf8"),
      );
    } catch {
      state.installed = {};
    }
  }
  // Every tool folder the manifest in dir names exists.
  function complete(dir) {
    try {
      const active = JSON.parse(
        fs.readFileSync(path.join(dir, "active.json"), "utf8"),
      );
      const entries = Object.values(active);
      return (
        entries.length > 0 &&
        entries.every(
          (e) => e?.directory && fs.existsSync(path.join(dir, e.directory)),
        )
      );
    } catch {
      return false;
    }
  }
  // Rename, or copy then delete across drives; a failed copy leaves nothing.
  function move(from, to) {
    try {
      fs.renameSync(from, to);
    } catch (e) {
      if (e.code !== "EXDEV") throw e;
      try {
        fs.cpSync(from, to, { recursive: true, errorOnExist: true });
      } catch (c) {
        fs.rmSync(to, { recursive: true, force: true });
        throw c;
      }
      fs.rmSync(from, { recursive: true, force: true });
    }
  }
  // Switch the install folder. Installed tools are moved along (a folder that
  // already holds an installation is reused instead); an empty target is fine.
  function relocate(target) {
    if (busy) throw appError("TOOLS_BUSY");
    if (typeof target !== "string" || !path.isAbsolute(target))
      throw appError("TOOLS_ROOT_INVALID");
    target = path.resolve(target);
    if (target.toLowerCase() === root.toLowerCase()) return state;
    if (
      target.toLowerCase().startsWith(root.toLowerCase() + path.sep) ||
      root.toLowerCase().startsWith(target.toLowerCase() + path.sep)
    )
      throw appError("TOOLS_ROOT_OVERLAP");
    busy = true;
    try {
      // A folder counts as an installation only when every tool its manifest
      // names is really there; a half-moved one does not.
      const existing = complete(target);
      if (!existing && fs.existsSync(path.join(target, "active.json")))
        throw appError("TOOLS_ROOT_INCOMPLETE");
      fs.mkdirSync(target, { recursive: true });
      const probe = path.join(target, ".write-test");
      fs.writeFileSync(probe, "");
      fs.rmSync(probe);
      const installed = fs.existsSync(path.join(root, "active.json"));
      if (installed && !existing) {
        if (fs.readdirSync(target).length)
          throw appError("TOOLS_ROOT_NOT_EMPTY");
        // Tools first, the manifest last: until it moves, the old place is
        // still a working installation. Any failure moves everything back.
        const names = fs
          .readdirSync(root)
          .sort((x, y) => (x === "active.json") - (y === "active.json"));
        const moved = [];
        try {
          for (const name of names) {
            move(path.join(root, name), path.join(target, name));
            moved.push(name);
          }
        } catch (e) {
          for (const name of moved.reverse())
            try {
              move(path.join(target, name), path.join(root, name));
            } catch {}
          const error = serializeError(e);
          const wrapper = appError("TOOLS_MOVE_FAILED", {
            detail: error.message,
          });
          wrapper.params = { error };
          throw wrapper;
        }
      }
      root = target;
      load();
      emit({
        root,
        ...messagePatch(
          Object.keys(state.installed).length
            ? "TOOLS_INSTALLED_OFFLINE"
            : "TOOLS_FIRST_USE",
        ),
      });
      return state;
    } finally {
      busy = false;
    }
  }
  return { state, paths, run, relocate };
}
module.exports = { createTools, trusted, releases, DEFAULT_ROOT };
