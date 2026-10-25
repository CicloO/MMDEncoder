const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

// Compile renderer modules for Node assertions, with explicit dependency
// injection for their shared locale runtime.
function load(file, dependencies = {}) {
  const filename = path.resolve(file);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      resolveJsonModule: true,
      esModuleInterop: true,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  const original = Module.createRequire(filename);
  loaded.require = (id) => dependencies[id] || original(id);
  loaded._compile(compiled, filename);
  return loaded.exports;
}
module.exports = { load };
