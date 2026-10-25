"use strict";
const messages = require("../locales/zh-CN.json");
const { createTranslator } = require("../locales/runtime.mjs");
const {
  messageDescriptor,
  serializeError,
  restoreError,
} = require("../locales/messages.mjs");
const source = createTranslator({
  sourceLocale: "zh-CN",
  catalogs: { "zh-CN": messages },
});

function appError(code, params = {}) {
  const message = source.has(`error.${code}`)
    ? source.t(`error.${code}`, params)
    : code;
  return Object.assign(new Error(message), { code, params });
}
function validationIssue(code, params = {}) {
  return serializeError(appError(code, params));
}
function validationError(issues) {
  return Object.assign(appError("VALIDATION_FAILED"), {
    issues: issues.map(serializeError),
  });
}
// Logs retain every source diagnostic. UI consumers keep the structured
// record and format it separately when they render.
function diagnosticMessage(error) {
  const lines = (value) => [
    value.message,
    ...(value.issues || []).flatMap(lines),
  ];
  return lines(serializeError(error)).filter(Boolean).join("\n");
}
function summary(code, params = {}) {
  const key = `message.${code}`;
  return messageDescriptor(
    code,
    params,
    source.has(key) ? source.t(key, params) : code,
  );
}
function stage(id, params = {}) {
  const key = `stage.${id}`;
  return {
    stage: id,
    params,
    message: source.has(key) ? source.t(key, params) : id,
  };
}
module.exports = {
  sourceText: source.t,
  appError,
  validationIssue,
  validationError,
  diagnosticMessage,
  summary,
  stage,
  serializeError,
  restoreError,
};
