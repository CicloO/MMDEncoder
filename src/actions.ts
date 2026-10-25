import type { State } from "./types";
export type RequestCall = (
  action: string,
  payload?: unknown,
  message?: string,
) => Promise<any>;
export function createActions({
  request,
  onState,
  onError,
  onNotice,
}: {
  request: (action: string, payload?: unknown) => Promise<any>;
  onState: (state: State) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  async function call(action: string, payload?: unknown, message?: string) {
    onError("");
    try {
      const result = await request(action, payload);
      if (result?.jobs) onState(result);
      if (message && !result?.cancelled) onNotice(message);
      return result;
    } catch (e) {
      onError(
        (e as Error).message.replace(
          /^Error invoking remote method '[^']+': (?:Error: )?/,
          "",
        ),
      );
      throw e;
    }
  }

  function action(actionName: string, payload?: unknown, message?: string) {
    void call(actionName, payload, message).catch(() => {});
  }

  return { call, action };
}
