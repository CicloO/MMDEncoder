require("./isolate.cjs");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createService } = require("../backend/service.cjs"),
  core = require("../backend/core.cjs"),
  { serializeError, appError } = require("../backend/errors.cjs"),
  { load } = require("./load-typescript.cjs");
function fixture(t, raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-recovery-")),
    file = path.join(dir, "settings.json");
  fs.writeFileSync(file, raw);
  let svc;
  t.after(() => {
    svc?.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    file,
    open: () => (svc = createService({ dataDir: dir, mmdPluginDll: "" })),
  };
}
test("failed backup is truthful and every settings write waits for a complete original backup", async (t) => {
  const raw = "User unreadable original {raw}",
    f = fixture(t, raw),
    copy = fs.copyFileSync,
    attempts = [];
  let denied = true,
    svc;
  fs.copyFileSync = (from, to, ...rest) => {
    if (from === f.file) {
      attempts.push(to);
      if (denied)
        throw Object.assign(Error("fixture EACCES {diagnostic}"), {
          code: "EACCES",
        });
    }
    return copy(from, to, ...rest);
  };
  try {
    svc = f.open();
    const initial = svc.getState();
    assert.equal(initial.noticeData.code, "SETTINGS_BACKUP_FAILED");
    assert.match(initial.notice, /备份失败/);
    assert.doesNotMatch(initial.notice, /已备份/);
    assert.equal(initial.noticeData.params.backupError.code, "EACCES");
    for (const action of [
      ["settings", { patch: { quality: 19 } }],
      ["setLocale", { locale: "zh-CN" }],
    ]) {
      await assert.rejects(
        svc.invoke(...action),
        (e) =>
          e.code === "SETTINGS_BACKUP_FAILED" &&
          e.params.error.code === "EACCES",
      );
      assert.equal(fs.readFileSync(f.file, "utf8"), raw);
      assert.equal(
        fs.readdirSync(f.dir).some((name) => name.includes(".unreadable-")),
        false,
      );
    }
    assert.equal(
      new Set(attempts).size,
      1,
      "retry uses the same reserved backup",
    );
    denied = false;
    await svc.invoke("settings", { patch: { quality: 20 } });
    const backups = fs
      .readdirSync(f.dir)
      .filter((name) => name.includes(".unreadable-"));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(f.dir, backups[0]), "utf8"), raw);
    assert.equal(
      JSON.parse(fs.readFileSync(f.file, "utf8")).settings.quality,
      20,
    );
    assert.equal(svc.getState().noticeData.code, "SETTINGS_UNREADABLE");
    const completed = attempts.length;
    await svc.invoke("settings", { patch: { quality: 21 } });
    assert.equal(
      attempts.length,
      completed,
      "completed backup is not repeated",
    );
    assert.equal(fs.readFileSync(path.join(f.dir, backups[0]), "utf8"), raw);
  } finally {
    fs.copyFileSync = copy;
  }
});
test("successful unreadable backup keeps original bytes and the original source sentence", (t) => {
  const raw = JSON.stringify({ version: 999, settings: core.DEFAULTS }),
    f = fixture(t, raw),
    svc = f.open(),
    state = svc.getState();
  const file = path.join(f.dir, state.noticeData.params.backup);
  assert.equal(fs.readFileSync(file, "utf8"), raw);
  assert.equal(
    state.notice,
    `已忽略无法读取的配置：版本不支持；原文件已备份为 ${path.basename(file)}`,
  );
  assert.equal(state.noticeData.message, state.notice);
});
test("both configuration causes refresh through JSON without changing paths or unknown diagnostics", () => {
  const i = load("src/i18n.ts"),
    cause = serializeError(
      appError("SETTINGS_FIELD_INVALID", { field: "User {field}" }),
    ),
    backup = serializeError(
      appError("TOOLS_EXECUTABLE_MISSING", { name: "User {tool}.exe" }),
    );
  const notice = JSON.parse(
    JSON.stringify({
      code: "SETTINGS_BACKUP_FAILED",
      params: {
        error: cause,
        backupError: backup,
        detail: cause.message,
        backupDetail: backup.message,
        backup: "settings.json.unreadable-1",
      },
      message: "source fallback",
    }),
  );
  i.localeRuntime.registerCatalog("en-XA", {
    "message.SETTINGS_BACKUP_FAILED":
      "Read: {detail}; backup: {backupDetail}; {backup}",
    "error.SETTINGS_FIELD_INVALID": "Field {field}",
    "error.TOOLS_EXECUTABLE_MISSING": "Tool {name}",
    "error.SETTINGS_BACKUP_FAILED": "Write blocked: {detail}",
    "message.SETTINGS_UNREADABLE": "Read: {detail}; kept: {backup}",
  });
  i.setLocale("en-XA");
  assert.equal(
    i.summaryMessage(notice),
    "Read: Field User {field}; backup: Tool User {tool}.exe; settings.json.unreadable-1",
  );
  const raw = "Error invoking remote method 'external': Error: User {raw}";
  notice.params.backupError = { message: raw, params: {} };
  assert.ok(i.summaryMessage(notice).includes(raw));
  assert.equal(
    i.errorMessage({
      code: "SETTINGS_BACKUP_FAILED",
      params: { error: { message: raw, params: {} } },
      message: "fallback",
    }),
    "Write blocked: " + raw,
  );
});
