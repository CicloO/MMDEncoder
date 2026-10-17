import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
const { version } = JSON.parse(
  fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);
export default defineConfig({
  base: "./",
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: "dist", emptyOutDir: true },
});
