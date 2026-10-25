import { autoAlign } from "./autoAlign";
import type { MessageDescriptor } from "./i18n";
import type { MediaJob } from "./types";

// MediaTools owns selection, pairing, options and feedback. This module
// only sequences the requests for one chosen audio file.
export function createMediaAudioReplacement({
  run,
  notify,
  enabled,
}: {
  run: (action: string, payload?: unknown) => Promise<any>;
  notify: (notice: MessageDescriptor) => void;
  enabled: boolean;
}) {
  async function setAudio(job: Pick<MediaJob, "id" | "path">, file: string) {
    const r = await run("mediaSetAudio", { id: job.id, path: file });
    if (r && enabled) {
      const note = await autoAlign(job.path, file, (offset) =>
        run("mediaSetAudioOffset", { id: job.id, offset }),
      );
      if (note) notify(note);
    }
    return r;
  }
  return { setAudio };
}
