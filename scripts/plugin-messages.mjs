// Generate the native fallback from the same source used by the app. No hand
// maintained Chinese table in C++; no test locale is compiled into the DLL.
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const source = JSON.parse(
  fs.readFileSync(path.join(root, "locales/zh-CN.json"), "utf8"),
);
const keys = JSON.parse(
  fs.readFileSync(path.join(root, "locales/plugin-keys.json"), "utf8"),
);
if (new Set(keys).size !== keys.length)
  throw Error("Duplicate plugin message key");
const rows = keys.map((key) => {
  if (typeof source[key] !== "string" || !source[key])
    throw Error(`Missing plugin source: ${key}`);
  return `  {L${JSON.stringify(key)}, L${JSON.stringify(source[key])}},`;
});
if (!process.argv.includes("--check")) {
  const dir = path.join(root, "mmd-plugin/build");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin-messages.generated.h"),
    `// Generated from locales/zh-CN.json; do not edit.\nstatic const std::pair<const wchar_t*, const wchar_t*> kPluginFallback[] = {\n${rows.join("\n")}\n};\n`,
  );
}
console.log(`Plugin source messages: ${keys.length}`);
