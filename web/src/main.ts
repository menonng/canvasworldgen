/** Editor shell: state, input handling and panel wiring. */

import {
  BRUSH_MODES,
  DEFAULT_BRUSH,
  FEATURE_FLAGS,
  LAYER_SPECS,
  MapModel,
  History,
  applyBrush,
  finishStroke,
  layersFromDoc,
  layersToDoc,
  type BrushMode,
  type BrushSettings,
  type LayerId,
} from "./field";
import {
  analyseMap,
  analysisToGenerator,
  analysisToWorld,
  previewHeights,
  TERRAIN_HEADROOM,
  type Analysis,
} from "./compile";
import { emptyProject, type ProjectDoc } from "./project";
import { renderHeightGrid, renderMap, type RenderOptions, type ViewState } from "./render";
import {
  LAND_COLOUR,
  OCEAN_COLOUR,
  biomeColour,
  css,
  elevationColour,
  featureColour,
  temperatureColour,
  type RGB,
} from "./palette";
import { t, tf, setLocale, currentLocale, missingKeys, type Locale } from "./i18n";
import { ALL_VANILLA_BIOMES, BIOME_GROUPS } from "./biomes";
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

function defaultScale(doc: ProjectDoc): number {
  // a stand-in until the canvas exists and fitView can measure it properly
  return Math.max(0.05, (doc.map.width * 1.15) / 900);
}

function createState(doc: ProjectDoc): EditorState {
  const map = new MapModel(doc);
  return {
    doc,
    map,
    history: new History(),
    view: { scale: defaultScale(doc), centreX: doc.map.origin.x, centreZ: doc.map.origin.z },
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
/** Last known cursor position in canvas pixels, for the brush ring. */
let cursor: { px: number; py: number } | null = null;

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
  drawBrushRing();
}

/** Shows the brush footprint at true map scale, so size is never a guess. */
function drawBrushRing(): void {
  if (!cursor || panning) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const radius = state.brush.size / 2 / state.view.scale;
  ctx.save();
  ctx.lineWidth = 1;

  const outline = (r: number): void => {
    ctx.beginPath();
    if (state.brush.shape === "circle") {
      ctx.arc(cursor!.px, cursor!.py, r, 0, Math.PI * 2);
    } else if (state.brush.shape === "diamond") {
      ctx.moveTo(cursor!.px, cursor!.py - r);
      ctx.lineTo(cursor!.px + r, cursor!.py);
      ctx.lineTo(cursor!.px, cursor!.py + r);
      ctx.lineTo(cursor!.px - r, cursor!.py);
      ctx.closePath();
    } else {
      ctx.rect(cursor!.px - r, cursor!.py - r, r * 2, r * 2);
    }
    ctx.stroke();
  };

  if (state.brush.mode === "fill") {
    // fill ignores size, so show a crosshair at the seed cell instead
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.beginPath();
    ctx.moveTo(cursor.px - 7, cursor.py);
    ctx.lineTo(cursor.px + 7, cursor.py);
    ctx.moveTo(cursor.px, cursor.py - 7);
    ctx.lineTo(cursor.px, cursor.py + 7);
    ctx.stroke();
    ctx.restore();
    return;
  }

  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  outline(Math.max(1.5, radius));
  // a soft inner ring marks where the stroke-time falloff begins
  if (state.brush.slopeStrength > 0) {
    ctx.strokeStyle = "rgba(255,255,255,0.30)";
    outline(Math.max(1, radius * (1 - state.brush.slopeStrength)));
  }
  ctx.restore();
}

/** Centres the design surface and zooms so all of it fits, with a margin. */
function fitView(): void {
  const scale = Math.max(state.doc.map.width / canvas.width, state.doc.map.height / canvas.height) * 1.12;
  state.view = {
    scale: Math.max(0.05, Math.min(4096, scale)),
    centreX: state.doc.map.origin.x,
    centreZ: state.doc.map.origin.z,
  };
  draw();
}

function resizeCanvas(): void {
  const rect = canvas.parentElement!.getBoundingClientRect();
  canvas.width = Math.max(320, Math.floor(rect.width));
  canvas.height = Math.max(320, Math.floor(rect.height));
  draw();
}

// --------------------------------------------------------------------- input
let painting = false;
let panning = false;
let panFrom: { px: number; py: number; centreX: number; centreZ: number } | null = null;
let spaceHeld = false;
let touched = new Map<number, number>();

function canvasPixel(event: { clientX: number; clientY: number }): { px: number; py: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    // the backing store is sized to the CSS box, but guard against a stale
    // resize by scaling anyway
    px: ((event.clientX - rect.left) / rect.width) * canvas.width,
    py: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function pixelToWorld(px: number, py: number): { x: number; z: number } {
  return {
    x: state.view.centreX + (px - canvas.width / 2) * state.view.scale,
    z: state.view.centreZ + (py - canvas.height / 2) * state.view.scale,
  };
}

function canvasToWorld(event: { clientX: number; clientY: number }): { x: number; z: number } {
  const { px, py } = canvasPixel(event);
  return pixelToWorld(px, py);
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
    const active = FEATURE_FLAGS.filter((_, bit) => flags & (1 << bit)).map((flag) => t(`feature.${flag}`));
    if (active.length) rows.push(`${t("layer.feature")}: ${active.join(", ")}`);
  }
  $("hover").textContent = rows.join("\n");
}

function endStroke(): void {
  if (!painting) return;
  painting = false;
  const stroke = finishStroke(state.map.layer(state.activeLayer), state.activeLayer, touched);
  if (stroke) {
    state.history.push(stroke);
    markPreviewsStale();
    if (state.activeLayer === "biome") buildLegend();
  }
  touched = new Map();
  scheduleAutosave();
}

function endPan(): void {
  if (!panning) return;
  panning = false;
  panFrom = null;
  canvas.classList.remove("panning");
  draw();
  scheduleAutosave();
}

function zoomAt(px: number, py: number, factor: number): void {
  // keep whatever sits under the cursor exactly where it is
  const before = pixelToWorld(px, py);
  state.view.scale = Math.max(0.05, Math.min(4096, state.view.scale * factor));
  const after = pixelToWorld(px, py);
  state.view.centreX += before.x - after.x;
  state.view.centreZ += before.z - after.z;
  draw();
}

function bindCanvas(): void {
  canvas.addEventListener("pointerdown", (event) => {
    const wantsPan = event.button === 1 || event.button === 2 || (event.button === 0 && spaceHeld);
    if (wantsPan) {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      panning = true;
      const { px, py } = canvasPixel(event);
      panFrom = { px, py, centreX: state.view.centreX, centreZ: state.view.centreZ };
      canvas.classList.add("panning");
      draw();
      return;
    }
    if (event.button !== 0) return; // left button only; nothing else edits terrain
    canvas.setPointerCapture(event.pointerId);
    painting = true;
    touched = new Map();
    // flatten levels to wherever the stroke began, so it has to be sampled
    // before the first dab writes anything
    if (state.brush.mode === "flatten") {
      const { x, z } = canvasToWorld(event);
      const { cx, cy } = state.map.worldToCell(x, z);
      state.brush.anchor = state.map.layer(state.activeLayer).get(cx, cy);
    }
    paintAt(event);
  });

  canvas.addEventListener("pointermove", (event) => {
    cursor = canvasPixel(event);
    updateHover(event);
    if (panning && panFrom) {
      state.view.centreX = panFrom.centreX - (cursor.px - panFrom.px) * state.view.scale;
      state.view.centreZ = panFrom.centreZ - (cursor.py - panFrom.py) * state.view.scale;
      draw();
      return;
    }
    if (painting) paintAt(event);
    else draw();
  });

  const release = (): void => {
    endStroke();
    endPan();
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", () => {
    cursor = null;
    if (!panning && !painting) draw();
  });
  // right-drag is the pan gesture, so the browser menu must stay out of the way
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  // middle-click autoscroll would fight the pan gesture
  canvas.addEventListener("auxclick", (event) => event.preventDefault());

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const { px, py } = canvasPixel(event);
      zoomAt(px, py, event.deltaY > 0 ? 1.15 : 1 / 1.15);
    },
    { passive: false },
  );

  window.addEventListener("keydown", (event) => {
    const typing =
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement;
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === "z" && !event.shiftKey) {
      event.preventDefault();
      if (state.history.undo(state.map)) draw();
      return;
    }
    if (ctrl && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) {
      event.preventDefault();
      if (state.history.redo(state.map)) draw();
      return;
    }
    if (typing) return;
    if (event.code === "Space") {
      spaceHeld = true;
      event.preventDefault();
    } else if (event.key === "[") {
      state.brush.size = Math.max(1, Math.round(state.brush.size / 1.3));
      syncBrushInputs();
      draw();
    } else if (event.key === "]") {
      state.brush.size = Math.min(100000, Math.round(state.brush.size * 1.3));
      syncBrushInputs();
      draw();
    } else if (event.key === "+" || event.key === "=") {
      zoomAt(canvas.width / 2, canvas.height / 2, 1 / 1.15);
    } else if (event.key === "-" || event.key === "_") {
      zoomAt(canvas.width / 2, canvas.height / 2, 1.15);
    } else if (event.key >= "1" && event.key <= "5") {
      selectLayer(LAYER_SPECS[Number(event.key) - 1].id);
    }
  });
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") spaceHeld = false;
  });
  window.addEventListener("blur", () => {
    spaceHeld = false;
    release();
  });
}

