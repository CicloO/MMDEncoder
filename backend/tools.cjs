"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { Readable, Transform } = require("node:stream");
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
    throw Error("下载来源不受信任：" + u.hostname);
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
    if (count >= 5) throw Error("下载重定向过多");
    await response.body?.cancel();
    return request(
      new URL(response.headers.get("location"), url).href,
      options,
      count + 1,
    );
  }
  if (!response.ok) throw Error("下载服务器返回 " + response.status);
  return response;
}
async function releases() {
  const base = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z";
  const version = (await (await request(base + ".ver")).text()).trim();
  const hash = (await (await request(base + ".sha256")).text()).match(
    /\b[a-f0-9]{64}\b/i,
  )?.[0];
  if (!hash || !version || version.length > 100)
    throw Error("FFmpeg 发布校验信息无效");
  const release = await (
    await request("https://api.github.com/repos/rigaya/NVEnc/releases/latest")
  ).json();
  const asset = release.assets?.find((a) =>
    /^NVEncC.*x64.*\.7z$/i.test(a.name),
  );
  if (!asset || !release.tag_name)
    throw Error("NVEncC 发布中未找到 Windows x64 包");
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
        ? reject(Error("工具输出超过安全限制"))
        : code === 0
          ? resolve(out)
          : reject(Error(out.slice(-20000) || "工具验证失败：" + code));
    });
  });
}
function find(root, name) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isSymbolicLink()) throw Error("工具包包含不支持的链接");
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
  const state = {
    busy: false,
    phase: "idle",
    message: "首次使用请下载编码工具",
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
    state.message = "已安装编码工具，可离线使用；可检查官方更新";
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
  async function run(install = false) {
    if (busy) throw Error("工具安装或检查正在进行");
    busy = true;
    emit({
      busy: true,
      phase: "checking",
      message: "正在检查官方最新版本…",
      received: 0,
      total: 0,
    });
    try {
      const available = await resolveReleases();
      emit({ available });
      if (!install) {
        emit({
          phase: "ready",
          message: available.some(
            (r) => state.installed[r.id]?.version !== r.version,
          )
            ? "有可安装的新版本"
            : "已安装最新版本",
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
            message: "正在下载 " + release.id + " " + release.version,
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
            throw Error("SHA-256 校验失败");
          emit({
            phase: "extracting",
            message: "正在解压并验证 " + release.id,
          });
          const unpack = path.join(stage, "unpacked");
          fs.mkdirSync(unpack);
          const seven =
            extractor || path.resolve(__dirname, "../assets/7za.exe");
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
                throw Error("工具包包含不安全路径");
            }
            if (/^(Symbolic Link|Hard Link) = /i.test(line))
              throw Error("工具包包含链接");
          }
          await extract(seven, ["x", "-y", "-o" + unpack, archive]);
          for (const name of release.id === "ffmpeg"
            ? ["ffmpeg.exe", "ffprobe.exe"]
            : ["NVEncC.exe"]) {
            const exe =
              find(unpack, name) ||
              (name === "NVEncC.exe" && find(unpack, "NVEncC64.exe"));
            if (!exe) throw Error("工具包缺少 " + name);
            await verify(exe, [
              name === "NVEncC.exe" ? "--version" : "-version",
            ]);
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
        } finally {
          fs.rmSync(stage, { recursive: true, force: true });
        }
      }
      emit({ phase: "ready", message: "编码工具已安装，可离线使用" });
    } catch (e) {
      emit({
        phase: "error",
        message: e.message + "；可重试，已安装版本继续可用",
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
  // Switch the install folder. Installed tools are moved along (a folder that
  // already holds an installation is reused instead); an empty target is fine.
  function relocate(target) {
    if (busy) throw Error("工具安装或检查正在进行");
    if (typeof target !== "string" || !path.isAbsolute(target))
      throw Error("请选择有效的安装位置");
    target = path.resolve(target);
    if (target.toLowerCase() === root.toLowerCase()) return state;
    if (
      target.toLowerCase().startsWith(root.toLowerCase() + path.sep) ||
      root.toLowerCase().startsWith(target.toLowerCase() + path.sep)
    )
      throw Error("新位置不能在当前安装位置之内或之上");
    busy = true;
    try {
      const existing = fs.existsSync(path.join(target, "active.json"));
      fs.mkdirSync(target, { recursive: true });
      const probe = path.join(target, ".write-test");
      fs.writeFileSync(probe, "");
      fs.rmSync(probe);
      const installed = fs.existsSync(path.join(root, "active.json"));
      if (installed && !existing) {
        if (fs.readdirSync(target).length)
          throw Error("新位置需要是空文件夹，或已有本软件安装的编码工具");
        for (const name of fs.readdirSync(root)) {
          const from = path.join(root, name),
            to = path.join(target, name);
          try {
            fs.renameSync(from, to);
          } catch (e) {
            if (e.code !== "EXDEV") throw e;
            fs.cpSync(from, to, { recursive: true, errorOnExist: true });
            fs.rmSync(from, { recursive: true, force: true });
          }
        }
      }
      root = target;
      load();
      emit({
        root,
        message: Object.keys(state.installed).length
          ? "已安装编码工具，可离线使用；可检查官方更新"
          : "首次使用请下载编码工具",
      });
      return state;
    } finally {
      busy = false;
    }
  }
  return { state, paths, run, relocate };
}
module.exports = { createTools, trusted, releases, DEFAULT_ROOT };
