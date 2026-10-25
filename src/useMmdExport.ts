import { useEffect, useState } from "react";
import type { RequestCall } from "./actions";
import { serializeError } from "../locales/messages.mjs";
import type { ErrorData } from "../locales/messages.mjs";
export function useMmdExport(modal: string, call: RequestCall) {
  // MMD export plugin actions run one at a time (install, test encode, …).
  const [mmdBusy, setMmdBusy] = useState(false);
  const [error, setError] = useState<ErrorData | null>(null);
  async function mmdCall(
    actionName: string,
    payload?: unknown,
    message?: string,
  ) {
    setMmdBusy(true);
    setError(null);
    try {
      await call(actionName, payload, message);
    } catch (error) {
      setError(serializeError(error));
    } finally {
      setMmdBusy(false);
    }
  }
  useEffect(() => {
    if (modal === "mmd" && window.encoder) void mmdCall("mmdStatus");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

  return { busy: mmdBusy, call: mmdCall, error };
}
