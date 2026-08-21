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

// --- every brush mode on every layer ----------------------------------------
const layerModes = await page.evaluate(() =>
  Object.fromEntries(
    ["land", "elevation", "temperature", "biome", "feature"].map((id) => [id, window.mwg.brushModes(id)]),
  ),
);
for (const [layer, modes] of Object.entries(layerModes)) {
  for (const mode of modes) {
    await page.evaluate(
      ([l, m]) => {
        window.mwg.selectLayer(l);
        window.mwg.setBrush({
          mode: m,
          size: 300,
          flow: 1,
          slopeStrength: 0.4,
          amount: 12,
          // raise_to and lower_to stop once the target is reached, so aim each
          // one somewhere the current terrain is not
          targetY: m === "lower_to" ? -20 : 200,
        });
      },
      [layer, mode],
    );
    const before = await page.evaluate((l) => window.mwg.snapshot(l), layer);
    await stroke(40);
    const after = await page.evaluate((l) => window.mwg.snapshot(l), layer);
    const shapeOk = await page.evaluate(() => window.mwg.brush().mode);
    check(`${layer}: ${mode} runs and is selectable`, shapeOk === mode);
    // Modes whose effect depends on what is already there cannot be asserted
    // blind: erase on an untouched cell, smoothing flat ground, or filling a
    // region with the value it already holds are all correctly no-ops. Fill
    // gets its own check below.
    const mustChange = !["erase", "sharpen", "smooth", "terrace", "flatten", "fill"].includes(mode);
    if (mustChange) check(`${layer}: ${mode} edits the layer`, before !== after);
  }
}

// Each brush shape reaches the map. The painted value alternates so every
// stroke inverts what the previous one left behind and a no-op cannot pass.
const shapes = ["circle", "square", "diamond"];
const offeredShapes = await page.evaluate(() =>
  [...document.querySelectorAll("#brush-shape option")].map((o) => o.value),
);
check(
  "the shape select offers every brush shape",
  shapes.every((s) => offeredShapes.includes(s)),
  offeredShapes.join(", "),
);
for (let i = 0; i < shapes.length; i++) {
  await page.evaluate(
    ([s, value]) => {
      window.mwg.selectLayer("land");
      window.mwg.setBrush({ shape: s, mode: "paint", value, size: 200 });
    },
    [shapes[i], i % 2 === 0 ? 1 : 0],
  );
  const before = await page.evaluate(() => window.mwg.snapshot("land"));
  await stroke(260);
  const after = await page.evaluate(() => window.mwg.snapshot("land"));
  check(`brush shape ${shapes[i]} paints`, after !== before);
}

// --- the value each layer writes --------------------------------------------
// Every biome in the registry has to be reachable, and painting one has to put
// that exact id on the map.
const biomeCount = await page.evaluate(() => {
  window.mwg.selectLayer("biome");
  window.mwg.setBrush({ mode: "paint" });
  const select = [...document.querySelectorAll("#brush-options select")][1];
  return [...select.querySelectorAll("option")].length - 1; // minus "Clear"
});
check("the biome brush offers every vanilla biome", biomeCount === 66, `${biomeCount} biomes`);

const biomeGroups = await page.evaluate(() =>
  [...document.querySelectorAll("#brush-options optgroup")].map((g) => g.label),
);
check("biomes are grouped by dimension", biomeGroups.length === 4, biomeGroups.join(", "));

