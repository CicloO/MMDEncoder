// Exercise the shipped renderer without the desktop bridge, not a mock component.
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, ".."),
  dir = fs.mkdtempSync(path.join(root, "verification/i18n/startup-no-bridge-"));
fs.writeFileSync(
  path.join(dir, "package.json"),
  JSON.stringify({ main: "main.cjs" }),
);
fs.writeFileSync(
  path.join(dir, "main.cjs"),
  `const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true}});await w.loadFile(${JSON.stringify(path.join(root, "dist/index.html"))});});app.on('window-all-closed',()=>app.quit());`,
);
const app = await electron.launch({
  executablePath: require("electron"),
  args: [dir],
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  await expect(page.locator("main.startup").getByRole("alert")).toContainText(
    "MMDEncoder.exe",
  );
  await expect(page.locator("main.startup")).toContainText(
    "访问本地视频和编码引擎",
  );
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        checks: ["actual-renderer-missing-bridge-shows-launch-instruction"],
        text: await page.locator("body").innerText(),
      },
      null,
      2,
    ),
  );
  console.log("Renderer startup without desktop bridge PASS", dir);
} catch (error) {
  const page = await app.firstWindow();
  fs.writeFileSync(
    path.join(dir, "failure.json"),
    JSON.stringify(
      {
        error: String(error.stack || error),
        text: await page.locator("body").innerText(),
        html: await page.locator("#root").innerHTML(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app.close();
}
