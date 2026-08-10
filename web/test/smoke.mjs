/**
 * Headless smoke test for the published site.
 *
 * Serves the repository root exactly the way GitHub Pages does, opens the page
 * in Chromium, and drives the editor: paint a stroke, analyse, edit the config,
 * load a preset, pan, export a data pack. Any console error, any unhandled
 * rejection or any failed check fails the run, so a broken bundle cannot be
 * pushed unnoticed.
 *
 * Run with: node test/smoke.mjs
 */

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
// Use a browser that is already on the machine when there is one, and let
// Playwright resolve its own download otherwise.
const EXECUTABLE = [process.env.CHROMIUM_PATH, "/opt/pw-browsers/chromium"].find(
  (path) => path && existsSync(path),
);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mcmeta": "application/json; charset=utf-8",
};

function serve() {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
    const relative = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
    try {
      const body = await readFile(join(ROOT, relative));
      response.writeHead(200, { "content-type": MIME[extname(relative)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({
  ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

await page.goto(base, { waitUntil: "networkidle" });

// --- the page came up at all -------------------------------------------------
check("no console errors on load", consoleErrors.length === 0, consoleErrors.join(" | "));

const ids = [
  "map-canvas", "map-width", "map-height", "map-resolution", "sea-level", "seed",
  "new-map", "contour-interval", "toggle-grid", "toggle-contours",
  "preset-pick", "preset-load", "layer-buttons", "brush-shape", "brush-size",
  "brush-options", "btn-undo", "btn-redo", "btn-analyse", "analysis-output",
  "config-json", "config-apply", "config-reset", "export-mode", "pack-name",
  "btn-import", "btn-export-project", "btn-export-pack", "status", "locale",
  "preview-user", "preview-procedural", "hover",
];
const missing = await page.evaluate((list) => list.filter((id) => !document.getElementById(id)), ids);
check("every control is present after boot", missing.length === 0, `missing: ${missing.join(", ")}`);

// Inputs living inside a translated <label> are the classic casualty of a
// naive textContent-based translator, so assert they survived.
const inputsAlive = await page.evaluate(() => {
  const el = document.getElementById("map-width");
  return el instanceof HTMLInputElement && el.value !== "";
});
check("translated labels keep their inputs", inputsAlive);

const untranslated = await page.evaluate(() =>
  [...document.querySelectorAll("[data-i18n]")]
    .map((el) => el.dataset.i18n)
    .filter((key) => {
      const node = [...document.querySelectorAll("[data-i18n]")].find((n) => n.dataset.i18n === key);
      return node.textContent.trim() === key;
    }),
);
check("no raw translation keys on screen", untranslated.length === 0, untranslated.join(", "));

// --- painting ---------------------------------------------------------------
const box = await page.locator("#map-canvas").boundingBox();
async function stroke(dx = 0) {
  await page.mouse.move(box.x + box.width / 2 - 60 + dx, box.y + box.height / 2 - 20);
  await page.mouse.down();
  for (let i = 0; i < 14; i++) {
    await page.mouse.move(box.x + box.width / 2 - 60 + dx + i * 9, box.y + box.height / 2 - 20 + i * 5);
  }
  await page.mouse.up();
}
await stroke();
let painted = await page.evaluate(() => window.mwg.paintedCells("land"));
check("left-drag paints the land layer", painted > 0, `${painted} cells`);

// Right-drag must never edit terrain; it pans.
const beforePan = await page.evaluate(() => ({ ...window.mwg.view() }));
await page.mouse.move(box.x + 200, box.y + 200);
await page.mouse.down({ button: "right" });
await page.mouse.move(box.x + 320, box.y + 260);
await page.mouse.up({ button: "right" });
const afterPan = await page.evaluate(() => ({ ...window.mwg.view() }));
const paintedAfterPan = await page.evaluate(() => window.mwg.paintedCells("land"));
check("right-drag pans the view", afterPan.centreX !== beforePan.centreX && afterPan.centreZ !== beforePan.centreZ);
check("right-drag does not paint", paintedAfterPan === painted);

// Middle-drag pans too.
const beforeMiddle = await page.evaluate(() => window.mwg.view().centreX);
await page.mouse.move(box.x + 400, box.y + 300);
await page.mouse.down({ button: "middle" });
await page.mouse.move(box.x + 300, box.y + 300);
await page.mouse.up({ button: "middle" });
check("middle-drag pans the view", (await page.evaluate(() => window.mwg.view().centreX)) !== beforeMiddle);

// Undo/redo.
await page.click("#btn-undo");
check("undo reverts the stroke", (await page.evaluate(() => window.mwg.paintedCells("land"))) === 0);
await page.click("#btn-redo");
check("redo reapplies the stroke", (await page.evaluate(() => window.mwg.paintedCells("land"))) === painted);

// Elevation brush.
await page.evaluate(() => window.mwg.selectLayer("elevation"));
await stroke(120);
check(
  "elevation brush changes heights",
  (await page.evaluate(() => window.mwg.paintedCells("elevation"))) > 0,
);

// --- zoom keeps the point under the cursor ----------------------------------
const anchored = await page.evaluate(async () => {
  const canvas = document.getElementById("map-canvas");
  const rect = canvas.getBoundingClientRect();
  const clientX = rect.left + 300;
  const clientY = rect.top + 200;
  const at = () => window.mwg.worldAtClient(clientX, clientY);
  const before = at();
  canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, clientX, clientY, bubbles: true, cancelable: true }));
  const after = at();
  return Math.abs(after.x - before.x) < 1 && Math.abs(after.z - before.z) < 1;
});
check("wheel zoom keeps the cursor anchored", anchored);

// --- analysis and the config textarea ---------------------------------------
await page.click("#btn-analyse");
await page.waitForFunction(() => document.getElementById("analysis-output").textContent.length > 0);
const configText = await page.inputValue("#config-json");
let parsedOk = true;
try {
  JSON.parse(configText);
} catch {
  parsedOk = false;
}
check("analysis fills the config textarea with valid JSON", parsedOk && configText.includes("continents"));

// Editing the textarea must reach the generator.
await page.evaluate(() => {
  const area = document.getElementById("config-json");
  const config = JSON.parse(area.value);
  config.continents.width = 12345;
  area.value = JSON.stringify(config, null, 2);
});
await page.click("#config-apply");
check(
  "config edits reach the generator",
  (await page.evaluate(() => window.mwg.generator().continents.width)) === 12345,
);

// Broken JSON must be reported, not thrown.
await page.fill("#config-json", "{ not json");
await page.click("#config-apply");
const statusText = await page.textContent("#status");
check("invalid config JSON is reported", statusText.trim().length > 0 && (await page.getAttribute("#status", "class")).includes("error"));
await page.click("#config-reset");
check(
  "reset restores a parseable config",
  await page.evaluate(() => {
    try {
      JSON.parse(document.getElementById("config-json").value);
      return true;
    } catch {
      return false;
    }
  }),
);

// --- presets ----------------------------------------------------------------
await page.selectOption("#preset-pick", "archipelago");
await page.click("#preset-load");
await page.waitForFunction(() => window.mwg.generator().islands.size === 520);
const archipelago = await page.evaluate(() => window.mwg.generator());
check("preset load replaces the generator", archipelago.continents.land_ratio < 0.2, `land_ratio ${archipelago.continents.land_ratio}`);

await page.selectOption("#preset-pick", "vanilla");
await page.click("#preset-load");
let vanillaSwitched = true;
try {
  await page.waitForFunction(() => document.getElementById("export-mode").value === "vanilla", null, { timeout: 5000 });
} catch {
  vanillaSwitched = false;
}
check("the vanilla preset switches the export mode", vanillaSwitched, await page.inputValue("#export-mode"));

await page.selectOption("#preset-pick", "earthlike");
await page.click("#preset-load");
await page.waitForFunction(() => window.mwg.generator().islands.size === 800);
await page.selectOption("#export-mode", "procedural");

// --- out-of-range values clamp rather than fail -----------------------------
await page.evaluate(() => {
  const area = document.getElementById("config-json");
  const config = JSON.parse(area.value);
  config.continents.land_ratio = 99;
  config.continents.width = -500;
  area.value = JSON.stringify(config, null, 2);
});
await page.click("#config-apply");

// --- export -----------------------------------------------------------------
await page.fill("#pack-name", "SmokeWorld");
const download = await Promise.all([
  page.waitForEvent("download", { timeout: 60000 }),
  page.click("#btn-export-pack"),
]).then(([d]) => d);
check("export downloads a zip", download.suggestedFilename() === "SmokeWorld.zip", download.suggestedFilename());
const zipPath = await download.path();
const zipBytes = await readFile(zipPath);
check("the zip is a real archive", zipBytes[0] === 0x50 && zipBytes[1] === 0x4b, `${zipBytes.length} bytes`);
check("clamped values still produced a pack", (await page.textContent("#status")).includes("files"));

// Vanilla export writes a pack with no worldgen files.
await page.selectOption("#export-mode", "vanilla");
const vanillaDownload = await Promise.all([
  page.waitForEvent("download", { timeout: 60000 }),
  page.click("#btn-export-pack"),
]).then(([d]) => d);
check("vanilla export downloads too", vanillaDownload.suggestedFilename() === "SmokeWorld.zip");

// --- project round trip -----------------------------------------------------
const roundTrip = await page.evaluate(async () => {
  const before = window.mwg.paintedCells("land");
  const doc = await window.mwg.currentDoc();
  await window.mwg.loadProject(JSON.parse(JSON.stringify(doc)));
  return { before, after: window.mwg.paintedCells("land") };
});
check("a project survives export/import", roundTrip.before === roundTrip.after, `${roundTrip.before} → ${roundTrip.after}`);

// --- locale -----------------------------------------------------------------
await page.selectOption("#locale", "ko");
const stillThere = await page.evaluate(() => !!document.getElementById("map-width"));
check("switching locale does not destroy the panels", stillThere);
await page.selectOption("#locale", "en");

// --- new map ----------------------------------------------------------------
await page.fill("#map-width", "4000");
await page.fill("#map-height", "3000");
await page.click("#new-map");
const size = await page.evaluate(() => window.mwg.mapSize());
check("new map applies the entered size", size.width === 4000 && size.height === 3000, JSON.stringify(size));

check("no console errors during the session", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();
server.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
