import { notification, errorMessage, type MessageDescriptor } from "./i18n";
import { serializeError } from "../locales/messages.mjs";
import { isCancelled } from "./alignRequests";

type Request = (action: string, payload?: unknown) => Promise<any>;
type Entry = { active: boolean; target?: string };
export type AlignmentTargets = readonly { id: string; target?: string }[];

// Only request identity/lifecycle lives here. The queue owns files and
// offsets; the backend owns workers. Different tasks have different slots.
export function createAlignmentTasks({
  request,
  prefix,
  changed,
}: {
  request: Request;
  prefix: string;
  changed: (active: ReadonlySet<string>) => void;
}) {
  const entries = new Map<string, Entry>();
  const closing = new Map<string, Promise<unknown>>();
  const slot = (id: string) => `auto-align:${prefix}:${id}`;
  const publish = () =>
    changed(
      new Set(
        [...entries].filter(([, entry]) => entry.active).map(([id]) => id),
      ),
    );

  function cancel(id: string) {
    const previous = entries.get(id);
    if (!previous) return closing.get(id) || Promise.resolve();
    entries.delete(id);
    if (previous.active) publish();
    // A delayed old cancellation must finish before a new request can use
    // this slot. Cancelling never exposes a diagnostic to the user.
    const pending = (closing.get(id) || Promise.resolve())
      .then(() => request("alignCancel", { slots: [slot(id)] }))
      .catch(() => {});
    closing.set(id, pending);
    void pending.finally(() => {
      if (closing.get(id) === pending) closing.delete(id);
    });
    return pending;
  }
  function begin(id: string) {
    const cancelled = cancel(id);
    const entry: Entry = { active: false };
    entries.set(id, entry);
    const current = () => entries.get(id) === entry;
    function finish() {
      if (!current()) return;
      entries.delete(id);
      if (entry.active) publish();
    }
    return {
      current,
      finish,
      async run(
        reference: string,
        target: string,
        apply: (offset: number) => Promise<unknown>,
      ): Promise<"" | MessageDescriptor | null> {
        if (!current()) return null;
        entry.active = true;
        entry.target = target;
        publish();
        try {
          await cancelled;
          if (!current()) return null;
          const result = await request("alignRun", {
            reference,
            target,
            slot: slot(id),
          });
          if (!current()) return null;
          if (!result.reliable)
            return notification("AUTO_ALIGN_LOW_CONFIDENCE");
          await apply(result.offset);
          return current() ? "" : null;
        } catch (error) {
          if (!current() || isCancelled(error)) return null;
          return notification("AUTO_ALIGN_FAILED", {
            detail: errorMessage(error),
            error: serializeError(error),
          });
        } finally {
          finish();
        }
      },
    };
  }
  function retain(targets: AlignmentTargets) {
    const available = new Map(targets.map(({ id, target }) => [id, target]));
    for (const [id, entry] of entries)
      if (
        !available.has(id) ||
        (entry.target && available.get(id) !== entry.target)
      )
        void cancel(id);
  }
  function cancelAll() {
    for (const id of entries.keys()) void cancel(id);
  }
  return { begin, cancel, retain, cancelAll };
}

export type AlignmentTasks = Pick<
  ReturnType<typeof createAlignmentTasks>,
  "begin"
>;
