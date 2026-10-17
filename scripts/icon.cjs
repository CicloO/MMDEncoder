const fs = require("node:fs");
const path = require("node:path");
const sharp = require(
  require.resolve("sharp", {
    paths: [
      process.env.MMD_BUILD_MODULES ||
        "C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules",
    ],
  }),
);
(async () => {
  const png = await sharp(path.join(__dirname, "../assets/icon.svg"))
    .png()
    .toBuffer();
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  fs.writeFileSync(
    path.join(__dirname, "../assets/icon.ico"),
    Buffer.concat([header, png]),
  );
})();
