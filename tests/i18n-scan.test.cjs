const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("i18n inventory parses JS/JSX/templates and skips comments without truncating text", async () => {
  const { scanJavaScript } = await import("../scripts/i18n-scan.mjs");
  const text = "长".repeat(200);
  const entries = scanJavaScript(
    "src/Test.tsx",
    '// "注释"\nconst x = <div aria-label="名称">可见文字 {`第${n}项`}</div>;\nconst long = "' +
      text +
      '";',
  );
  assert.deepEqual(
    entries.map((s) => s.text),
    ["名称", "可见文字", "第", "项", text],
  );
  assert.equal(entries[0].line, 2);
  assert.ok(entries.every((s) => s.column > 0));
  assert.equal(
    scanJavaScript("backend/test.cjs", 'throw Error("失败")')[0].category,
    "business",
  );
  assert.equal(
    scanJavaScript("backend/test.cjs", 'console.error("诊断")')[0].category,
    "diagnostic",
  );
});

test("C++ inventory handles wide/adjacent/raw strings, escaped quotes, comments and ASCII controls", async () => {
  const { scanCpp } = await import("../scripts/i18n-scan.mjs");
  const entries = scanCpp(
    "mmd-plugin/src/test.cpp",
    '// L"注释"\n/* "注释" */\nMessageBoxW(dlg, L"说明\\n" L"续行", L"MMDEncoder", 0);\nauto json = R"tag({"name":"原文"})tag";\nauto c = \'"\'; auto escaped = L"引号\\\"继续";',
  );
  assert.deepEqual(
    entries.map((s) => s.text),
    ["说明\\n", "续行", "MMDEncoder", '{"name":"原文"}', '引号\\\"继续'],
  );
  assert.equal(entries[0].line, 3);
  assert.equal(entries[2].category, "interface");
  assert.equal(entries[3].kind, "cpp-raw");
  assert.throws(() => scanCpp("test.cpp", 'auto x = L"未闭合'), /unterminated/);
});

test("all-literals mode exposes ASCII UI, diagnostics and technical templates without treating comments as copy", async () => {
  const { scanJavaScript } = await import("../scripts/i18n-scan.mjs");
  const source =
    '// "Hidden comment"\nconst x = <button title="Start">Run</button>;\nthrow Error("Operation failed");\nconst command = `--path ${name}`;';
  assert.deepEqual(scanJavaScript("src/Test.tsx", source), []);
  const entries = scanJavaScript("src/Test.tsx", source, { allLiterals: true });
  assert.deepEqual(
    entries.map((e) => e.text),
    ["Start", "Run", "Operation failed", "--path "],
  );
  assert.equal(entries[2].category, "business");
  assert.equal(entries[3].kind, "template");
});

test("ASCII exceptions stay exact, visible and stale-checked in both inventory scopes", async () => {
  const { collectInventory, sourceRoots } =
    await import("../scripts/i18n-scan.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-i18n-ascii-"));
  try {
    for (const folder of sourceRoots)
      fs.mkdirSync(path.join(dir, folder), { recursive: true });
    const file = "src/test.tsx";
    fs.writeFileSync(
      path.join(dir, file),
      'const x = <button title="Start">MMDEncoder</button>;',
    );
    const exception = {
      file,
      text: "MMDEncoder",
      category: "technical",
      reason: "Invariant product name",
    };
    const narrow = collectInventory(dir, [exception]);
    assert.deepEqual(
      narrow.files[0].strings.map((s) => s.text),
      ["MMDEncoder"],
    );
    assert.equal(narrow.files[0].strings[0].excluded, true);
    const all = collectInventory(dir, [exception], { allLiterals: true });
    assert.equal(all.mode, "all-literals");
    assert.deepEqual(
      all.files[0].strings.map((s) => s.text),
      ["Start", "MMDEncoder"],
    );
    assert.equal(all.files[0].strings[0].excluded, false);
    assert.throws(
      () =>
        collectInventory(dir, [{ ...exception, text: "Removed" }], {
          allLiterals: true,
        }),
      /Stale exception/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reviewed exceptions match exact literals, remain in all four inventories and fail when stale", async () => {
  const { collectInventory, sourceRoots } =
    await import("../scripts/i18n-scan.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-i18n-scan-"));
  try {
    for (const root of sourceRoots) {
      fs.mkdirSync(path.join(dir, root), { recursive: true });
      fs.writeFileSync(
        path.join(
          dir,
          root,
          root === "mmd-plugin/src" ? "test.cpp" : "test.cjs",
        ),
        'const x = "原文";',
      );
    }
    const exception = {
      file: "backend/test.cjs",
      text: "原文",
      category: "technical",
      reason: "Fixture protocol value",
    };
    const result = collectInventory(dir, [exception]);
    assert.deepEqual(Object.values(result.summary), [1, 1, 1, 1]);
    const literal = result.files.find((f) => f.file === exception.file)
      .strings[0];
    assert.equal(literal.excluded, true);
    assert.equal(literal.reason, exception.reason);
    assert.throws(
      () => collectInventory(dir, [{ ...exception, text: "已删除" }]),
      /Stale exception/,
    );
    assert.throws(
      () => collectInventory(dir, [exception, exception]),
      /Duplicate exception/,
    );
    assert.throws(
      () => collectInventory(dir, [{ ...exception, file: "backend/*" }]),
      /Stale exception/,
    );
    assert.throws(
      () => collectInventory(dir, [{ ...exception, reason: "" }]),
      /Every exception/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
