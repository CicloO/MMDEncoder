"use strict";
const messages = require("../locales/zh-CN.json");

function appError(code, params = {}) {
  const message = (messages[`error.${code}`] || code).replace(
    /\{(\w+)\}/g,
    (token, name) =>
      Object.hasOwn(params, name) ? String(params[name]) : token,
  );
  return Object.assign(new Error(message), { code, params });
}
module.exports = { appError };
