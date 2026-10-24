import zhCN from "../locales/zh-CN.json";

export type MessageKey = keyof typeof zhCN;
export type MessageParams = Record<string, string | number>;
// Preparation only: the current product locale remains zh-CN.
export function t(key: MessageKey, params: MessageParams = {}) {
  return zhCN[key].replace(/\{(\w+)\}/g, (token, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : token,
  );
}

export function errorMessage(error: unknown) {
  const e = error as {
    code?: string;
    params?: MessageParams;
    message?: string;
  } | null;
  const key = `error.${e?.code}`;
  if (Object.hasOwn(zhCN, key)) return t(key as MessageKey, e?.params);
  return String(e?.message ?? error).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
}
