/**
 * Proves the browser's Overhauled Overworld port matches the command line one.
 *
 *   node web/test/port-parity.mjs path/to/Overhauled_Overworld.zip
 *
 * The site converts the player's own copy of the decoration pack in their
 * browser, so there are now two implementations of the same port -
 * tools/port_pack.py with tools/build_companion.py, and web/src/pack/port.ts
 * with web/src/pack/companion.ts. This runs both over the same zip and the same
 * generated pack and requires the two results to agree, file for file.
 *
 * JSON files are compared by value rather than by byte, because Python writes a
 * whole float as `1.0` where JSON.stringify writes `1`; that is the only
 * difference the two produce, and it is the same number to any reader. Anything
 * the port copies through unchanged is compared by hash.
 *
 * The decoration pack is not in this repository and is not redistributed by the
 * site, so this test has nothing to run against unless you point it at your own
 * copy. Without one it reports that and exits 0.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = process.argv[2] ?? process.env.MWG_DECORATION_PACK;
if (!source || !fs.existsSync(source)) {
  console.log("no decoration pack given, nothing to compare");
  console.log("  node web/test/port-parity.mjs path/to/Overhauled_Overworld.zip");
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "mwg-port-parity-"));
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { stdio: "pipe", ...options });

for (const module of ["companion", "builder"]) {
  run("npx", ["esbuild", `src/pack/${module}.ts`, "--bundle", "--format=esm",
    "--target=es2022", `--outfile=${work}/${module}.mjs`, "--log-level=warning"],
    { cwd: path.join(ROOT, "web"), stdio: "inherit" });
}

globalThis.document = { baseURI: "https://x/" };
globalThis.fetch = async (url) => {
  const file = path.join(ROOT, new URL(url).pathname.replace(/^\//, ""));
  if (!fs.existsSync(file)) return { ok: false, status: 404 };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) };
};
const { combinePack } = await import(`${work}/companion.mjs`);
const { buildPack } = await import(`${work}/builder.mjs`);

const isText = (rel) =>
  rel.endsWith(".json") || rel.endsWith(".mcmeta") || rel.endsWith(".mcfunction") ||
  rel.endsWith(".txt") || rel.endsWith(".md");

/** Write the text files to a tree to compare, hash the rest. */
function spill(files, into) {
  const binary = new Map();
  for (const [rel, content] of files) {
    const blob = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    if (!isText(rel)) {
      binary.set(rel, crypto.createHash("sha256").update(blob).digest("hex"));
      continue;
    }
    const target = path.join(into, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, blob);
  }
  return binary;
}

// karst is off by default and volcanoes are on, so the two configs between them
// cover every mwg: feature the companion policy can inject, and the karst one
// also turns on the second helping of dripstone caves.
const CASES = {
  earthlike: {},
  karst: { karst: { enabled: true, frequency: 0.2, size: 70, height_blocks: 60, setting: "sea" } },
};

let failures = 0;
for (const [label, patch] of Object.entries(CASES)) {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "presets/earthlike.json"), "utf8"));
  for (const [section, values] of Object.entries(patch)) {
    config[section] = { ...(config[section] ?? {}), ...values };
  }
  const preset = path.join(work, `cfg-${label}.json`);
  fs.writeFileSync(preset, JSON.stringify(config, null, 2));

  // the command line path: generate, then fold the decoration pack in
  const pyPack = path.join(work, `py-pack-${label}`);
  run("python3", [path.join(ROOT, "tools/apply_config.py"),
    "--config", preset, "--out", pyPack, "--quiet"]);
  for (const extra of ["config.json", "generated.json"]) {
    fs.rmSync(path.join(pyPack, extra), { force: true });
  }
  const zip = path.join(work, `py-${label}.zip`);
  run("python3", [path.join(ROOT, "tools/build_companion.py"),
    "--woo", source, "--pack", pyPack, "--out", zip]);
  const pyOut = path.join(work, `py-out-${label}`);
  run("python3", ["-c",
    `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, zip, pyOut]);
  const pyBinary = new Map();
  for (const rel of run("python3", ["-c",
    `import zipfile,sys;print("\\n".join(i.filename for i in zipfile.ZipFile(sys.argv[1]).infolist() if not i.is_dir()))`,
    zip]).toString().trim().split("\n")) {
    if (isText(rel)) continue;
    pyBinary.set(rel, crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(pyOut, rel))).digest("hex"));
    fs.rmSync(path.join(pyOut, rel));
  }

  // the browser path: the same two steps, in one process, from the zip's bytes
  const { files } = await buildPack(config);
  const combined = await combinePack(fs.readFileSync(source), files);
  const tsOut = path.join(work, `ts-out-${label}`);
  const tsBinary = spill(combined.files, tsOut);

  try {
    run("python3", [path.join(ROOT, "tools/compare_packs.py"), pyOut, tsOut, label],
      { stdio: "inherit" });
  } catch {
    failures++;
  }
  for (const [rel, hash] of pyBinary) {
    if (tsBinary.get(rel) !== hash) {
      console.error(`  binary differs or missing: ${rel}`);
      failures++;
    }
  }
  for (const rel of tsBinary.keys()) {
    if (!pyBinary.has(rel)) {
      console.error(`  only in typescript: ${rel}`);
      failures++;
    }
  }
}

fs.rmSync(work, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} difference(s) between the browser port and the Python one`);
  process.exit(1);
}
console.log("\nbrowser and Python produce the same combined pack");
