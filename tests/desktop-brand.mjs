import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { _electron as electron, expect } from "@playwright/test";
const require = createRequire(import.meta.url);
require("./engines.cjs");
const root = path.resolve(import.meta.dirname, ".."),
  dir = fs.mkdtempSync(path.join(root, "verification/i18n/brand-"));
const exe = process.env.MMD_BRAND_EXE;
const app = await electron.launch({
  executablePath: exe || require("electron"),
  args: exe ? [] : [root],
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
    w.setSize(1360, 1000);
    w.showInactive();
  });
  await page.getByRole("heading", { name: "视频队列" }).waitFor();
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (theme) => window.encoder.invoke("setTheme", { theme }),
      mode,
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    const alignment = await page.locator(".brand").evaluate((brand) =>
      [...brand.children].map((node) => {
        const box = node.getBoundingClientRect();
        return box.top + box.height / 2;
      }),
    );
    assert.ok(Math.max(...alignment) - Math.min(...alignment) < 0.01);
    await page
      .locator(".app-header")
      .screenshot({ path: path.join(dir, `${mode}-header.png`) });
    await page.locator(".about-button").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator("svg.brand-mark")).toHaveCount(2);
    for (const selector of [".brand h1 span", ".about-name span"]) {
      const colors = await page.locator(selector).evaluate((node) => {
        const sample = document.createElement("span");
        sample.style.color = "var(--color-primary)";
        node.appendChild(sample);
        const result = {
          actual: getComputedStyle(node).color,
          expected: getComputedStyle(sample).color,
        };
        sample.remove();
        return result;
      });
      assert.equal(colors.actual, colors.expected);
    }
    const aboutAlignment = await page.locator(".about-hero").evaluate((hero) =>
      [...hero.children].map((node) => {
        const box = node.getBoundingClientRect();
        return box.top + box.height / 2;
      }),
    );
    assert.ok(Math.max(...aboutAlignment) - Math.min(...aboutAlignment) < 0.01);
    const canonical = fs.readFileSync(
      path.join(root, `assets/logo/mark-on-${mode}.svg`),
      "utf8",
    );
    const geometry = await page.evaluate((canonical) => {
      const parsed = new DOMParser().parseFromString(
        canonical,
        "image/svg+xml",
      ).documentElement;
      const rootStyle = getComputedStyle(document.documentElement);
      const normalize = (element, prefix) => ({
        tag: element.localName,
        attrs: Object.fromEntries(
          [...element.attributes]
            .map((a) => [
              a.name,
              a.value
                .replaceAll(prefix ? prefix + "-" : "__no_prefix__", "")
                .replace(
                  /var\(--color-(logoMain|logoCyan|logoPink)\)/g,
                  (_, key) =>
                    rootStyle.getPropertyValue("--color-" + key).trim(),
                ),
            ])
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
        children: [...element.children].map((child) =>
          normalize(child, prefix),
        ),
      });
      const expected = [...parsed.children].map((child) =>
        normalize(child, ""),
      );
      const marks = [...document.querySelectorAll("svg.brand-mark")];
      return marks.map((mark) => {
        const prefix = mark.querySelector("symbol").id.slice(0, -2);
        return {
          tree: [...mark.children].map((child) => normalize(child, prefix)),
          ids: [...mark.querySelectorAll("[id]")].map((n) => n.id),
          viewBox: mark.getAttribute("viewBox"),
          hidden: mark.getAttribute("aria-hidden"),
          expected,
        };
      });
    }, canonical);
    const ids = geometry.flatMap((mark) => mark.ids);
    assert.equal(new Set(ids).size, ids.length);
    for (const mark of geometry) {
      assert.deepEqual(mark.tree, mark.expected);
      assert.equal(mark.viewBox, "20 20 88 88");
      assert.equal(mark.hidden, "true");
    }
    checks.push(`${mode}-approved-geometry-theme-colors-and-unique-references`);
    await page
      .getByRole("dialog")
      .screenshot({ path: path.join(dir, `${mode}-about.png`) });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
  }
  const state = await page.evaluate(() => window.encoder.invoke("state"));
  const before = state.settings;
  await page.evaluate(() =>
    window.encoder.invoke("setTheme", { theme: "light" }),
  );
  assert.deepEqual(
    (await page.evaluate(() => window.encoder.invoke("state"))).settings,
    before,
  );
  checks.push("brand-theme-switch-keeps-encoding-settings");
  for (const width of [1360, 1000, 680]) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setSize(width, 900),
      width,
    );
    const header = await page.locator(".app-header").evaluate((node) => {
      const brand = node.querySelector(".brand-icon").getBoundingClientRect();
      const tab = document.querySelector(".workspace-tabs .button");
      return {
        iconLeft: brand.left,
        tabLeft: tab.getBoundingClientRect().left,
        gap: parseFloat(getComputedStyle(node.querySelector(".brand")).gap),
        fits: node.scrollWidth <= node.clientWidth,
        tabPadding: [
          ...document.querySelectorAll(".workspace-tabs .button"),
        ].map((tab) => {
          const style = getComputedStyle(tab);
          return [
            parseFloat(style.paddingLeft),
            parseFloat(style.paddingRight),
          ];
        }),
      };
    });
    assert.ok(
      Math.abs(header.iconLeft - header.tabLeft) < 1,
      JSON.stringify(header),
    );
    assert.equal(header.gap, 12);
    assert.equal(header.fits, true);
    for (const padding of header.tabPadding)
      assert.deepEqual(padding, [14, 14]);
    await page
      .locator(".app-header")
      .screenshot({ path: path.join(dir, `header-${width}.png`) });
  }
  checks.push(
    "compact-header-and-navigation-keep-natural-margins-and-symmetrical-tabs-at-three-widths",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(680, 900),
  );
  const narrow = await page.locator(".app-header").evaluate((node) => ({
    fits: node.scrollWidth <= node.clientWidth,
    centers: [...node.querySelector(".brand").children].map((child) => {
      const box = child.getBoundingClientRect();
      return box.top + box.height / 2;
    }),
  }));
  assert.equal(narrow.fits, true);
  assert.ok(Math.max(...narrow.centers) - Math.min(...narrow.centers) < 0.01);
  await page
    .locator(".app-header")
    .screenshot({ path: path.join(dir, "light-header-narrow.png") });
  checks.push(
    "header-and-about-align-without-tagline-at-wide-and-narrow-widths",
  );
  fs.writeFileSync(
    path.join(dir, "results.json"),
    JSON.stringify({ passed: true, exe: exe || "source", checks }, null, 2),
  );
  console.log("Desktop brand PASS", dir);
} finally {
  await app.close();
}
