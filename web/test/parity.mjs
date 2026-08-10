/**
 * Proves the browser compiler and the Python reference generator produce the
 * same data pack, for every preset.
 *
 *   node web/test/parity.mjs
 *
 * Bundles the TypeScript compiler, runs it with the vanilla files served from
 * disk instead of fetched, runs tools/apply_config.py over the same presets,
 * and compares the two trees by value. Numbers are compared numerically, so
 * Python's 0.0 and JavaScript's 0 count as equal; everything else must match.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mwg-parity-"));

execFileSync("npx", ["esbuild", "src/pack/builder.ts", "--bundle", "--format=esm",
  "--target=es2022", `--outfile=${work}/builder.mjs`, "--log-level=warning"],
  { cwd: path.join(ROOT, "web"), stdio: "inherit" });

globalThis.document = { baseURI: "https://x/" };
globalThis.fetch = async (url) => {
  const file = path.join(ROOT, new URL(url).pathname.replace(/^\//, ""));
  if (!fs.existsSync(file)) return { ok: false, status: 404 };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) };
};
const { buildPack } = await import(`${work}/builder.mjs`);

let failures = 0;
for (const name of fs.readdirSync(path.join(ROOT, "presets")).filter((f) => f.endsWith(".json"))) {
  const preset = path.join(ROOT, "presets", name);
  const label = name.replace(/\.json$/, "");
  const pyOut = path.join(work, `py-${label}`);
  const tsOut = path.join(work, `ts-${label}`);

  execFileSync("python3", [path.join(ROOT, "tools/apply_config.py"),
    "--config", preset, "--out", pyOut, "--quiet"], { stdio: "pipe" });
  for (const extra of ["config.json", "generated.json"]) {
    fs.rmSync(path.join(pyOut, extra), { force: true });
  }

  const { files } = await buildPack(JSON.parse(fs.readFileSync(preset, "utf8")));
  for (const [rel, content] of files) {
    const target = path.join(tsOut, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  try {
    execFileSync("python3", [path.join(ROOT, "tools/compare_packs.py"), pyOut, tsOut, label],
      { stdio: "inherit" });
  } catch {
    failures++;
  }
}
fs.rmSync(work, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} preset(s) differ`); process.exit(1); }
console.log("\nbrowser and Python compilers agree on every preset");
