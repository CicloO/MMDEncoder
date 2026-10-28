// Development-time catalog/reference checks. Dynamic data paths remain explicit
// review work; a clean static report is not a claim of complete UI coverage.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { scanCpp } from "./i18n-scan.mjs";

export function parameters(message) {
  const forms =
    typeof message === "string" ? [message] : Object.values(message || {});
  const names = new Set(
    forms.flatMap((text) =>
      typeof text === "string"
        ? [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
        : [],
    ),
  );
  if (message && typeof message === "object") names.add("count");
  return [...names].sort();
}

export function validateCatalog(name, catalog, source) {
  const errors = [];
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog))
    return [
      {
        file: name,
        rule: "catalog-shape",
        detail: "Catalog must be an object",
      },
    ];
  for (const [key, value] of Object.entries(catalog)) {
    if (typeof value === "string") {
      if (!value.trim())
        errors.push({ file: name, key, rule: "empty-message" });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!Object.hasOwn(value, "other"))
        errors.push({ file: name, key, rule: "plural-other" });
      for (const [form, text] of Object.entries(value))
        if (
          !["one", "other"].includes(form) ||
          typeof text !== "string" ||
          !text.trim()
        )
          errors.push({ file: name, key, rule: "plural-form", detail: form });
    } else errors.push({ file: name, key, rule: "message-shape" });
    if (source && Object.hasOwn(source, key)) {
      if (typeof value !== typeof source[key])
        errors.push({ file: name, key, rule: "message-kind" });
      const expected = parameters(source[key]),
        actual = parameters(value);
      if (JSON.stringify(expected) !== JSON.stringify(actual))
        errors.push({
          file: name,
          key,
          rule: "parameter-names",
          expected,
          actual,
        });
    }
  }
  if (source) {
    for (const key of Object.keys(source))
      if (!Object.hasOwn(catalog, key))
        errors.push({ file: name, key, rule: "missing-key" });
    for (const key of Object.keys(catalog))
      if (!Object.hasOwn(source, key))
        errors.push({ file: name, key, rule: "unexpected-key" });
  }
  return errors;
}

export function readJson(file) {
  const text = fs.readFileSync(file, "utf8"),
    tree = ts.parseJsonText(file, text),
    duplicates = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set();
      for (const property of node.properties) {
        const name = property.name?.text;
        if (names.has(name))
          duplicates.push({
            file,
            rule: "duplicate-key",
            key: name,
            line:
              tree.getLineAndCharacterOfPosition(property.getStart(tree)).line +
              1,
          });
        names.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { data: JSON.parse(text), errors: duplicates };
}

const unwrap = (node) => {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node))
  )
    node = node.expression;
  return node;
};
// Module-local adapters emit the same stable descriptor contracts. Audit their
// producers too, rather than considering only the final generic wrapper.
const descriptorAdapters = {
  "backend/compatibility.cjs": { add: ["message.", 1] },
  "backend/install-update.cjs": { retry: ["error.", 1] },
  "backend/mmd-cli.cjs": { failure: ["error.", 1] },
  "backend/mmd-export.cjs": { note: ["message.", 1] },
  "backend/process-runner.cjs": { runnerError: ["error.", 0] },
  "backend/rtx-check.cjs": { statusMessage: ["message.", 0] },
  "backend/tools.cjs": { messagePatch: ["message.", 0] },
};