// --------------------------------------------------------------------- panels
function syncBrushInputs(): void {
  const slider = $("brush-size") as HTMLInputElement;
  // the slider caps lower than the brush does, so keep it in range without
  // capping what the keyboard shortcuts can reach
  slider.value = String(Math.min(Number(slider.max), state.brush.size));
  $("brush-size-label").textContent = `${state.brush.size}`;
}

/** What the paint brush writes when a layer is first opened. */
const LAYER_DEFAULT_VALUE: Record<LayerId, number> = {
  land: 1,
  elevation: 0,
  // stored as hundredths. 0.35 is the middle of the vanilla "warm" band, and
  // unlike 0 it differs from the layer default, so the first stroke on a fresh
  // map actually does something
  temperature: 35,
  biome: 1,
  feature: 1,
};

function selectLayer(id: LayerId): void {
  if (state.activeLayer !== id) {
    // brush.value means something different on every layer — a feature bit
    // carried into the temperature brush would read as 20 degrees
    state.brush.value = LAYER_DEFAULT_VALUE[id];
    if (!BRUSH_MODES[id].includes(state.brush.mode)) state.brush.mode = BRUSH_MODES[id][0];
  }
  state.activeLayer = id;
  state.visible.add(id);
  buildLayerButtons();
  buildBrushOptions();
  buildLegend();
  draw();
}

/**
 * Colour key for the layer being edited.
 *
 * It reads the same palette the canvas does, so a swatch here cannot disagree
 * with what lands on the map. Feature and biome entries double as a picker:
 * clicking one sets the brush to that value.
 */
