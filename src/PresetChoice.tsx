import { Select } from "./components";
import type { Preset } from "./types";
import { t } from "./i18n";
import { presetLabel } from "./presentation";

export function PresetChoice({
  presets,
  value,
  modified,
  hidden,
  onChange,
}: {
  presets: Preset[];
  value: string;
  modified: boolean;
  hidden: (p: Preset) => boolean;
  onChange: (id: string) => void;
}) {
  return (
    <Select
      id="preset-select"
      label={t(modified ? "preset.choiceModified" : "preset.choice")}
      value={value}
      options={[
        { value: "", label: t("preset.custom") },
        ...presets
          .filter((p) => !hidden(p) || p.id === value)
          .map((p) => ({ value: p.id, label: presetLabel(p, presets) })),
      ]}
      onChange={onChange}
    />
  );
}
