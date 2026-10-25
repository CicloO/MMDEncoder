const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  clipboard,
  shell,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const { createService } = require("../backend/service.cjs");
const {
  checkForUpdate,
  RELEASES_URL,
  PROJECT_PAGES,
  changelogSection,
} = require("../backend/update.cjs");
const { createUpdater } = require("../backend/selfupdate.cjs");
let win,
  service,
  updater,
  updateInfo = null,
  quitting = false;
const base = app.isPackaged
  ? path.dirname(app.getPath("exe"))
  : path.resolve(__dirname, "..");
const engineDir = process.env.MMD_ENCODER_ENGINES;
const dataDir = process.env.MMD_ENCODER_DATA || path.join(base, "data");
app.setPath("userData", path.join(dataDir, "electron"));
app.setName("MMDEncoder");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      win = new BrowserWindow({
        width: 1280,
        height: 900,
        minWidth: 650,
        minHeight: 600,
        title: "MMDEncoder",
        icon: path.join(__dirname, "../assets/icon.ico"),
        backgroundColor: "#f3f5f8",
        show: !process.env.MMD_ENCODER_TEST,
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      win.webContents.session.setPermissionRequestHandler(
        (_wc, _permission, callback) => callback(false),
      );
      updater = createUpdater({
        appDir: base,
        version: app.getVersion(),
        extractor: path.join(__dirname, "../assets/7za.exe"),
        logDir: path.join(dataDir, "logs"),
      });
      if (app.isPackaged) updater.cleanup();
      service = createService({
        engineDir,
        dataDir,
        toolsRoot:
          process.env.MMD_ENCODER_TOOLS_ROOT || process.env.MMD_ENCODER_TOOLS,
        onUpdate: (s) => {
          if (win && !win.isDestroyed())
            win.webContents.send("encoder:state", s);
        },
      });
      const { registerAction } = require("./actions.cjs");
      registerAction(ipcMain, async (event, action, payload) => {
        if (
          event.sender !== win.webContents ||
          event.senderFrame !== win.webContents.mainFrame
        )
          throw new Error("不受信任的界面");
        if (action === "quit") {
          await service.invoke("cancel");
          await service.invoke("trimCancel");
          const deadline = Date.now() + 5000;
          const busy = () => {
            const s = service.uiState();
            return s.running || s.trim?.running;
          };
          while (busy() && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 50));
          quitting = true;
          service.dispose();
          app.quit();
          return null;
        }
        if (action === "pickFiles") {
          const result = await dialog.showOpenDialog(win, {
            title: "添加视频",
            properties: ["openFile", "multiSelections"],
            filters: [
              {
                name: "视频文件",
                extensions: [
                  "avi",
                  "mov",
                  "mp4",
                  "mkv",
                  "webm",
                  "m4v",
                  "mpg",
                  "mpeg",
                  "mts",
                  "m2ts",
                  "wmv",
                  "flv",
                  "png",
                ],
              },
              {
                name: "PNG 图片序列（选其中任意一张）",
                extensions: ["png"],
              },
              { name: "所有文件", extensions: ["*"] },
            ],
          });
          return result.canceled
            ? service.uiState()
            : service.invoke("add", { paths: result.filePaths });
        }
        if (action === "pickMedia") {
          const result = await dialog.showOpenDialog(win, {
            title: "选择媒体文件",
            properties: payload?.multiple
              ? ["openFile", "multiSelections"]
              : ["openFile"],
            filters: [
              {
                name: "音视频文件",
                extensions: [
                  "avi",
                  "mov",
                  "mp4",
                  "mkv",
                  "webm",
                  "wav",
                  "flac",
                  "mp3",
                  "aac",
                  "m4a",
                  "opus",
                  "ogg",
                  "mka",
                ],
              },
              { name: "全部文件", extensions: ["*"] },
            ],
          });
          if (result.canceled) return null;
          return payload?.multiple ? result.filePaths : result.filePaths[0];
        }
        if (action === "pickMediaOutput") {
          const extensions = {
            wav: "wav",
            flac: "flac",
            aac: "m4a",
            opus: "opus",
            copy: "mka",
          };
          const ext =
            payload?.operation === "audio"
              ? extensions[payload.audioFormat] || "wav"
              : "mkv";
          const result = await dialog.showSaveDialog(win, {
            title: "选择新的输出文件",
            defaultPath: "输出." + ext,
            filters: [{ name: "输出文件", extensions: [ext] }],
          });
          return result.canceled ? null : result.filePath;
        }
        if (action === "pickDirectory") {
          const r = await dialog.showOpenDialog(win, {
            title: payload?.title || "选择统一输出目录",
            properties: ["openDirectory", "createDirectory"],
          });
          return r.canceled ? null : r.filePaths[0];
        }
        if (action === "copyCommand") {
          const p = await service.invoke("preview", payload);
          if (p.errors.length) throw new Error(p.errors.join("\n"));
          clipboard.writeText(p.command);
          return p;
        }
        if (action === "importPresetsFile") {
          const r = await dialog.showOpenDialog(win, {
            title: "导入预设",
            properties: ["openFile"],
            filters: [{ name: "JSON 预设", extensions: ["json"] }],
          });
          if (r.canceled) return { cancelled: true };
          let content;
          try {
            content = JSON.parse(await fs.readFile(r.filePaths[0], "utf8"));
          } catch {
            throw new Error(
              "无法读取预设 JSON。请检查文件格式，已有预设未被修改。",
            );
          }
          if (!Array.isArray(content) && content?.version !== 1)
            throw new Error("预设文件版本不受支持，请使用版本 1 的预设文件");
          return service.invoke("importPresets", {
            presets: Array.isArray(content) ? content : content.presets,
          });
        }
        if (action === "exportPresetsFile") {
          const r = await dialog.showSaveDialog(win, {
            title: "导出预设",
            defaultPath: "MMDEncoder-presets.json",
            filters: [{ name: "JSON 预设", extensions: ["json"] }],
          });
          if (r.canceled) return { cancelled: true };
          if (r.filePath)
            await fs.writeFile(
              r.filePath,
              JSON.stringify(
                {
                  version: 1,
                  presets: service.getState().presets.filter((p) => !p.builtin),
                },
                null,
                2,
              ),
              "utf8",
            );
          return service.uiState();
        }
        if (action === "mmdOpenLog") {
          const logs = path.join(
            process.env.LOCALAPPDATA || app.getPath("appData"),
            "MMDEncoder",
            "mmd-plugin",
            "logs",
          );
          await fs.mkdir(logs, { recursive: true });
          return shell.openPath(logs);
        }
        if (action === "mmdOpenLatest") {
          // The newest MMD export from the plugin's own history: select the
          // video (or its mask) in Explorer, or open its folder if both are gone.
          const history = path.join(
            process.env.LOCALAPPDATA || app.getPath("appData"),
            "MMDEncoder",
            "mmd-plugin",
            "exports.jsonl",
          );
          let last = null;
          try {
            const lines = (await fs.readFile(history, "utf8"))
              .trim()
              .split("\n");
            for (let i = lines.length - 1; i >= 0 && !last; i--) {
              try {
                const entry = JSON.parse(lines[i]);
                if (entry.output) last = entry;
              } catch {}
            }
          } catch {}
          if (!last) throw new Error("还没有 MMD 导出记录");
          const file = [last.output, last.mask].find(
            (f) => f && fsSync.existsSync(f),
          );
          if (file) {
            shell.showItemInFolder(file);
            return null;
          }
          const dir = path.dirname(last.output);
          if (!fsSync.existsSync(dir))
            throw new Error("上次导出的文件夹已不存在：" + dir);
          await shell.openPath(dir);
          return null;
        }
        if (action === "openDataFolder") {
          await fs.mkdir(dataDir, { recursive: true });
          return shell.openPath(dataDir);
        }
        if (action === "engineFolder") return engineDir;
        if (action === "appVersion") return app.getVersion();
        if (action === "checkAppUpdate") {
          updateInfo = await checkForUpdate(app.getVersion());
          const blocked = updater.supported();
          return {
            ...updateInfo,
            canInstall: !!updateInfo.assets && !blocked,
            installBlocked: blocked,
          };
        }
        if (action === "appUpdateStatus") return { ...updater.state };
        if (action === "downloadAppUpdate") {
          await updater.download(updateInfo);
          return { ...updater.state };
        }
        if (action === "installAppUpdate") {
          const s = service.getState();
          if (s.running || s.trim?.running || s.detecting || s.tools?.busy)
            throw new Error(
              "请等待当前压制、剪辑导出、检测或工具安装结束后再更新",
            );
          updater.install();
          quitting = true;
          service.dispose();
          app.quit();
          return null;
        }
        if (action === "aboutInfo") {
          // The packaged app has CHANGELOG.md beside the exe.
          const file = app.isPackaged
            ? path.join(base, "CHANGELOG.md")
            : path.join(base, "docs", "CHANGELOG.md");
          let notes = "";
          try {
            notes = changelogSection(
              await fs.readFile(file, "utf8"),
              app.getVersion(),
            );
          } catch {}
          return { version: app.getVersion(), notes };
        }
        if (action === "openProjectPage") {
          const url = PROJECT_PAGES[payload?.page];
          if (!url) throw new Error("未知的项目页面");
          await shell.openExternal(url);
          return null;
        }
        if (action === "openReleasePage") {
          const url = String(payload?.url || RELEASES_URL);
          if (url !== RELEASES_URL && !url.startsWith(RELEASES_URL + "/"))
            throw new Error("只能打开本项目的发行页");
          await shell.openExternal(url);
          return null;
        }
        if (action === "reveal") {
          const current = service.getState();
          const allowed = [
            ...current.jobs.flatMap((j) => [j.path, j.output, j.maskOutput]),
            ...current.mediaJobs.flatMap((j) => [
              j.path,
              j.audioPath,
              j.output,
            ]),
          ].filter(Boolean);
          if (!allowed.includes(payload?.path))
            throw new Error("只能打开当前任务的文件位置");
          shell.showItemInFolder(payload.path);
          return null;
        }
        const allowed = [
          "state",
          "compatibility",
          "testEnhancements",
          "mediaStart",
          "mediaSuggest",
          "mediaAdd",
          "mediaSetAudio",
          "trimAdd",
          "trimRemove",
          "trimDuplicate",
          "trimReorder",
          "trimSet",
          "trimFrame",
          "trimExport",
          "trimSmart",
          "trimCancel",
          "trimClear",
          "mediaLog",
          "mediaRemove",
          "mediaClearCompleted",
          "mediaRequeue",
          "hidePreset",
          "reorderPresets",
          "restoreBuiltinPresets",
          "resolvePresetConflict",
          "reorderJobs",
          "setSequenceFps",
          "mediaReorder",
          "mediaSetAlign",
          "mediaSetAudioOffset",
          "setAudioOffset",
          "alignPreview",
          "alignRun",
          "alignCancel",
          "mmdStatus",
          "mmdInstall",
          "mmdUninstall",
          "mmdExportSet",
          "mmdTest",
          "mmdRecover",
          "mmdDiscard",
          "setToolsRoot",
          "details",
          "detect",
          "checkTools",
          "installTools",
          "add",
          "remove",
          "setAudio",
          "setJobSettings",
          "clearCompleted",
          "settings",
          "start",
          "cancel",
          "retry",
          "requeue",
          "savePreset",
          "applyPreset",
          "deletePreset",
          "renamePreset",
          "preview",
          "logs",
        ];
        if (!allowed.includes(action)) throw new Error("不支持的操作");
        return service.invoke(action, payload);
      });
      await win.loadFile(path.join(__dirname, "../dist/index.html"));
      win.on("close", (event) => {
        if (!quitting) {
          event.preventDefault();
          win.webContents.send("encoder:close-request");
        }
      });
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
  app.on("before-quit", () => {
    quitting = true;
    service?.dispose();
  });
  app.on("window-all-closed", () => app.quit());
}
