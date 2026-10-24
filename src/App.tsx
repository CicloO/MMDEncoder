import { useEffect, useRef, useState } from "react";
import {
  Sun,
  Moon,
  ArrowRight,
  ArrowDownToLine,
  Plus,
  FolderOpen,
  Layers,
  Settings2,
  SlidersHorizontal,
  Copy,
  Check,
  Trash2,
  RefreshCw,
  Play,
  Square,
  Bookmark,
  Info,
  Cpu,
  X,
  LoaderCircle,
  Folder,
  Save,
  FilePlus2,
  Clapperboard,
  Eye,
  EyeOff,
  GripVertical,
} from "lucide-react";
import {
  Button,
  Field,
  Select,
  Modal,
  useDragSort,
  PAGE_SIZE,
} from "./components";
import { MediaTools } from "./MediaTools";
import { TrimTools } from "./TrimTools";
import { EncodeQueue } from "./EncodeQueue";
import { autoAlign } from "./autoAlign";
import { MediaDetails } from "./MediaDetails";
import { RtxSettings } from "./RtxSettings";
import { AboutDialog } from "./AboutDialog";
import {
  formatFPS,
  formatSize,
  audioLabels,
  compatibilityErrors,
  fadeOptions,
  fadeHint,
} from "./presentation";
import type { State, Settings, Preview, Job, Preset } from "./types";

const options = (values: string[]) =>
  values.map((value) => ({ value, label: value }));