function buildLegend(): void {
  const host = $("legend");
  host.innerHTML = "";
  const layer = state.activeLayer;

  const row = (colour: RGB, label: string, onPick?: () => void): void => {
    const item = document.createElement(onPick ? "button" : "div");
    item.className = onPick ? "legend-row pick" : "legend-row";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = css(colour);
    const text = document.createElement("span");
    text.className = "legend-label";
    text.textContent = label;
    item.append(swatch, text);
    if (onPick) (item as HTMLButtonElement).onclick = onPick;
    host.append(item);
  };

  if (layer === "land") {
    row(LAND_COLOUR, t("value.land"), () => pickValue(1));
    row(OCEAN_COLOUR, t("value.ocean"), () => pickValue(0));
  } else if (layer === "elevation") {
    const sea = state.doc.world.sea_level;
    for (const d of [-64, -16, 0, 24, 72, 140, 220, 300]) {
      row(elevationColour(sea + d, sea, d >= 0), `Y ${sea + d}`);
    }
  } else if (layer === "temperature") {
    for (const band of TEMPERATURE_BANDS) {
      const middle = (band.from + band.to) / 2;
      row(temperatureColour(middle), `${t(band.key)}  ${band.from.toFixed(2)} … ${band.to.toFixed(2)}`, () => {
        state.brush.value = Math.round(middle * 100);
        buildBrushOptions();
      });
    }
  } else if (layer === "feature") {
    FEATURE_FLAGS.forEach((flag, bit) => {
      row(featureColour(flag), t(`feature.${flag}`), () => pickValue(1 << bit));
    });
  } else {
    // only the biomes actually on the map, or the brush would list all 66
    const used = new Set<number>();
    const field = state.map.layer("biome");
    for (let i = 0; i < field.values.length; i++) if (field.values[i]) used.add(field.values[i]);
    if (!used.size) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = t("legend.noBiomes");
      host.append(hint);
      return;
    }
    for (const index of [...used].sort((a, b) => a - b)) {
      const id = state.map.biomePalette[index] ?? "";
      row(biomeColour(id), id, () => pickValue(index));
    }
  }
}

function pickValue(value: number): void {
  state.brush.value = value;
  buildBrushOptions();
  draw();
}

function buildLayerButtons(): void {
  const host = $("layer-buttons");
  host.innerHTML = "";
  LAYER_SPECS.forEach((spec, index) => {
    const row = document.createElement("div");
    row.className = "layer-row";

    const pick = document.createElement("button");
    pick.textContent = `${index + 1}. ${t(`layer.${spec.id}`)}`;
    pick.className = state.activeLayer === spec.id ? "layer-pick active" : "layer-pick";
    pick.onclick = () => selectLayer(spec.id);

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
  });
}

/** Translation key for a brush mode, e.g. raise_to -> brush.raiseTo. */
function modeLabel(mode: BrushMode): string {
  const camel = mode.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
  return t(`brush.${camel}`);
}

/**
 * Modes that mean "make it this value" rather than "move it a bit that way".
 * They start at full flow, because a Set to Y that only travels 35% of the way
 * per dab is not setting anything.
 */
const ABSOLUTE_MODES: ReadonlySet<BrushMode> = new Set<BrushMode>([
  "paint",
  "erase",
  "fill",
  "set",
  "flatten",
  "terrace",
  "add_flag",
  "remove_flag",
]);

function defaultFlow(mode: BrushMode): number {
  return ABSOLUTE_MODES.has(mode) ? 1 : 0.35;
}

/**
 * The vanilla Overworld temperature bands, from OverworldBiomeBuilder. The
 * layer holds the climate parameter, which runs -1 to 1 — not a biome's own
 * temperature field — so these are the values that actually select a biome.
 */
const TEMPERATURE_BANDS: Array<{ key: string; from: number; to: number }> = [
  { key: "climate.frozen", from: -1.0, to: -0.45 },
  { key: "climate.cold", from: -0.45, to: -0.15 },
  { key: "climate.temperate", from: -0.15, to: 0.2 },
  { key: "climate.warm", from: 0.2, to: 0.55 },
  { key: "climate.hot", from: 0.55, to: 1.0 },
];

/** Stored index of a biome id, adding it to the project palette on first use. */
function biomePaletteIndex(id: string): number {
  const found = state.map.biomePalette.indexOf(id);
  return found >= 0 ? found : state.map.biomePalette.push(id) - 1;
}

/** Text typed into the biome filter, kept across panel rebuilds. */
let biomeFilter = "";

/** The mode the panel was last built for, so a change can reset the flow. */
let lastBuiltMode: BrushMode | null = null;