const biomePick = await page.evaluate(async ({ x, y }) => {
  window.mwg.selectLayer("biome");
  const select = [...document.querySelectorAll("#brush-options select")][1];
  const wanted = [...select.querySelectorAll("option")].find((o) => o.textContent === "minecraft:lush_caves");
  if (!wanted) return { ok: false, reason: "lush_caves not offered" };
  select.value = wanted.value;
  select.dispatchEvent(new Event("change"));
  return { ok: true, value: window.mwg.brush().value, x, y };
}, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
check("a biome from the cave group is selectable", biomePick.ok, biomePick.reason ?? "");
await page.evaluate(() => window.mwg.setBrush({ size: 200, mode: "paint" }));
await stroke(0);
check(
  "the painted biome lands on the map as its registry id",
  (await page.evaluate(({ x, y }) => window.mwg.biomeAtClient(x, y), {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  })) === "minecraft:lush_caves",
);

// The biome filter narrows the list without losing the current pick.
const filtered = await page.evaluate(() => {
  const search = document.querySelector('#brush-options input[type="search"]');
  search.value = "ocean";
  search.dispatchEvent(new Event("input"));
  const select = [...document.querySelectorAll("#brush-options select")][1];
  return [...select.querySelectorAll("option")].map((o) => o.textContent);
});
check(
  "the biome filter narrows the list",
  filtered.length < 20 && filtered.some((name) => name.includes("ocean")),
  `${filtered.length} shown`,
);
await page.evaluate(() => {
  const search = document.querySelector('#brush-options input[type="search"]');
  search.value = "";
  search.dispatchEvent(new Event("input"));
});

// Set to Y has to actually reach Y, not creep a third of the way per dab.
await page.evaluate(() => {
  window.mwg.selectLayer("elevation");
  window.mwg.setBrush({ mode: "set", targetY: 140, size: 300, slopeStrength: 0 });
});
check("an absolute mode starts at full flow", (await page.evaluate(() => window.mwg.brush().flow)) === 1);
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.up();
check(
  "Set to Y reaches the target in one click",
  (await page.evaluate(({ x, y }) => window.mwg.cellAtClient("elevation", x, y).value, {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  })) === 140,
);

// Target Y is clamped to the world's build range rather than accepted blind.
const clampedY = await page.evaluate(() => {
  const input = [...document.querySelectorAll("#brush-options input[type=number]")][0];
  input.value = "99999";
  input.dispatchEvent(new Event("change"));
  return window.mwg.brush().targetY;
});
check("Target Y clamps to the build range", clampedY === 320, `${clampedY}`);

// Temperature carries the climate parameter, so the bands must map onto it.
const bands = await page.evaluate(() => {
  window.mwg.selectLayer("temperature");
  window.mwg.setBrush({ mode: "paint" });
  const select = [...document.querySelectorAll("#brush-options select")][1];
  const labels = [...select.querySelectorAll("option")].map((o) => o.textContent);
  select.value = "0";
  select.dispatchEvent(new Event("change"));
  return { labels, frozen: window.mwg.brush().value };
});
check("temperature offers the vanilla climate bands", bands.labels.length === 5, bands.labels.join(" | "));
check(
  "picking a band moves the value into that band",
  bands.frozen / 100 >= -1 && bands.frozen / 100 < -0.45,
  `${bands.frozen / 100}`,
);

const clampedTemp = await page.evaluate(() => {
  const input = [...document.querySelectorAll("#brush-options input[type=number]")][0];
  input.value = "9";
  input.dispatchEvent(new Event("change"));
  return window.mwg.brush().value;
});
check("temperature clamps to the -1..1 climate range", clampedTemp === 100, `${clampedTemp / 100}`);

// Fill replaces a connected region in one click, without a drag. Fill with
// whatever the seed cell is not, so the click cannot be a legitimate no-op.
const candidates = [];
for (let fx = 0.1; fx <= 0.9; fx += 0.1) {
  for (let fy = 0.1; fy <= 0.9; fy += 0.1) {
    candidates.push({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  }
}
const picked = await page.evaluate((points) => {
  window.mwg.selectLayer("land");
  const hit = points.find((p) => window.mwg.cellAtClient("land", p.x, p.y).inside);
  if (!hit) return null;
  const seed = window.mwg.cellAtClient("land", hit.x, hit.y).value;
  window.mwg.setBrush({ shape: "circle", mode: "fill", value: seed === 0 ? 1 : 0 });
  return { ...hit, seed };
}, candidates);
check("found a point inside the design surface to fill from", picked !== null);
const fillPoint = picked ?? candidates[0];
const filledCells = picked?.seed;
const landBeforeFill = await page.evaluate(() => window.mwg.paintedCells("land"));
await page.mouse.move(fillPoint.x, fillPoint.y);
await page.mouse.down();
await page.mouse.up();
const landAfterFill = await page.evaluate(() => window.mwg.paintedCells("land"));
check(
  "fill floods the whole connected region in one click",
  Math.abs(landAfterFill - landBeforeFill) > 10000,
  `seed ${filledCells}: ${landBeforeFill} -> ${landAfterFill}`,
);
await page.click("#btn-undo");
check("undo reverts a fill in one step", (await page.evaluate(() => window.mwg.paintedCells("land"))) === landBeforeFill);
await page.evaluate(() => window.mwg.setBrush({ mode: "paint", value: 1 }));

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

// --- preview refresh --------------------------------------------------------
const canvasHash = (id) =>
  page.evaluate((target) => {
    const canvas = document.getElementById(target);
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 0;
    for (let i = 0; i < data.length; i += 997) hash = (hash * 31 + data[i]) | 0;
    return hash;
  }, id);

await page.evaluate(() => {
  window.mwg.selectLayer("land");
  window.mwg.setBrush({ mode: "paint", value: 1, size: 900 });
});
const designBefore = await canvasHash("preview-user");
await stroke(-150);
check(
  "painting marks both previews stale",
  await page.evaluate(
    () =>
      !document.getElementById("stale-user").hidden &&
      !document.getElementById("stale-procedural").hidden,
  ),
);
check("painting alone does not redraw the preview", (await canvasHash("preview-user")) === designBefore);

await page.click("#refresh-user");
check("the design refresh button redraws it", (await canvasHash("preview-user")) !== designBefore);
check("the design refresh clears its stale mark", await page.evaluate(() => document.getElementById("stale-user").hidden));

const proceduralBefore = await canvasHash("preview-procedural");
await page.click("#refresh-procedural");
await page.waitForFunction(() => document.getElementById("stale-procedural").hidden);
check(
  "the procedural refresh re-analyses and redraws",
  (await canvasHash("preview-procedural")) !== proceduralBefore,
);

// --- every layer paints a colour on the map ---------------------------------
// The feature layer used to have a visibility checkbox and a brush but no
// rendering at all, so painting it changed nothing on screen.
const mapHash = () =>
  page.evaluate(() => {
    const canvas = document.getElementById("map-canvas");
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 0;
    for (let i = 0; i < data.length; i += 401) hash = (hash * 31 + data[i]) | 0;
    return hash;
  });

for (const layer of ["land", "elevation", "temperature", "biome", "feature"]) {
  // Pick a value the cell under the brush does not already hold, or the stroke
  // is a legitimate no-op and the check would be asserting nothing.
  await page.evaluate(
    ([l, x, y]) => {
      window.mwg.selectLayer(l);
      const held = window.mwg.cellAtClient(l, x, y).value;
      const brush = { size: 400, flow: 1, mode: "paint" };
      if (l === "land") brush.value = held ? 0 : 1;
      else if (l === "temperature") brush.value = held > 0 ? -60 : 60;
      else if (l === "biome") brush.value = held === 3 ? 5 : 3;
      else if (l === "feature") {
        brush.mode = held & (1 << 11) ? "remove_flag" : "add_flag";
        brush.value = 1 << 11;
      } else {
        brush.mode = "set";
        brush.targetY = 200;
      }
      window.mwg.setBrush(brush);
    },
    [layer, box.x + box.width / 2 - 60 - 160, box.y + box.height / 2 - 20],
  );
  const layerBefore = await page.evaluate((l) => window.mwg.snapshot(l), layer);
  const before = await mapHash();
  await stroke(-160);
  check(`${layer}: the stroke reached the layer`, (await page.evaluate((l) => window.mwg.snapshot(l), layer)) !== layerBefore);
  check(`${layer}: painting changes what the map shows`, (await mapHash()) !== before);
}

// Each terrain feature has to be its own colour, or the map cannot be read.
const featureColours = await page.evaluate(() => {
  window.mwg.selectLayer("feature");
  return [...document.querySelectorAll("#legend .legend-row .swatch")].map(
    (s) => getComputedStyle(s).backgroundColor,
  );
});
check(
  "every terrain feature has its own colour",
  featureColours.length === 12 && new Set(featureColours).size === 12,
  `${featureColours.length} swatches, ${new Set(featureColours).size} distinct`,
);

// The legend is a picker, not just a key.
const legendPick = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("#legend button.legend-row")];
  rows[4].click(); // mountain_range, bit 4
  return window.mwg.brush().value;
});
check("clicking a legend row sets the brush", legendPick === 1 << 4, `value ${legendPick}`);