const frameOptions = [
  { value: "source", label: "保持源帧率" },
  ...["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"].map((v) => ({
    value:
      (
        {
          "23.976": "24000/1001",
          "29.97": "30000/1001",
          "59.94": "60000/1001",
        } as Record<string, string>
      )[v] || v,
    label: `${v} FPS`,
  })),
  { value: "custom", label: "自定义帧率" },
];
// Presets an MMD export cannot use yet (mirrors backend/mmd-export.cjs).
function mmdUnsupported(p: Preset) {
  if (
    p.settings.alphaMode !== "mask" &&
    p.settings.encoder.startsWith("nvencc:")
  )
    return "NVEncC 暂不支持";
  return "";
}
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
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
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
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
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
  function notify(text: string) {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 6000);
  }
  function receive(s: State) {
    setState(s);
    stateRef.current = s;
    if (s.notice && s.notice !== lastNotice.current) {
      lastNotice.current = s.notice;
      notify(s.notice);
    }
    if (!initialized.current) {
      initialized.current = true;
      setDraft(s.settings);
      draftRef.current = s.settings;
      setPresetId(
        s.presets.find((p) => p.name === s.settings.presetName)?.id || "",
      );
      if (s.notice) setError(s.notice);
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
  async function call(action: string, payload?: unknown, message?: string) {
    setError("");
    try {
      const result = await window.encoder.invoke(action, payload);
      if (result?.jobs) receive(result);
      if (message && !result?.cancelled) notify(message);
      return result;
    } catch (e) {
      setError(
        (e as Error).message.replace(
          /^Error invoking remote method '[^']+': (?:Error: )?/,
          "",
        ),
      );
      throw e;
    }
  }
  // MMD export plugin actions run one at a time (install, test encode, …).
  const [mmdBusy, setMmdBusy] = useState(false);
  async function mmdCall(
    actionName: string,
    payload?: unknown,
    message?: string,
  ) {
    setMmdBusy(true);
    try {
      await call(actionName, payload, message);
    } catch {
      /* the error is shown in the dialog */
    } finally {
      setMmdBusy(false);
    }
  }
  useEffect(() => {
    if (modal === "mmd" && window.encoder) void mmdCall("mmdStatus");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);
  function action(actionName: string, payload?: unknown, message?: string) {
    void call(actionName, payload, message).catch(() => {});
  }
  // Replace one video's audio, as the media page's merge does, and line it
  // up with the video's own sound when "自动对齐" is on and there is one.
  async function pickAudio(j: Job) {
    const file = await call("pickMedia", { multiple: false }).catch(() => null);
    if (typeof file === "string") await replaceAudio(j, file);
  }
  async function replaceAudio(j: Job, file: string) {
    try {
      await call("setAudio", { id: j.id, path: file }, "已替换音频");
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
  // 前向分析只对 NVENC / NVEncC 生效；级别只有 HEVC / AV1 支持
  const lookaheadSupported = /_nvenc$|^nvencc:/.test(s?.encoder || "");
  const lookaheadLevelSupported =
    lookaheadSupported && !/^h264_nvenc$|^nvencc:h264$/.test(s?.encoder || "");
  function fieldNumber(
    key: keyof Settings,
    label: string,
    min: number,
    max: number,
    hint?: string,
  ) {
    const value = Number(s?.[key]);
    const fieldError =
      !Number.isFinite(value) || value < min || value > max
        ? `请输入 ${min}–${max} 范围内的数值。`
        : undefined;
    return (
      <Field id={key} label={label} hint={hint} error={fieldError}>
        <input
          id={key}
          type="number"
          min={min}
          max={max}
          value={Number.isFinite(value) ? String(value) : ""}
          disabled={
            (s?.encoder === "prores_ks" && key === "bitrate") ||
            (key === "lookahead" && !lookaheadSupported) ||
            (key === "lookaheadLevel" && !lookaheadLevelSupported)
          }
          aria-invalid={!!fieldError}
          aria-describedby={
            fieldError ? `${key}-error` : hint ? `${key}-hint` : undefined
          }
          onChange={(e) =>
            set(key, e.target.value === "" ? NaN : Number(e.target.value))
          }
        />
      </Field>
    );
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
              state={state}
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
            <aside className="settings-column" aria-label="压制设置">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">输出控制</span>
                  <h2>压制设置</h2>
                </div>
                <label
                  className="job-own-toggle"
                  title="开启后，下面的设置只用于当前选中的视频"
                >
                  <input
                    type="checkbox"
                    checked={!!job?.ownSettings}
                    disabled={
                      !job ||
                      job.status === "encoding" ||
                      (state.running && !!job.settings)
                    }
                    onChange={(e) => void setOwn(e.target.checked)}
                  />
                  <SlidersHorizontal size={16} />
                  单独设置
                </label>
              </div>
              <div className="settings-panel">
                {job?.ownSettings && (
                  <div className="job-preset-note" role="status">
                    <Info size={16} />
                    <p>
                      正在单独设置“{job.name}
                      ”：这里的修改只用于这个视频；关闭“单独设置”后这些修改会清除。
                    </p>
                  </div>
                )}
                <div className="preset-bar">
                  <Select
                    id="preset-select"
                    label={`编码预设${modified ? " · 已修改" : ""}`}
                    value={presetId}
                    options={[
                      { value: "", label: "自定义设置" },
                      ...presets
                        .filter((p) => !presetHidden(p) || p.id === presetId)
                        .map((p) => ({
                          value: p.id,
                          label: p.name,
                        })),
                    ]}
                    onChange={(id) => {
                      const p = state.presets.find((p) => p.id === id);
                      if (p) {
                        if (modified) setPendingPreset(p);
                        else void applyPreset(p);
                      } else setPresetId("");
                    }}
                  />
                  <Button
                    title={
                      activePreset
                        ? `保存（覆盖“${activePreset.name}”）`
                        : "保存（先选择一个预设）"
                    }
                    aria-label="保存到当前预设"
                    disabled={busy || !activePreset || !modified}
                    onClick={() => void overwritePreset()}
                  >
                    <Save size={17} />
                  </Button>
                  <Button
                    title="另存为预设"
                    aria-label="另存为预设"
                    onClick={() => {
                      setSaveId("");
                      setPresetName("");
                      setModal("save");
                    }}
                  >
                    <FilePlus2 size={17} />
                  </Button>
                </div>
                <div
                  className="setting-tabs"
                  role="group"
                  aria-label="设置分类"
                >
                  {[
                    { id: "encoding", name: "画质" },
                    { id: "audio", name: "音频" },
                    { id: "alpha", name: "透明通道" },
                    { id: "rtx", name: "超分补帧" },
                    { id: "output", name: "输出" },
                    { id: "advanced", name: "高级" },
                  ].map((t) => (
                    <button
                      key={t.id}
                      aria-pressed={tab === t.id}
                      className={tab === t.id ? "active" : ""}
                      onClick={() => setTab(t.id)}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
                <form
                  noValidate
                  onSubmit={(e) => e.preventDefault()}
                  className="settings-body"
                >
                  {tab === "encoding" && (
                    <>
                      <div className="form-row">
                        <Select
                          id="container"
                          label="封装格式"
                          value={s.container}
                          options={options(["mp4", "mkv", "mov", "webm"]).map(
                            (o) => ({ ...o, label: o.label.toUpperCase() }),
                          )}
                          onChange={(v) => set("container", v)}
                        />
                        <Select
                          id="bitDepth"
                          label="色彩位深"
                          value={s.bitDepth}
                          options={[
                            { value: 8, label: "8-bit" },
                            { value: 10, label: "10-bit" },
                          ]}
                          onChange={(v) => set("bitDepth", Number(v))}
                        />
                      </div>
                      <Select
                        id="encoder"
                        label="视频编码器"
                        value={s.encoder}
                        options={[
                          ...(!engine
                            ? [
                                {
                                  value: s.encoder,
                                  label: `${s.encoder} · ${state.detecting ? "检测中" : "不可用"}`,
                                },
                              ]
                            : []),
                          ...state.engines.map((e) => ({
                            value: e.id,
                            label: e.label,
                          })),
                        ]}
                        onChange={(v) => {
                          const en = state.engines.find((e) => e.id === v);
                          changed({
                            ...s,
                            encoder: v,
                            // ProRes takes a quantizer, not a CRF; start at 16 (the built-in value).
                            ...(v === "prores_ks" && s.encoder !== "prores_ks"
                              ? { quality: 12, rateControl: "quality" }
                              : {}),
                            preset:
                              en?.backend === "cpu"
                                ? v === "libsvtav1"
                                  ? "6"
                                  : "medium"
                                : en?.backend === "qsv"
                                  ? "medium"
                                  : en?.backend === "amf"
                                    ? "balanced"
                                    : "p7",
                          });
                        }}
                        hint={
                          state.detecting
                            ? "正在试编码，完成后显示当前电脑可用的编码器。"
                            : "只显示已通过本机试编码的编码器。"
                        }
                      />
                      <div className="form-row">
                        <Select
                          id="rateControl"
                          disabled={s.encoder === "prores_ks"}
                          label="码率控制"
                          value={s.rateControl}
                          options={[
                            {
                              value: "quality",
                              label:
                                backend === "cpu"
                                  ? "恒定质量 · CRF"
                                  : "目标质量 · CQ",
                            },
                            { value: "qp", label: "固定量化 · QP" },
                            { value: "bitrate", label: "目标码率" },
                          ]}
                          onChange={(v) => set("rateControl", v)}
                        />
                        {s.rateControl === "bitrate"
                          ? fieldNumber("bitrate", "码率 · kbps", 100, 1000000)
                          : fieldNumber(
                              "quality",
                              s.encoder === "prores_ks"
                                ? "画质 · 量化"
                                : `画质 · ${s.rateControl === "qp" ? "QP" : backend === "cpu" ? "CRF" : "CQ"}`,
                              0,
                              s.encoder === "prores_ks"
                                ? 64
                                : ["h264", "hevc"].includes(engine?.codec || "")
                                  ? 51
                                  : 63,
                            )}
                      </div>
                      <p className="hint quality-hint">
                        {s.encoder === "prores_ks"
                          ? "ProRes 量化 1–64：数值越小质量越高、文件越大；0 为编码器默认（实测约为量化 12 的 4 倍大小）。4:2:2 对应 HQ，4:4:4 对应 4444。"
                          : s.rateControl === "bitrate"
                            ? "目标平均码率（kbps）：数值越大通常质量越高、文件越大；单遍 VBR 实际码率会波动，不保证文件大小。"
                            : s.rateControl === "qp"
                              ? "QP 固定量化：数值越小压缩越少；复杂场景使用相同量化，质量和码率会波动。"
                              : backend === "cpu"
                                ? "CRF 恒定质量：数值越小质量越高；码率随画面复杂度变化，不同软件编码器的 CRF 不可直接比较。"
                                : "CQ 目标质量：硬件按画面分配码率，数值越小通常质量越高；CQ 与 CRF 不在相同尺度。"}
                      </p>
                      <Select
                        id="speed"
                        label="编码预设 · 速度与压缩效率"
                        value={s.preset}
                        disabled={s.encoder === "prores_ks"}
                        options={options(
                          backend === "qsv"
                            ? [
                                "veryfast",
                                "faster",
                                "fast",
                                "medium",
                                "slow",
                                "slower",
                                "veryslow",
                              ]
                            : backend === "amf"
                              ? ["speed", "balanced", "quality"]
                              : backend === "cpu"
                                ? s.encoder === "libsvtav1"
                                  ? ["0", "2", "4", "6", "8", "10", "12"]
                                  : [
                                      "ultrafast",
                                      "fast",
                                      "medium",
                                      "slow",
                                      "veryslow",
                                    ]
                                : ["p1", "p2", "p3", "p4", "p5", "p6", "p7"],
                        )}
                        onChange={(v) => set("preset", v)}
                        hint={
                          s.encoder === "prores_ks"
                            ? "ProRes 使用 Profile 决定压缩配置。"
                            : backend === "nvenc" || backend === "nvencc"
                              ? "p1 最快，p7 压缩效率优先；具体速度依显卡和处理链。"
                              : s.encoder === "libsvtav1"
                                ? "AV1 数字越小越慢、效率通常越高；数字越大越快。"
                                : backend === "amf"
                                  ? "speed 优先速度，quality 优先压缩效率，balanced 折中。"
                                  : "veryfast / ultrafast 更快；slow / veryslow 更慢、压缩效率通常更高。"
                        }
                      />
                      <div className="divider" />
                      <Select
                        id="resizeMode"
                        label="输出分辨率"
                        value={s.resizeMode || "source"}
                        options={[
                          { value: "source", label: "保持源分辨率" },
                          {
                            value: "long",
                            label: "按长边缩放 · 自动识别横竖屏",
                          },
                          { value: "custom", label: "自定义分辨率" },
                        ]}
                        onChange={(v) => set("resizeMode", v)}
                      />
                      {s.resizeMode === "long" &&
                        fieldNumber(
                          "width",
                          "长边 · px",
                          2,
                          16384,
                          "横屏视频用作宽度，竖屏视频用作高度，另一边按原比例计算。",
                        )}
                      {s.resizeMode === "custom" && (
                        <>
                          <div className="form-row">
                            {(["width", "height"] as const).map((axis) => {
                              const derived =
                                s.keepAspect &&
                                s.resizeAxis !== axis &&
                                job?.meta;
                              const value = derived
                                ? Math.max(
                                    2,
                                    Math.round(
                                      (s[s.resizeAxis as "width" | "height"] *
                                        job.meta![axis]) /
                                        job.meta![
                                          s.resizeAxis as "width" | "height"
                                        ] /
                                        2,
                                    ) * 2,
                                  )
                                : s[axis];
                              const invalid =
                                !Number.isInteger(value) ||
                                value < 2 ||
                                value > 16384;
                              return (
                                <Field
                                  key={axis}
                                  id={axis}
                                  label={
                                    axis === "width" ? "宽度 · px" : "高度 · px"
                                  }
                                  error={
                                    invalid
                                      ? "请输入 2–16384 的整数"
                                      : undefined
                                  }
                                >
                                  <input
                                    id={axis}
                                    type="number"
                                    min={2}
                                    max={16384}
                                    step={1}
                                    value={value || ""}
                                    aria-invalid={invalid}
                                    aria-describedby={
                                      invalid ? `${axis}-error` : undefined
                                    }
                                    onChange={(e) =>
                                      changed({
                                        ...s,
                                        [axis]: Number(e.target.value),
                                        resizeAxis: axis,
                                      })
                                    }
                                  />
                                </Field>
                              );
                            })}
                          </div>
                          <label className="check-card">
                            <input
                              type="checkbox"
                              checked={s.keepAspect}
                              onChange={(e) =>
                                changed({
                                  ...s,
                                  keepAspect: e.target.checked,
                                  ...(e.target.checked
                                    ? {}
                                    : job?.meta
                                      ? s.resizeAxis === "height"
                                        ? {
                                            width: Math.max(
                                              2,
                                              Math.round(
                                                (s.height * job.meta.width) /
                                                  job.meta.height /
                                                  2,
                                              ) * 2,
                                            ),
                                          }
                                        : {
                                            height: Math.max(
                                              2,
                                              Math.round(
                                                (s.width * job.meta.height) /
                                                  job.meta.width /
                                                  2,
                                              ) * 2,
                                            ),
                                          }
                                      : {}),
                                })
                              }
                            />
                            <span>
                              <strong>保持宽高比</strong>
                              <small>
                                默认开启；按每个源视频的比例计算另一边，取最接近的偶数像素。
                              </small>
                            </span>
                          </label>
                          {!job?.meta && s.keepAspect && (
                            <p className="hint">
                              添加视频后自动计算另一边尺寸。
                            </p>
                          )}
                        </>
                      )}
                      <Select
                        id="fps"
                        label="输出帧率"
                        value={
                          customFPS ||
                          !frameOptions.some((o) => o.value === s.fps)
                            ? "custom"
                            : s.fps
                        }
                        options={frameOptions}
                        onChange={(v) => {
                          setCustomFPS(v === "custom");
                          if (v !== "custom") set("fps", v);
                        }}
                      />
                      {(customFPS ||
                        !frameOptions.some((o) => o.value === s.fps)) && (
                        <Field
                          id="custom-fps"
                          label="自定义 FPS"
                          hint="1–240，可输入 30 或 30000/1001"
                        >
                          <input
                            id="custom-fps"
                            value={s.fps === "source" ? "" : s.fps}
                            onChange={(e) => set("fps", e.target.value)}
                          />
                        </Field>
                      )}
                      <p className="hint">
                        降帧率保持时长与音画同步；提高帧率使用重复帧，不生成运动细节。
                      </p>
                    </>
                  )}
                  {tab === "audio" && (
                    <>
                      <Select
                        id="audio"
                        label="音频编码"
                        value={s.audio}
                        options={Object.entries(audioLabels).map(
                          ([value, label]) => ({ value, label }),
                        )}
                        onChange={(v) => set("audio", v)}
                      />
                      <Select
                        id="audioBitrate"
                        label="音频码率"
                        value={s.audioBitrate ?? 0}
                        options={[
                          {
                            value: 0,
                            label:
                              s.audio === "aac"
                                ? "默认 · 192 kbps"
                                : "默认 · 编码器自动",
                          },
                          ...[64, 96, 128, 160, 192, 256, 320, 384, 512].map(
                            (value) => ({ value, label: `${value} kbps` }),
                          ),
                        ]}
                        onChange={(v) => set("audioBitrate", Number(v))}
                        disabled={!["aac", "libopus"].includes(s.audio)}
                        hint={
                          s.audio === "none"
                            ? "不保留音频，无需设置码率。"
                            : ["flac", "pcm_s16le"].includes(s.audio)
                              ? "无损或未压缩音频不使用目标码率。"
                              : "目标码率；实际码率会随编码器和声音内容变化。"
                        }
                      />
                      <Select
                        id="audioFade"
                        label="音频淡入淡出"
                        value={String(s.audioFade ?? 0)}
                        options={fadeOptions}
                        disabled={s.audio === "none"}
                        hint={
                          s.audio === "none"
                            ? "不保留音频，无需淡入淡出。"
                            : fadeHint
                        }
                        onChange={(v) => set("audioFade", Number(v))}
                      />
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={!!s.hiRes}
                          disabled={!["flac", "pcm_s16le"].includes(s.audio)}
                          onChange={(e) =>
                            // FLAC / PCM do not fit MP4: switch to MKV with it.
                            changed({
                              ...s,
                              hiRes: e.target.checked,
                              ...(e.target.checked && s.container === "mp4"
                                ? { container: "mkv" }
                                : {}),
                            })
                          }
                        />
                        <span>
                          Hi-Res 音频（24-bit，低于 48 kHz 时升到 2 倍采样率）
                          <small className="hint hires-hint">
                            {!["flac", "pcm_s16le"].includes(s.audio)
                              ? "选择 FLAC 或 PCM 音频后可用。"
                              : (() => {
                                  const a = job?.audioPath
                                    ? job.audioMeta
                                    : job?.meta?.audio;
                                  if (!a?.sampleRate)
                                    return "按每个视频自己的音轨计算。";
                                  const rate =
                                    a.sampleRate < 48000
                                      ? a.sampleRate * 2
                                      : a.sampleRate;
                                  return `当前素材：${a.sampleRate / 1000} kHz / ${a.float ? "浮点" : a.bits ? a.bits + "-bit" : "位深未知"} → ${rate / 1000} kHz / 24-bit。`;
                                })() + "升采样不会提高音质。"}
                          </small>
                        </span>
                      </label>
                      <div className="help-box">
                        <Info size={17} />
                        <p>
                          保持源采样率与声道；MP4 用 AAC，FLAC 用
                          MKV。要换成别的音频，点队列里的 ♪
                          为该视频选择，按视频时长截取。
                        </p>
                      </div>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={autoAlignAudio}
                          onChange={(e) => setAutoAlignAudio(e.target.checked)}
                        />
                        <span>
                          替换音频后自动对齐
                          <small className="hint hires-hint">
                            以视频自带的声音为参考；对不上时不应用，可在“当前素材”里点“对齐”检视、微调。
                          </small>
                        </span>
                      </label>
                      {(job?.audioPath ? job.audioMeta : job?.meta?.audio) &&
                        (() => {
                          const a = (
                            job!.audioPath ? job!.audioMeta : job!.meta!.audio
                          )!;
                          return (
                            <div className="mini-facts">
                              <span>
                                {job!.audioPath ? "替换音频" : "源音频"}
                              </span>
                              <strong>
                                {a.codec.toUpperCase()} / {a.sampleRate / 1000}{" "}
                                kHz
                              </strong>
                            </div>
                          );
                        })()}
                    </>
                  )}
                  {tab === "rtx" && (
                    <RtxSettings
                      s={s}
                      state={state}
                      set={set}
                      patch={(p) => changed({ ...s, ...p })}
                      call={call}
                    />
                  )}
                  {tab === "alpha" && (
                    <>
                      <Select
                        id="alphaMode"
                        label="透明通道处理"
                        // "split" = colour video without alpha + separate mask
                        // (stored as alphaMode discard + alphaMask, any format).
                        value={
                          s.alphaMask && s.alphaMode === "discard"
                            ? "split"
                            : s.alphaMode
                        }
                        options={[
                          { value: "discard", label: "移除 Alpha" },
                          { value: "preserve", label: "保留 Alpha" },
                          {
                            value: "split",
                            label: "分离 Alpha · 彩色视频 + 黑白遮罩",
                          },
                          { value: "mask", label: "分离 Alpha · 仅黑白遮罩" },
                          { value: "green", label: "合成到绿幕（#00FF00）" },
                          // Older presets may still use black / white.
                          ...(s.alphaMode === "black"
                            ? [{ value: "black", label: "合成到黑色背景" }]
                            : s.alphaMode === "white"
                              ? [{ value: "white", label: "合成到白色背景" }]
                              : []),
                        ]}
                        onChange={(v) =>
                          changed({
                            ...s,
                            alphaMode: v === "split" ? "discard" : v,
                            alphaMask: v === "split",
                            // ProRes alpha starts at quantizer 16 (~1/5 of the default size).
                            ...(v === "preserve" &&
                            s.alphaMode !== "preserve" &&
                            s.encoder === "prores_ks"
                              ? { quality: 12 }
                              : {}),
                          })
                        }
                      />
                      {s.alphaMask && (
                        <>
                          <div className="alpha-diagram">
                            <div className="alpha-swatch color">
                              {s.alphaMode === "preserve" ? "RGBA" : "RGB"}
                            </div>
                            <Plus size={16} />
                            <div className="alpha-swatch mask">A</div>
                          </div>
                          <p className="hint">
                            {s.alphaMode === "discard"
                              ? "彩色视频不含 Alpha，可用任意编码器和封装；另外导出同尺寸、同帧率的黑白遮罩（_alpha 后缀，无损）。"
                              : "这个旧预设除了上面的处理，还会额外导出黑白遮罩（_alpha 后缀）。"}
                            白色表示不透明，黑色表示透明，灰色保留半透明信息。
                          </p>
                        </>
                      )}
                      {s.alphaMode === "mask" && (
                        <>
                          <div className="alpha-diagram">
                            <div className="alpha-swatch mask">A</div>
                          </div>
                          <p className="hint">
                            只导出同尺寸、同帧率的黑白遮罩（_alpha
                            后缀，无损，不含音频），不导出彩色视频。WebM 用
                            VP9，其他格式用
                            H.264；画质页的编码器设置不影响遮罩。白色表示不透明，黑色表示透明，灰色保留半透明信息。
                          </p>
                        </>
                      )}
                      {(s.alphaMask || s.alphaMode === "mask") &&
                        job?.meta &&
                        !job.meta.hasAlpha && (
                          <p className="inline-error">
                            当前素材没有可读取的 Alpha
                            通道，不能导出遮罩。请选择其他处理方式或包含透明通道的视频。
                          </p>
                        )}
                    </>
                  )}
                  {tab === "output" && (
                    <>
                      <Select
                        id="outputMode"
                        label="保存位置"
                        value={s.outputMode}
                        options={[
                          { value: "source", label: "源文件目录" },
                          { value: "encoded", label: "源目录 \\ Encoded" },
                          { value: "custom", label: "自定义统一目录" },
                        ]}
                        onChange={(v) => set("outputMode", v)}
                      />
                      {s.outputMode === "custom" && (
                        <Field id="outputDir" label="统一输出目录">
                          <div className="input-action">
                            <input
                              id="outputDir"
                              value={s.outputDir}
                              onChange={(e) => set("outputDir", e.target.value)}
                              placeholder="选择文件夹"
                            />
                            <Button
                              title="选择输出文件夹"
                              aria-label="选择输出文件夹"
                              onClick={pickDirectory}
                            >
                              <Folder size={17} />
                            </Button>
                          </div>
                        </Field>
                      )}
                      <p className="hint">
                        自动记住上一次选择。不同源目录分别创建自己的 Encoded
                        文件夹。
                      </p>
                      <div className="divider" />
                      <Field
                        id="nameTemplate"
                        label="文件名模板"
                        hint="扩展名自动添加，同名文件自动编号。"
                      >
                        <input
                          id="nameTemplate"
                          value={s.nameTemplate}
                          onChange={(e) => set("nameTemplate", e.target.value)}
                        />
                      </Field>
                      <div className="template-tokens">
                        {["{name}", "{preset}", "{date}", "{index}"].map(
                          (v) => (
                            <Button
                              key={v}
                              variant="ghost"
                              onClick={() =>
                                set("nameTemplate", s.nameTemplate + v)
                              }
                            >
                              {v}
                            </Button>
                          ),
                        )}
                      </div>
                      <p className="hint">原名 / 预设名 / 日期 / 队列序号</p>
                      <div className="path-preview">
                        <span>输出示例</span>
                        <code>
                          {preview?.output || "添加视频后显示完整路径"}
                        </code>
                      </div>
                    </>
                  )}
                  {tab === "advanced" && (
                    <>
                      <div className="form-row">
                        <Select
                          id="chroma"
                          label="色度采样"
                          value={s.chroma}
                          options={[
                            { value: "420", label: "4:2:0" },
                            { value: "422", label: "4:2:2" },
                            { value: "444", label: "4:4:4" },
                          ]}
                          onChange={(v) => set("chroma", v)}
                        />
                        <Select
                          id="colorRange"
                          label="输出范围"
                          value={s.colorRange}
                          options={[
                            { value: "tv", label: "有限 · TV" },
                            { value: "pc", label: "全范围 · PC" },
                          ]}
                          onChange={(v) => set("colorRange", v)}
                        />
                      </div>
                      <Select
                        id="colorSpace"
                        label="色彩空间 · SDR"
                        value={s.colorSpace}
                        options={options(["bt709", "bt601", "bt2020"])}
                        onChange={(v) => set("colorSpace", v)}
                      />
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={!!s.editFriendly}
                          onChange={(e) =>
                            set("editFriendly", e.target.checked)
                          }
                        />
                        <span>
                          剪辑友好：每秒一个关键帧
                          <small className="hint hires-hint">
                            {s.gop >= 0
                              ? "已手动设置 GOP 间隔，此项不生效。"
                              : "成片可以按约 1 秒的间隔无损裁切；同画质下文件约大 2%–5%（软件编码更多）。"}
                          </small>
                        </span>
                      </label>
                      <div className="form-row">
                        {fieldNumber("gop", "GOP 间隔", -1, 10000, "-1 为自动")}
                        {fieldNumber("bframes", "B 帧", -1, 16, "-1 为自动")}
                      </div>
                      <div className="form-row">
                        {fieldNumber(
                          "lookahead",
                          "前向分析帧数",
                          0,
                          32,
                          lookaheadSupported ? undefined : "仅 NVIDIA 硬件编码",
                        )}
                        {fieldNumber(
                          "lookaheadLevel",
                          "前向分析级别",
                          0,
                          3,
                          lookaheadLevelSupported
                            ? undefined
                            : "仅 NVIDIA HEVC / AV1",
                        )}
                      </div>
                      <div className="command-row">
                        <details className="command-details">
                          <summary>查看完整命令</summary>
                          <pre>{preview?.command || "添加视频后生成命令"}</pre>
                        </details>
                        <Button disabled={!job} onClick={copy}>
                          <Copy size={14} />
                          复制命令
                        </Button>
                      </div>
                    </>
                  )}
                  {s.encoder.startsWith("nvencc:") && (
                    <p className="help-box">
                      NVEncC
                      将先生成临时中间视频，可能需要较多磁盘空间；完成后自动清理。
                    </p>
                  )}
                </form>
                <div className="settings-foot">
                  <Check size={13} />
                  <span>设置自动保存 · 全部待处理视频共用当前设置</span>
                </div>
              </div>
            </aside>
          </main>
        </div>
        <footer className="output-strip">
          <div className="output-icon">
            <ArrowDownToLine size={23} />
          </div>
          <div className="output-summary">
            <span className="eyebrow">预计结果</span>
            <strong>
              {job?.meta
                ? `${job.meta.width}×${job.meta.height}${(s.resizeMode !== "source" || s.vsr) && preview?.dimensions ? ` → ${preview.dimensions.width}×${preview.dimensions.height}` : ""} · ${formatFPS(job.meta.fpsText || job.meta.fps)}${s.vfg ? ` → ${formatFPS(Number(job.meta.fps) * s.vfgMultiplier)}（VFG ${s.vfgMultiplier}×）` : s.fps === "source" ? "" : ` → ${formatFPS(s.fps)}`} FPS`
                : "保持源分辨率与帧率"}{" "}
              <ArrowRight size={15} />
              <span>
                {s.alphaMode === "mask"
                  ? "Alpha 黑白遮罩"
                  : `${engine?.label || s.encoder} · ${s.bitDepth}-bit`}
              </span>
            </strong>
            <span className="output-facts">
              {s.alphaMode === "mask" ? (
                <>
                  {s.container === "webm" ? "VP9" : "H.264"} 无损
                  <i /> 无音频
                  <i /> 输出 → {s.container.toUpperCase()}
                </>
              ) : (
                <>
                  {s.encoder === "prores_ks" ? (
                    `ProRes ${s.chroma === "444" ? "4444" : "HQ"}`
                  ) : (
                    <>
                      {s.rateControl === "bitrate"
                        ? `${s.bitrate} kbps`
                        : `${s.rateControl === "qp" ? "QP" : backend === "cpu" ? "CRF" : "CQ"} ${s.quality}`}{" "}
                      · {s.preset}
                    </>
                  )}
                  <i />
                  音频 →{" "}
                  {job?.meta && !job.meta.audio && !job.audioPath
                    ? "无音轨"
                    : audioLabels[s.audio]}
                  {(!job?.meta || job.meta.audio || job.audioPath) &&
                  ["aac", "libopus"].includes(s.audio) &&
                  s.audioBitrate > 0
                    ? ` · ${s.audioBitrate} kbps`
                    : ""}
                  {(!job?.meta || job.meta.audio || job.audioPath) && s.hiRes
                    ? " · Hi-Res 24-bit"
                    : ""}
                  {job?.audioPath && s.audio !== "none" ? " · 替换音频" : ""}{" "}
                  {s.alphaMode === "preserve" && " · 保留 Alpha"}
                  <i /> 输出 → {s.container.toUpperCase()}{" "}
                  {s.alphaMask && (
                    <>
                      <i />+ Alpha 遮罩
                    </>
                  )}
                </>
              )}
            </span>
            <span className="output-path" title={preview?.output}>
              {preview?.output || "添加视频后预览保存路径"}
            </span>
          </div>
          <div className="run-actions">
            <span>
              {state.running
                ? "正在处理队列"
                : `${readyCount} 个视频待处理${doneCount ? ` · ${doneCount} 个已完成` : ""}`}
            </span>
            {state.running ? (
              <Button variant="stop" onClick={() => action("cancel")}>
                <Square size={16} />
                取消队列
              </Button>
            ) : (
              <Button
                variant="primary run"
                disabled={busy || !readyCount || !engine || errors.length > 0}
                onClick={start}
              >
                <Play size={17} />
                {busy ? "准备中…" : "开始压制"}
              </Button>
            )}
          </div>
        </footer>
        {(!!error || errors.length > 0 || !!preview?.errors?.length) && (
          <div className="error-banner" role="alert">
            <Info size={17} />
            <span>{error || errors[0] || preview?.errors[0]}</span>
            {compatibility.suggestions.map((fix) => (
              <Button
                key={fix.id}
                disabled={state.running}
                onClick={async () => {
                  const next = { ...s, ...fix.patch };
                  changed(next);
                  try {
                    await persist(next);
                    notify("已应用兼容设置");
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                {fix.label}
              </Button>
            ))}
            <Button
              variant="ghost"
              aria-label="关闭提示"
              onClick={() => setError("")}
            >
              <X size={15} />
            </Button>
          </div>
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
                <strong>{c.builtinName}</strong>
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
        <div className="preset-list">
          {presets.map((p) => (
            <div
              key={p.id}
              className={`preset-item ${presetHidden(p) ? "is-hidden" : ""}`}
              {...sortPreset(p.id)}
            >
              <span {...sortPreset.handle(p.id)}>
                <GripVertical size={16} aria-hidden />
              </span>
              <Bookmark size={20} />
              <div>
                <strong>{p.name}</strong>
                <small>
                  {p.builtin ? (p.edited ? "内置 · 已修改" : "内置") : "个人"} ·{" "}
                  {p.settings.container.toUpperCase()} · {p.settings.encoder}
                  {presetHidden(p) ? " · 已隐藏" : ""}
                </small>
              </div>
              <Button
                onClick={() => {
                  setModal("");
                  if (modified) setPendingPreset(p);
                  else void applyPreset(p);
                }}
              >
                调用
              </Button>
              <Button
                onClick={() => {
                  setRenameTarget(p);
                  setPresetName(p.name);
                  setError("");
                }}
              >
                编辑名称
              </Button>
              <Button
                variant="ghost"
                title={presetHidden(p) ? "显示" : "隐藏"}
                aria-label={`${presetHidden(p) ? "显示" : "隐藏"}预设 ${p.name}`}
                onClick={() =>
                  void call("hidePreset", {
                    id: p.id,
                    hidden: !presetHidden(p),
                  }).catch(() => {})
                }
              >
                {presetHidden(p) ? <EyeOff size={16} /> : <Eye size={16} />}
              </Button>
              <Button
                variant="ghost"
                aria-label={`删除预设 ${p.name}`}
                onClick={() => setPendingDelete(p)}
              >
                <Trash2 size={16} />
              </Button>
            </div>
          ))}
        </div>
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
      <Modal
        error={error}
        open={modal === "mmd"}
        onClose={() => setModal("")}
        fixedHeight
        title="MMD 导出"
        description="在 MMD“AVI 输出”中选择 MMDEncoder。这里的选项优先于预设，并与 MMD“詳細設定”同步。"
      >
        {state.mmd.interrupted.length > 0 && (
          <section className="modal-section" aria-label="中断的导出">
            <h3>中断的导出</h3>
            <p className="hint">
              MMD
              在导出途中崩溃或被关闭时，已导出的画面仍保存在临时文件里。补完会按导出开始时的设置合成音频并改回正式文件名。
            </p>
            {state.mmd.interrupted.map((x) => (
              <div className="status-row" key={x.id}>
                <p title={x.temp}>
                  {baseName(x.output)}
                  <small className="row-detail">
                    {x.presetName} · 已导出 {(x.size / 1048576).toFixed(1)} MiB
                    · {new Date(x.at).toLocaleString()} 开始
                  </small>
                </p>
                <div className="row-actions">
                  <Button
                    variant="primary"
                    disabled={mmdBusy}
                    onClick={() =>
                      mmdCall("mmdRecover", { id: x.id }, "已补完中断的导出")
                    }
                  >
                    补完
                  </Button>
                  <Button
                    disabled={mmdBusy}
                    onClick={() =>
                      mmdCall("mmdDiscard", { id: x.id }, "已删除中断的导出")
                    }
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </section>
        )}
        <section
          className="modal-section"
          aria-label="插件"
          aria-busy={mmdBusy}
        >
          <h3>插件</h3>
          <div className="status-row">
            <p className={state.mmd.plugin.broken ? "inline-error" : undefined}>
              {!state.mmd.plugin.available
                ? "这个版本没有附带 MMD 导出插件。"
                : state.mmd.plugin.broken
                  ? "插件需要修复：注册的插件文件已不存在，MMD 里会找不到“MMDEncoder”。点“修复插件”重新安装，然后重启 MMD。"
                  : !state.mmd.plugin.installed
                    ? "未安装。安装后在 MMD 的“AVI 输出”里选择视频编码“MMDEncoder”。"
                    : state.mmd.plugin.upToDate
                      ? "已安装，在 MMD 的“AVI 输出”里选择视频编码“MMDEncoder”。"
                      : "已安装，有新版插件可以更新（MMD 重启后生效）。"}
            </p>
            <div className="row-actions">
              {state.mmd.plugin.available &&
                (!state.mmd.plugin.installed || !state.mmd.plugin.upToDate) && (
                  <Button
                    variant="primary"
                    disabled={mmdBusy}
                    onClick={() =>
                      mmdCall("mmdInstall", undefined, "MMD 导出插件已安装")
                    }
                  >
                    {state.mmd.plugin.broken
                      ? "修复插件"
                      : state.mmd.plugin.installed
                        ? "更新插件"
                        : "安装到 MMD"}
                  </Button>
                )}
              {state.mmd.plugin.installed && (
                <Button
                  disabled={mmdBusy}
                  onClick={() =>
                    mmdCall("mmdUninstall", undefined, "MMD 导出插件已卸载")
                  }
                >
                  卸载
                </Button>
              )}
            </div>
          </div>
        </section>
        <section className="modal-section" aria-label="导出设置">
          <h3>导出设置</h3>
          <Select
            id="mmd-export-preset"
            label="导出预设"
            value={state.mmd.presetId}
            disabled={mmdBusy}
            options={[
              { value: "", label: "未选择" },
              ...presets.map((p) => {
                const why = mmdUnsupported(p);
                return {
                  value: p.id,
                  label: why ? `${p.name}（${why}）` : p.name,
                  disabled: !!why,
                };
              }),
            ]}
            onChange={(presetId) => mmdCall("mmdExportSet", { presetId })}
          />
          <label className="check-card">
            <input
              type="checkbox"
              checked={state.mmd.followMmd}
              disabled={mmdBusy}
              onChange={(e) =>
                mmdCall("mmdExportSet", { followMmd: e.target.checked })
              }
            />
            <span>
              <strong>分辨率和帧率跟随 MMD</strong>
              <small>使用 MMD“AVI 输出”的尺寸和帧率。</small>
            </span>
          </label>
          <label className="check-card">
            <input
              type="checkbox"
              checked={state.mmd.rangeSuffix !== false}
              disabled={mmdBusy}
              onChange={(e) =>
                mmdCall("mmdExportSet", { rangeSuffix: e.target.checked })
              }
            />
            <span>
              <strong>文件名加 MMD 帧范围</strong>
              <small>
                例如 场景_0400-0600f.mp4；支持剪辑时按 MMD 帧号定位。
              </small>
            </span>
          </label>
          <div className="form-row">
            {/* Overrides the preset's own alpha setting; the same choice as
              in MMD's 詳細設定, where a change wins over this window. */}
            <Select
              id="mmd-mask-mode"
              label="Alpha 遮罩"
              value={state.mmd.maskMode || "off"}
              disabled={mmdBusy}
              hint="无损黑白遮罩：白色不透明，黑色透明。"
              options={[
                { value: "off", label: "不导出" },
                { value: "with", label: "同时导出遮罩" },
                { value: "only", label: "仅导出遮罩" },
              ]}
              onChange={(maskMode) => mmdCall("mmdExportSet", { maskMode })}
            />
            <Select
              id="mmd-audio-fade"
              label="音频淡入淡出"
              value={String(state.mmd.audioFade)}
              disabled={mmdBusy}
              hint="仅淡化成片首尾。"
              options={fadeOptions}
              onChange={(v) =>
                mmdCall("mmdExportSet", { audioFade: Number(v) })
              }
            />
          </div>
        </section>
        <section className="modal-section" aria-label="测试与日志">
          <h3>测试与日志</h3>
          <div className="status-row">
            <p
              className={
                state.mmd.error || state.mmd.test?.ok === false
                  ? "inline-error"
                  : undefined
              }
              role={state.mmd.error ? "alert" : "status"}
            >
              {state.mmd.error ||
                (state.mmd.test
                  ? state.mmd.test.message
                  : state.mmd.lastExport
                    ? state.mmd.lastExport.ok
                      ? `上次导出：${baseName(state.mmd.lastExport.output || "")}${state.mmd.lastExport.audio === "wav" ? "（音频取自工程 WAV）" : state.mmd.lastExport.audio === "avi" ? "（含音频）" : "（无音频）"}${state.mmd.lastExport.mask ? "，含 Alpha 遮罩" : ""}`
                      : `上次导出失败：${state.mmd.lastExport.error}`
                    : "成片保存在 AVI 同目录，自动合成音频，完成后删除占位 AVI。")}
            </p>
            <div className="row-actions">
              <Button
                disabled={mmdBusy || !state.mmd.presetId || !!state.mmd.error}
                onClick={() => mmdCall("mmdTest")}
              >
                {mmdBusy ? "处理中…" : "测试编码"}
              </Button>
              <Button
                disabled={!state.mmd.lastExport?.output}
                title={state.mmd.lastExport?.output}
                onClick={() => action("mmdOpenLatest")}
              >
                <Folder size={15} />
                打开最新导出
              </Button>
              <Button onClick={() => action("mmdOpenLog")}>
                <FolderOpen size={15} />
                打开导出日志
              </Button>
            </div>
          </div>
          {(() => {
            // Where the last export's time went, measured by the plugin.
            const e = state.mmd.lastExport;
            const t = e?.ok ? e.timing : undefined;
            if (!t || !(t.render > 0)) return null;
            const s = (v: number) => `${v.toFixed(1)} 秒`;
            const share = (100 * t.waited) / t.render;
            const total = t.setup + t.render + t.encoderTail + (t.finish || 0);
            return (
              <p className="hint export-timing">
                上次导出耗时 {s(total)}：准备 {s(t.setup)} · 渲染 {s(t.render)}
                {e?.frames
                  ? `（${(e.frames / t.render).toFixed(1)} fps）`
                  : ""}{" "}
                · 等待编码器 {s(t.waited)}（{share.toFixed(0)}%，单帧最长{" "}
                {Math.round(t.longestWait * 1000)} 毫秒） · 编码收尾{" "}
                {s(t.encoderTail)}
                {t.finish !== undefined
                  ? ` · 合成音频与整理 ${s(t.finish)}`
                  : ""}
                {share >= 10
                  ? "。编码器跟不上 MMD 渲染，换更快的预设（如硬件编码）可缩短导出时间。"
                  : "。编码没有拖慢 MMD，导出时间主要花在 MMD 渲染上。"}
              </p>
            );
          })()}
        </section>
      </Modal>
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
              <strong>{e.label}</strong>
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
            应用“{pendingPreset?.name}”
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
            ? `删除内置预设“${pendingDelete.name}”后，可在预设管理中点“恢复内置预设”找回。`
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
