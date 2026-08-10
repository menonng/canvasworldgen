/** Editor shell: state, input handling and panel wiring. */

import {
  DEFAULT_BRUSH,
  FEATURE_FLAGS,
  LAYER_SPECS,
  MapModel,
  History,
  applyBrush,
  finishStroke,
  layersFromDoc,
  layersToDoc,
  type BrushSettings,
  type LayerId,
} from "./field";
import { analyseMap, analysisToGenerator, previewHeights, type Analysis } from "./compile";
import { emptyProject, type ProjectDoc } from "./project";
import { renderHeightGrid, renderMap, type RenderOptions, type ViewState } from "./render";
import { t, setLocale, currentLocale, type Locale } from "./i18n";
import { VANILLA_OVERWORLD_BIOMES } from "./biomes";
import { buildPack } from "./pack/builder";
import { createZip } from "./pack/zip";

interface EditorState {
  doc: ProjectDoc;
  map: MapModel;
  history: History;
  view: ViewState;
  brush: BrushSettings;
  activeLayer: LayerId;
  visible: Set<LayerId>;
  grid: boolean;
  contours: boolean;
  contourInterval: number;
  analysis: Analysis | null;
}

const state: EditorState = createState(emptyProject());

function createState(doc: ProjectDoc): EditorState {
  const map = new MapModel(doc);
  return {
    doc,
    map,
    history: new History(),
    view: { scale: Math.max(1, doc.map.width / 900), centreX: doc.map.origin.x, centreZ: doc.map.origin.z },
    brush: { ...DEFAULT_BRUSH },
    activeLayer: "land",
    visible: new Set<LayerId>(["land", "elevation"]),
    grid: true,
    contours: true,
    contourInterval: 16,
    analysis: null,
  };
}

// ------------------------------------------------------------------ elements
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

let canvas: HTMLCanvasElement;
let previewUser: HTMLCanvasElement;
let previewProcedural: HTMLCanvasElement;

// -------------------------------------------------------------------- render
function draw(): void {
  const options: RenderOptions = {
    visible: state.visible,
    activeLayer: state.activeLayer,
    grid: state.grid,
    contours: state.contours,
    contourInterval: state.contourInterval,
    seaLevel: state.doc.world.sea_level,
  };
  renderMap(canvas, state.map, state.view, options);
}

function resizeCanvas(): void {
  const rect = canvas.parentElement!.getBoundingClientRect();
  canvas.width = Math.max(320, Math.floor(rect.width));
  canvas.height = Math.max(320, Math.floor(rect.height));
  draw();
}

// --------------------------------------------------------------------- input
let painting = false;
let touched = new Map<number, number>();

function canvasToWorld(event: PointerEvent): { x: number; z: number } {
  const rect = canvas.getBoundingClientRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  return {
    x: state.view.centreX + (px - canvas.width / 2) * state.view.scale,
    z: state.view.centreZ + (py - canvas.height / 2) * state.view.scale,
  };
}

function paintAt(event: PointerEvent): void {
  const { x, z } = canvasToWorld(event);
  applyBrush(state.map.layer(state.activeLayer), state.map, x, z, state.brush, touched);
  draw();
}

function updateHover(event: PointerEvent): void {
  const { x, z } = canvasToWorld(event);
  const { cx, cy } = state.map.worldToCell(x, z);
  const inside = cx >= 0 && cy >= 0 && cx < state.map.cols && cy < state.map.rows;
  const rows: string[] = [
    `X ${Math.round(x)}   Z ${Math.round(z)}`,
  ];
  if (!inside) {
    rows.push(t("hover.outside"));
  } else {
    const land = state.map.layer("land").get(cx, cy) !== 0;
    const y = state.map.layer("elevation").real(cx, cy);
    const temp = state.map.layer("temperature").real(cx, cy);
    const biomeIndex = state.map.layer("biome").get(cx, cy);
    const flags = state.map.layer("feature").get(cx, cy);
    rows.push(`${t("layer.land")}: ${land ? t("value.land") : t("value.ocean")}`);
    rows.push(`${t("layer.elevation")}: Y ${Math.round(y)}`);
    rows.push(`${t("layer.temperature")}: ${temp.toFixed(2)}`);
    rows.push(`${t("layer.biome")}: ${biomeIndex > 0 ? state.map.biomePalette[biomeIndex] : "—"}`);
    const active = FEATURE_FLAGS.filter((_, bit) => flags & (1 << bit));
    if (active.length) rows.push(`${t("layer.feature")}: ${active.join(", ")}`);
  }
  $("hover").textContent = rows.join("\n");
}

