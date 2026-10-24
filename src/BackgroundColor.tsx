import { useEffect, useState } from "react";

// The colour of 合成到纯色: green screen, black and white to pick, or any
// colour from the picker or typed as #RRGGBB.
const PRESETS = [
  ["#00FF00", "绿幕"],
  ["#000000", "黑"],
  ["#FFFFFF", "白"],
];
const HEX = /^#[0-9a-f]{6}$/i;
export function BackgroundColor({
  value,
  onChange,
}: {
  value: string;
  onChange: (hex: string) => void;
}) {
  const current = value.toUpperCase();
  // What is typed, applied once it is a whole #RRGGBB.
  const [text, setText] = useState(current);
  useEffect(() => setText(current), [current]);
  return (
    <div className="field">
      <span className="field-label" id="alpha-background-label">
        背景颜色
      </span>
      <div className="background-color">
        <div
          className="segmented"
          role="radiogroup"
          aria-labelledby="alpha-background-label"
        >
          {PRESETS.map(([hex, label]) => (
            <label key={hex}>
              <input
                type="radio"
                name="alpha-background"
                checked={current === hex}
                onChange={() => onChange(hex)}
              />
              <span className="color-dot" style={{ background: hex }} />
              {label}
            </label>
          ))}
        </div>
        <label className="color-custom">
          自选
          <input
            type="color"
            aria-label="自选背景颜色"
            value={current.toLowerCase()}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
          />
        </label>
        <input
          className="color-hex"
          aria-label="背景颜色（#RRGGBB）"
          value={text}
          spellCheck={false}
          maxLength={7}
          onChange={(e) => {
            const v = e.target.value.trim();
            setText(v);
            if (HEX.test(v)) onChange(v.toUpperCase());
          }}
          onBlur={() => setText(current)}
        />
      </div>
    </div>
  );
}