function buildBrushOptions(): void {
  const host = $("brush-options");
  host.innerHTML = "";
  const layer = state.activeLayer;
  const modes = BRUSH_MODES[layer];
  if (!modes.includes(state.brush.mode)) state.brush.mode = modes[0];
  const mode = state.brush.mode;
  // An absolute mode left at 0.35 flow travels a third of the way per dab,
  // which reads as "Set to Y does not set anything". Reset on every mode
  // change, wherever it came from, and leave it alone otherwise so a flow the
  // user chose survives a rebuild.
  if (lastBuiltMode !== mode) {
    state.brush.flow = defaultFlow(mode);
    lastBuiltMode = mode;
  }

  const addSelect = (label: string, options: Array<[string, string]>, value: string, onChange: (v: string) => void) => {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const caption = document.createElement("span");
    caption.textContent = label;
    const select = document.createElement("select");
    for (const [key, text] of options) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = text;
      select.append(option);
    }
    // an unknown value would leave the select blank and silently disagree with
    // the brush, so fall back to the first entry
    select.value = options.some(([key]) => key === value) ? value : options[0][0];
    onChange(select.value);
    select.onchange = () => onChange(select.value);
    wrap.append(caption, select);
    host.append(wrap);
  };

  const addNumber = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    step = 1,
    bounds?: { min: number; max: number },
  ) => {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const caption = document.createElement("span");
    caption.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(value);
    input.step = String(step);
    if (bounds) {
      input.min = String(bounds.min);
      input.max = String(bounds.max);
    }
    input.onchange = () => {
      onChange(Number(input.value));
      // the handler clamps, so echo back what was actually taken
      if (bounds) input.value = String(Math.max(bounds.min, Math.min(bounds.max, Number(input.value))));
      draw();
    };
    wrap.append(caption, input);
    host.append(wrap);
    return input;
  };

  const addHintText = (text: string) => {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = text;
    host.append(p);
  };

  const addHint = (key: string) => {
    const text = t(key);
    if (text !== key) addHintText(text);
  };

  /**
   * Every biome in the registry, grouped by dimension. Sixty-six is too many to
   * scroll blind, so a filter box narrows the list; it never removes the
   * current pick, which would silently change what the brush paints.
   */
  const addBiomePicker = () => {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const caption = document.createElement("span");
    caption.textContent = t("brush.value");

    const filter = document.createElement("input");
    filter.type = "search";
    filter.placeholder = t("brush.filter");
    filter.value = biomeFilter;

    const select = document.createElement("select");
    select.size = 8;
    const fill = () => {
      select.innerHTML = "";
      const needle = biomeFilter.trim().toLowerCase();
      const clear = document.createElement("option");
      clear.value = "0";
      clear.textContent = t("value.clear");
      select.append(clear);
      for (const group of BIOME_GROUPS) {
        const matching = group.biomes.filter(
          (id) => !needle || id.includes(needle) || String(biomePaletteIndex(id)) === String(state.brush.value),
        );
        if (!matching.length) continue;
        const optgroup = document.createElement("optgroup");
        optgroup.label = t(group.key);
        for (const id of matching) {
          const option = document.createElement("option");
          option.value = String(biomePaletteIndex(id));
          option.textContent = id; // registry id, never translated
          optgroup.append(option);
        }
        select.append(optgroup);
      }
      select.value = String(state.brush.value);
      if (!select.value) {
        // the current pick was filtered out; keep the brush honest
        select.value = "0";
        state.brush.value = 0;
      }
    };
    fill();
    select.onchange = () => (state.brush.value = Number(select.value));
    filter.oninput = () => {
      biomeFilter = filter.value;
      fill();
    };

    wrap.append(caption, filter, select);
    host.append(wrap);
    addHintText(tf("brush.hint.biome", { count: ALL_VANILLA_BIOMES.length }));
  };

  /**
   * The temperature layer holds the climate parameter the biome source reads,
   * which runs -1 to 1. Offering the vanilla bands by name makes the number
   * mean something; the number itself stays editable for anything between.
   */
  const addTemperaturePicker = () => {
    const current = state.brush.value / 100;
    const bandOf = (value: number) =>
      TEMPERATURE_BANDS.findIndex((band, i) => value < band.to || i === TEMPERATURE_BANDS.length - 1);
    addSelect(
      t("brush.band"),
      TEMPERATURE_BANDS.map((band, i) => [
        String(i),
        `${t(band.key)}  (${band.from.toFixed(2)} … ${band.to.toFixed(2)})`,
      ]),
      String(bandOf(current)),
      (v) => {
        const band = TEMPERATURE_BANDS[Number(v)];
        const middle = (band.from + band.to) / 2;
        // only jump when the current value is outside the band, so picking the
        // band a hand-typed value already sits in does not move it
        if (current < band.from || current >= band.to) {
          state.brush.value = Math.round(middle * 100);
          buildBrushOptions();
        }
      },
    );
    addNumber(
      t("brush.value"),
      state.brush.value / 100,
      (v) => (state.brush.value = Math.round(Math.max(-1, Math.min(1, v)) * 100)),
      0.05,
      { min: -1, max: 1 },
    );
  };

  addSelect(
    t("brush.mode"),
    modes.map((id) => [id, modeLabel(id)]),
    mode,
    (value) => {
      if (value === state.brush.mode) return;
      state.brush.mode = value as BrushMode;
      buildBrushOptions();
      draw();
    },
  );

  // what the mode writes
  const writesValue = mode === "paint" || mode === "fill" || mode === "add_flag" || mode === "remove_flag";
  if (writesValue) {
    if (layer === "land") {
      addSelect(
        t("brush.value"),
        [
          ["1", t("value.land")],
          ["0", t("value.ocean")],
        ],
        String(state.brush.value),
        (v) => (state.brush.value = Number(v)),
      );
    } else if (layer === "feature") {
      addSelect(
        t("brush.flag"),
        FEATURE_FLAGS.map((flag, bit) => [String(1 << bit), t(`feature.${flag}`)]),
        String(state.brush.value),
        (v) => (state.brush.value = Number(v)),
      );
    } else if (layer === "biome") {
      addBiomePicker();
    } else if (layer === "temperature") {
      addTemperaturePicker();
    }
  }

  const world = state.doc.world;
  const buildMin = world.build_min_y;
  const buildMax = world.build_min_y + world.build_height;

  if (mode === "raise" || mode === "lower") {
    addNumber(t("brush.amount"), state.brush.amount, (v) => (state.brush.amount = v));
  } else if (mode === "raise_to" || mode === "lower_to" || mode === "set") {
    addNumber(
      t("brush.targetY"),
      state.brush.targetY,
      (v) => (state.brush.targetY = Math.max(buildMin, Math.min(buildMax, Math.round(v)))),
      1,
      { min: buildMin, max: buildMax },
    );
    addHintText(tf("brush.hint.range", { min: buildMin, max: buildMax, sea: world.sea_level }));
    if (mode !== "set") addNumber(t("brush.amount"), state.brush.amount, (v) => (state.brush.amount = v));
  } else if (mode === "terrace") {
    addNumber(t("brush.step"), Math.max(1, Math.abs(state.brush.amount)), (v) => (state.brush.amount = Math.max(1, v)));
  } else if (mode === "noise") {
    addNumber(t("brush.jitter"), state.brush.amount, (v) => (state.brush.amount = v));
  }

  addHint(`brush.hint.${mode}`);

  // fill replaces a whole region in one go, so shape and falloff play no part
  if (mode !== "fill") {
    addNumber(t("brush.slope"), state.brush.slopeStrength, (v) => (state.brush.slopeStrength = Math.max(0, Math.min(1, v))), 0.05);
    addNumber(t("brush.flow"), state.brush.flow, (v) => (state.brush.flow = Math.max(0.01, Math.min(1, v))), 0.05);
  }
  syncShapeInput();
}

