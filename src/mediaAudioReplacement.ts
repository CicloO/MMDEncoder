import type { AlignmentTasks } from "./alignmentTasks";
import type { MessageDescriptor } from "./i18n";
import type { MediaJob } from "./types";

// MediaTools owns selection, pairing, options and feedback. This module
// only sequences the requests for one chosen audio file.
export function createMediaAudioReplacement({
  run,
  notify,
  tasks,
  applyOffset,
}: {
  run: (action: string, payload?: unknown) => Promise<any>;
  notify: (notice: MessageDescriptor) => void;
  tasks: AlignmentTasks;
  applyOffset: (id: string, file: string, offset: number) => Promise<unknown>;
}) {
  async function setAudio(
    job: Pick<MediaJob, "id" | "path" | "meta">,
    file: string,
  ) {
    const task = tasks.begin(job.id);
    const r = await run("mediaSetAudio", { id: job.id, path: file });
    const updated = r?.mediaJobs?.find((item: MediaJob) => item.id === job.id);
    if (
      !r ||
      !task.current() ||
      (updated && updated.audioPath !== file) ||
      !(updated || job).meta?.audio
    ) {
      task.finish();
      return r;
    }
    const note = await task.run(job.path, file, (offset) =>
      applyOffset(job.id, file, offset),
    );
    if (note) notify(note);
    return r;
  }
  return { setAudio };
}
