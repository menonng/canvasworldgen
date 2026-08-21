/** Export a pack from the site and write it to disk, so the real registry
 * checker can be run against exactly what a user downloads. */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("../..", import.meta.url).pathname;
const OUT = process.argv[2] ?? "/tmp/site-pack";
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
const problems = [];
page.on("pageerror", (e) => problems.push(String(e)));
await page.goto(base, { waitUntil: "networkidle" });

const files = await page.evaluate(async () => {
  const s = window.mwg.mapSize();
  const cx = Math.round(s.width / s.resolution / 2);
  const cy = Math.round(s.height / s.resolution / 2);
  window.mwg.selectLayer("land");
  window.mwg.setBrush({ mode: "paint", size: 400 });
  window.mwg.paintAtCell(cx, cy);
  window.mwg.selectLayer("elevation");
  window.mwg.setBrush({ mode: "set", targetY: 150, size: 400, flow: 1 });
  window.mwg.paintAtCell(cx, cy);
  window.mwg.runAnalysis();
  const box = document.getElementById("config-json");
  const cfg = JSON.parse(box.value);
  cfg.karst = { enabled: true, frequency: 0.2, size: 70, height_blocks: 60, setting: "sea" };
  box.value = JSON.stringify(cfg, null, 2);
  document.getElementById("config-apply").click();
  return await window.mwg.buildFiles();
});
for (const [path, data] of Object.entries(files)) {
  const target = join(OUT, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
}
console.log(`wrote ${Object.keys(files).length} files to ${OUT}`);
if (problems.length) console.log("page errors:", problems.slice(0, 5));
await browser.close();
server.close();