/** Shape and size mean nothing to the fill brush; grey them out rather than
 * leaving controls that quietly do nothing. */
function syncShapeInput(): void {
  const disabled = state.brush.mode === "fill";
  ($("brush-shape") as HTMLSelectElement).disabled = disabled;
  ($("brush-size") as HTMLInputElement).disabled = disabled;
}

// -------------------------------------------------------------- project files
function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // give the click a turn to be picked up before the URL goes away
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
  const hadCamera = restoreEditorState(next, doc.editor);
  Object.assign(state, next);
  syncPanels();
  buildLayerButtons();
  buildBrushOptions();
  buildLegend();
  syncBrushInputs();
  if (hadCamera) draw();
  else fitView();
  renderPreviews();
}

/**
 * Puts back the workspace a project was saved with, ignoring anything odd.
 * Returns whether a usable camera came with it, so the caller knows whether to
 * fit the view instead.
 */
function restoreEditorState(next: EditorState, editor: Record<string, unknown> | undefined): boolean {
  if (!editor) return false;
  const layerIds = LAYER_SPECS.map((s) => s.id) as string[];
  if (typeof editor.active_layer === "string" && layerIds.includes(editor.active_layer)) {
    next.activeLayer = editor.active_layer as LayerId;
  }
  if (Array.isArray(editor.visible_layers)) {
    const visible = editor.visible_layers.filter((id): id is LayerId => layerIds.includes(id as string));
    if (visible.length) next.visible = new Set(visible);
  }
  if (editor.brush && typeof editor.brush === "object") {
    next.brush = { ...next.brush, ...(editor.brush as Partial<BrushSettings>) };
  }
  if (typeof editor.grid === "boolean") next.grid = editor.grid;
  if (typeof editor.contours === "boolean") next.contours = editor.contours;
  if (typeof editor.contour_interval === "number" && editor.contour_interval >= 1) {
    next.contourInterval = Math.round(editor.contour_interval);
  }
  const camera = editor.camera as { x?: number; z?: number; zoom?: number } | undefined;
  if (camera && Number.isFinite(camera.zoom) && (camera.zoom as number) > 0) {
    next.view = {
      scale: Math.max(0.05, Math.min(4096, camera.zoom as number)),
      centreX: Number.isFinite(camera.x) ? (camera.x as number) : next.view.centreX,
      centreZ: Number.isFinite(camera.z) ? (camera.z as number) : next.view.centreZ,
    };
    return true;
  }
  return false;
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

// ------------------------------------------------------------- config bridge
/**
 * The config the compiler sees: the project's world geometry followed by the
 * generator settings. It is one flat document in the textarea because that is
 * what pack/config.json looks like on disk, so what a user copies out of here
 * can be pasted straight into a pack.
 */
function compilerConfig(): Record<string, unknown> {
  // seed lives on the project, not in the pack config: the pack takes whatever
  // seed the world is created with
  const { seed, ...world } = state.doc.world;
  void seed;
  return { world, ...state.doc.generator };
}

function showConfig(): void {
  ($("config-json") as HTMLTextAreaElement).value = JSON.stringify(compilerConfig(), null, 2);
}

/** Applies whatever is in the textarea. Out-of-range values clamp at compile
 * time, so nothing here needs to reject a number. */
function applyConfigText(): void {
  const area = $("config-json") as HTMLTextAreaElement;
  let parsed: unknown;
  try {
    parsed = JSON.parse(area.value);
  } catch (error) {
    status(`${t("status.configInvalid")}: ${(error as Error).message}`, true);
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    status(t("status.configInvalid"), true);
    return;
  }
  const { world, mode, format, ...generator } = parsed as Record<string, unknown>;
  void mode;
  void format;
  if (world && typeof world === "object") {
    for (const [key, value] of Object.entries(world as Record<string, unknown>)) {
      if (key === "seed") continue;
      if (typeof value === "number" && Number.isFinite(value) && key in state.doc.world) {
        (state.doc.world as unknown as Record<string, number>)[key] = value;
      }
    }
  }
  state.doc.generator = generator;
  analysedVersion = -1;
  syncPanels();
  draw();
  renderPreviews();
  scheduleAutosave();
  status(t("status.configApplied"));
}

// ----------------------------------------------------------------- presets
/**
 * Presets are data pack configs, not projects: loading one replaces the
 * generator settings and leaves the drawn map alone.
 */
async function loadPreset(): Promise<void> {
  const name = ($("preset-pick") as HTMLSelectElement).value;
  if (!name) {
    status(t("status.presetNone"), true);
    return;
  }
  try {
    const response = await fetch(`./presets/${name}.json`, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = (await response.json()) as Record<string, unknown>;
    const { world, mode, format, ...generator } = config;
    void format;
    if (world && typeof world === "object") {
      state.doc.world = { ...state.doc.world, ...(world as Record<string, number>) };
    }
    if (Object.keys(generator).length) state.doc.generator = generator;
    // preset settings are not an analysis of this map
    analysedVersion = -1;
    const exportMode = mode === "vanilla" ? "vanilla" : "procedural";
    state.doc.export.mode = exportMode;
    ($("export-mode") as HTMLSelectElement).value = exportMode;
    state.analysis = null;
    syncPanels();
    draw();
    renderPreviews();
    scheduleAutosave();
    status(`${t("status.presetLoaded")}: ${name}`);
  } catch (error) {
    status(`${t("status.presetFailed")}: ${(error as Error).message}`, true);
  }
}

// ----------------------------------------------------------------- analysis
function runAnalysis(): void {
  const analysis = analyseMap(state.map, state.doc);
  state.analysis = analysis;
  state.doc.generator = analysisToGenerator(analysis, state.doc.generator);
  // The world's ceiling follows the map: highest drawn land plus headroom.
  Object.assign(state.doc.world, analysisToWorld(analysis, state.doc.world));
  analysedVersion = mapVersion;

  const lines = [
    `${t("analysis.landRatio")}: ${(analysis.landRatio * 100).toFixed(1)}%`,
    `${t("analysis.landmasses")}: ${analysis.landmassCount}`,
    `${t("analysis.continentSize")}: ${Math.round(analysis.continentWidth)} × ${Math.round(analysis.continentHeight)}`,
    `${t("analysis.variation")}: ${analysis.widthVariationPercent}% / ${analysis.heightVariationPercent}%`,
    `${t("analysis.islands")}: ${analysis.islandCount} @ ${Math.round(analysis.islandSize)}`,
    `${t("analysis.clustering")}: ${analysis.islandClustering.toFixed(2)}`,
    `${t("analysis.oceanDepth")}: ${Math.round(analysis.meanOceanDepth)} / ${Math.round(analysis.maxOceanDepth)}`,
    `${t("analysis.center")}: ${t(`center.${analysis.centerType}`)} r=${analysis.centerRadius}`,
    tf("analysis.worldRange", {
      max: state.doc.world.terrain_max_y,
      min: state.doc.world.terrain_min_y,
      peak: Math.round(analysis.maxLandElevation),
      headroom: TERRAIN_HEADROOM,
    }),
    ...analysis.notes.map((key) => `! ${t(key)}`),
  ];
  $("analysis-output").textContent = lines.join("\n");
  showConfig();
  renderPreviews();
  scheduleAutosave();
}

/**
 * The window both previews cover, in blocks.
 *
 * Wide enough to hold the design surface, and wide enough that the generator's
 * own continents fit inside it — a pangaea preset on a small map would
 * otherwise fill the frame with one undifferentiated landmass.
 */
function previewSpan(): number {
  const cont = (state.doc.generator.continents ?? {}) as Record<string, number>;
  const islands = (state.doc.generator.islands ?? {}) as Record<string, number>;
  const mapSpan = Math.max(state.doc.map.width, state.doc.map.height);
  const wanted = Math.max(
    mapSpan * 1.6,
    Math.max(Number(cont.width) || 0, Number(cont.height) || 0) * 2.4,
    (Number(islands.size) || 0) * 12,
    1024,
  );
  // Never zoom so far out that the design surface becomes a speck. A preset
  // with 26000-block continents on a 2000-block map would otherwise show the
  // drawn world as four pixels, which reads as the two panels disagreeing when
  // they are only at different scales.
  return Math.min(wanted, mapSpan * 6);
}

const PREVIEW_SIZE = 256;

/**
 * Previews are not redrawn on every brush stroke — resampling the map and
 * re-running the generator on each dab would fight the drawing. Instead the
 * pair is marked stale and each has its own refresh button.
 */
/**
 * Bumped on every edit to the map. The procedural preview records the value it
 * was analysed at, so it can say when it is showing a generator that has not
 * seen the current map — including on a fresh page, where the defaults have
 * seen nothing at all.
 */
let mapVersion = 0;
let analysedVersion = -1;

function markPreviewsStale(): void {
  mapVersion++;
  ($("stale-user") as HTMLParagraphElement).hidden = false;
  refreshStaleMark();
}

function refreshStaleMark(): void {
  const stale = analysedVersion !== mapVersion;
  const mark = $("stale-procedural") as HTMLParagraphElement;
  mark.hidden = !stale;
  mark.textContent = analysedVersion < 0 ? t("preview.neverAnalysed") : t("preview.stale");
}

function markProceduralFresh(): void {
  refreshStaleMark();
}

function showPreviewScale(span: number): void {
  const blocks = Math.round(span).toLocaleString("en-US");
  $("preview-scale").textContent = tf("preview.scale", { size: blocks });
}

/**
 * Outlines the design surface on a preview.
 *
 * Both panels cover the same window, which is usually wider than the map. The
 * outline is what makes that legible: without it a small design next to a
 * large generated world looks like the two disagree, rather than like one is a
 * detail of the other.
 */
function drawDesignBounds(canvas: HTMLCanvasElement, span: number): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const scale = canvas.width / span;
  const w = state.doc.map.width * scale;
  const h = state.doc.map.height * scale;
  if (w >= canvas.width * 0.98 && h >= canvas.height * 0.98) return; // fills the frame anyway
  ctx.save();
  ctx.strokeStyle = "rgba(120,200,255,0.75)";
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.strokeRect((canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  ctx.restore();
}

/** Left panel: the drawn elevation, resampled to the shared preview window. */
function renderDesignPreview(): void {
  const size = PREVIEW_SIZE;
  const span = previewSpan();
  showPreviewScale(span);

  const design = new Float32Array(size * size);
  const landMask = new Uint8Array(size * size);
  const step = span / size;
  const elevation = state.map.layer("elevation");
  const land = state.map.layer("land");
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const x = state.doc.map.origin.x + (ix - size / 2) * step;
      const z = state.doc.map.origin.z + (iy - size / 2) * step;
      const { cx, cy } = state.map.worldToCell(x, z);
      const inside = cx >= 0 && cy >= 0 && cx < state.map.cols && cy < state.map.rows;
      const slot = iy * size + ix;
      design[slot] = inside ? elevation.real(cx, cy) : state.doc.world.sea_level - 30;
      // outside the design surface there is no drawn coastline to show
      landMask[slot] = inside && land.get(cx, cy) !== 0 ? 1 : 0;
    }
  }
  renderHeightGrid(previewUser, design, size, state.doc.world.sea_level, landMask);
  drawDesignBounds(previewUser, span);
  ($("stale-user") as HTMLParagraphElement).hidden = true;
}

/** Right panel: what the current generator settings actually produce. */
function renderProceduralPreview(): void {
  const size = PREVIEW_SIZE;
  const span = previewSpan();
  showPreviewScale(span);

  const heights = previewHeights(state.doc.generator, {
    seed: state.doc.world.seed || 1234,
    size,
    spanBlocks: span,
    seaLevel: state.doc.world.sea_level,
  });
  renderHeightGrid(previewProcedural, heights, size, state.doc.world.sea_level);
  drawDesignBounds(previewProcedural, span);
  markProceduralFresh();
}

function renderPreviews(): void {
  renderDesignPreview();
  renderProceduralPreview();
}

// -------------------------------------------------------------------- export
async function exportDatapack(): Promise<void> {
  const mode = ($("export-mode") as HTMLSelectElement).value as ProjectDoc["export"]["mode"];
  state.doc.export.mode = mode;
  if (mode === "exact") {
    status(t("status.exactPending"), true);
    return;
  }
  const name = (($("pack-name") as HTMLInputElement).value || "MyWorld").trim() || "MyWorld";
  state.doc.export.pack_name = name;
  if (mode === "procedural" && !state.analysis) runAnalysis();
  status(t("status.building"));
  try {
    const input =
      mode === "vanilla" ? { mode: "vanilla" } : { mode: "custom", ...compilerConfig() };
    const { files, notes, adjustments } = await buildPack(input, name);
    const blob = await createZip([...files].map(([path, data]) => ({ path, data })));
    download(`${sanitiseFileName(name)}.zip`, blob);
    const summary = [
      `${files.size} ${t("status.filesWritten")}`,
      ...adjustments.map((a) => `- ${tf(a.key, a.params)}`),
    ];
    status(summary.join("  "));
    $("analysis-output").textContent = JSON.stringify(notes, null, 2);
  } catch (error) {
    status(`${t("status.buildFailed")}: ${(error as Error).message}`, true);
  }
}

/** Keeps a pack name usable as a file name without silently renaming it. */
function sanitiseFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, "_").trim();
  return cleaned.length ? cleaned : "MyWorld";
}

