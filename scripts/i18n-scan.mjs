// Inventory actual string/template literals and JSX text, excluding comments.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
const root = path.resolve(import.meta.dirname, "..");
const han = /\p{Script=Han}/u;
const files = [];
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(file);
      continue;
    }
    if (!/\.(?:tsx?|c?js)$/.test(file)) continue;
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const strings = [];
    function visit(node) {
      if (
        (ts.isStringLiteralLike(node) ||
          ts.isJsxText(node) ||
          [
            ts.SyntaxKind.TemplateHead,
            ts.SyntaxKind.TemplateMiddle,
            ts.SyntaxKind.TemplateTail,
          ].includes(node.kind)) &&
        han.test(node.text)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        strings.push({ line: line + 1, text: node.text.trim().slice(0, 160) });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (strings.length)
      files.push({
        file: path.relative(root, file).replaceAll(path.sep, "/"),
        count: strings.length,
        strings,
      });
  }
}
for (const dir of ["src", "backend"]) scan(path.join(root, dir));
const summary = Object.fromEntries(
  ["src", "backend"].map((dir) => [
    dir,
    files
      .filter((f) => f.file.startsWith(dir + "/"))
      .reduce((n, f) => n + f.count, 0),
  ]),
);
if (process.argv.includes("--json"))
  console.log(JSON.stringify({ summary, files }, null, 2));
else {
  for (const file of files)
    console.log(`${String(file.count).padStart(4)}  ${file.file}`);
  console.log(
    `Remaining Chinese literals: src=${summary.src}, backend=${summary.backend}`,
  );
}
