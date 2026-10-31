import { t, summaryMessage } from "./i18n";
import { Info, X } from "lucide-react";
import { Button } from "./components";
import type { Settings } from "./types";
import type { MessageDescriptor } from "./i18n";
export type VideoFix = Partial<MessageDescriptor> & {
  id: string;
  label: string;
  patch: Partial<Settings>;
};
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
          {fix.code
            ? summaryMessage({
                code: fix.code,
                params: fix.params || {},
                message: fix.message || fix.label,
              })
            : fix.label}
        </Button>
      ))}
      <Button
        variant="ghost"
        aria-label={t("video.closeHint")}
        onClick={onDismiss}
      >
        <X size={15} />
      </Button>
    </div>
  );
}