function bindCanvas(): void {
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return; // left button only; right is never a terrain edit
    canvas.setPointerCapture(event.pointerId);
    painting = true;
    touched = new Map();
    paintAt(event);
  });
  canvas.addEventListener("pointermove", (event) => {
    updateHover(event);
    if (painting) paintAt(event);
  });
  const stop = (): void => {
    if (!painting) return;
    painting = false;
    const stroke = finishStroke(state.map.layer(state.activeLayer), state.activeLayer, touched);
    if (stroke) state.history.push(stroke);
    touched = new Map();
    scheduleAutosave();
  };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const factor = event.deltaY > 0 ? 1.15 : 1 / 1.15;
      state.view.scale = Math.max(0.25, Math.min(256, state.view.scale * factor));
      draw();
    },
    { passive: false },
  );

  window.addEventListener("keydown", (event) => {
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === "z" && !event.shiftKey) {
      event.preventDefault();
      if (state.history.undo(state.map)) draw();
    } else if (ctrl && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) {
      event.preventDefault();
      if (state.history.redo(state.map)) draw();
    } else if (event.key === "[") {
      state.brush.size = Math.max(1, Math.round(state.brush.size / 1.3));
      syncBrushInputs();
    } else if (event.key === "]") {
      state.brush.size = Math.min(100000, Math.round(state.brush.size * 1.3));
      syncBrushInputs();
    }
  });
}

// --------------------------------------------------------------------- panels
function syncBrushInputs(): void {
  ($("brush-size") as HTMLInputElement).value = String(state.brush.size);
  $("brush-size-label").textContent = `${state.brush.size}`;
}

function buildLayerButtons(): void {
  const host = $("layer-buttons");
  host.innerHTML = "";
  for (const spec of LAYER_SPECS) {
    const row = document.createElement("div");
    row.className = "layer-row";

    const pick = document.createElement("button");
    pick.textContent = t(`layer.${spec.id}`);
    pick.className = state.activeLayer === spec.id ? "layer-pick active" : "layer-pick";
    pick.onclick = () => {
      state.activeLayer = spec.id;
      state.visible.add(spec.id);
      buildLayerButtons();
      buildBrushOptions();
      draw();
    };

    const eye = document.createElement("input");
    eye.type = "checkbox";
    eye.checked = state.visible.has(spec.id);
    eye.title = t("layer.visible");
    eye.onchange = () => {
      if (eye.checked) state.visible.add(spec.id);
      else state.visible.delete(spec.id);
      draw();
    };

    row.append(eye, pick);
    host.append(row);
  }
}

function buildBrushOptions(): void {
  const host = $("brush-options");
  host.innerHTML = "";
  const layer = state.activeLayer;

  const addSelect = (label: string, options: Array<[string, string]>, value: string, onChange: (v: string) => void) => {
    const wrap = document.createElement("label");
    wrap.className = "field";
    wrap.textContent = label;
    const select = document.createElement("select");
    for (const [key, text] of options) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = text;
      select.append(option);
    }
    select.value = value;
    select.onchange = () => onChange(select.value);
    wrap.append(select);
    host.append(wrap);
  };

  const addNumber = (label: string, value: number, onChange: (v: number) => void, step = 1) => {
    const wrap = document.createElement("label");
    wrap.className = "field";
    wrap.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(value);
    input.step = String(step);
    input.onchange = () => onChange(Number(input.value));
    wrap.append(input);
    host.append(wrap);
  };

  if (layer === "land") {
    state.brush.mode = "paint";
    addSelect(
      t("brush.value"),
      [
        ["1", t("value.land")],
        ["0", t("value.ocean")],
      ],
      String(state.brush.value),
      (v) => (state.brush.value = Number(v)),
    );
  } else if (layer === "elevation") {
    addSelect(
      t("brush.mode"),
      [
        ["raise", t("brush.raise")],
        ["lower", t("brush.lower")],
        ["raise_to", t("brush.raiseTo")],
        ["lower_to", t("brush.lowerTo")],
        ["set", t("brush.set")],
      ],
      state.brush.mode === "paint" ? "raise" : state.brush.mode,
      (v) => {
        state.brush.mode = v as BrushSettings["mode"];
        buildBrushOptions();
      },
    );
    if (state.brush.mode === "raise" || state.brush.mode === "lower") {
      addNumber(t("brush.amount"), state.brush.amount, (v) => (state.brush.amount = v));
    } else {
      addNumber(t("brush.targetY"), state.brush.targetY, (v) => (state.brush.targetY = v));
    }
  } else if (layer === "temperature") {
    state.brush.mode = "paint";
    addNumber(t("brush.value"), state.brush.value / 100, (v) => (state.brush.value = Math.round(v * 100)), 0.05);
  } else if (layer === "biome") {
    state.brush.mode = "paint";
    const options: Array<[string, string]> = [["0", t("value.clear")]];
    VANILLA_OVERWORLD_BIOMES.forEach((id) => {
      let index = state.map.biomePalette.indexOf(id);
      if (index < 0) index = state.map.biomePalette.push(id) - 1;
      options.push([String(index), id]);
    });
    addSelect(t("brush.value"), options, String(state.brush.value), (v) => (state.brush.value = Number(v)));
  } else {
    state.brush.mode = "paint";
    const options: Array<[string, string]> = FEATURE_FLAGS.map((flag, bit) => [String(1 << bit), flag]);
    addSelect(t("brush.value"), options, String(state.brush.value), (v) => (state.brush.value = Number(v)));
  }

  addNumber(t("brush.slope"), state.brush.slopeStrength, (v) => (state.brush.slopeStrength = Math.max(0, Math.min(1, v))), 0.05);
  addNumber(t("brush.flow"), state.brush.flow, (v) => (state.brush.flow = Math.max(0.01, Math.min(1, v))), 0.05);
}

