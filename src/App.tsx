import { useEffect, useRef, useState } from "react";
import {
  Sun,
  Moon,
  ArrowRight,
  ArrowDownToLine,
  Plus,
  FolderOpen,
  Film,
  Layers,
  Settings2,
  SlidersHorizontal,
  Copy,
  Check,
  ChevronLeft,
  ChevronRight,
  Trash2,
  FileVideo,
  RefreshCw,
  Play,
  Square,
  Bookmark,
  Info,
  Cpu,
  X,
  LoaderCircle,
  Terminal,
  Folder,
  Save,
  FilePlus2,
  ExternalLink,
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
import { MediaDetails } from "./MediaDetails";
import { FileMeta, metaSummary } from "./FileMeta";
import { RtxSettings } from "./RtxSettings";
import {
  formatFPS,
  formatDuration,
  formatSize,
  statusLabels,
  audioLabels,
  compatibilityErrors,
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
    stateRef = useRef<State | null>(null),
    lastNotice = useRef(""),
    draftRef = useRef<Settings | null>(null),
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
      if (r.newer) notify(`发现新版本 ${r.latest}，可在“设置与引擎”中更新`);
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
      if (stateRef.current?.running) setModal("close");
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
    backend =
      engine?.backend ||
      (s?.encoder.startsWith("nvencc:")
        ? "nvencc"
        : s?.encoder.endsWith("_nvenc")
          ? "nvenc"
          : s?.encoder.endsWith("_qsv")
            ? "qsv"
            : s?.encoder.endsWith("_amf")
              ? "amf"
              : "cpu"),
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
  // Software built-ins stay hidden while H.264 NVENC is available, unless the
  // user chose otherwise with the hide / show button.
  const hardwareH264 =
    !!state?.detecting || !!state?.engines.some((e) => e.id === "h264_nvenc");
  const presetHidden = (p: Preset) =>
    p.hidden ?? (p.builtin && p.id.endsWith("-sw") && hardwareH264);
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
  function action(actionName: string, payload?: unknown, message?: string) {
    void call(actionName, payload, message).catch(() => {});
  }
  function persist(settings: Settings) {
    const task = saveChain.current
      .catch(() => {})
      .then(() => window.encoder.invoke("settings", { patch: settings }))
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
      const result: State = await call("applyPreset", { id: p.id });
      changed(result.settings);
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
      });
      changed(r.settings);
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
      });
      changed(r.settings);
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
  const renderMeta = () =>
    job?.meta ? (
      <FileMeta meta={job.meta} />
    ) : (
      <p className="muted">
        {job?.status === "probing"
          ? "正在读取视频信息…"
          : "选中视频后显示分辨率、帧率与音轨信息。"}
      </p>
    );
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
        else action("add", { paths });
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
          <Button
            title="设置与引擎"
            aria-label="设置与引擎"
            onClick={() => setModal("engines")}
          >
            <Settings2 size={18} />
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
      </nav>
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
        <main className="workspace">
          <section className="queue-column" aria-label="视频队列">
            <div className="section-heading">
              <div>
                <span className="eyebrow">工作区</span>
                <h2>
                  视频队列 <span className="count">{jobs.length}</span>
                </h2>
              </div>
              <Button variant="primary" onClick={add} disabled={busy}>
                <Plus size={17} />
                添加视频
              </Button>
            </div>
            <div className={`queue-panel ${drag ? "dragging" : ""}`}>
              <div className="queue-toolbar">
                <span>
                  <FileVideo size={15} /> 源文件
                </span>
                <Button
                  variant="ghost"
                  disabled={!doneCount}
                  onClick={() =>
                    action(
                      "clearCompleted",
                      undefined,
                      "已移除完成项，输出文件保留",
                    )
                  }
                >
                  清除已完成
                </Button>
              </div>
              {!jobs.length ? (
                <div className="empty-queue">
                  <div className="film-emblem">
                    <Film size={42} />
                    <div className="frame-ticks" />
                  </div>
                  <h3>把视频放进来</h3>
                  <p>
                    拖入多个视频，或从文件夹中选择
                    <br />
                    保留创作，把压制交给队列。
                  </p>
                  <Button onClick={add} disabled={busy}>
                    <FolderOpen size={17} />
                    选择视频文件
                  </Button>
                  <small>AVI · MOV · MP4 · MKV · WebM 等常见视频格式</small>
                </div>
              ) : (
                <ol className="job-list">
                  {jobs
                    .slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
                    .map((j, i) => (
                      <li
                        key={j.id}
                        className={`job-row ${j.id === job?.id ? "selected" : ""}`}
                        {...sortJob(j.id)}
                      >
                        <button
                          className="job-select"
                          onClick={() => setSelected(j.id)}
                          aria-pressed={j.id === job?.id}
                        >
                          <span
                            className={`file-tile ${j.status === "done" ? "complete" : ""}`}
                          >
                            {j.status === "done" ? (
                              <Check size={22} />
                            ) : (
                              <FileVideo size={23} />
                            )}
                            <small>
                              {j.name
                                .split(".")
                                .pop()
                                ?.slice(0, 5)
                                .toUpperCase()}
                            </small>
                          </span>
                          <span className="job-copy">
                            <strong title={j.name}>{j.name}</strong>
                            <span className="job-sub">
                              {j.meta
                                ? metaSummary(j.meta)
                                : "正在读取素材信息"}
                            </span>
                            <span className={`job-status ${j.status}`}>
                              {j.status === "encoding" && (
                                <LoaderCircle size={12} className="spin" />
                              )}
                              {statusLabels[j.status] || j.status}
                              {j.status === "encoding"
                                ? ` · ${Math.round(j.progress)}% · ${j.stage || "编码"} · ${formatDuration(j.elapsed || 0)}`
                                : ""}
                            </span>
                          </span>
                        </button>
                        {["done", "cancelled"].includes(j.status) && (
                          <Button
                            variant="ghost icon"
                            aria-label={`重新导出 ${j.name}`}
                            title="重新导出：放回队列，按当前设置压制，已有文件不覆盖"
                            disabled={state.running}
                            onClick={() =>
                              action(
                                "requeue",
                                { id: j.id },
                                "已放回队列，开始压制时使用当前设置",
                              )
                            }
                          >
                            <RefreshCw size={16} />
                          </Button>
                        )}
                        <Button
                          variant="ghost icon"
                          aria-label={`移除 ${j.name}`}
                          title="从队列移除"
                          disabled={j.status === "encoding" || state.running}
                          onClick={() => action("remove", { id: j.id })}
                        >
                          <X size={16} />
                        </Button>
                        <span className="row-index">
                          {String(page * PAGE_SIZE + i + 1).padStart(2, "0")}
                        </span>
                        {j.status === "encoding" && (
                          <progress
                            max={100}
                            value={j.progress}
                            aria-label={`${j.name} 压制进度`}
                          />
                        )}
                      </li>
                    ))}
                </ol>
              )}
              {jobs.length > 0 && (
                <div className="queue-pagination">
                  <span>
                    {page * PAGE_SIZE + 1}–
                    {Math.min((page + 1) * PAGE_SIZE, jobs.length)} /{" "}
                    {jobs.length} 个视频
                  </span>
                  <div>
                    <Button
                      aria-label="上一页"
                      disabled={page === 0}
                      onClick={() => setPage(page - 1)}
                    >
                      <ChevronLeft size={16} />
                    </Button>
                    <Button
                      aria-label="下一页"
                      disabled={page + 1 >= pageCount}
                      onClick={() => setPage(page + 1)}
                    >
                      <ChevronRight size={16} />
                    </Button>
                  </div>
                </div>
              )}
            </div>
            {job && (
              <section className="detail-card">
                <div className="detail-title">
                  <span className="eyebrow">当前素材</span>
                  <Button
                    variant="ghost"
                    onClick={() => action("reveal", { path: job.path })}
                  >
                    <FolderOpen size={14} />
                    打开位置
                  </Button>
                </div>
                <h3 title={job.name}>{job.name}</h3>
                <Button
                  disabled={!!state.tools?.busy}
                  onClick={async () => {
                    setDetails(null);
                    setModal("details");
                    try {
                      setDetails(await call("details", { id: job.id }));
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  文件详情 · 转换前 / 后
                </Button>
                {renderMeta()}
                <p className="path-text" title={job.path}>
                  {job.path}
                </p>
                {job.error && (
                  <div className="inline-error" role="alert">
                    {job.error}
                  </div>
                )}
                {["failed", "partial", "cancelled", "invalid"].includes(
                  job.status,
                ) && (
                  <div className="recovery">
                    <Button onClick={() => openLog(job)}>
                      <Terminal size={14} />
                      查看日志
                    </Button>
                    <Button
                      onClick={() => {
                        setTab("encoding");
                        document.getElementById("encoder")?.focus();
                      }}
                    >
                      调整参数
                    </Button>
                    <Button
                      disabled={state.running}
                      onClick={() => {
                        if (s)
                          persist(s)
                            .then(() => call("retry", { id: job.id }))
                            .catch((e) => setError(e.message));
                      }}
                    >
                      重试
                    </Button>
                    {job.status === "failed" &&
                      !/磁盘|空间|权限|ENOENT|EACCES|ENOSPC/.test(
                        job.error || "",
                      ) &&
                      /nvenc|qsv|amf/.test(
                        job.settings?.encoder || s.encoder,
                      ) && (
                        <Button
                          disabled={state.running}
                          onClick={() => setFallback(job)}
                        >
                          改用软件编码重试
                        </Button>
                      )}
                  </div>
                )}
                {job.output && (
                  <Button
                    variant="ghost"
                    onClick={() => action("reveal", { path: job.output })}
                  >
                    <FolderOpen size={15} />
                    查看输出文件
                  </Button>
                )}
              </section>
            )}
            <div className="workflow-note">
              <span className="note-icon">
                <Info size={17} />
              </span>
              <div>
                <strong>从素材到成片，路径清晰可见</strong>
                <p>原视频始终保留。同名输出自动编号，每个任务独立记录结果。</p>
              </div>
            </div>
          </section>
          <aside className="settings-column" aria-label="压制设置">
            <div className="section-heading">
              <div>
                <span className="eyebrow">输出控制</span>
                <h2>压制设置</h2>
              </div>
              <SlidersHorizontal size={20} className="muted" />
            </div>
            <div className="settings-panel">
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
              <div className="setting-tabs" role="group" aria-label="设置分类">
                {[
                  { id: "encoding", name: "画质" },
                  { id: "audio", name: "音频" },
                  { id: "alpha", name: "透明通道" },
                  { id: "rtx", name: "RTX 增强" },
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
                          // ProRes takes a quantizer, not a CRF; start at 8.
                          ...(v === "prores_ks" && s.encoder !== "prores_ks"
                            ? { quality: 8, rateControl: "quality" }
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
                        ? "ProRes 量化 1–64：数值越小质量越高、文件越大；0 为编码器默认（约为量化 8 的 4 倍大小）。4:2:2 对应 HQ，4:4:4 对应 4444。"
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
                                  invalid ? "请输入 2–16384 的整数" : undefined
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
                          <p className="hint">添加视频后自动计算另一边尺寸。</p>
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
                    <h3 className="panel-subtitle">保留声音的细节</h3>
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
                    <div className="help-box">
                      <Info size={17} />
                      <p>
                        保持源采样率与声道。MP4 推荐 AAC；FLAC 无损音频推荐使用
                        MKV。源视频没有音轨时，输出也不添加音轨。
                      </p>
                    </div>
                    {job?.meta?.audio && (
                      <div className="mini-facts">
                        <span>源音频</span>
                        <strong>
                          {job.meta.audio.codec.toUpperCase()} /{" "}
                          {job.meta.audio.sampleRate / 1000} kHz
                        </strong>
                      </div>
                    )}
                  </>
                )}
                {tab === "rtx" && (
                  <RtxSettings s={s} state={state} set={set} call={call} />
                )}
                {tab === "alpha" && (
                  <>
                    <h3 className="panel-subtitle">彩色视频与透明遮罩</h3>
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
                          // ProRes alpha starts at quantizer 8 (~1/4 of the default size).
                          ...(v === "preserve" &&
                          s.alphaMode !== "preserve" &&
                          s.encoder === "prores_ks"
                            ? { quality: 8 }
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
                    {s.alphaMask && job?.meta && !job.meta.hasAlpha && (
                      <p className="inline-error">
                        当前素材没有可读取的 Alpha
                        通道，不能分离遮罩。请选择其他处理方式或包含透明通道的视频。
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
                      {["{name}", "{preset}", "{date}", "{index}"].map((v) => (
                        <Button
                          key={v}
                          variant="ghost"
                          onClick={() =>
                            set("nameTemplate", s.nameTemplate + v)
                          }
                        >
                          {v}
                        </Button>
                      ))}
                    </div>
                    <p className="hint">原名 / 预设名 / 日期 / 队列序号</p>
                    <div className="path-preview">
                      <span>输出示例</span>
                      <code>{preview?.output || "添加视频后显示完整路径"}</code>
                    </div>
                  </>
                )}
                {tab === "advanced" && (
                  <>
                    <div className="advanced-title">
                      <h3 className="panel-subtitle">编码细节</h3>
                      <Button disabled={!job} onClick={copy}>
                        <Copy size={14} />
                        复制命令
                      </Button>
                    </div>
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
                    <details className="command-details">
                      <summary>查看完整命令</summary>
                      <pre>{preview?.command || "添加视频后生成命令"}</pre>
                    </details>
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
                {engine?.label || s.encoder} · {s.bitDepth}-bit
              </span>
            </strong>
            <span className="output-facts">
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
              {job?.meta && !job.meta.audio ? "无音轨" : audioLabels[s.audio]}
              {(!job?.meta || job.meta.audio) &&
              ["aac", "libopus"].includes(s.audio) &&
              s.audioBitrate > 0
                ? ` · ${s.audioBitrate} kbps`
                : ""}{" "}
              {s.alphaMode === "preserve" && " · 保留 Alpha"}
              <i /> 输出 → {s.container.toUpperCase()}{" "}
              {s.alphaMask && (
                <>
                  <i />+ Alpha 遮罩
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
        open={modal === "presets"}
        onClose={() => setModal("")}
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
                  {presetHidden(p)
                    ? p.hidden !== undefined
                      ? " · 已隐藏"
                      : " · 已自动隐藏（本机支持硬件编码）"
                    : ""}
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
        open={modal === "engines"}
        onClose={() => setModal("")}
        title="编码引擎"
        description="首次使用从官方来源下载工具到本机；安装后可离线编码，无需管理员权限。"
      >
        <section
          className="modal-section"
          aria-label="软件更新"
          aria-busy={update.checking}
        >
          <h3>软件更新</h3>
          <div className="status-row">
            <p>
              MMDEncoder {__APP_VERSION__} ·{" "}
              {update.checking
                ? "正在检查更新…"
                : update.error
                  ? "检查更新失败：" + update.error
                  : update.newer
                    ? `发现新版本 ${update.latest}`
                    : update.current
                      ? update.latest
                        ? "已是最新版本"
                        : "项目尚未发布版本"
                      : "尚未检查更新"}
            </p>
            <div className="row-actions">
              <Button
                disabled={update.checking || appUpdate.phase === "downloading"}
                onClick={() => checkUpdate()}
              >
                <RefreshCw size={15} />
                检查更新
              </Button>
              {update.newer && update.canInstall && (
                <Button
                  variant="primary"
                  disabled={
                    busy ||
                    state.running ||
                    ["downloading", "extracting", "installing"].includes(
                      appUpdate.phase,
                    )
                  }
                  onClick={() =>
                    appUpdate.phase === "ready"
                      ? void installUpdate()
                      : void downloadUpdate()
                  }
                >
                  <ArrowDownToLine size={15} />
                  {appUpdate.phase === "ready"
                    ? "重启并完成更新"
                    : appUpdate.phase === "downloading"
                      ? "正在下载…"
                      : appUpdate.phase === "extracting"
                        ? "正在解压…"
                        : "下载并更新"}
                </Button>
              )}
              <Button
                variant={
                  update.newer && !update.canInstall ? "primary" : undefined
                }
                onClick={() =>
                  action("openReleasePage", {
                    url: update.newer ? update.url : "",
                  })
                }
              >
                <ExternalLink size={15} />
                {update.newer ? "打开下载页" : "项目发行页"}
              </Button>
            </div>
          </div>
          {update.newer && (
            <p
              className={appUpdate.error ? "inline-error" : "hint"}
              role={appUpdate.error ? "alert" : undefined}
            >
              {appUpdate.error
                ? "更新失败：" + appUpdate.error
                : appUpdate.phase === "downloading"
                  ? `已下载 ${formatSize(appUpdate.received)}${appUpdate.total ? " / " + formatSize(appUpdate.total) : ""}`
                  : appUpdate.phase === "ready"
                    ? "新版本已下载并通过校验。点“重启并完成更新”后软件会关闭，替换程序文件后自动重新打开；设置、预设和日志（data 文件夹）保留不动。"
                    : update.canInstall
                      ? "下载后先校验 SHA-256，再替换程序文件；data 文件夹保留不动，替换失败会自动还原旧版本。"
                      : update.installBlocked ||
                        "这个版本没有可自动安装的压缩包，请打开下载页手动更新。"}
            </p>
          )}
        </section>
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
                    state.tools.busy || state.running || state.detecting
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
                    state.tools.busy || state.running || state.detecting
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
                    state.tools.busy || state.running || state.detecting
                  }
                  onClick={() => action("checkTools")}
                >
                  检查工具更新
                </Button>
                <Button
                  disabled={
                    state.tools.busy || state.running || state.detecting
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
            {state.running && <p>编码结束后可更新工具。</p>}
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
        description="队列仍在运行。退出将取消未完成任务，保留原视频和已完成输出。"
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
