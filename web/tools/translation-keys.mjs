/**
 * Regenerates docs/TRANSLATION_KEYS.md from web/src/i18n.ts.
 *
 * The English table in i18n.ts is the only place a UI string is written, so the
 * hand-off list for a translator is derived from it rather than kept in step by
 * hand. Run with: npm run keys
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(WEB, "..", "docs", "TRANSLATION_KEYS.md");

const work = mkdtempSync(join(tmpdir(), "mwg-keys-"));
try {
  const bundle = join(work, "i18n.mjs");
  execFileSync("npx", ["esbuild", "src/i18n.ts", "--bundle", "--format=esm", `--outfile=${bundle}`], {
    cwd: WEB,
    stdio: "pipe",
  });
  // i18n.ts remembers the chosen locale in localStorage, which Node has not got
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const i18n = await import(pathToFileURL(bundle).href);

  const keys = i18n.translationKeys();
  const header = readFileSync(DOC, "utf8").split("| --- | --- | --- |")[0];
  const rows = keys.map((key) => `| \`${key}\` | ${i18n.t(key).replace(/\|/g, "\\|")} |  |`);
  writeFileSync(DOC, `${header}| --- | --- | --- |\n${rows.join("\n")}\n`);
  console.log(`${keys.length} keys written to docs/TRANSLATION_KEYS.md`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
