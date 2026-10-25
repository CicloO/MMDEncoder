import { notification, type MessageDescriptor } from "./i18n";
import type { AlignmentTasks } from "./alignmentTasks";
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
  tasks,
}: {
  call: RequestCall;
  notify: (notice: string | MessageDescriptor) => void;
  tasks: AlignmentTasks;
}) {
  async function pickAudio(j: AudioTarget) {
    const file = await call("pickMedia", { multiple: false }).catch(() => null);
    if (typeof file === "string") await replaceAudio(j, file);
  }
  async function replaceAudio(row: AudioTarget, file: string) {
    const task = tasks.begin(row.id);
    let j = row;
    try {
      const r = await call(
        "setAudio",
        { id: j.id, path: file },
        notification("VIDEO_AUDIO_REPLACED"),
      );
      const updated = r?.jobs?.find((x: Job) => x.id === j.id);
      if (!task.current() || (updated && updated.audioPath !== file)) {
        task.finish();
        return;
      }
      j = updated ? audioTarget(updated) : j;
    } catch {
      task.finish();
      return;
    }
    if (!task.current() || !j.hasAudio || j.isSequence) {
      task.finish();
      return;
    }
    const note = await task.run(j.path, file, (offset) =>
      call("setAudioOffset", { id: j.id, offset, expectedAudioPath: file }),
    );
    if (note !== null) notify(note || notification("VIDEO_AUDIO_ALIGNED"));
  }
  return { pickAudio, replaceAudio };
}
