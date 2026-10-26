import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
} from "lucide-react";
import { Button, Field } from "./components";
import { clock, seconds, mmdFrame } from "./trimCoordinates";
import type { TrimClip } from "./types";
import { errorMessage } from "./i18n";
export function TrimEditor({
  ready,
  frame,
  image,
  running,
  smart,
  mmdFrames,
  cuts,
  inText,
  outText,
  onKey,
  onReveal,
  onMmdStart,
  onSeek,
  move,
  jump,
  setRange,
  setInText,
  setOutText,
  applyText,
  pct,
}: {
  ready: TrimClip;
  frame: number;
  image: string;
  running: boolean;
  smart: boolean;
  mmdFrames: boolean;
  cuts: number[] | null;
  inText: string;
  outText: string;
  onKey: (event: React.KeyboardEvent) => void;
  onReveal: () => unknown;
  onMmdStart: (value: number) => unknown;
  onSeek: (frame: number) => void;
  move: (frame: number) => unknown;
  jump: (direction: 1 | -1) => void;
  setRange: (from: number | string, to: number | string) => unknown;
  setInText: (value: string) => void;
  setOutText: (value: string) => void;
  applyText: (which: "in" | "out") => unknown;
  pct: (frame: number) => string;
}) {
  return (
    <section
      className="detail-card trim-editor"
      aria-label="片段编辑"
      tabIndex={0}
      onKeyDown={onKey}
    >
      <div className="detail-title">
        <span className="eyebrow">编辑片段</span>
        <div className="detail-actions">
          <Button variant="ghost" onClick={onReveal}>
            <FolderOpen size={14} />
            打开位置
          </Button>
        </div>
      </div>
      <h3 title={ready.path}>{ready.name}</h3>
      <div className="trim-preview">
        {image ? (
          <img src={image} alt={`第 ${frame} 帧`} />
        ) : (
          <LoaderCircle size={22} className="spin" />
        )}
      </div>
      {mmdFrames && (
        <div className="file-pick mmd-start">
          <span>视频第 0 帧 = MMD 第</span>
          <input
            aria-label="视频第 0 帧对应的 MMD 帧"
            inputMode="numeric"
            key={ready.id + ":" + ready.mmdStart}
            defaultValue={String(ready.mmdStart ?? 0)}
            disabled={running}
            onBlur={(e) =>
              Number(e.target.value) !== (ready.mmdStart ?? 0) &&
              onMmdStart(Number(e.target.value))
            }
            onKeyDown={(e) =>
              e.key === "Enter" && (e.target as HTMLInputElement).blur()
            }
          />
          <span className="hint">
            帧
            {ready.mmdStartFrom === "tag"
              ? "（来自 MMDEncoder 导出时记录的信息）"
              : ready.mmdStartFrom === "name"
                ? "（来自文件名里的帧范围）"
                : ready.mmdStartFrom === "manual"
                  ? "（手动填写）"
                  : "（没有识别到，按 0 计算，可以手动填写）"}
          </span>
        </div>
      )}
      <div className="trim-position">
        <strong>
          第 {frame} 帧{mmdFrames && ` · MMD 第 ${mmdFrame(ready, frame)} 帧`}
        </strong>
        <span>{clock(seconds(ready, frame))}</span>
        {(ready.cuts === "all" || cuts?.includes(frame)) && (
          <span className="cut-badge">可切</span>
        )}
      </div>
      <div className="trim-track">
        <div className="trim-marks" aria-hidden="true">
          <div className="trim-rail" />
          <div
            className="trim-range"
            style={{
              left: pct(ready.from ?? 0),
              right: `calc(100% - ${pct((ready.to ?? 1) - 1)})`,
            }}
          />
          {cuts &&
            cuts.length <= 400 &&
            cuts.map((c) => (
              <i key={c} className="trim-tick" style={{ left: pct(c) }} />
            ))}
        </div>
        <input
          type="range"
          aria-label="当前帧"
          aria-valuetext={`第 ${frame} 帧`}
          min={0}
          max={(ready.frames || 1) - 1}
          value={frame}
          onChange={(e) => {
            // Pointer drags and clicks (keys are handled by onKey).
            const v = Number(e.target.value);
            onSeek(v);
          }}
        />
      </div>
      <div className="trim-buttons">
        <Button
          variant="ghost icon"
          aria-label="上一个可切位置"
          title="上一个可切位置（↑）"
          onClick={() => jump(-1)}
        >
          <ChevronFirst size={16} />
        </Button>
        <Button
          variant="ghost icon"
          aria-label="上一帧"
          title="上一帧（←）"
          onClick={() => move(frame - 1)}
        >
          <ChevronLeft size={16} />
        </Button>
        <Button
          variant="ghost icon"
          aria-label="下一帧"
          title="下一帧（→）"
          onClick={() => move(frame + 1)}
        >
          <ChevronRight size={16} />
        </Button>
        <Button
          variant="ghost icon"
          aria-label="下一个可切位置"
          title="下一个可切位置（↓）"
          onClick={() => jump(1)}
        >
          <ChevronLast size={16} />
        </Button>
        <Button
          disabled={running}
          title="I"
          onClick={() =>
            setRange(frame, ready.to === ready.frames ? "end" : (ready.to ?? 0))
          }
        >
          设为入点
        </Button>
        <Button
          disabled={running}
          title="O"
          onClick={() => setRange(ready.from ?? 0, frame)}
        >
          设为出点
        </Button>
      </div>
      <div className="form-row">
        <Field
          id="trim-in"
          label={mmdFrames ? "入点 · MMD 帧号或时间" : "入点 · 帧号或时间"}
        >
          <input
            id="trim-in"
            value={inText}
            disabled={running}
            onChange={(e) => setInText(e.target.value)}
            onBlur={() => applyText("in")}
            onKeyDown={(e) => e.key === "Enter" && applyText("in")}
          />
        </Field>
        <Field id="trim-out" label="出点（不含这一帧；end 为结尾）">
          <input
            id="trim-out"
            value={outText}
            disabled={running}
            onChange={(e) => setOutText(e.target.value)}
            onBlur={() => applyText("out")}
            onKeyDown={(e) => e.key === "Enter" && applyText("out")}
          />
        </Field>
      </div>
      <p className="hint">
        实际：第 {ready.from} –{" "}
        {ready.to === ready.frames ? "结尾" : `${ready.to}`} 帧，共{" "}
        {(ready.to ?? 0) - (ready.from ?? 0)} 帧（
        {clock(seconds(ready, (ready.to ?? 0) - (ready.from ?? 0)))}）
        {ready.requested &&
          (ready.requested.from !== ready.from ||
            (ready.requested.to !== ready.to && ready.to !== ready.frames)) &&
          `。已吸附到最近的可切位置（输入 ${ready.requested.from} – ${ready.requested.to}）`}
        。
        {ready.cuts === "all"
          ? "这个文件每一帧都可以切。"
          : `可切位置共 ${cuts?.length} 处${cuts && cuts.length > 1 ? `，约每 ${Math.round((ready.frames || 0) / cuts.length)} 帧一处` : "（只能从开头切）"}。`}
        {smart &&
          ready.cuts !== "all" &&
          (ready.smartBlocker
            ? ` 这个文件不能智能剪切：${errorMessage(ready.smartBlocker)}，仍吸附到可切位置。`
            : (() => {
                const list = (ready.cuts as number[]) || [];
                const from = ready.from ?? 0,
                  to = ready.to ?? 0;
                const a = list.find((x) => x >= from) ?? (ready.frames || 0);
                const b =
                  to === ready.frames
                    ? to
                    : ([...list].reverse().find((x) => x <= to) ?? 0);
                if (a >= b)
                  return ` 智能剪切：这一段第 ${from}–${to - 1} 帧全部重新编码。`;
                const parts = [
                  from < a ? `第 ${from}–${a - 1} 帧` : "",
                  b < to ? `第 ${b}–${to - 1} 帧` : "",
                ].filter(Boolean);
                return parts.length
                  ? ` 智能剪切：${parts.join("、")}重新编码，其余直接复制。`
                  : " 智能剪切：切点正好在关键帧上，全部直接复制。";
              })())}
        {ready.refused?.length
          ? ` 其他关键帧不能切：${ready.refused.map(errorMessage).join("；")}。`
          : ""}
      </p>
    </section>
  );
}