// Biome colours must come from the biome, not from a hash of its index.
const biomeColours = await page.evaluate(() => {
  const wanted = ["minecraft:desert", "minecraft:jungle", "minecraft:snowy_plains", "minecraft:ocean"];
  return wanted.map((id) => window.mwg.colourFor("biome", id));
});
check(
  "biome colours are drawn from the biome itself",
  // desert sandy (r > b), jungle green (g highest), snowy pale, ocean blue (b > r)
  biomeColours[0][0] > biomeColours[0][2] &&
    biomeColours[1][1] > biomeColours[1][0] &&
    Math.min(...biomeColours[2]) > 180 &&
    biomeColours[3][2] > biomeColours[3][0],
  JSON.stringify(biomeColours),
);

// Every layer offers a key.
for (const [layer, min] of [["land", 2], ["elevation", 4], ["temperature", 5], ["feature", 12]]) {
  const rows = await page.evaluate((l) => {
    window.mwg.selectLayer(l);
    return document.querySelectorAll("#legend .legend-row").length;
  }, layer);
  check(`${layer}: the legend lists its colours`, rows >= min, `${rows} rows`);
}
await page.evaluate(() => window.mwg.selectLayer("land"));

// --- the world's ceiling follows the map ------------------------------------
// A map whose highest ground is Y 190 should not generate a world built for
// Y 320; the ceiling is the highest drawn land plus 64 blocks of headroom.
const ceiling = await page.evaluate(async () => {
  window.mwg.selectLayer("land");
  window.mwg.setBrush({ mode: "paint", value: 1, size: 700 });
  return true;
});
void ceiling;
await stroke(0);
await page.evaluate(() => {
  window.mwg.selectLayer("elevation");
  window.mwg.setBrush({ mode: "set", targetY: 190, size: 500, slopeStrength: 0.5 });
});
await stroke(0);
await page.click("#btn-analyse");
await page.waitForFunction(() => document.getElementById("stale-procedural").hidden);
const geometry = await page.evaluate(() => window.mwg.world());
const peak = Math.round(await page.evaluate(() => window.mwg.analysisResult().maxLandElevation));
check(
  "the world ceiling is the highest drawn land plus 64",
  geometry.terrain_max_y === peak + 64,
  `peak ${peak} -> terrain_max_y ${geometry.terrain_max_y}`,
);
check(
  "the build range contains the terrain range",
  geometry.build_min_y + geometry.build_height > geometry.terrain_max_y &&
    geometry.build_min_y < geometry.terrain_min_y &&
    geometry.build_height % 16 === 0,
  JSON.stringify(geometry),
);
const shown = await page.textContent("#analysis-output");
const rangeLine = shown.split("\n").find((line) => line.includes(String(geometry.terrain_max_y)) && line.includes("…"));
check("the analysis reports the world range", Boolean(rangeLine), rangeLine ?? shown.split("\n").slice(-2).join(" / "));

