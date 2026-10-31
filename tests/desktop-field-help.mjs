import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { _electron as electron, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const require = createRequire(import.meta.url);
require("./engines.cjs");
const root = path.resolve(import.meta.dirname, "..");
const source = require("../locales/zh-CN.json");
const dir = fs.mkdtempSync(path.join(root, "verification/i18n/field-help-"));
const app = await electron.launch({
  executablePath: require("electron"),
  args: [root],
  env: {
    ...process.env,
    MMD_ENCODER_TEST: "1",
    MMD_ENCODER_DATA: path.join(dir, "data"),
    MMD_ENCODER_TOOLS_ROOT: process.env.MMD_TEST_TOOLS_ROOT,
    MMD_ENCODER_ENGINES: process.env.MMD_TEST_ENGINE_DIR,
  },
  timeout: 60000,
});
const checks = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1360, 1100);
    w.showInactive();
  });
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  const state = () => page.evaluate(() => window.encoder.invoke("state"));
  await expect
    .poll(
      async () => {
        const s = await state();
        return s.located && !s.detecting;
      },
      { timeout: 90000 },
    )
    .toBe(true);
  const help = page.getByRole("button", {
    name: "视频编码器 说明",
    exact: true,
  });
  const tip = page.getByRole("tooltip");
  await help.focus();
  await expect(tip).toHaveText(source["video.encoderAvailableHint"]);
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  await expect(help).toBeFocused();
  await help.click();
  await expect(tip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(tip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  await page.getByRole("heading", { name: "视频队列" }).click();
  await help.hover();
  await expect(tip).toBeVisible();
  await tip.hover();
  await expect(tip).toBeVisible();
  await page.screenshot({ path: path.join(dir, "encoder-help.png") });
  await page.getByRole("heading", { name: "视频队列" }).hover();
  await expect(tip).toHaveCount(0);
  assert.equal(
    await page
      .locator(".field > .hint")
      .filter({ hasText: source["video.encoderAvailableHint"] })
      .count(),
    0,
  );
  checks.push("label-help-focus-click-enter-hover-and-escape");
  const standaloneHintGap = await page.locator("#fps").evaluate((input) => {
    const field = input.closest(".field"),
      hint = field.nextElementSibling;
    return hint.classList.contains("hint")
      ? hint.getBoundingClientRect().top - field.getBoundingClientRect().bottom
      : null;
  });
  // Chromium returns fractional CSS coordinates at Windows display scaling.
  assert.ok(Math.abs(standaloneHintGap - 4) < 0.01);
  checks.push("standalone-caption-stays-four-pixels-below-its-field");
  await page.getByRole("button", { name: "高级", exact: true }).click();
  for (const [id, manual] of [
    ["gop", "48"],
    ["bframes", "0"],
  ]) {
    const input = page.locator("#" + id);
    await expect(input).toHaveValue("");
    await expect(input).toHaveAttribute(
      "placeholder",
      source["video.automatic"],
    );
    await input.fill(manual);
    await expect
      .poll(async () => (await state()).settings[id])
      .toBe(Number(manual));
    await input.fill("");
    await expect.poll(async () => (await state()).settings[id]).toBe(-1);
    await expect(input).toHaveValue("");
    await expect(input).toHaveAttribute("aria-invalid", "false");
  }
  await expect(page.getByText("-1 为自动", { exact: true })).toHaveCount(0);
  checks.push("auto-empty-manual-zero-and-persisted-minus-one");
  await expect(page.locator("#lookahead")).toBeDisabled();
  await page.locator("#bframes").focus();
  await page.keyboard.press("Tab");
  const lookahead = page.getByRole("group", {
    name: source["video.lookahead"],
    exact: true,
  });
  await expect(lookahead).toBeFocused();
  await expect(tip).toHaveText(source["video.lookaheadHint"]);
  await page.keyboard.press("Tab");
  const level = page.getByRole("group", {
    name: source["video.lookaheadLevel"],
    exact: true,
  });
  await expect(level).toBeFocused();
  await expect(tip).toHaveText(source["video.lookaheadLevelHint"]);
  const reason = await page
    .locator("#lookaheadLevel")
    .getAttribute("aria-describedby");
  assert.equal(
    await page.locator(`[id=${JSON.stringify(reason)}]`).textContent(),
    source["video.lookaheadLevelHint"],
  );
  await page.screenshot({ path: path.join(dir, "disabled-reason.png") });
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  checks.push("unavailable-input-reasons-tab-accessible-and-associated");
  await page.getByRole("button", { name: "画质", exact: true }).click();
  await page.selectOption("#encoder", "nvencc:h264");
  await page.getByRole("button", { name: "高级", exact: true }).click();
  await expect(page.locator("#lookahead")).toBeEnabled();
  await expect(page.locator("#lookaheadLevel")).toBeDisabled();
  await page.getByRole("button", { name: "画质", exact: true }).click();
  await page.selectOption("#encoder", "nvencc:hevc");
  await page.getByRole("button", { name: "高级", exact: true }).click();
  await expect(page.locator("#lookaheadLevel")).toBeEnabled();
  checks.push("codec-capability-keeps-the-original-disabled-rules");
  const violations = (await new AxeBuilder({ page }).setLegacyMode().analyze())
    .violations;
  fs.writeFileSync(
    path.join(dir, "accessibility.json"),
    JSON.stringify(violations, null, 2),
  );
  assert.equal(violations.length, 0);
  await page.getByRole("button", { name: "画质", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(840, 900),
  );
  await help.focus();
  await expect(tip).toBeVisible();
  const box = await tip.boundingBox(),
    width = await page.evaluate(() => window.innerWidth);
  assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0);
  await page.screenshot({ path: path.join(dir, "help-narrow.png") });
  checks.push("narrow-tooltip-fits-and-axe-has-no-violations");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1360, 1100),
  );
  await page.getByRole("button", { name: "MMD 导出", exact: true }).click();
  const dialog = page.getByRole("dialog");
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (theme) => window.encoder.invoke("setTheme", { theme }),
      mode,
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    const cards = await dialog.locator(".check-card").evaluateAll((nodes) =>
      nodes.map((node) => {
        const title = node.querySelector("strong"),
          hint = node.querySelector("small"),
          ts = getComputedStyle(title),
          hs = getComputedStyle(hint);
        return {
          titleSize: ts.fontSize,
          titleWeight: ts.fontWeight,
          hintSize: hs.fontSize,
          hintHeight: hs.lineHeight,
          leftAligned:
            title.getBoundingClientRect().left ===
            hint.getBoundingClientRect().left,
          gap:
            Math.round(
              (hint.getBoundingClientRect().top -
                title.getBoundingClientRect().bottom) *
                100,
            ) / 100,
          fits: node.scrollWidth <= node.clientWidth,
        };
      }),
    );
    assert.equal(cards.length, 2);
    for (const card of cards)
      assert.deepEqual(card, {
        titleSize: "14px",
        titleWeight: "400",
        hintSize: "12px",
        hintHeight: "18px",
        leftAligned: true,
        gap: 4,
        fits: true,
      });
  }
  checks.push("mmd-checkbox-cards-share-the-title-and-caption-hierarchy");
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify({ passed: true, checks, main: "current-source" }, null, 2),
  );
  console.log("Field help and automatic numeric inputs PASS", dir);
} finally {
  await app.close();
}