// -------------------------------------------------------------- project files
function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

async function exportProject(): Promise<void> {
  const doc = await currentDoc();
  download(`${doc.meta?.name ?? "world"}.mwgproj.json`, new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
}

async function currentDoc(): Promise<ProjectDoc> {
  const doc = structuredClone(state.doc);
  doc.map.layers = await layersToDoc(state.map);
  doc.meta = { ...doc.meta, modified: new Date().toISOString() };
  doc.editor = {
    active_layer: state.activeLayer,
    visible_layers: [...state.visible],
    brush: state.brush,
    grid: state.grid,
    contours: state.contours,
    contour_interval: state.contourInterval,
    camera: { x: state.view.centreX, z: state.view.centreZ, zoom: state.view.scale },
  };
  return doc;
}

async function loadProject(doc: ProjectDoc): Promise<void> {
  const next = createState(doc);
  await layersFromDoc(next.map, doc.map.layers ?? {});
  Object.assign(state, next);
  buildLayerButtons();
  buildBrushOptions();
  syncBrushInputs();
  draw();
}

function importProject(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const doc = JSON.parse(await file.text()) as ProjectDoc;
      if (doc.format !== 1) throw new Error(`unsupported project format ${doc.format}`);
      await loadProject(doc);
      status(t("status.imported"));
    } catch (error) {
      status(`${t("status.importFailed")}: ${(error as Error).message}`, true);
    }
  };
  input.click();
}

// ---------------------------------------------------------------- autosave
let autosaveTimer: number | undefined;
function scheduleAutosave(): void {
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(async () => {
    try {
      localStorage.setItem("mwg.autosave", JSON.stringify(await currentDoc()));
    } catch {
      // quota exceeded on a large map is not worth interrupting the user for
    }
  }, 1500);
}

async function restoreAutosave(): Promise<void> {
  const saved = localStorage.getItem("mwg.autosave");
  if (!saved) return;
  try {
    await loadProject(JSON.parse(saved) as ProjectDoc);
    status(t("status.restored"));
  } catch {
    localStorage.removeItem("mwg.autosave");
  }
}

// ----------------------------------------------------------------- analysis
function runAnalysis(): void {
  const analysis = analyseMap(state.map, state.doc);
  state.analysis = analysis;
  state.doc.generator = analysisToGenerator(analysis, state.doc.generator);

  const lines = [
    `${t("analysis.landRatio")}: ${(analysis.landRatio * 100).toFixed(1)}%`,
    `${t("analysis.landmasses")}: ${analysis.landmassCount}`,
    `${t("analysis.continentSize")}: ${Math.round(analysis.continentWidth)} × ${Math.round(analysis.continentHeight)}`,
    `${t("analysis.variation")}: ${analysis.widthVariationPercent}% / ${analysis.heightVariationPercent}%`,
    `${t("analysis.islands")}: ${analysis.islandCount} @ ${Math.round(analysis.islandSize)}`,
    `${t("analysis.clustering")}: ${analysis.islandClustering.toFixed(2)}`,
    `${t("analysis.oceanDepth")}: ${Math.round(analysis.meanOceanDepth)} / ${Math.round(analysis.maxOceanDepth)}`,
    `${t("analysis.center")}: ${analysis.centerType} r=${analysis.centerRadius}`,
    ...analysis.notes.map((n) => `! ${n}`),
  ];
  $("analysis-output").textContent = lines.join("\n");
  $("config-json").textContent = JSON.stringify(state.doc.generator, null, 2);
  renderPreviews();
}

