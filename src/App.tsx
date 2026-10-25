import { useEffect, useRef, useState } from "react";
import {
  Sun,
  Moon,
  ArrowDownToLine,
  Plus,
  FolderOpen,
  Layers,
  Settings2,
  Check,
  RefreshCw,
  Bookmark,
  Cpu,
  LoaderCircle,
  Clapperboard,
} from "lucide-react";
import { Button, Field, Modal, useDragSort, PAGE_SIZE } from "./components";
import { MediaTools } from "./MediaTools";
import { TrimTools } from "./TrimTools";
import { EncodeQueue } from "./EncodeQueue";
import { autoAlign } from "./autoAlign";
import { MediaDetails } from "./MediaDetails";
import { EncodeFooter } from "./EncodeFooter";
import { VideoFeedback } from "./VideoFeedback";
import { VideoSettings } from "./VideoSettings";
import { AboutDialog } from "./AboutDialog";
import { VideoSettingsPanel } from "./VideoSettingsPanel";
import { PresetList } from "./PresetList";
import { MmdExportDialog } from "./MmdExportDialog";
import { createActions } from "./actions";
import { useMmdExport } from "./useMmdExport";
import { invoke } from "./ipc";
import { errorMessage, summaryMessage } from "./i18n";
import type { ErrorData, MessageDescriptor } from "./i18n";
import {
  engineLabel,
  presetLabel,
  formatSize,
  compatibilityErrors,
} from "./presentation";
import type { State, Settings, Preview, Job, Preset } from "./types";

// Which kind of encoder an id names, for encoders not detected here.
const encoderBackend = (id: string) =>
  id.startsWith("nvencc:")
    ? "nvencc"
    : id.endsWith("_nvenc")
      ? "nvenc"
      : id.endsWith("_qsv")
        ? "qsv"
        : id.endsWith("_amf")
          ? "amf"
          : "cpu";
