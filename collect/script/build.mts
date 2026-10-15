// Builds claritia.js into collect/dist: s.js and a versioned s.<hash>.js. Fails over 6 KB gzipped.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const LIMIT = 6 * 1024;
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "dist");

const res = await build({
  entryPoints: [join(here, "index.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  legalComments: "none",
  write: false,
});
const code = res.outputFiles[0].contents;
const gz = gzipSync(code, { level: 9 }).length;
const tag = createHash("sha256").update(code).digest("hex").slice(0, 10);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "s.js"), code);
writeFileSync(join(out, `s.${tag}.js`), code);
writeFileSync(join(out, "version.json"), JSON.stringify({ tag, bytes: code.length, gzip: gz }) + "\n");
console.log(`claritia.js ${code.length} bytes, ${gz} gzipped (limit ${LIMIT}), s.${tag}.js`);
if (gz > LIMIT) {
  console.error(`claritia.js is ${gz - LIMIT} bytes over the ${LIMIT} byte limit.`);
  process.exit(1);
}
