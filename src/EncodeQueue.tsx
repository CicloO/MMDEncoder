import {
  AudioLines,
  Check,
  ChevronLeft,
  ChevronRight,
  Film,
  FileVideo,
  FolderOpen,
  Info,
  LoaderCircle,
  Music,
  Plus,
  RefreshCw,
  Terminal,
  X,
} from "lucide-react";
import { useState } from "react";
import { Button, Select, useDragSort, PAGE_SIZE } from "./components";
import { AlignDialog } from "./AlignDialog";
import { offsetText } from "./autoAlign";
import { FileMeta, metaSummary } from "./FileMeta";
import { formatDuration, statusLabel, targetLabel } from "./presentation";
import type { Job, Settings, State } from "./types";

// Frame rates a PNG sequence can play at (backend SEQUENCE_RATES).
const SEQUENCE_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120];
// Time left from the pace so far, once there is enough to go on.
const remaining = (j: Job) =>
  j.progress >= 2 && (j.elapsed || 0) >= 5
    ? ` · 剩余约 ${formatDuration(((j.elapsed || 0) * (100 - j.progress)) / j.progress)}`
    : "";
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

// 视频压制 page, left column: the queue, its pages, and the selected video.
export function EncodeQueue({
  state,
  jobs,
  job,
  s,
  page,
  setPage,
  pageCount,
  setSelected,
  drag,
  busy,
  doneCount,
  sortJob,
  add,
  call,
  action,
  pickAudio,
  persist,
  openLog,
  setDetails,
  setModal,
  setError,
  setTab,
  setFallback,
}: {
  state: State;
  jobs: Job[];
  job: Job | undefined;
  s: Settings;
  page: number;
  setPage: (page: number) => void;
  pageCount: number;
  setSelected: (id: string) => void;
  drag: boolean;
  busy: boolean;
  doneCount: number;
  sortJob: ReturnType<typeof useDragSort>;
  add: () => void;
  call: (action: string, payload?: unknown, message?: string) => Promise<any>;
  action: (action: string, payload?: unknown, message?: string) => void;
  pickAudio: (job: Job) => void;
  persist: (settings: Settings) => Promise<void>;
  openLog: (job: Job) => void;
  setDetails: (details: any) => void;
  setModal: (modal: string) => void;
  setError: (message: string) => void;
  setTab: (tab: string) => void;
  setFallback: (job: Job) => void;
}) {
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
  // The video whose replacement audio is being aligned (音频对齐).
  const [alignId, setAlignId] = useState("");
  const aligning = jobs.find((j) => j.id === alignId);
  return (
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
              action("clearCompleted", undefined, "已移除完成项，输出文件保留")
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
              PNG 序列：拖入文件夹，或选其中任意一张。
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
                        {j.name.split(".").pop()?.slice(0, 5).toUpperCase()}
                      </small>
                    </span>
                    <span className="job-copy">
                      <strong title={j.name}>{j.name}</strong>
                      <span className="job-sub">
                        {j.meta ? metaSummary(j.meta) : "正在读取素材信息"}
                        {j.audioPath &&
                          ` · 音频：${baseName(j.audioPath)}${j.audioOffset !== undefined ? " · 对齐 " + offsetText(j.audioOffset) : ""}`}
                      </span>
                      {(() => {
                        const own = j.ownSettings;
                        return (
                          own && (
                            <span
                              className="job-target"
                              title={`单独设置${own.presetName ? "：" + own.presetName : ""}`}
                            >
                              → {targetLabel(own, state.engines)}
                            </span>
                          )
                        );
                      })()}
                      <span className={`job-status ${j.status}`}>
                        {j.status === "encoding" && (
                          <LoaderCircle size={12} className="spin" />
                        )}
                        {statusLabel(j.status)}
                        {j.status === "encoding"
                          ? ` · ${Math.round(j.progress)}% · ${j.stage || "编码"} · ${formatDuration(j.elapsed || 0)}${remaining(j)}`
                          : j.status === "done" && j.elapsed
                            ? ` · 用时 ${j.elapsed < 1 ? "不到 1 秒" : formatDuration(j.elapsed)}`
                            : ""}
                      </span>
                    </span>
                  </button>
                  {!["encoding", "done"].includes(j.status) && (
                    <Button
                      variant="ghost icon"
                      aria-label={`为 ${j.name} 选择音频`}
                      title="替换音频"
                      disabled={state.running}
                      onClick={() => pickAudio(j)}
                    >
                      <Music size={16} />
                    </Button>
                  )}
                  {/* As on the media page: the alignment of a chosen audio. */}
                  {!["encoding", "done"].includes(j.status) && j.audioPath && (
                    <Button
                      variant={`ghost icon${j.audioOffset !== undefined ? " active" : ""}`}
                      aria-label={`对齐 ${j.name} 的替换音频`}
                      title={
                        j.meta?.audio
                          ? "音频对齐：以视频自带的声音为参考检视、微调"
                          : "这个视频没有自带的声音，无法对齐"
                      }
                      disabled={state.running || !j.meta?.audio}
                      onClick={() => setAlignId(j.id)}
                    >
                      <AudioLines size={16} />
                    </Button>
                  )}
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
              {Math.min((page + 1) * PAGE_SIZE, jobs.length)} / {jobs.length}{" "}
              个视频
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
            <div className="detail-actions">
              <Button
                variant="ghost"
                title="转换前 / 后的 ffprobe 参数"
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
                <Info size={14} />
                文件详情
              </Button>
              <Button
                variant="ghost"
                // Before encoding: the source; once written: the result.
                title={job.output ? "打开成片所在位置" : "打开源文件所在位置"}
                onClick={() =>
                  action("reveal", { path: job.output || job.path })
                }
              >
                <FolderOpen size={14} />
                打开位置
              </Button>
            </div>
          </div>
          <h3 title={job.name}>{job.name}</h3>
          {renderMeta()}
          {job.sequence && (
            // Pictures carry no frame rate: the user says how fast they play.
            <div className="sequence-rate">
              <Select
                id="sequence-fps"
                label="序列帧率"
                value={String(job.sequence.fps)}
                disabled={
                  state.running ||
                  ![
                    "ready",
                    "invalid",
                    "done",
                    "failed",
                    "cancelled",
                    "partial",
                  ].includes(job.status)
                }
                hint={`${job.sequence.count} 张图片按这个帧率播放，时长随之改变。`}
                options={SEQUENCE_RATES.map((r) => ({
                  value: String(r),
                  label: `${r} FPS`,
                }))}
                onChange={(v) =>
                  action("setSequenceFps", {
                    id: job.id,
                    fps: Number(v),
                  })
                }
              />
            </div>
          )}
          <p
            className="path-text"
            title={job.sequence ? job.sequence.pattern : job.path}
          >
            {job.sequence ? job.sequence.pattern.replace(/%%/g, "%") : job.path}
          </p>
          {job.audioPath && (
            <div className="replace-audio">
              <Music size={14} />
              <span className="path-text" title={job.audioPath}>
                替换音频：{job.audioPath}
                {job.audioOffset !== undefined &&
                  ` · 对齐 ${offsetText(job.audioOffset)}`}
              </span>
              <Button
                variant="ghost"
                disabled={state.running || !job.meta?.audio}
                title={
                  job.meta?.audio
                    ? "以视频自带的声音为参考，检视、微调替换音频的对齐"
                    : "这个视频没有自带的声音，无法对齐"
                }
                onClick={() => setAlignId(job.id)}
              >
                <AudioLines size={14} />
                对齐
              </Button>
              <Button
                variant="ghost"
                disabled={state.running}
                onClick={() => action("setAudio", { id: job.id, path: "" })}
              >
                改回原音轨
              </Button>
            </div>
          )}
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
                !/磁盘|空间|权限|ENOENT|EACCES|ENOSPC/.test(job.error || "") &&
                /nvenc|qsv|amf/.test(job.settings?.encoder || s.encoder) && (
                  <Button
                    disabled={state.running}
                    onClick={() => setFallback(job)}
                  >
                    改用软件编码重试
                  </Button>
                )}
            </div>
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
      <AlignDialog
        open={!!aligning?.audioPath}
        call={call}
        onClose={() => setAlignId("")}
        targetPath={aligning?.audioPath}
        fixedReference={aligning?.path}
        initial={
          aligning?.audioOffset !== undefined
            ? { offset: aligning.audioOffset }
            : undefined
        }
        description={`把替换音频对齐到“${aligning?.name || ""}”自带的声音；压制时按这里的结果截取或补静音，时长仍与视频相同。`}
        onApply={(a) =>
          call("setAudioOffset", { id: aligning!.id, offset: a.offset })
        }
        onClear={
          aligning?.audioOffset !== undefined
            ? () => call("setAudioOffset", { id: aligning.id, offset: null })
            : undefined
        }
      />
    </section>
  );
}