function status(message: string, isError = false): void {
  const el = $("status");
  el.textContent = message;
  el.className = isError ? "status error" : "status";
  lastStatus = message;
}
let lastStatus = "";

// ---------------------------------------------------------------------- boot
/** Pushes the current document back into the panel inputs. */
function syncPanels(): void {
  ($("map-width") as HTMLInputElement).value = String(state.doc.map.width);
  ($("map-height") as HTMLInputElement).value = String(state.doc.map.height);
  ($("map-resolution") as HTMLSelectElement).value = String(state.doc.map.resolution);
  ($("sea-level") as HTMLInputElement).value = String(state.doc.world.sea_level);
  ($("seed") as HTMLInputElement).value = String(state.doc.world.seed);
  ($("contour-interval") as HTMLInputElement).value = String(state.contourInterval);
  ($("toggle-grid") as HTMLInputElement).checked = state.grid;
  ($("toggle-contours") as HTMLInputElement).checked = state.contours;
  ($("export-mode") as HTMLSelectElement).value = state.doc.export.mode;
  ($("pack-name") as HTMLInputElement).value = state.doc.export.pack_name;
  ($("brush-shape") as HTMLSelectElement).value = state.brush.shape;
  showConfig();
}

/** Clamps to the input's own bounds rather than refusing the value. */
function clampedNumber(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  if (!Number.isFinite(value)) return fallback;
  const min = input.min === "" ? -Infinity : Number(input.min);
  const max = input.max === "" ? Infinity : Number(input.max);
  const clamped = Math.min(max, Math.max(min, value));
  if (clamped !== value) input.value = String(clamped);
  return clamped;
}

