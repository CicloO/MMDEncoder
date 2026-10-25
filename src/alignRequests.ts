// Requests owned by the alignment dialog rather than its parent page.
export { invoke as ask } from "./ipc";
export const isCancelled = (e: unknown) =>
  (e as { code?: string }).code === "ALIGN_CANCELLED" ||
  /已取消$/.test((e as Error).message);