// Audio files dropped on the video page replace a video's audio.
const AUDIO_EXT = /\.(wav|flac|mp3|aac|m4a|opus|ogg|mka)$/i;
export default function App() {
  // Light is the default. A new key so the old auto-saved "dark" default does not stick.
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("mmd-color-theme") === "dark"
        ? "dark"
        : "light";
    } catch {
      return "light";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("mmd-color-theme", theme);
    } catch {
      /* Theme still works for this session. */
    }
  }, [theme]);
  // Video page: line a replacement audio up with the video's own sound
  // when it is chosen (remembered per computer, like the theme).
  const [autoAlignAudio, setAutoAlignAudio] = useState(() => {
    try {
      return localStorage.getItem("mmd-auto-align") !== "off";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("mmd-auto-align", autoAlignAudio ? "on" : "off");
    } catch {
      /* Still applies for this session. */
    }
  }, [autoAlignAudio]);
  const [state, setState] = useState<State | null>(null),
    [compatibility, setCompatibility] = useState<{
      errors: string[];
      suggestions: { id: string; label: string; patch: Partial<Settings> }[];
    }>({ errors: [], suggestions: [] }),
    [draft, setDraft] = useState<Settings | null>(null),
    [workspace, setWorkspace] = useState("encode"),
    [details, setDetails] = useState<any>(null),
    [selected, setSelected] = useState(""),
    [page, setPage] = useState(0),
    [tab, setTab] = useState("encoding"),
    [modal, setModal] = useState(""),
    [noticeValue, setNotice] = useState<MessageDescriptor | string>(""),
    [errorValue, setError] = useState<ErrorData | string>(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [drag, setDrag] = useState(false),
    [mediaDrop, setMediaDrop] = useState<{ paths: string[]; seq: number }>(),
    [trimDrop, setTrimDrop] = useState<
      { paths: string[]; seq: number } | undefined
    >(),
    [presetId, setPresetId] = useState(""),
    [presetName, setPresetName] = useState(""),
    [log, setLog] = useState(""),
    [pendingPreset, setPendingPreset] = useState<Preset | null>(null),
    [pendingDelete, setPendingDelete] = useState<Preset | null>(null),
    [customFPS, setCustomFPS] = useState(false),
    [fallback, setFallback] = useState<Job | null>(null),
    [renameTarget, setRenameTarget] = useState<Preset | null>(null),
    [saveId, setSaveId] = useState("");
  const error = errorMessage(errorValue);
  const notice = summaryMessage(noticeValue);
  const initialized = useRef(false),
    seenInterrupted = useRef(new Set<string>()),
    stateRef = useRef<State | null>(null),
    lastNotice = useRef(""),
    draftRef = useRef<Settings | null>(null),
    // "" = the page's settings, else the id of the video being set on its own.
    draftTarget = useRef(""),
    previewSequence = useRef(0),
    saveChain = useRef(Promise.resolve()),
    autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [update, setUpdate] = useState<{
    checking: boolean;
    current?: string;
    latest?: string;
    newer?: boolean;
    url?: string;
    error?: string;
    canInstall?: boolean;
    installBlocked?: string;
  }>({ checking: false });
  // In-place update progress, mirrored from the main process.
  const [appUpdate, setAppUpdate] = useState({
    phase: "idle",
    received: 0,
    total: 0,
    error: "",
  });
  async function downloadUpdate() {
    setAppUpdate((s) => ({ ...s, phase: "downloading", error: "" }));
    const timer = setInterval(() => {
      window.encoder
        .invoke("appUpdateStatus")
        .then(setAppUpdate)
        .catch(() => {});
    }, 400);
    try {
      await window.encoder.invoke("downloadAppUpdate");
    } catch {
      /* The status below carries the error. */
    } finally {
      clearInterval(timer);
      setAppUpdate(await window.encoder.invoke("appUpdateStatus"));
    }
  }
  async function installUpdate() {
    setBusy(true);
    try {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      if (draftRef.current) await persist(draftRef.current);
      await window.encoder.invoke("installAppUpdate");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  async function checkUpdate(quiet = false) {
    setUpdate((u) => ({ ...u, checking: true, error: "" }));
    try {
      const r = await window.encoder.invoke("checkAppUpdate");
      setUpdate({ checking: false, ...r });
      if (r.newer) notify(`发现新版本 ${r.latest}，可在右上角“关于”中更新`);
    } catch (e) {
      const message = (e as Error).message.replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        "",
      );
      setUpdate((u) => ({
        ...u,
        checking: false,
        error: quiet ? "" : message,
      }));
    }
  }
  useEffect(() => {
    if (window.encoder) void checkUpdate(true);
  }, []);
  function notify(text: MessageDescriptor | string) {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 6000);
  }
  function receive(s: State) {
    setState(s);
    stateRef.current = s;
    if (s.notice && s.notice !== lastNotice.current) {
      lastNotice.current = s.notice;
      notify(s.noticeData?.message === s.notice ? s.noticeData : s.notice);
    }
    if (!initialized.current) {
      initialized.current = true;
      setDraft(s.settings);
      draftRef.current = s.settings;
      setPresetId(
        s.presets.find((p) => p.name === s.settings.presetName)?.id || "",
      );
      if (s.notice)
        setError(s.noticeData?.message === s.notice ? s.noticeData : s.notice);
      // An update changed built-ins the user had edited: ask once per start.
      if (s.presetConflicts?.length) setModal("conflicts");
    }
    // An MMD export was cut off (now, or before this start): open "MMD 导出"
    // where it can be finished, unless another dialog is in the way.
    const cut = s.mmd.interrupted || [];
    if (cut.some((x) => !seenInterrupted.current.has(x.id))) {
      cut.forEach((x) => seenInterrupted.current.add(x.id));
      setModal((m) => m || "mmd");
    }
  }
  useEffect(() => {
    if (!window.encoder) {
      setError(
        "请通过 MMDEncoder.exe 启动桌面应用，以访问本地视频和编码引擎。",
      );
      return;
    }
    const off = window.encoder.onUpdate(receive);
    const offClose = window.encoder.onCloseRequest(() => {
      if (stateRef.current?.running || stateRef.current?.trim?.running)
        setModal("close");
      else void flushAndQuit();
    });
    window.encoder
      .invoke("state")
      .then(receive)
      .catch((e) => setError(String(e.message)));
    return () => {
      off();
      offClose();
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);
  const installationPrompted = useRef(false);
  useEffect(() => {
    if (state?.located && !installationPrompted.current) {
      installationPrompted.current = true;
      if (!state.engineInfo.ffmpeg || !state.engineInfo.ffprobe)
        setModal("engines");
    }
  }, [state?.located]);
  const jobs = state?.jobs || [],
    job = jobs.find((j) => j.id === selected) || jobs[0],
    s = draft,
    activePreset = state?.presets.find((p) => p.id === presetId),
    engine = state?.engines.find((e) => e.id === s?.encoder),
    backend = engine?.backend || encoderBackend(s?.encoder || ""),
    pageCount = Math.max(1, Math.ceil(jobs.length / PAGE_SIZE));
  const sortJob = useDragSort(
    jobs.map((j) => j.id),
    (ids) => void call("reorderJobs", { ids }).catch(() => {}),
  );
  const presets = state?.presets || [];
  const sortPreset = useDragSort(
    presets.map((p) => p.id),
    (ids) => void call("reorderPresets", { ids }).catch(() => {}),
    true,
    { handle: true },
  );
  // Every preset shows unless the user hid it with the hide / show button.
  const presetHidden = (p: Preset) => p.hidden ?? false;
  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);
  function changed(next: Settings) {
    setDraft(next);
    draftRef.current = next;
  }
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    if (s) changed({ ...s, [key]: value });
  };
  useEffect(() => {
    let cancelled = false;
    if (s && window.encoder)
      window.encoder
        .invoke("compatibility", { settings: s })
        .then((result) => {
          if (!cancelled) setCompatibility(result);
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [s, state?.engines]);
  const { call, action } = createActions({
    request: invoke,
    onState: receive,
    onError: (text, data) => setError(data || text),
    onNotice: notify,
  });
  const {
    busy: mmdBusy,
    call: mmdCall,
    error: mmdError,
  } = useMmdExport(
    modal,
    createActions({
      request: invoke,
      onState: receive,
      onError: (text, data) => setError(data || text),
      onNotice: notify,
    }).call,
  );
  // Replace one video's audio, as the media page's merge does, and line it
  // up with the video's own sound when "自动对齐" is on and there is one.
  async function pickAudio(j: Job) {
    const file = await call("pickMedia", { multiple: false }).catch(() => null);
    if (typeof file === "string") await replaceAudio(j, file);
  }
  async function replaceAudio(row: Job, file: string) {
    let j = row;
    try {
      const r = await call("setAudio", { id: j.id, path: file }, "已替换音频");
      // The response is the current state: the row may be older (pushes
      // during an import come at most every 200 ms).
      j = r?.jobs?.find((x: Job) => x.id === j.id) || j;
    } catch {
      return;
    }
    if (!autoAlignAudio || !j.meta?.audio || j.sequence) return;
    const note = await autoAlign(j.path, file, (offset) =>
      call("setAudioOffset", { id: j.id, offset }),
    );
    notify(note || "已替换音频，并按视频自带的声音自动对齐");
  }
  // Dropped on the video page: videos join the queue; audio files replace
  // the audio of the selected video, or of the first one still without a
  // replacement (as the media page's merge pairs them).
  async function dropOnQueue(paths: string[]) {
    const audio = paths.filter((p) => AUDIO_EXT.test(p));
    const videos = paths.filter((p) => !audio.includes(p));
    let current = stateRef.current?.jobs || [];
    if (videos.length) {
      const r = await call("add", { paths: videos }).catch(() => null);
      current = r?.jobs || current;
    }
    const open = (j?: Job) =>
      !!j &&
      !j.audioPath &&
      !["encoding", "done"].includes(j.status) &&
      !!j.meta;
    for (const file of audio) {
      const chosen = current.find((j) => j.id === job?.id);
      const target = open(chosen) ? chosen : current.find((j) => open(j));
      if (!target) {
        setError("没有等待替换音频的视频，请先加入视频");
        break;
      }
      await replaceAudio(target, file);
      current = stateRef.current?.jobs || current;
    }
  }
  function persist(settings: Settings, to = draftTarget.current) {
    const task = saveChain.current
      .catch(() => {})
      .then(() =>
        to
          ? window.encoder.invoke("setJobSettings", { id: to, patch: settings })
          : window.encoder.invoke("settings", { patch: settings }),
      )
      .then((r: State) => {
        receive(r);
      });
    saveChain.current = task;
    return task;
  }
  async function flushAndQuit() {
    setBusy(true);
    try {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      if (draftRef.current) await persist(draftRef.current);
      await window.encoder.invoke("quit");
    } catch (e) {
      setError((e as Error).message);
      setModal("closeSaveError");
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!draft || !state) return;
    const seq = ++previewSequence.current;
    const timer = setTimeout(() => {
      persist(draft)
        .then(() =>
          job ? window.encoder.invoke("preview", { id: job.id }) : null,
        )
        .then((p) => {
          if (seq === previewSequence.current) {
            setPreview(p);
            setError("");
          }
        })
        .catch((e) => {
          if (seq === previewSequence.current) {
            setPreview(null);
            setError(e.message);
          }
        });
    }, 400);
    autoSaveTimer.current = timer;
    return () => clearTimeout(timer);
  }, [
    draft,
    job?.id,
    JSON.stringify(job?.meta),
    state?.enhancements.verified,
    state?.enhancements.signature,
  ]);
  // "单独设置": with it on for the selected video, the settings panel edits
  // that video's own settings; otherwise the page's. Switching between them
  // first saves what was being edited, then loads the other.
  const target = job?.ownSettings ? job.id : "";
  useEffect(() => {
    if (!state || draftTarget.current === target) return;
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
      if (draftRef.current && stillEditable(draftTarget.current))
        void persist(draftRef.current).catch(() => {});
    }
    draftTarget.current = target;
    const next = (target && job?.ownSettings) || state.settings;
    changed(next);
    setPresetId(
      state.presets.find((p) => p.name === next.presetName)?.id || "",
    );
    setCustomFPS(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  // A video's own settings are saved only while it still has them.
  function stillEditable(id: string) {
    return (
      !id || !!stateRef.current?.jobs.find((j) => j.id === id)?.ownSettings
    );
  }
  async function setOwn(on: boolean) {
    if (!job) return;
    // Turning it off drops the video's settings, unsaved edits included.
    if (!on && autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
    try {
      if (on && draftRef.current && !draftTarget.current)
        await persist(draftRef.current);
      await call(
        "setJobSettings",
        { id: job.id, own: on },
        on ? "已为这个视频开启单独设置" : "已关闭单独设置，改回跟随压制设置",
      );
    } catch {}
  }
  const modified = !!(
    s &&
    activePreset &&
    Object.keys(s).some(
      (k) =>
        !["outputMode", "outputDir", "presetName"].includes(k) &&
        s[k as keyof Settings] !== activePreset.settings[k as keyof Settings],
    )
  );
  const errors = [
    ...new Set([...(s ? compatibilityErrors(s) : []), ...compatibility.errors]),
  ];
  async function start() {
    if (!s) return;
    setBusy(true);
    try {
      await persist(s);
      await call("start");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function applyPreset(p: Preset) {
    try {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      await saveChain.current.catch(() => {});
      if (draftTarget.current) {
        // A video's own settings: the preset replaces them, keeping where to save.
        changed({
          ...p.settings,
          outputMode: draftRef.current?.outputMode ?? p.settings.outputMode,
          outputDir: draftRef.current?.outputDir ?? p.settings.outputDir,
          presetName: p.name,
        });
      } else {
        const result: State = await call("applyPreset", { id: p.id });
        changed(result.settings);
      }
      setPresetId(p.id);
      setCustomFPS(false);
      setPendingPreset(null);
      notify(`已应用“${p.name}”`);
    } catch {}
  }
  async function add() {
    setBusy(true);
    try {
      await call("pickFiles");
    } catch {
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    if (!job || !s) return;
    try {
      await persist(s);
      await call("copyCommand", { id: job.id }, "命令已复制到剪贴板");
    } catch {}
  }
  async function savePreset() {
    if (!s || !presetName.trim()) return;
    setBusy(true);
    try {
      await persist(s);
      const r: State = await call("savePreset", {
        name: presetName.trim(),
        ...(saveId ? { id: saveId } : {}),
        ...(draftTarget.current ? { settings: s } : {}),
      });
      changed(
        draftTarget.current
          ? { ...s, presetName: presetName.trim() }
          : r.settings,
      );
      setPresetId(
        r.presets.find((p) => p.name === presetName.trim())?.id || "",
      );
      setModal("");
      notify("预设已保存");
    } catch {
    } finally {
      setBusy(false);
    }
  }
  // Overwrite the selected preset with the current settings, keeping its name.
  async function overwritePreset() {
    if (!s || !activePreset) return;
    setBusy(true);
    try {
      await persist(s);
      const r: State = await call("savePreset", {
        id: activePreset.id,
        name: activePreset.name,
        ...(draftTarget.current ? { settings: s } : {}),
      });
      changed(
        draftTarget.current
          ? { ...s, presetName: activePreset.name }
          : r.settings,
      );
      setPresetId(activePreset.id);
      notify(`已保存到“${activePreset.name}”`);
    } catch {
    } finally {
      setBusy(false);
    }
  }
  async function renamePreset() {
    if (!renameTarget || !presetName.trim()) return;
    setBusy(true);
    try {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      if (draftRef.current) await persist(draftRef.current);
      const r: State = await call("renamePreset", {
        id: renameTarget.id,
        name: presetName.trim(),
      });
      changed({
        ...r.settings,
        presetName:
          presetId === renameTarget.id
            ? presetName.trim()
            : r.settings.presetName,
      });
      setRenameTarget(null);
      notify("预设名称已更新");
    } catch {
    } finally {
      setBusy(false);
    }
  }
  async function openLog(j: Job) {
    try {
      setLog(await call("logs", { id: j.id }));
      setModal("logs");
    } catch {}
  }
  async function pickDirectory() {
    try {
      const path = await call("pickDirectory");
      if (path) set("outputDir", path);
    } catch {}
  }
  if (!s || !state)
    return (
      <main className="startup">
        <div className="brand-icon">
          <Layers />
        </div>
        <h1>MMDEncoder</h1>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <p>
            <LoaderCircle className="spin" size={16} /> 正在读取配置…
          </p>
        )}
      </main>
    );
  const readyCount = jobs.filter(
      (j) => j.status === "ready" || (j.status === "invalid" && j.meta),
    ).length,
    doneCount = jobs.filter((j) => j.status === "done").length;
  return (
    <div
      className="app-shell"
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes("Files")) setDrag(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const paths = window.encoder.getPaths(Array.from(e.dataTransfer.files));
        if (!paths.length) return;
        if (workspace === "media") setMediaDrop({ paths, seq: Date.now() });
        else if (workspace === "trim") setTrimDrop({ paths, seq: Date.now() });
        else void dropOnQueue(paths);
      }}
    >
      <header className="app-header">
        <div className="brand">
          <span className="brand-icon">
            <Layers size={23} />
          </span>
          <div>
            <h1>
              MMD<span>Encoder</span>
            </h1>
            <p>让每一帧，恰到好处。</p>
          </div>
          <span className="version">{__APP_VERSION__}</span>
        </div>
        <div className="header-actions">
          <Button
            className="theme-toggle"
            aria-label={theme === "dark" ? "切换到白天模式" : "切换到黑夜模式"}
            title={theme === "dark" ? "切换到白天模式" : "切换到黑夜模式"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </Button>
          <Button onClick={() => setModal("engines")}>
            <span
              className={`status-dot ${state.detecting ? "pending" : ""}`}
            />
            {state.detecting
              ? "检测编码器…"
              : `${state.engines.length} 个可用编码器`}
          </Button>
          <Button onClick={() => setModal("presets")}>
            <Bookmark size={16} />
            预设管理
          </Button>
          <Button onClick={() => setModal("mmd")}>
            <Clapperboard size={16} />
            MMD 导出
          </Button>
          <Button
            className="about-button"
            title={update.newer ? `关于 · 新版本 ${update.latest}` : "关于"}
            aria-label={
              update.newer ? `关于，有新版本 ${update.latest}` : "关于"
            }
            onClick={() => setModal("about")}
          >
            <Settings2 size={18} />
            {update.newer && <span className="update-dot" aria-hidden="true" />}
          </Button>
        </div>
      </header>
      <nav className="workspace-tabs" aria-label="功能页">
        <Button
          aria-pressed={workspace === "encode"}
          onClick={() => {
            setError("");
            setWorkspace("encode");
          }}
        >
          视频压制
        </Button>
        <Button
          aria-pressed={workspace === "media"}
          onClick={() => {
            setError("");
            setWorkspace("media");
          }}
        >
          音视频提取与合并
        </Button>
        <Button
          aria-pressed={workspace === "trim"}
          onClick={() => {
            setError("");
            setWorkspace("trim");
          }}
        >
          无损剪辑
        </Button>
      </nav>
      {workspace === "trim" && (
        <div className="page">
          <TrimTools
            state={state}
            call={call}
            dropped={trimDrop}
            onDropHandled={() => setTrimDrop(undefined)}
          />
        </div>
      )}
      {workspace === "media" && (
        <div className="page">
          <MediaTools
            state={state}
            call={call}
            dropped={mediaDrop}
            // A drop is consumed once; the page remounts on every tab switch.
            onDropHandled={() => setMediaDrop(undefined)}
          />
        </div>
      )}
      <div className="page" hidden={workspace !== "encode"}>
        <div className="page-scroll">
          <main className="workspace">
            <EncodeQueue
              engines={state.engines}
              running={state.running}
              toolsBusy={!!state.tools?.busy}
              jobs={jobs}
              job={job}
              s={s}
              page={page}
              setPage={setPage}
              pageCount={pageCount}
              setSelected={setSelected}
              drag={drag}
              busy={busy}
              doneCount={doneCount}
              sortJob={sortJob}
              add={add}
              call={call}
              action={action}
              pickAudio={pickAudio}
              persist={persist}
              openLog={openLog}
              setDetails={setDetails}
              setModal={setModal}
              setError={setError}
              setTab={setTab}
              setFallback={setFallback}
            />
            <VideoSettingsPanel
              own={!!job?.ownSettings}
              ownDisabled={
                !job ||
                job.status === "encoding" ||
                (state.running && !!job.settings)
              }
              jobName={job?.name || ""}
              onOwn={setOwn}
              presets={presets}
              presetId={presetId}
              modified={modified}
              presetHidden={presetHidden}
              onSelectPreset={(id) => {
                const p = state.presets.find((p) => p.id === id);
                if (p) {
                  if (modified) setPendingPreset(p);
                  else void applyPreset(p);
                } else setPresetId("");
              }}
              hasActivePreset={!!activePreset}
              activePresetLabel={
                activePreset ? presetLabel(activePreset, presets) : ""
              }
              busy={busy}
              onOverwrite={() => void overwritePreset()}
              onSaveAs={() => {
                setSaveId("");
                setPresetName("");
                setModal("save");
              }}
              tab={tab}
              setTab={setTab}
            >
              <VideoSettings
                s={s}
                tab={tab}
                engine={engine}
                backend={backend}
                engines={state.engines}
                detecting={state.detecting}
                verification={state.enhancements}
                placebo={state.engineInfo.libplacebo}
                canTest={
                  !(
                    state.running ||
                    state.detecting ||
                    state.tools?.busy ||
                    state.enhancements.busy
                  )
                }
                job={
                  job
                    ? {
                        meta: job.meta,
                        audioPath: job.audioPath,
                        audioMeta: job.audioMeta,
                      }
                    : undefined
                }
                preview={preview}
                customFPS={customFPS}
                setCustomFPS={setCustomFPS}
                autoAlignAudio={autoAlignAudio}
                setAutoAlignAudio={setAutoAlignAudio}
                set={set}
                changed={changed}
                call={call}
                copy={copy}
                pickDirectory={pickDirectory}
              />
            </VideoSettingsPanel>
          </main>
        </div>
        <EncodeFooter
          s={s}
          job={job ? { meta: job.meta, audioPath: job.audioPath } : undefined}
          preview={preview}
          engine={engine}
          backend={backend}
          running={state.running}
          readyCount={readyCount}
          doneCount={doneCount}
          busy={busy}
          errorCount={errors.length}
          onCancel={() => action("cancel")}
          onStart={start}
        />
        {(!!error || errors.length > 0 || !!preview?.errors?.length) && (
          <VideoFeedback
            message={error || errors[0] || preview?.errors[0]}
            suggestions={compatibility.suggestions}
            running={state.running}
            onFix={async (fix) => {
              const next = { ...s, ...fix.patch };
              changed(next);
              try {
                await persist(next);
                notify("已应用兼容设置");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            onDismiss={() => setError("")}
          />
        )}
      </div>
      <Modal
        open={modal === "details"}
        onClose={() => setModal("")}
        title="文件详情"
        description="直接读取源文件与实际生成文件的 ffprobe 参数。"
        error={error}
        wide
      >
        <MediaDetails details={details} />
      </Modal>
      <div
        className={`toast ${notice ? "visible" : ""}`}
        role="status"
        aria-live="polite"
      >
        {notice && (
          <>
            <Check size={16} />
            {notice}
          </>
        )}
      </div>
      {drag && (
        <div className="drop-overlay">
          <ArrowDownToLine size={42} />
          <h2>
            {workspace === "media"
              ? "松开以选择媒体文件"
              : workspace === "trim"
                ? "松开以加入剪辑片段"
                : "松开以加入视频队列"}
          </h2>
        </div>
      )}
      <Modal
        error={error}
        open={modal === "save"}
        onClose={() => setModal("")}
        title="保存当前配置"
        description="把画质、音频和帧率保存为可重复使用的预设。输出目录单独记忆。"
      >
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void savePreset();
          }}
        >
          <Field id="preset-name" label="预设名称">
            <input
              id="preset-name"
              autoFocus
              maxLength={80}
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="例如：MMD · HEVC 30帧"
            />
          </Field>
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <Button onClick={() => setModal("")}>取消</Button>
            <Button
              variant="primary"
              disabled={busy || !presetName.trim()}
              type="submit"
            >
              保存预设
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        error={error}
        open={modal === "conflicts" && !!state.presetConflicts?.length}
        onClose={() => setModal("")}
        title="内置预设已更新"
        description="新版本改动了下面这些内置预设，而你之前修改过它们。内置预设已换成新版；你的修改可以丢弃，也可以另存为个人预设。关闭这个窗口后，下次打开软件还会再问。"
      >
        <div className="preset-list">
          {state.presetConflicts?.map((c) => (
            <div className="preset-item" key={c.id}>
              <div>
                <strong>
                  {state.presets.find((p) => p.id === c.id)
                    ? presetLabel(
                        state.presets.find((p) => p.id === c.id)!,
                        state.presets,
                      )
                    : c.builtinName}
                </strong>
                <small>你修改过的版本：{c.name}</small>
              </div>
              <Button
                onClick={() =>
                  call("resolvePresetConflict", { id: c.id, keep: false })
                }
              >
                用新版覆盖
              </Button>
              <Button
                variant="primary"
                onClick={() =>
                  call(
                    "resolvePresetConflict",
                    { id: c.id, keep: true },
                    "已另存为个人预设",
                  )
                }
              >
                保留我的版本
              </Button>
            </div>
          ))}
        </div>
      </Modal>
      <Modal
        error={error}
        open={modal === "presets"}
        onClose={() => setModal("")}
        fixedHeight
        title="预设管理"
        description="拖动排序；隐藏的预设不出现在预设下拉框里。内置预设也可以改名、更新或删除，随时可以恢复。导入导出只包含个人预设。"
      >
        <PresetList
          presets={presets}
          sort={sortPreset}
          hidden={presetHidden}
          onApply={(p) => {
            setModal("");
            if (modified) setPendingPreset(p);
            else void applyPreset(p);
          }}
          onRename={(p) => {
            setRenameTarget(p);
            setPresetName(p.name);
            setError("");
          }}
          onHide={(p) => {
            void call("hidePreset", {
              id: p.id,
              hidden: !presetHidden(p),
            }).catch(() => {});
          }}
          onDelete={setPendingDelete}
        />
        <div className="modal-actions">
          <Button
            onClick={() => action("importPresetsFile", undefined, "预设已导入")}
          >
            导入 JSON
          </Button>
          <Button
            onClick={() =>
              action("exportPresetsFile", undefined, "预设导出操作已完成")
            }
          >
            导出预设
          </Button>
          <Button
            onClick={() =>
              action("restoreBuiltinPresets", undefined, "内置预设已恢复")
            }
          >
            恢复内置预设
          </Button>
          {activePreset && (
            <Button
              onClick={() => {
                setSaveId(activePreset.id);
                setPresetName(activePreset.name);
                setModal("save");
              }}
            >
              用当前设置更新预设
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => {
              setSaveId("");
              setPresetName("");
              setModal("save");
            }}
          >
            <Plus size={15} />
            新建预设
          </Button>
        </div>
      </Modal>
      <MmdExportDialog
        error={mmdError || error}
        open={modal === "mmd"}
        onClose={() => setModal("")}
        mmd={state.mmd}
        presets={presets}
        busy={mmdBusy}
        onCall={mmdCall}
        action={action}
      />
      <AboutDialog
        open={modal === "about"}
        onClose={() => setModal("")}
        update={update}
        appUpdate={appUpdate}
        blocked={
          busy || state.running || state.trim?.running
            ? "请等待当前压制或剪辑导出结束后再更新"
            : ""
        }
        onCheck={() => void checkUpdate()}
        onDownload={() => void downloadUpdate()}
        onInstall={() => void installUpdate()}
        action={action}
      />
      <Modal
        error={error}
        open={modal === "engines"}
        onClose={() => setModal("")}
        fixedHeight
        title="编码引擎"
        description="首次使用从官方来源下载工具到本机；安装后可离线编码，无需管理员权限。"
      >
        {state.tools && (
          <section
            className="modal-section"
            aria-label="工具安装与更新"
            aria-busy={state.tools.busy}
          >
            <h3>编码工具</h3>
            <p className="hint">
              FFmpeg / ffprobe：Gyan · NVEncC：rigaya / GitHub
            </p>
            {state.tools.phase === "downloading" && (
              <p>
                {formatSize(state.tools.received)}
                {state.tools.total
                  ? ` / ${formatSize(state.tools.total)}`
                  : " · 总大小待服务器确认"}
              </p>
            )}
            <Field id="tools-root" label="安装位置">
              <div className="path-picker">
                <input
                  id="tools-root"
                  value={state.tools.root}
                  readOnly
                  title={state.tools.root}
                />
                <Button
                  disabled={
                    state.tools.busy ||
                    state.running ||
                    state.trim.running ||
                    state.detecting
                  }
                  title="已安装的工具会一起移到新位置；选择已装有本软件工具的文件夹则直接使用"
                  onClick={async () => {
                    try {
                      const dir = await call("pickDirectory", {
                        title: "选择编码工具安装位置",
                      });
                      if (dir)
                        await call(
                          "setToolsRoot",
                          { root: dir },
                          "已更改编码工具安装位置",
                        );
                    } catch {}
                  }}
                >
                  <FolderOpen size={15} />
                  更改位置
                </Button>
                <Button
                  disabled={
                    state.tools.busy ||
                    state.running ||
                    state.trim.running ||
                    state.detecting
                  }
                  onClick={() =>
                    action("setToolsRoot", { root: "" }, "已恢复默认安装位置")
                  }
                >
                  恢复默认
                </Button>
              </div>
            </Field>
            <div className="status-row">
              <div>
                <p role={state.tools.phase === "error" ? "alert" : "status"}>
                  {state.tools.message}
                </p>
                <p className="hint">
                  {Object.entries(state.tools.installed)
                    .map(
                      ([id, tool]) =>
                        `${id} ${tool.version}（${tool.verifiedHash ? "发布 SHA-256 已验证" : "发布方未提供校验值"}）`,
                    )
                    .join(" · ") || "尚未安装编码工具"}
                </p>
              </div>
              <div className="row-actions">
                <Button
                  disabled={
                    state.tools.busy ||
                    state.running ||
                    state.trim.running ||
                    state.detecting
                  }
                  onClick={() => action("checkTools")}
                >
                  检查工具更新
                </Button>
                <Button
                  disabled={
                    state.tools.busy ||
                    state.running ||
                    state.trim.running ||
                    state.detecting
                  }
                  onClick={() => action("installTools")}
                >
                  {state.tools.busy
                    ? "正在处理…"
                    : state.tools.phase === "error"
                      ? "重试下载并安装"
                      : "下载并安装最新工具"}
                </Button>
              </div>
            </div>
            {(state.running || state.trim.running) && (
              <p>编码或剪辑导出结束后可更新工具。</p>
            )}
          </section>
        )}
        <div className="engine-list">
          {state.engines.map((e) => (
            <div className="engine-item" key={e.id}>
              <Cpu size={17} />
              <strong>{engineLabel(e)}</strong>
              <span>
                <Check size={14} />
                可用
              </span>
            </div>
          ))}
        </div>
        {state.detecting && (
          <p role="status">
            <LoaderCircle size={16} className="spin" /> 正在测试硬件编码能力…
          </p>
        )}
        {!state.detecting && !state.engines.length && (
          <p className="inline-error">
            尚无可用编码器。请下载编码工具，或在安装完成后重新检测。
          </p>
        )}
        <details className="engine-paths">
          <summary>引擎位置</summary>
          {Object.entries(state.engineInfo).map(([key, value]) => (
            <p key={key}>
              <strong>{key}</strong>
              <code>{value || "未找到"}</code>
            </p>
          ))}
        </details>
        <div className="modal-actions">
          <Button onClick={() => action("openDataFolder")}>配置与日志</Button>
          <Button
            onClick={async () => {
              try {
                setLog(await call("logs", {}));
                setModal("logs");
              } catch {}
            }}
          >
            检测日志与版本
          </Button>
          <Button
            disabled={state.detecting || state.running}
            onClick={() => action("detect")}
          >
            <RefreshCw size={15} />
            重新检测
          </Button>
        </div>
      </Modal>
      <Modal
        error={error}
        open={modal === "logs"}
        onClose={() => setModal("")}
        title="任务日志"
        description="日志记录实际执行命令及引擎输出，可用于定位失败参数。"
      >
        <pre className="log-view">{log || "此任务暂无编码日志。"}</pre>
      </Modal>
      <Modal
        error={error}
        open={!!pendingPreset}
        onClose={() => setPendingPreset(null)}
        title="切换编码预设"
        description="当前配置有未保存到预设的修改。切换将替换当前编码设置，输出目录保留。"
      >
        <div className="modal-actions">
          <Button onClick={() => setPendingPreset(null)} autoFocus>
            保留当前设置
          </Button>
          <Button
            variant="primary"
            onClick={() => pendingPreset && applyPreset(pendingPreset)}
          >
            应用“{pendingPreset ? presetLabel(pendingPreset, presets) : ""}”
          </Button>
        </div>
      </Modal>
      <Modal
        error={error}
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title="删除个人预设"
        description={
          pendingDelete?.builtin
            ? `删除内置预设“${presetLabel(pendingDelete, presets)}”后，可在预设管理中点“恢复内置预设”找回。`
            : `删除“${pendingDelete?.name || ""}”后无法恢复。不会影响视频文件。`
        }
      >
        <div className="modal-actions">
          <Button autoFocus onClick={() => setPendingDelete(null)}>
            取消
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              try {
                await call("deletePreset", { id: pendingDelete?.id });
                setPendingDelete(null);
                notify("预设已删除");
              } catch {}
            }}
          >
            删除预设
          </Button>
        </div>
      </Modal>
      <Modal
        error={error}
        open={!!fallback}
        onClose={() => setFallback(null)}
        title="改用软件编码重试"
        description="软件编码速度通常更慢。CQ 与 CRF 不等效，重试将使用软件编码预设，并保留可兼容的输出设置。"
      >
        <p>
          重试参数：
          {fallback?.settings?.encoder.includes("hevc")
            ? "HEVC · libx265"
            : fallback?.settings?.encoder.includes("av1")
              ? "AV1 · libsvtav1"
              : "H.264 · libx264"}
          ，CRF 18，
          {fallback?.settings?.encoder.includes("av1") ? "预设 6" : "medium"}
          ；关闭硬件前向分析。分辨率、帧率、音频和位深保持原任务设置；不兼容项会要求调整。
        </p>
        <div className="modal-actions">
          <Button onClick={() => setFallback(null)}>取消</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await call("retry", { id: fallback?.id, software: true });
                setFallback(null);
              } catch {}
            }}
          >
            软件编码重试
          </Button>
        </div>
      </Modal>
      <Modal
        error={error}
        open={!!renameTarget}
        onClose={() => setRenameTarget(null)}
        title="修改预设名称"
        description="仅修改名称，已保存的编码参数保持不变。"
      >
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void renamePreset();
          }}
        >
          <Field id="rename-preset" label="预设名称">
            <input
              id="rename-preset"
              value={presetName}
              maxLength={80}
              onChange={(e) => setPresetName(e.target.value)}
            />
          </Field>
          <div className="modal-actions">
            <Button onClick={() => setRenameTarget(null)}>取消</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !presetName.trim()}
            >
              保存名称
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        error={error}
        open={modal === "close"}
        onClose={() => setModal("")}
        title="退出 MMDEncoder"
        description="队列或剪辑导出仍在运行。退出将取消未完成任务，保留原视频和已完成输出。"
      >
        <div className="modal-actions">
          <Button autoFocus onClick={() => setModal("")}>
            继续压制
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void flushAndQuit()}
          >
            取消任务并退出
          </Button>
        </div>
      </Modal>
      <Modal
        error={error}
        open={modal === "closeSaveError"}
        onClose={() => setModal("")}
        title="设置尚未保存"
        description="最后一次修改未能保存。可以返回调整，也可以放弃这次修改并退出。"
      >
        <div className="modal-actions">
          <Button autoFocus onClick={() => setModal("")}>
            返回调整
          </Button>
          <Button variant="danger" onClick={() => action("quit")}>
            不保存并退出
          </Button>
        </div>
      </Modal>
    </div>
  );
}
