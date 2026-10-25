"use strict";
const { StringDecoder } = require("node:string_decoder");
const { appError, serializeError, restoreError } = require("./errors.cjs");
const ERROR_PREFIX = "MMDENCODER_ERROR_V1 ";
const DIAGNOSTIC_LIMIT = 4000;
const RECORD_LIMIT = 64 * 1024;

function workerErrorRecord(error) {
  return ERROR_PREFIX + JSON.stringify(serializeError(error)) + "\n";
}

// stderr is a byte stream, not a sequence of complete UTF-8 strings or lines.
// Retain the complete structured record separately from the diagnostic tail.
function createWorkerErrorReader() {
  const decoder = new StringDecoder("utf8");
  let pending = "",
    detail = "",
    error = null;
  const diagnostic = (text) => {
    detail = (detail + text).slice(-DIAGNOSTIC_LIMIT);
  };
  function line(text) {
    if (text.startsWith(ERROR_PREFIX)) {
      try {
        const data = JSON.parse(text.slice(ERROR_PREFIX.length));
        if (
          typeof data?.message === "string" &&
          data.params &&
          typeof data.params === "object" &&
          !Array.isArray(data.params)
        ) {
          error = data;
          return;
        }
      } catch {
        /* Malformed records remain readable diagnostics. */
      }
    }
    diagnostic(text + "\n");
  }
  function consume(text) {
    pending += text;
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      line(pending.slice(0, end).replace(/\r$/, ""));
      pending = pending.slice(end + 1);
    }
    if (pending.length > RECORD_LIMIT) {
      diagnostic(pending);
      pending = "";
    }
  }
  return {
    write(bytes) {
      consume(decoder.write(bytes));
    },
    finish(exitCode) {
      consume(decoder.end());
      if (pending) line(pending);
      const diagnosticText = detail.trim();
      if (!error)
        return appError("ALIGN_FAILED", {
          detail: diagnosticText || String(exitCode),
        });
      if (diagnosticText)
        error.params = {
          ...error.params,
          detail: [error.params.detail, diagnosticText]
            .filter(Boolean)
            .join("\n"),
        };
      return restoreError(error);
    },
  };
}
module.exports = { ERROR_PREFIX, workerErrorRecord, createWorkerErrorReader };
