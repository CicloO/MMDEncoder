import { Bookmark, GripVertical, Eye, EyeOff, Trash2 } from "lucide-react";
import { Button, useDragSort } from "./components";
import type { Preset } from "./types";
import { t } from "./i18n";
import { presetLabel } from "./presentation";
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
            <strong>{presetLabel(p, presets)}</strong>
            <small>
              {t(
                p.builtin
                  ? p.edited
                    ? "preset.edited"
                    : "preset.builtin"
                  : "preset.personal",
              )}{" "}
              · {p.settings.container.toUpperCase()} · {p.settings.encoder}
              {hidden(p) ? t("preset.hidden") : ""}
            </small>
          </div>
          <Button onClick={() => onApply(p)}>{t("preset.apply")}</Button>
          <Button onClick={() => onRename(p)}>{t("preset.rename")}</Button>
          <Button
            variant="ghost"
            title={t(hidden(p) ? "preset.show" : "preset.hide")}
            aria-label={t(hidden(p) ? "preset.showName" : "preset.hideName", {
              name: presetLabel(p, presets),
            })}
            onClick={() => onHide(p)}
          >
            {hidden(p) ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
          <Button
            variant="ghost"
            aria-label={t("preset.deleteName", {
              name: presetLabel(p, presets),
            })}
            onClick={() => onDelete(p)}
          >
            <Trash2 size={16} />
          </Button>
        </div>
      ))}
    </div>
  );
}
