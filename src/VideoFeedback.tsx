import { Info, X } from "lucide-react";
import { Button } from "./components";
import type { Settings } from "./types";
export type VideoFix = { id: string; label: string; patch: Partial<Settings> };
export function VideoFeedback({
  message,
  suggestions,
  running,
  onFix,
  onDismiss,
}: {
  message: string | undefined;
  suggestions: VideoFix[];
  running: boolean;
  onFix: (fix: VideoFix) => void;
  onDismiss: () => void;
}) {
  return (
    <div className="error-banner" role="alert">
      <Info size={17} />
      <span>{message}</span>
      {suggestions.map((fix) => (
        <Button key={fix.id} disabled={running} onClick={() => onFix(fix)}>
          {fix.label}
        </Button>
      ))}
      <Button variant="ghost" aria-label="关闭提示" onClick={onDismiss}>
        <X size={15} />
      </Button>
    </div>
  );
}