function staticStrings(node) {
  node = unwrap(node);
  if (!node) return [];
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node))
    return [...staticStrings(node.whenTrue), ...staticStrings(node.whenFalse)];
  return [];
}
function argumentNames(node) {
  node = unwrap(node);
  if (!node) return { names: [], open: false };
  if (!ts.isObjectLiteralExpression(node)) return { names: [], open: true };
  const names = [];
  let open = false;
  for (const property of node.properties) {
    if (
      property.name &&
      (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
    )
      names.push(property.name.text);
    else open = true;
  }
  return { names, open };
}

export function checkSource(file, text, catalog) {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const references = [],
    dynamic = [],
    deferredParameters = [],
    errors = [];
  const namespaces = new Set(
    Object.keys(catalog).map((key) => key.split(".")[0]),
  );
  const recordedLines = new Set();
  const location = (node) => ({
    file,
    line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
  });
  const record = (node, key, kind) => {
    const entry = { ...location(node), key, kind };
    references.push(entry);
    recordedLines.add(`${entry.line}:${key}`);
    if (!Object.hasOwn(catalog, key))
      errors.push({ ...entry, rule: "missing-reference" });
  };
  const visit = (node) => {
    // Finite tables (busy/status maps and conditional key variables) are also
    // resource references even when their eventual t(key) is dynamic.
    if (
      ts.isStringLiteralLike(node) &&
      /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z0-9_.]+$/.test(node.text) &&
      !node.text.endsWith(".") &&
      namespaces.has(node.text.split(".")[0]) &&
      !(
        ts.isCallExpression(node.parent) &&
        ["path.join", "path.resolve"].includes(
          node.parent.expression.getText(tree),
        )
      ) &&
      !recordedLines.has(`${location(node).line}:${node.text}`)
    )
      record(node, node.text, "key-value");
    if (
      ts.isPropertyAssignment(node) &&
      ["nameKey", "labelKey"].includes(node.name.getText(tree))
    )
      for (const key of staticStrings(node.initializer))
        record(node, key, "metadata");
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(tree),
        bare = ts.isIdentifier(node.expression);
      let prefix = "",
        index = 0,
        kind = "direct",
        matched = true;
      if (bare && ["appError", "validationIssue"].includes(name)) {
        prefix = "error.";
        kind = "descriptor";
      } else if (bare && name === "check" && node.arguments.length > 1) {
        prefix = "error.";
        index = 1;
        kind = "descriptor";
      } else if (
        bare &&
        ["summary", "messageDescriptor", "notification"].includes(name)
      ) {
        prefix = "message.";
        kind = "descriptor";
      } else if (bare && ["stage", "stageDescriptor"].includes(name)) {
        prefix = "stage.";
        kind = "descriptor";
      } else if (bare && descriptorAdapters[file]?.[name]) {
        [prefix, index] = descriptorAdapters[file][name];
        kind = "descriptor";
      } else if (!(
        (bare && ["t", "text", "sourceText", "desktopText"].includes(name)) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "t")
      ))
        matched = false;
      if (matched) {
        const keys = [
          ...new Set(
            staticStrings(node.arguments[index]).map((key) => prefix + key),
          ),
        ];
        const params = argumentNames(node.arguments[index + 1]);
        if (!keys.length)
          dynamic.push({
            ...location(node),
            name,
            kind,
            expression: node.getText(tree).replace(/\s+/g, " ").trim(),
          });
        for (const key of keys) {
          record(node, key, kind);
          if (kind === "direct" && Object.hasOwn(catalog, key)) {
            if (params.open)
              deferredParameters.push({
                ...location(node),
                key,
                expression: node.arguments[index + 1]?.getText(tree) || "",
              });
            else
              for (const parameter of parameters(catalog[key]))
                if (!params.names.includes(parameter))
                  errors.push({
                    ...location(node),
                    key,
                    rule: "missing-parameter",
                    parameter,
                  });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { references, dynamic, deferredParameters, errors };
}

export async function checkProject(root) {
  const registryFile = path.join(root, "locales/registry.json"),
    registered = readJson(registryFile);
  const registry = registered.data,
    errors = [...registered.errors],
    catalogs = {};
  for (const entry of registry.locales) {
    const file = path.join(root, "locales", entry.file),
      loaded = readJson(file);
    errors.push(...loaded.errors);
    catalogs[entry.id] = loaded.data;
  }
  const source = catalogs[registry.sourceLocale];
  if (!source) throw Error("Source locale is absent from the registry");
  const ids = registry.locales.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length)
    errors.push({ file: registryFile, rule: "duplicate-locale" });
  if (ids.includes("en-XA"))
    errors.push({ file: registryFile, rule: "test-locale-shipped" });
  for (const [id, catalog] of Object.entries(catalogs))
    errors.push(
      ...validateCatalog(
        id,
        catalog,
        id === registry.sourceLocale ? undefined : source,
      ),
    );
  const { pseudoCatalog } = await import(
    pathToFileURL(path.join(root, "tests/fixtures/i18n/pseudo.mjs")).href
  );
  errors.push(
    ...validateCatalog("test-only-pseudo", pseudoCatalog(source), source),
  );
  const subsetFile = path.join(root, "locales/plugin-keys.json"),
    subset = readJson(subsetFile).data;
  if (new Set(subset).size !== subset.length)
    errors.push({ file: subsetFile, rule: "duplicate-plugin-key" });
  for (const key of subset)
    if (typeof source[key] !== "string" || !source[key])
      errors.push({ file: subsetFile, key, rule: "plugin-source" });
  const report = {
    sourceKeys: Object.keys(source).length,
    pluralKeys: Object.values(source).filter((v) => typeof v === "object")
      .length,
    registeredLocales: ids,
    pluginKeys: subset.length,
    references: [],
    dynamic: [],
    deferredParameters: [],
    errors,
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), {
      withFileTypes: true,
    })) {
      const file = dir + "/" + entry.name;
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:tsx?|[cm]?js)$/.test(file) && !file.endsWith(".d.mts")) {
        const checked = checkSource(
          file,
          fs.readFileSync(path.join(root, file), "utf8"),
          source,
        );
        for (const name of [
          "references",
          "dynamic",
          "deferredParameters",
          "errors",
        ])
          report[name].push(...checked[name]);
      } else if (/\.(cpp|h)$/.test(file)) {
        for (const item of scanCpp(
          file,
          fs.readFileSync(path.join(root, file), "utf8"),
        )) {
          if (!/^(plugin|error|message|stage)\.[A-Za-z0-9_.]+$/.test(item.text))
            continue;
          report.references.push({
            file,
            line: item.line,
            key: item.text,
            kind: "native",
          });
          if (!Object.hasOwn(source, item.text) || !subset.includes(item.text))
            report.errors.push({
              file,
              line: item.line,
              key: item.text,
              rule: "native-reference",
            });
        }
      }
    }
  };
  for (const dir of ["src", "backend", "desktop", "mmd-plugin/src", "locales"])
    walk(dir);
  const builtin = readJson(path.join(root, "locales/builtin-presets.json"));
  report.errors.push(...builtin.errors);
  for (const key of Object.values(builtin.data)) {
    report.references.push({
      file: "locales/builtin-presets.json",
      key,
      kind: "metadata",
    });
    if (!Object.hasOwn(source, key))
      report.errors.push({
        file: "locales/builtin-presets.json",
        key,
        rule: "missing-reference",
      });
  }
  report.reviewRequired =
    report.dynamic.length + report.deferredParameters.length;
  report.staticPassed = !report.errors.length;
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const report = await checkProject(path.resolve(import.meta.dirname, ".."));
  console.log(
    JSON.stringify(
      process.argv.includes("--json")
        ? report
        : {
            sourceKeys: report.sourceKeys,
            registeredLocales: report.registeredLocales,
            pluginKeys: report.pluginKeys,
            staticReferences: report.references.length,
            errors: report.errors,
            reviewRequired: report.reviewRequired,
            staticPassed: report.staticPassed,
          },
      null,
      2,
    ),
  );
  process.exitCode = report.errors.length ? 1 : 0;
}
