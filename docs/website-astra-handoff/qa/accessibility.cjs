const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;
(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("https://get.geojs.io/**", (r) => r.abort());
  await page.goto("http://127.0.0.1:8765");
  const output = [];
  for (const lang of ["zh", "en", "ja"]) {
    await page.selectOption("#language-select", lang);
    for (const mode of ["ai", "alpha", "cut"]) {
      await page.locator("#tab-" + mode).click();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      output.push({
        lang,
        mode,
        violations: results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            summary: n.failureSummary,
          })),
        })),
      });
    }
  }
  console.log(JSON.stringify(output, null, 2));
  await browser.close();
})();