function bindPanels(): void {
  syncPanels();

  $("new-map").onclick = async () => {
    const width = clampedNumber($("map-width") as HTMLInputElement, 2000);
    const height = clampedNumber($("map-height") as HTMLInputElement, 2000);
    const resolution = Number(($("map-resolution") as HTMLSelectElement).value);
    const doc = emptyProject(width, height, resolution);
    doc.world.sea_level = Number(($("sea-level") as HTMLInputElement).value) || 63;
    doc.world.seed = Math.trunc(Number(($("seed") as HTMLInputElement).value)) || 0;
    doc.generator = structuredClone(state.doc.generator);
    doc.export = { ...state.doc.export };
    await loadProject(doc);
    status(t("status.newMap"));
  };

  // sea level and seed are properties of the world, not of the drawing, so
  // they take effect at once instead of waiting for a new map
  ($("sea-level") as HTMLInputElement).onchange = (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    state.doc.world.sea_level = Math.round(value);
    showConfig();
    draw();
    renderPreviews();
    scheduleAutosave();
  };
  ($("seed") as HTMLInputElement).onchange = (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    state.doc.world.seed = Number.isFinite(value) ? Math.trunc(value) : 0;
    renderPreviews();
    scheduleAutosave();
  };
  ($("contour-interval") as HTMLInputElement).onchange = (event) => {
    state.contourInterval = Math.max(1, Math.round(clampedNumber(event.target as HTMLInputElement, 16)));
    draw();
    scheduleAutosave();
  };
  $("reset-view").onclick = fitView;

  ($("brush-shape") as HTMLSelectElement).onchange = (event) => {
    state.brush.shape = (event.target as HTMLSelectElement).value as BrushSettings["shape"];
    draw();
  };
  ($("brush-size") as HTMLInputElement).oninput = (event) => {
    state.brush.size = Number((event.target as HTMLInputElement).value);
    $("brush-size-label").textContent = `${state.brush.size}`;
    draw();
  };
  ($("toggle-grid") as HTMLInputElement).onchange = (event) => {
    state.grid = (event.target as HTMLInputElement).checked;
    draw();
  };
  ($("toggle-contours") as HTMLInputElement).onchange = (event) => {
    state.contours = (event.target as HTMLInputElement).checked;
    draw();
  };
  $("btn-undo").onclick = () => {
    if (state.history.undo(state.map)) {
      draw();
      scheduleAutosave();
    }
  };
  $("btn-redo").onclick = () => {
    if (state.history.redo(state.map)) {
      draw();
      scheduleAutosave();
    }
  };
  $("btn-import").onclick = importProject;
  $("btn-export-project").onclick = () => void exportProject();
  $("btn-analyse").onclick = runAnalysis;
  $("btn-export-pack").onclick = () => void exportDatapack();
  $("preset-load").onclick = () => void loadPreset();
  $("refresh-user").onclick = renderDesignPreview;
  // the procedural side reflects the map only through the analysis, so
  // refreshing it means analysing again
  $("refresh-procedural").onclick = runAnalysis;
  $("config-apply").onclick = applyConfigText;
  $("config-reset").onclick = () => {
    showConfig();
    status(t("status.configReset"));
  };
  ($("export-mode") as HTMLSelectElement).onchange = (event) => {
    state.doc.export.mode = (event.target as HTMLSelectElement).value as ProjectDoc["export"]["mode"];
    scheduleAutosave();
  };
  ($("pack-name") as HTMLInputElement).onchange = (event) => {
    state.doc.export.pack_name = (event.target as HTMLInputElement).value || "MyWorld";
    scheduleAutosave();
  };

  const locale = $("locale") as HTMLSelectElement;
  locale.value = currentLocale();
  locale.onchange = () => {
    setLocale(locale.value as Locale);
    applyStaticText();
    buildLayerButtons();
    buildBrushOptions();
    buildLegend();
    renderPreviews();
  };
}