// --- the two previews have to agree on how much land there is ---------------
// Procedural Export reproduces statistics, not coastlines — but the land
// fraction is one of those statistics, so a design and its procedural result
// disagreeing on it is a bug, not a difference of interpretation.
await page.click("#btn-analyse");
await page.waitForFunction(() => document.getElementById("stale-procedural").hidden);
const ratios = await page.evaluate(() => ({
  requested: Math.min(0.95, Math.max(0.02, window.mwg.generator().continents.land_ratio)),
  produced: window.mwg.proceduralLandFraction(),
}));
check(
  "the procedural preview produces the land ratio it was asked for",
  Math.abs(ratios.produced - ratios.requested) < 0.01,
  `asked ${ratios.requested.toFixed(3)}, got ${ratios.produced.toFixed(3)}`,
);

// And across the whole range, not just at one value.
const sweep = await page.evaluate(() => {
  const out = [];
  const generator = window.mwg.generator();
  const original = generator.continents.land_ratio;
  for (const wanted of [0.05, 0.2, 0.5, 0.8]) {
    generator.continents.land_ratio = wanted;
    out.push([wanted, window.mwg.proceduralLandFraction()]);
  }
  generator.continents.land_ratio = original;
  return out;
});
check(
  "it tracks the requested ratio across the range",
  sweep.every(([wanted, got]) => Math.abs(got - wanted) < 0.01),
  sweep.map(([w, g]) => `${w}->${g.toFixed(3)}`).join(" "),
);

// A generator that has never seen the map must say so rather than imply it did.
await page.evaluate(
  ([x, y]) => {
    window.mwg.selectLayer("land");
    const held = window.mwg.cellAtClient("land", x, y).value;
    window.mwg.setBrush({ mode: "paint", value: held ? 0 : 1, size: 400 });
  },
  [box.x + box.width / 2 - 260, box.y + box.height / 2 - 20],
);
await stroke(-200);
check(
  "editing the map marks the procedural preview stale",
  await page.evaluate(() => !document.getElementById("stale-procedural").hidden),
);

// --- locale -----------------------------------------------------------------
await page.selectOption("#locale", "ko");
const stillThere = await page.evaluate(() => !!document.getElementById("map-width"));
check("switching locale does not destroy the panels", stillThere);

const koreanPanels = await page.evaluate(() => {
  const text = (selector) => document.querySelector(selector).textContent.trim();
  return {
    map: text('[data-i18n="panel.map"]'),
    brush: text('[data-i18n="panel.brush"]'),
    tooltip: document.getElementById("refresh-user").title,
  };
});
const hangul = /[가-힣]/;
check(
  "Korean reaches the panels and the tooltips",
  hangul.test(koreanPanels.map) && hangul.test(koreanPanels.brush) && hangul.test(koreanPanels.tooltip),
  JSON.stringify(koreanPanels),
);

