import { useEffect, useState } from "react";
import type { RequestCall } from "./actions";
export function useMmdExport(modal: string, call: RequestCall) {
  // MMD export plugin actions run one at a time (install, test encode, …).
  const [mmdBusy, setMmdBusy] = useState(false);
  async function mmdCall(
    actionName: string,
    payload?: unknown,
    message?: string,
  ) {
    setMmdBusy(true);
    try {
      await call(actionName, payload, message);
    } catch {
      /* the error is shown in the dialog */
    } finally {
      setMmdBusy(false);
    }
  }
  useEffect(() => {
    if (modal === "mmd" && window.encoder) void mmdCall("mmdStatus");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

  return { busy: mmdBusy, call: mmdCall };
}
