import { Select } from "./components";
import type { Preset } from "./types";

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
      label={`编码预设${modified ? " · 已修改" : ""}`}
      value={value}
      options={[
        { value: "", label: "自定义设置" },
        ...presets
          .filter((p) => !hidden(p) || p.id === value)
          .map((p) => ({ value: p.id, label: p.name })),
      ]}
      onChange={onChange}
    />
  );
}