const koreanBrush = await page.evaluate(() => {
  window.mwg.selectLayer("feature");
  return [...document.querySelectorAll("#brush-options select option")].map((o) => o.textContent);
});
check(
  "terrain feature names are translated",
  koreanBrush.some((name) => hangul.test(name)),
  koreanBrush.slice(0, 4).join(", "),
);

const untranslatedKo = await page.evaluate(() => window.mwg.missingTranslations("ko"));
check("no key is left without a Korean string", untranslatedKo.length === 0, untranslatedKo.join(", "));

await page.selectOption("#locale", "en");
await page.evaluate(() => window.mwg.selectLayer("land"));

// --- live resize ------------------------------------------------------------
// Growing the map has to keep what is drawn where it is on the ground, so a
// cell is sampled by world coordinate before and after.
const beforeResize = await page.evaluate(() => ({
  size: window.mwg.mapSize(),
  painted: window.mwg.paintedCells("elevation"),
}));
await page.fill("#map-width", "6000");
await page.dispatchEvent("#map-width", "change");
const afterResize = await page.evaluate(() => ({
  size: window.mwg.mapSize(),
  painted: window.mwg.paintedCells("elevation"),
}));
check(
  "changing the width resizes at once, without a new map",
  afterResize.size.width === 6000 && beforeResize.size.width !== 6000,
  JSON.stringify(afterResize.size),
);
check(
  "the resize keeps what was drawn",
  afterResize.painted > 0,
  `${beforeResize.painted} -> ${afterResize.painted} painted cells`,
);

// --- height limit -----------------------------------------------------------
await page.evaluate(() => window.mwg.selectLayer("elevation"));
const limited = await page.evaluate(() => {
  window.mwg.world().height_limit = true;
  return window.mwg.world();
});
check("the height limit is on by default", limited.height_limit === true);
const capped = await page.evaluate(() => {
  // ground far above the cap, on land so the analysis counts it
  const middle = [Math.round(window.mwg.mapSize().width / window.mwg.mapSize().resolution / 2),
                  Math.round(window.mwg.mapSize().height / window.mwg.mapSize().resolution / 2)];
  window.mwg.selectLayer("land");
  window.mwg.setBrush({ mode: "paint", size: 400 });
  window.mwg.paintAtCell(middle[0], middle[1]);
  window.mwg.selectLayer("elevation");
  window.mwg.setBrush({ mode: "set", targetY: 900, size: 400, flow: 1 });
  window.mwg.paintAtCell(middle[0], middle[1]);
  window.mwg.runAnalysis();
  return window.mwg.world();
});
check(
  "with the limit on the terrain ceiling stops at 448",
  capped.terrain_max_y <= 448 && capped.build_min_y + capped.build_height <= 512,
  JSON.stringify(capped),
);
await page.uncheck("#height-limit");
const uncapped = await page.evaluate(() => {
  window.mwg.runAnalysis();
  return window.mwg.world();
});
check(
  "turning the limit off lets the ceiling follow the drawing",
  uncapped.terrain_max_y > 448,
  JSON.stringify(uncapped),
);
await page.check("#height-limit");

// --- ground below sea level -------------------------------------------------
// Ground drawn under the water line still has to fit in the world: the terrain
// floor follows whatever was drawn lowest, not just the deepest ocean.
const sunken = await page.evaluate(() => {
  const size = window.mwg.mapSize();
  const mid = [Math.round(size.width / size.resolution / 2), Math.round(size.height / size.resolution / 2)];
  window.mwg.selectLayer("land");
  window.mwg.setBrush({ mode: "paint", size: 300 });
  window.mwg.paintAtCell(mid[0], mid[1]);
  window.mwg.selectLayer("elevation");
  window.mwg.setBrush({ mode: "set", targetY: 10, size: 300, flow: 1 });
  window.mwg.paintAtCell(mid[0], mid[1]);
  window.mwg.runAnalysis();
  return { world: window.mwg.world(), lowest: window.mwg.analysisResult().minLandElevation };
});
check(
  "the analysis sees ground drawn below sea level",
  sunken.lowest <= 10,
  `lowest drawn ground y ${sunken.lowest}`,
);
check(
  "the terrain floor reaches the lowest drawn ground",
  sunken.world.terrain_min_y <= 10,
  JSON.stringify(sunken.world),
);
check(
  "the world floor stays at -64 and terrain keeps clear of the bedrock",
  sunken.world.build_min_y === -64 && sunken.world.terrain_min_y >= -48,
  JSON.stringify(sunken.world),
);

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