/**
 * Fills in every element carrying a data-i18n key.
 *
 * Only elements without element children are rewritten: a translated wrapper
 * such as a <label> around an <input> would otherwise have its control
 * replaced by text.
 */
function applyStaticText(): void {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    if (el.firstElementChild) return;
    el.textContent = t(el.dataset.i18n!);
  });
  // tooltips carry their key separately, since they are not the element's text
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const text = t(el.dataset.i18nTitle!);
    el.title = text;
    el.setAttribute("aria-label", text);
  });
  document.title = t("app.title");
  document.documentElement.lang = currentLocale();
}

/** A small surface for the headless smoke test in web/test/smoke.mjs. */
function exposeTestHooks(): void {
  (window as unknown as Record<string, unknown>).mwg = {
    paintedCells: (id: LayerId) => {
      const field = state.map.layer(id);
      let count = 0;
      for (let i = 0; i < field.values.length; i++) if (field.values[i] !== field.spec.default) count++;
      return count;
    },
    cellsWhere: (id: LayerId, predicate: (value: number) => boolean) => {
      const field = state.map.layer(id);
      let count = 0;
      for (let i = 0; i < field.values.length; i++) if (predicate(field.values[i])) count++;
      return count;
    },
    snapshot: (id: LayerId) => {
      // a cheap checksum, enough to tell "the layer changed" from "it did not"
      const field = state.map.layer(id);
      let hash = 0;
      for (let i = 0; i < field.values.length; i++) hash = (hash * 31 + field.values[i]) | 0;
      return hash;
    },
    view: () => ({ ...state.view }),
    /** Land fraction of the procedural preview, straight from the heights. */
    proceduralLandFraction: () => {
      const heights = previewHeights(state.doc.generator, {
        seed: state.doc.world.seed || 1234,
        size: PREVIEW_SIZE,
        spanBlocks: previewSpan(),
        seaLevel: state.doc.world.sea_level,
      });
      let land = 0;
      for (let i = 0; i < heights.length; i++) if (heights[i] > state.doc.world.sea_level) land++;
      return land / heights.length;
    },
    brush: () => ({ ...state.brush }),
    brushModes: (id: LayerId) => [...BRUSH_MODES[id]],
    featureFlags: () => [...FEATURE_FLAGS],
    analysisResult: () => state.analysis,
    colourFor: (kind: string, key: string) =>
      kind === "biome" ? [...biomeColour(key)] : [...featureColour(key)],
    setBrush: (patch: Partial<BrushSettings>) => {
      Object.assign(state.brush, patch);
      buildBrushOptions();
      syncBrushInputs();
      draw();
    },
    worldAtClient: (clientX: number, clientY: number) => canvasToWorld({ clientX, clientY }),
    biomeAtClient: (clientX: number, clientY: number) => {
      const { x, z } = canvasToWorld({ clientX, clientY });
      const { cx, cy } = state.map.worldToCell(x, z);
      return state.map.biomePalette[state.map.layer("biome").get(cx, cy)];
    },
    cellAtClient: (id: LayerId, clientX: number, clientY: number) => {
      const { x, z } = canvasToWorld({ clientX, clientY });
      const { cx, cy } = state.map.worldToCell(x, z);
      const inside = cx >= 0 && cy >= 0 && cx < state.map.cols && cy < state.map.rows;
      return { cx, cy, inside, value: state.map.layer(id).get(cx, cy) };
    },
    generator: () => state.doc.generator,
    world: () => state.doc.world,
    mapSize: () => ({ width: state.doc.map.width, height: state.doc.map.height, resolution: state.doc.map.resolution }),
    selectLayer,
    currentDoc,
    loadProject,
    missingTranslations: (target: Locale) => missingKeys(target),
    lastStatus: () => lastStatus,
  };
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
  buildLegend();
  syncBrushInputs();
  exposeTestHooks();
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  fitView();
  renderPreviews();
  void restoreAutosave();
}

boot();
