import { notification, type MessageDescriptor } from "./i18n";
import { autoAlign } from "./autoAlign";
import type { RequestCall } from "./actions";
import type { Job } from "./types";

type AudioTarget = {
  id: string;
  path: string;
  hasAudio: boolean;
  isSequence: boolean;
};
export const audioTarget = (
  job: Pick<Job, "id" | "path" | "meta" | "sequence">,
): AudioTarget => ({
  id: job.id,
  path: job.path,
  hasAudio: !!job.meta?.audio,
  isSequence: !!job.sequence,
});

// Owns one replacement request flow; selection, preferences and queue state
// remain in App. A response may carry a newer version of this one task.
export function createAudioReplacement({
  call,
  notify,
  enabled,
}: {
  call: RequestCall;
  notify: (notice: string | MessageDescriptor) => void;
  enabled: boolean;
}) {
  async function pickAudio(j: AudioTarget) {
    const file = await call("pickMedia", { multiple: false }).catch(() => null);
    if (typeof file === "string") await replaceAudio(j, file);
  }
  async function replaceAudio(row: AudioTarget, file: string) {
    let j = row;
    try {
      const r = await call(
        "setAudio",
        { id: j.id, path: file },
        notification("VIDEO_AUDIO_REPLACED"),
      );
      const updated = r?.jobs?.find((x: Job) => x.id === j.id);
      j = updated ? audioTarget(updated) : j;
    } catch {
      return;
    }
    if (!enabled || !j.hasAudio || j.isSequence) return;
    const note = await autoAlign(j.path, file, (offset) =>
      call("setAudioOffset", { id: j.id, offset }),
    );
    notify(note || notification("VIDEO_AUDIO_ALIGNED"));
  }
  return { pickAudio, replaceAudio };
}