function renderPreviews(): void {
  const size = 256;
  const span = Math.max(state.doc.map.width, state.doc.map.height) * 1.6;

  // left: the design, resampled to the same window as the preview
  const design = new Float32Array(size * size);
  const step = span / size;
  const land = state.map.layer("land");
  const elevation = state.map.layer("elevation");
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const x = state.doc.map.origin.x + (ix - size / 2) * step;
      const z = state.doc.map.origin.z + (iy - size / 2) * step;
      const { cx, cy } = state.map.worldToCell(x, z);
      const inside = cx >= 0 && cy >= 0 && cx < state.map.cols && cy < state.map.rows;
      design[iy * size + ix] = inside
        ? elevation.real(cx, cy)
        : state.doc.world.sea_level - 30;
    }
  }
  renderHeightGrid(previewUser, design, size, state.doc.world.sea_level);
  void land;

  const heights = previewHeights(state.doc.generator, {
    seed: state.doc.world.seed || 1234,
    size,
    spanBlocks: span,
    seaLevel: state.doc.world.sea_level,
  });
  renderHeightGrid(previewProcedural, heights, size, state.doc.world.sea_level);
}

// -------------------------------------------------------------------- export
async function exportDatapack(): Promise<void> {
  const mode = ($("export-mode") as HTMLSelectElement).value;
  if (mode === "exact") {
    status(t("status.exactPending"), true);
    return;
  }
  if (!state.analysis) runAnalysis();
  const name = state.doc.export.pack_name || "MyWorld";
  status(t("status.building"));
  try {
    const { files, notes, adjustments } = await buildPack(
      { mode: "custom", ...state.doc.generator },
      name,
    );
    const blob = await createZip([...files].map(([path, data]) => ({ path, data })));
    download(`${name}.zip`, blob);
    const summary = [`${files.size} ${t("status.filesWritten")}`, ...adjustments.map((a) => `- ${a}`)];
    status(summary.join("  "));
    $("analysis-output").textContent = JSON.stringify(notes, null, 2);
  } catch (error) {
    status(`${t("status.buildFailed")}: ${(error as Error).message}`, true);
  }
}

function status(message: string, isError = false): void {
  const el = $("status");
  el.textContent = message;
  el.className = isError ? "status error" : "status";
}

// ---------------------------------------------------------------------- boot
function bindPanels(): void {
  ($("map-width") as HTMLInputElement).value = String(state.doc.map.width);
  ($("map-height") as HTMLInputElement).value = String(state.doc.map.height);
  ($("map-resolution") as HTMLSelectElement).value = String(state.doc.map.resolution);
  ($("sea-level") as HTMLInputElement).value = String(state.doc.world.sea_level);
  ($("seed") as HTMLInputElement).value = String(state.doc.world.seed);

  $("new-map").onclick = async () => {
    const width = Number(($("map-width") as HTMLInputElement).value);
    const height = Number(($("map-height") as HTMLInputElement).value);
    const resolution = Number(($("map-resolution") as HTMLSelectElement).value);
    const doc = emptyProject(width, height, resolution);
    doc.world.sea_level = Number(($("sea-level") as HTMLInputElement).value);
    doc.world.seed = Number(($("seed") as HTMLInputElement).value);
    await loadProject(doc);
    status(t("status.newMap"));
  };

  ($("brush-shape") as HTMLSelectElement).onchange = (event) => {
    state.brush.shape = (event.target as HTMLSelectElement).value as BrushSettings["shape"];
  };
  ($("brush-size") as HTMLInputElement).oninput = (event) => {
    state.brush.size = Number((event.target as HTMLInputElement).value);
    $("brush-size-label").textContent = `${state.brush.size}`;
  };
  ($("toggle-grid") as HTMLInputElement).onchange = (event) => {
    state.grid = (event.target as HTMLInputElement).checked;
    draw();
  };
  ($("toggle-contours") as HTMLInputElement).onchange = (event) => {
    state.contours = (event.target as HTMLInputElement).checked;
    draw();
  };
  $("btn-undo").onclick = () => state.history.undo(state.map) && draw();
  $("btn-redo").onclick = () => state.history.redo(state.map) && draw();
  $("btn-import").onclick = importProject;
  $("btn-export-project").onclick = () => void exportProject();
  $("btn-analyse").onclick = runAnalysis;
  $("btn-export-pack").onclick = () => void exportDatapack();

  const locale = $("locale") as HTMLSelectElement;
  locale.value = currentLocale();
  locale.onchange = () => {
    setLocale(locale.value as Locale);
    applyStaticText();
    buildLayerButtons();
    buildBrushOptions();
  };
}

function applyStaticText(): void {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  document.title = t("app.title");
}

function boot(): void {
  canvas = $("map-canvas");
  previewUser = $("preview-user");
  previewProcedural = $("preview-procedural");
  applyStaticText();
  bindPanels();
  bindCanvas();
  buildLayerButtons();
  buildBrushOptions();
  syncBrushInputs();
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  void restoreAutosave();
}

boot();
