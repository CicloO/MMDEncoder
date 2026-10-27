import { useEffect, useRef, useState } from "react";
import {
  Sun,
  Moon,
  ArrowDownToLine,
  Layers,
  Settings2,
  Check,
  Bookmark,
  LoaderCircle,
  Clapperboard,
} from "lucide-react";
import { Button, Modal, useDragSort, PAGE_SIZE } from "./components";
import { MediaTools } from "./MediaTools";
import { TrimTools } from "./TrimTools";
import { EncodeQueue } from "./EncodeQueue";
import { createAudioReplacement, audioTarget } from "./audioReplacement";
import { useAlignmentTasks } from "./useAlignmentTasks";
import { MediaDetails } from "./MediaDetails";
import { EncodeFooter } from "./EncodeFooter";
import { VideoFeedback } from "./VideoFeedback";
import { VideoSettings } from "./VideoSettings";
import { AboutDialog, type UpdateCheck, type AppUpdate } from "./AboutDialog";
import { VideoSettingsPanel } from "./VideoSettingsPanel";
import { usePresetManagement, presetHidden } from "./PresetManagement";
import { MmdExportDialog, useMmdExport } from "./MmdExportDialog";
import {
  EngineManagementDialog,
  EngineStatusButton,
  useEngineInstallationPrompt,
} from "./EngineManagement";
import { createActions } from "./actions";
import { invoke } from "./ipc";
import { errorMessage, summaryMessage, t, notification } from "./i18n";
import { serializeError } from "../locales/messages.mjs";
import type { VideoFix } from "./VideoFeedback";
import type { ErrorData, MessageDescriptor } from "./i18n";
import { presetLabel, videoName, compatibilityErrors } from "./presentation";
import type { State, Settings, Preview, Job } from "./types";

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
  useEffect(() => {
    try {
      localStorage.removeItem("mmd-auto-align");
    } catch {
      /* Alignment no longer depends on a saved switch. */
    }
  }, []);
  const [state, setState] = useState<State | null>(null),
    [compatibility, setCompatibility] = useState<{
      errors: string[];
      issues?: ErrorData[];
      suggestions: VideoFix[];
    }>({ errors: [], suggestions: [] }),
    [draft, setDraft] = useState<Settings | null>(null),
    [workspace, setWorkspace] = useState("encode"),
    [details, setDetails] = useState<any>(null),
    [selected, setSelected] = useState(""),
    [page, setPage] = useState(0),
    [tab, setTab] = useState("encoding"),
    [modal, setModal] = useState(""),
    [noticeValue, setNotice] = useState<MessageDescriptor | string>(""),
    [errorValue, setError] = useState<
      ErrorData | string | { notice: MessageDescriptor }
    >(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [drag, setDrag] = useState(false),
    [mediaDrop, setMediaDrop] = useState<{ paths: string[]; seq: number }>(),
    [trimDrop, setTrimDrop] = useState<
      { paths: string[]; seq: number } | undefined
    >(),
    [presetId, setPresetId] = useState(""),
    [log, setLog] = useState(""),
    [customFPS, setCustomFPS] = useState(false),
    [fallback, setFallback] = useState<Job | null>(null);
  const error =
    typeof errorValue !== "string" && "notice" in errorValue
      ? summaryMessage(errorValue.notice)
      : errorMessage(errorValue);
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
  const [update, setUpdate] = useState<UpdateCheck>({ checking: false });
  const aboutLabel = `${t("about.open")} · Language`;
  const aboutTitle = update.newer
    ? t("about.openUpdate", { label: aboutLabel, version: update.latest ?? "" })
    : aboutLabel;
  // In-place update progress, mirrored from the main process.
  const [appUpdate, setAppUpdate] = useState<AppUpdate>({
    phase: "idle",
    received: 0,
    total: 0,
    error: "",
  });
  async function downloadUpdate() {
    setAppUpdate((s) => ({
      ...s,
      phase: "downloading",
      error: "",
      errorData: null,
      fallbackData: null,
      received: 0,
      total: update.assets?.size || 0,
      packageKind: update.assets?.kind,
    }));
    const timer = setInterval(() => {
      invoke("appUpdateStatus")
        .then(setAppUpdate)
        .catch(() => {});
    }, 400);
    try {
      await invoke("downloadAppUpdate");
    } catch {
      /* The status below carries the error. */
    } finally {
      clearInterval(timer);
      setAppUpdate(await invoke("appUpdateStatus"));
    }
  }
  async function installUpdate() {
    setBusy(true);
    try {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      if (draftRef.current) await persist(draftRef.current);
      await invoke("installAppUpdate");
    } catch (e) {
      setError(serializeError(e));
      setBusy(false);
    }
  }
  async function checkUpdate(quiet = false) {
    setUpdate((u) => ({
      ...u,
      checking: true,
      error: "",
      errorData: undefined,
    }));
    try {
      const r = await invoke("checkAppUpdate");
      setUpdate({ checking: false, ...r });
      if (r.newer)
        notify(notification("UPDATE_AVAILABLE", { version: r.latest }));
    } catch (e) {
      const detail = serializeError(e);
      setUpdate((u) => ({
        ...u,
        checking: false,
        error: quiet ? "" : detail.message,
        errorData: quiet ? undefined : detail,
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
        setError(
          s.noticeData?.message === s.notice
            ? { notice: s.noticeData }
            : s.notice,
        );
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
      .catch((e) => setError(serializeError(e)));
    return () => {
      off();
      offClose();
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);
  useEngineInstallationPrompt(state?.located, state?.engineInfo, () =>
    setModal("engines"),
  );
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
      invoke("compatibility", { settings: s })
        .then((result) => {
          if (!cancelled) setCompatibility(result);
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [s, state?.engines]);
  const actions = createActions({
    request: invoke,
    onState: receive,
    onError: (text, data) => setError(data || text),
    onNotice: notify,
  });
  const { call, action } = actions;
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
  const videoAlignment = useAlignmentTasks(
    "video",
    (state?.jobs || [])
      .filter((job) => !["encoding", "done"].includes(job.status))
      .map((job) => ({ id: job.id, target: job.audioPath })),
  );
  const audioReplacement = createAudioReplacement({
    call,
    notify,
    tasks: videoAlignment,
    actions: { replace: "setAudio", offset: "setAudioOffset" },
  });
  const pickAudio = (row: Job) => audioReplacement.pickAudio(audioTarget(row));
  const replaceAudio = (row: Job, file: string) =>
    audioReplacement.replaceAudio(audioTarget(row), file);
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
        setError({
          code: "VIDEO_AUDIO_TARGET_REQUIRED",
          params: {},
          message: t("error.VIDEO_AUDIO_TARGET_REQUIRED"),
        });
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
          ? invoke("setJobSettings", { id: to, patch: settings })
          : invoke("settings", { patch: settings }),
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
      await invoke("quit");
    } catch (e) {
      setError(serializeError(e));
      setModal("closeSaveError");
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!draft || !state) return;
    const seq = ++previewSequence.current;
    const timer = setTimeout(() => {
      persist(draft)
        .then(() => (job ? invoke("preview", { id: job.id }) : null))
        .then((p) => {
          if (seq === previewSequence.current) {
            setPreview(p);
            setError("");
          }
        })
        .catch((e) => {
          if (seq === previewSequence.current) {
            setPreview(null);
            setError(serializeError(e));
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
        on ? notification("VIDEO_OWN_ON") : notification("VIDEO_OWN_OFF"),
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
  const presetFlow = usePresetManagement({
    presets,
    presetConflicts: state?.presetConflicts,
    settings: s,
    selection: {
      id: presetId,
      active: activePreset,
      modified,
      select: setPresetId,
      resetCustomFPS: () => setCustomFPS(false),
    },
    draft: {
      latest: () => draftRef.current,
      isOwn: () => !!draftTarget.current,
      change: changed,
      persist,
      beforeApply: async () => {
        if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
        await saveChain.current.catch(() => {});
      },
      beforeRename: async () => {
        if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
        if (draftRef.current) await persist(draftRef.current);
      },
    },
    modal,
    setModal,
    busy,
    setBusy,
    error,
    clearError: () => setError(""),
    actions,
    notify,
  });
  const errors = [
    ...new Set([
      ...(s ? compatibilityErrors(s) : []),
      ...(compatibility.issues?.map(errorMessage) || compatibility.errors),
    ]),
  ];
  async function start() {
    if (!s) return;
    setBusy(true);
    try {
      await persist(s);
      await call("start");
    } catch (e) {
      setError(serializeError(e));
    } finally {
      setBusy(false);
    }
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
      await call(
        "copyCommand",
        { id: job.id },
        notification("VIDEO_COMMAND_COPIED"),
      );
    } catch {}
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
          <EngineStatusButton
            detecting={state.detecting}
            count={state.engines.length}
            onOpen={() => setModal("engines")}
          />
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
            title={aboutTitle}
            aria-label={aboutTitle}
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
            trim={state.trim}
            call={call}
            dropped={trimDrop}
            onDropHandled={() => setTrimDrop(undefined)}
          />
        </div>
      )}
      {workspace === "media" && (
        <div className="page">
          <MediaTools
            jobs={state.mediaJobs}
            running={state.running}
            detecting={state.detecting}
            toolsBusy={!!state.tools?.busy}
            enhancementsBusy={state.enhancements.busy}
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
              aligningIds={videoAlignment.active}
              cancelAlignment={videoAlignment.cancel}
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
              jobName={job ? videoName(job) : ""}
              onOwn={setOwn}
              presets={presets}
              presetId={presetId}
              modified={modified}
              presetHidden={presetHidden}
              onSelectPreset={presetFlow.select}
              hasActivePreset={!!activePreset}
              activePresetLabel={
                activePreset ? presetLabel(activePreset, presets) : ""
              }
              busy={busy}
              onOverwrite={() => void presetFlow.overwrite()}
              onSaveAs={presetFlow.saveAs}
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
            message={
              error ||
              [
                ...new Set([
                  ...errors,
                  ...(preview?.issues?.map(errorMessage) ||
                    preview?.errors ||
                    []),
                ]),
              ].join("\n")
            }
            suggestions={compatibility.suggestions}
            running={state.running}
            onFix={async (fix) => {
              const next = { ...s, ...fix.patch };
              changed(next);
              try {
                await persist(next);
                notify(notification("VIDEO_COMPAT_APPLIED"));
              } catch (e) {
                setError(serializeError(e));
              }
            }}
            onDismiss={() => setError("")}
          />
        )}
      </div>
      <Modal
        open={modal === "details"}
        onClose={() => setModal("")}
        title={t("details.title")}
        description={t("details.description")}
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
      {presetFlow.dialogs.save}
      {presetFlow.dialogs.conflicts}
      {presetFlow.dialogs.manager}
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
        localePreference={state.preferences.locale}
        systemLocale={state.systemLocale}
        blocked={
          busy || state.running || state.trim?.running ? t("about.busy") : ""
        }
        onCheck={() => void checkUpdate()}
        onDownload={() => void downloadUpdate()}
        onInstall={() => void installUpdate()}
        action={action}
      />
      <EngineManagementDialog
        open={modal === "engines"}
        onClose={() => setModal("")}
        error={error}
        status={{
          tools: state.tools,
          engines: state.engines,
          engineInfo: state.engineInfo,
          detecting: state.detecting,
          running: state.running,
          trimRunning: state.trim.running,
        }}
        actions={actions}
        onShowLog={(text) => {
          setLog(text);
          setModal("logs");
        }}
      />
      <Modal
        error={error}
        open={modal === "logs"}
        onClose={() => setModal("")}
        title={t("engine.log.title")}
        description={t("engine.log.description")}
      >
        <pre className="log-view">{log || t("engine.log.empty")}</pre>
      </Modal>
      {presetFlow.dialogs.switching}
      {presetFlow.dialogs.deletion}
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
      {presetFlow.dialogs.rename}
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
