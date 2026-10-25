import type { State } from "./types";
import { errorMessage } from "./i18n";
import { serializeError } from "../locales/messages.mjs";
import type { ErrorData, MessageDescriptor } from "./i18n";
export type RequestCall = (
  action: string,
  payload?: unknown,
  message?: string | MessageDescriptor,
) => Promise<any>;
export function createActions({
  request,
  onState,
  onError,
  onNotice,
}: {
  request: (action: string, payload?: unknown) => Promise<any>;
  onState: (state: State) => void;
  onError: (message: string, data?: ErrorData) => void;
  onNotice: (message: string | MessageDescriptor) => void;
}) {
  async function call(
    action: string,
    payload?: unknown,
    message?: string | MessageDescriptor,
  ) {
    onError("");
    try {
      const result = await request(action, payload);
      if (result?.jobs) onState(result);
      if (message && !result?.cancelled) onNotice(message);
      return result;
    } catch (e) {
      onError(errorMessage(e), serializeError(e));
      throw e;
    }
  }

  function action(
    actionName: string,
    payload?: unknown,
    message?: string | MessageDescriptor,
  ) {
    void call(actionName, payload, message).catch(() => {});
  }

  return { call, action };
}
