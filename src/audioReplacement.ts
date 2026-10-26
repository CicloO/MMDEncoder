import { notification, type MessageDescriptor } from "./i18n";
import type { AlignmentTasks } from "./alignmentTasks";
import type { RequestCall } from "./actions";
import type { Job, MediaJob } from "./types";

export type AudioTarget = {
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

// One replacement/alignment sequence; callers keep selection, feedback and
// request policy. AlignmentTasks remains the sole owner of cancellation.
export function createReplacementFlow<Row extends { id: string }, Result>({
  tasks,
  replace,
  applyOffset,
  notify,
  successNotice,
}: {
  tasks: AlignmentTasks;
  replace: (
    row: Row,
    file: string,
  ) => Promise<{ result: Result; target: AudioTarget | null }>;
  applyOffset: (
    target: AudioTarget,
    file: string,
    offset: number,
  ) => Promise<unknown>;
  notify: (notice: MessageDescriptor) => void;
  successNotice?: MessageDescriptor;
}) {
  return async (row: Row, file: string): Promise<Result> => {
    const task = tasks.begin(row.id);
    const { result, target } = await replace(row, file);
    if (!task.current() || !target || !target.hasAudio || target.isSequence) {
      task.finish();
      return result;
    }
    const note = await task.run(target.path, file, (offset) =>
      applyOffset(target, file, offset),
    );
    if (note) notify(note);
    else if (note !== null && successNotice) notify(successNotice);
    return result;
  };
}

type ReplacementActions = { replace: string; offset: string };

export function createAudioReplacement({
  call,
  notify,
  tasks,
  actions,
}: {
  call: RequestCall;
  notify: (notice: string | MessageDescriptor) => void;
  tasks: AlignmentTasks;
  actions: ReplacementActions;
}) {
  const replaceAudio = createReplacementFlow<AudioTarget, void>({
    tasks,
    notify,
    successNotice: notification("VIDEO_AUDIO_ALIGNED"),
    replace: async (row, file) => {
      try {
        const r = await call(
          actions.replace,
          { id: row.id, path: file },
          notification("VIDEO_AUDIO_REPLACED"),
        );
        const updated = r?.jobs?.find((item: Job) => item.id === row.id);
        return {
          result: undefined,
          target:
            updated && updated.audioPath !== file
              ? null
              : updated
                ? audioTarget(updated)
                : row,
        };
      } catch {
        return { result: undefined, target: null };
      }
    },
    applyOffset: (target, file, offset) =>
      call(actions.offset, { id: target.id, offset, expectedAudioPath: file }),
  });
  async function pickAudio(j: AudioTarget) {
    const file = await call("pickMedia", { multiple: false }).catch(() => null);
    if (typeof file === "string") await replaceAudio(j, file);
  }
  return { pickAudio, replaceAudio };
}

// Media replacement preserves its response and local error route. Its
// reference is the selected row, whereas video uses the returned task.
export function createMediaAudioReplacement({
  run,
  call,
  notify,
  tasks,
  actions,
}: {
  run: RequestCall;
  call: RequestCall;
  notify: (notice: MessageDescriptor) => void;
  tasks: AlignmentTasks;
  actions: ReplacementActions;
}) {
  const setAudio = createReplacementFlow<
    Pick<MediaJob, "id" | "path" | "meta">,
    any
  >({
    tasks,
    notify,
    replace: async (job, file) => {
      const result = await run(actions.replace, { id: job.id, path: file });
      const updated = result?.mediaJobs?.find(
        (item: MediaJob) => item.id === job.id,
      );
      return {
        result,
        target:
          !result || (updated && updated.audioPath !== file)
            ? null
            : {
                id: job.id,
                path: job.path,
                hasAudio: !!(updated || job).meta?.audio,
                isSequence: false,
              },
      };
    },
    applyOffset: (target, file, offset) =>
      call(actions.offset, { id: target.id, offset, expectedAudioPath: file }),
  });
  return { setAudio };
}
