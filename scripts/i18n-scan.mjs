// Source inventory, not translation coverage: never suppress a file or a literal.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const sourceRoots = ["src", "backend", "desktop", "mmd-plugin/src"];
const han = /\p{Script=Han}/u;
const categories = new Set([
  "interface",
  "business",
  "diagnostic",
  "technical",
]);

function location(source, offset) {
  const before = source.slice(0, offset);
  return {
    line: before.split("\n").length,
    column: offset - before.lastIndexOf("\n"),
  };
}

// Suggestions are conservative. Only exact, reviewed exceptions exclude text
// from localization work; suggested categories never hide source literals.
function jsCategory(node, file) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isThrowStatement(current)) return "business";
    if (ts.isCallExpression(current)) {
      const call = current.expression.getText();
      if (
        /^(?:console\.(?:log|warn|error|info|debug)|(?:p?log|logProgress))$/.test(
          call,
        )
      )
        return "diagnostic";
      if (/^(?:Error|appError|check)$/.test(call)) return "business";
    }
    if (ts.isStatement(current)) break;
  }
  return file.startsWith("backend/") ? "business" : "interface";
}

export function scanJavaScript(file, source, { allLiterals = false } = {}) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const entries = [];
  function visit(node) {
    if (
      (ts.isStringLiteralLike(node) ||
        ts.isJsxText(node) ||
        [
          ts.SyntaxKind.TemplateHead,
          ts.SyntaxKind.TemplateMiddle,
          ts.SyntaxKind.TemplateTail,
        ].includes(node.kind)) &&
      (han.test(node.text) ||
        (allLiterals &&
          (ts.isJsxText(node) ? node.text.trim() : node.text).length > 0))
    ) {
      entries.push({
        ...location(source, node.getStart(ast)),
        kind: ts.isJsxText(node)
          ? "jsx"
          : ts.isStringLiteralLike(node)
            ? "string"
            : "template",
        text:
          allLiterals && !han.test(node.text) && !ts.isJsxText(node)
            ? node.text
            : node.text.trim(),
        category: jsCategory(node, file),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return entries;
}

// C++ has wide/adjacent/raw literals which a JS parser cannot inventory.
// Include ASCII literals too: native controls and codec metadata display them.
export function scanCpp(file, source) {
  const entries = [];
  let offset = 0;
  while (offset < source.length) {
    if (source.startsWith("//", offset)) {
      const end = source.indexOf("\n", offset + 2);
      offset = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", offset)) {
      const end = source.indexOf("*/", offset + 2);
      if (end < 0) throw Error(`${file}: unterminated comment`);
      offset = end + 2;
      continue;
    }
    const raw = /^(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(/.exec(
      source.slice(offset),
    );
    const quoted = /^(?:u8|u|U|L)?(["'])/.exec(source.slice(offset));
    if (!raw && !quoted) {
      offset++;
      continue;
    }
    const start = offset;
    let text;
    if (raw) {
      const endToken = `)${raw[1]}"`;
      const end = source.indexOf(endToken, offset + raw[0].length);
      if (end < 0) throw Error(`${file}: unterminated raw string`);
      text = source.slice(offset + raw[0].length, end);
      offset = end + endToken.length;
    } else {
      offset += quoted[0].length;
      const content = offset;
      while (offset < source.length && source[offset] !== quoted[1])
        offset += source[offset] === "\\" ? 2 : 1;
      if (offset >= source.length) throw Error(`${file}: unterminated literal`);
      text = source.slice(content, offset++);
      if (quoted[1] === "'") continue;
    }
    if (!text) continue;
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = source.indexOf("\n", offset);
    const context = source
      .slice(lineStart, lineEnd < 0 ? source.length : lineEnd)
      .trim();
    entries.push({
      ...location(source, start),
      kind: raw ? "cpp-raw" : "cpp-string",
      text,
      category: /\b(?:plog|log|ctx->log)\(/.test(context)
        ? "diagnostic"
        : /\bfail\(/.test(context)
          ? "business"
          : han.test(text) ||
              /(?:MessageBoxW|DialogTemplate|\.control|SetDlgItemTextW)\(/.test(
                context,
              )
            ? "interface"
            : "technical",
    });
  }
  return entries;
}

export function collectInventory(
  root,
  exceptions = [],
  { allLiterals = false } = {},
) {
  const reviewed = new Map();
  for (const entry of exceptions) {
    if (
      !sourceRoots.some((dir) => entry.file?.startsWith(dir + "/")) ||
      !entry.text ||
      !categories.has(entry.category) ||
      !entry.reason?.trim()
    )
      throw Error(
        "Every exception needs an exact source file, text, category and reason",
      );
    const key = JSON.stringify([entry.file, entry.text]);
    if (reviewed.has(key)) throw Error(`Duplicate exception: ${key}`);
    reviewed.set(key, { ...entry, used: false });
  }
  const files = [];
  function scan(dir) {
    for (const entry of fs
      .readdirSync(path.join(root, dir), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const file = dir + "/" + entry.name;
      if (entry.isDirectory()) {
        scan(file);
        continue;
      }
      if (!/\.(?:tsx?|[cm]?js|cpp|h)$/.test(file)) continue;
      const source = fs.readFileSync(path.join(root, file), "utf8");
      const native = /\.(?:cpp|h)$/.test(file);
      // Match exceptions against the complete syntax tree even in the default
      // Han scope. A reviewed ASCII exception stays visible in either mode.
      const strings = (
        native
          ? scanCpp(file, source)
          : scanJavaScript(file, source, { allLiterals: true })
      ).filter(
        (item) =>
          native ||
          allLiterals ||
          han.test(item.text) ||
          reviewed.has(JSON.stringify([file, item.text])),
      );
      for (const item of strings) {
        const exception = reviewed.get(JSON.stringify([file, item.text]));
        item.reviewed = !!exception;
        item.excluded =
          !!exception &&
          ["diagnostic", "technical"].includes(exception.category);
        if (exception) {
          item.category = exception.category;
          item.reason = exception.reason;
          exception.used = true;
        }
      }
      if (strings.length) files.push({ file, count: strings.length, strings });
    }
  }
  for (const dir of sourceRoots) scan(dir);
  for (const entry of reviewed.values())
    if (!entry.used)
      throw Error(`Stale exception: ${entry.file}: ${entry.text}`);
  const summary = Object.fromEntries(
    sourceRoots.map((dir) => [
      dir,
      files
        .filter((f) => f.file.startsWith(dir + "/"))
        .reduce((n, f) => n + f.count, 0),
    ]),
  );
  const classification = Object.fromEntries(
    [...categories].map((category) => [
      category,
      files.flatMap((f) => f.strings).filter((s) => s.category === category)
        .length,
    ]),
  );
  return {
    schemaVersion: 2,
    mode: allLiterals ? "all-literals" : "han-native-and-reviewed",
    summary,
    classification,
    files,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const root = path.resolve(import.meta.dirname, "..");
  const exceptions = JSON.parse(
    fs.readFileSync(path.join(root, "scripts/i18n-exceptions.json"), "utf8"),
  );
  const result = collectInventory(root, exceptions, {
    allLiterals: process.argv.includes("--all-literals"),
  });
  if (process.argv.includes("--json"))
    console.log(JSON.stringify(result, null, 2));
  else {
    for (const file of result.files)
      console.log(`${String(file.count).padStart(4)}  ${file.file}`);
    console.log(`Literal inventory: ${JSON.stringify(result.summary)}`);
    console.log(
      `Suggested categories (reviewed exceptions stay visible): ${JSON.stringify(result.classification)}`,
    );
  }
}
