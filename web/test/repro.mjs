/** Drive the published site the way a user would and capture any build error. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("../..", import.meta.url).pathname;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".mcmeta": "application/json; charset=utf-8" };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
  try {
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("nope"); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined,
});
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(base, { waitUntil: "networkidle" });

async function build(label) {
  await page.click("#btn-export-pack").catch((e) => console.log("click failed", String(e)));
  await page.waitForTimeout(3000);
  const status = await page.evaluate(() => window.mwg.lastStatus());
  console.log(`${label}: ${status}`);
}

await page.selectOption("#preset-pick", "earthlike");
await page.click("#preset-load").catch(() => {});
await page.waitForTimeout(400);

// draw something, the way a user would, then analyse and export
await page.evaluate(() => {
  const s = window.mwg.mapSize();
  const cx = Math.round(s.width / s.resolution / 2);
  const cy = Math.round(s.height / s.resolution / 2);
  window.mwg.selectLayer("land");
  window.mwg.setBrush({ mode: "paint", size: 400 });
  window.mwg.paintAtCell(cx, cy);
  window.mwg.selectLayer("elevation");
  window.mwg.setBrush({ mode: "set", targetY: 140, size: 400, flow: 1 });
  window.mwg.paintAtCell(cx, cy);
  window.mwg.runAnalysis();
});
await build("drawn map");

// turn karst on through the config box, which is the only way right now
const applied = await page.evaluate(() => {
  const box = document.getElementById("config-json");
  const cfg = JSON.parse(box.value);
  cfg.karst = { enabled: true, frequency: 0.2, size: 70, height_blocks: 60, setting: "sea" };
  box.value = JSON.stringify(cfg, null, 2);
  document.getElementById("config-apply").click();
  return window.mwg.lastStatus();
});
console.log("apply karst:", applied);
await build("karst on");

await build("second export, same document");
console.log("console errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
server.close();
