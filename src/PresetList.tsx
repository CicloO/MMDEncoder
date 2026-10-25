import { Bookmark, GripVertical, Eye, EyeOff, Trash2 } from "lucide-react";
import { Button, useDragSort } from "./components";
import type { Preset } from "./types";
export function PresetList({
  presets,
  sort,
  hidden,
  onApply,
  onRename,
  onHide,
  onDelete,
}: {
  presets: Preset[];
  sort: ReturnType<typeof useDragSort>;
  hidden: (p: Preset) => boolean;
  onApply: (p: Preset) => void;
  onRename: (p: Preset) => void;
  onHide: (p: Preset) => void;
  onDelete: (p: Preset) => void;
}) {
  return (
    <div className="preset-list">
      {presets.map((p) => (
        <div
          key={p.id}
          className={`preset-item ${hidden(p) ? "is-hidden" : ""}`}
          {...sort(p.id)}
        >
          <span {...sort.handle(p.id)}>
            <GripVertical size={16} aria-hidden />
          </span>
          <Bookmark size={20} />
          <div>
            <strong>{p.name}</strong>
            <small>
              {p.builtin ? (p.edited ? "内置 · 已修改" : "内置") : "个人"} ·{" "}
              {p.settings.container.toUpperCase()} · {p.settings.encoder}
              {hidden(p) ? " · 已隐藏" : ""}
            </small>
          </div>
          <Button onClick={() => onApply(p)}>调用</Button>
          <Button onClick={() => onRename(p)}>编辑名称</Button>
          <Button
            variant="ghost"
            title={hidden(p) ? "显示" : "隐藏"}
            aria-label={`${hidden(p) ? "显示" : "隐藏"}预设 ${p.name}`}
            onClick={() => onHide(p)}
          >
            {hidden(p) ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
          <Button
            variant="ghost"
            aria-label={`删除预设 ${p.name}`}
            onClick={() => onDelete(p)}
          >
            <Trash2 size={16} />
          </Button>
        </div>
      ))}
    </div>
  );
}
