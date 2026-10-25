import { useEffect, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { getLocale, setLocale, subscribeLocale, t } from "./i18n";
import { invoke } from "./ipc";

// Refresh by rendering children again, never by key/remount: in-flight tasks,
// draft edits, focus and the service's encoder state survive a locale update.
export function LocaleRoot({ children }: { children: () => ReactNode }) {
  useSyncExternalStore(subscribeLocale, getLocale);
  useEffect(() => {
    const apply = () => {
      document.documentElement.lang = getLocale();
      document.title = t("app.title");
    };
    apply();
    const unsubscribe = subscribeLocale(apply);
    let stopped = false;
    let updates = 0;
    const off = window.encoder.onUpdate((state) => {
      updates++;
      setLocale(state.locale);
    });
    void invoke("state")
      .then((state) => {
        if (!stopped && updates === 0) setLocale(state.locale);
      })
      .catch(() => {
        // App owns startup failure feedback; the source locale remains readable.
      });
    return () => {
      stopped = true;
      unsubscribe();
      off();
    };
  }, []);
  return children();
}
