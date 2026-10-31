const test = require("node:test");
const assert = require("node:assert/strict");
const {
  newer,
  checkForUpdate,
  RELEASES_URL,
} = require("../backend/update.cjs");
const reply = (status, body) => async () => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});
test("version comparison is numeric and ignores a leading v", () => {
  assert.equal(newer("1.3.0", "1.2.0"), true);
  assert.equal(newer("v1.10.0", "1.9.9"), true);
  assert.equal(newer("1.2.0", "1.2.0"), false);
  assert.equal(newer("1.1.9", "1.2.0"), false);
  assert.equal(newer("nightly", "1.2.0"), false);
});
test("latest release is reported with a project-only download link", async () => {
  const r = await checkForUpdate(
    "1.3.0",
    reply(200, {
      tag_name: "v1.4.0",
      html_url: RELEASES_URL + "/tag/v1.4.0",
      name: "1.4.0",
    }),
  );
  assert.equal(r.latest, "1.4.0");
  assert.equal(r.newer, true);
  assert.equal(r.url, RELEASES_URL + "/tag/v1.4.0");
  const foreign = await checkForUpdate(
    "1.3.0",
    reply(200, { tag_name: "1.4.0", html_url: "https://example.com/x" }),
  );
  assert.equal(foreign.url, RELEASES_URL);
});
test("no published release and server errors are handled", async () => {
  const none = await checkForUpdate("1.3.0", reply(404, {}));
  assert.equal(none.newer, false);
  assert.equal(none.latest, "");
  await assert.rejects(checkForUpdate("1.3.0", reply(503, {})), {
    code: "UPDATE_HTTP_STATUS",
    params: { status: 503 },
  });
  await assert.rejects(
    checkForUpdate("1.3.0", reply(200, { tag_name: "latest" })),
    { code: "UPDATE_VERSION_INVALID", params: { version: "latest" } },
  );
});
