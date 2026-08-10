/**
 * Layer storage, brushes and undo history.
 *
 * Layers are independent by construction. Nothing here derives land from
 * elevation or the other way round, so land below sea level and ocean above it
 * are both perfectly ordinary states.
 */

import { type Dtype, type LayerDoc, type ProjectDoc, type TypedArray, ARRAY_FOR, decodeLayer, encodeLayer } from "./project";

export type LayerId = "land" | "elevation" | "temperature" | "biome" | "feature";

export interface LayerSpec {
  id: LayerId;
  dtype: Dtype;
  default: number;
  scale: number;
  offset: number;
  /** How firmly the drawn value overrides the procedural field. */
  strength: number;
}

export const LAYER_SPECS: LayerSpec[] = [
  { id: "land", dtype: "u8", default: 0, scale: 1, offset: 0, strength: 1.0 },
  { id: "elevation", dtype: "i16", default: 63, scale: 1, offset: 0, strength: 1.0 },
  // temperature is stored as hundredths so it fits an i16 without losing detail
  { id: "temperature", dtype: "i16", default: 0, scale: 0.01, offset: 0, strength: 0.6 },
  { id: "biome", dtype: "u16", default: 0, scale: 1, offset: 0, strength: 1.0 },
  { id: "feature", dtype: "u32", default: 0, scale: 1, offset: 0, strength: 1.0 },
];

export const FEATURE_FLAGS = [
  "volcano",
  "atoll",
  "fjord",
  "island_arc",
  "mountain_range",
  "plateau",
  "tepui",
  "sea_stack",
  "columnar_jointing",
  "inland_sea",
  "river",
  "coral_reef",
] as const;

export type BrushShape = "circle" | "square" | "diamond";

export type BrushMode =
  | "paint"
  | "erase"
  | "fill"
  | "raise"
  | "lower"
  | "raise_to"
  | "lower_to"
  | "set"
  | "smooth"
  | "sharpen"
  | "noise"
  | "flatten"
  | "terrace"
  | "add_flag"
  | "remove_flag";

/** Which modes make sense on which layer, in the order the panel lists them. */
export const BRUSH_MODES: Record<LayerId, BrushMode[]> = {
  land: ["paint", "fill", "smooth", "erase"],
  elevation: [
    "raise",
    "lower",
    "raise_to",
    "lower_to",
    "set",
    "smooth",
    "sharpen",
    "flatten",
    "terrace",
    "noise",
    "erase",
  ],
  temperature: ["paint", "smooth", "noise", "erase"],
  biome: ["paint", "fill", "erase"],
  feature: ["add_flag", "remove_flag", "fill", "erase"],
};

/** Modes that read the cells around the one being written. */
const NEIGHBOURHOOD_MODES: ReadonlySet<BrushMode> = new Set<BrushMode>(["smooth", "sharpen"]);

export interface BrushSettings {
  shape: BrushShape;
  /** Diameter in blocks. */
  size: number;
  mode: BrushMode;
  targetY: number;
  amount: number;
  /** Stroke-time falloff. 0 stamps flat, 1 spreads the change into a slope. */
  slopeStrength: number;
  flow: number;
  /** Value written by the paint mode, meaning depends on the layer. */
  value: number;
  /** Height the flatten mode pulls toward, sampled when the stroke begins. */
  anchor?: number;
}

export const DEFAULT_BRUSH: BrushSettings = {
  shape: "circle",
  size: 64,
  mode: "paint",
  targetY: 100,
  amount: 8,
  slopeStrength: 0,
  flow: 0.35,
  value: 1,
};

/** One layer's grid of cells. */
export class Field {
  readonly spec: LayerSpec;
  readonly cols: number;
  readonly rows: number;
  values: TypedArray;
  palette: string[] = [];

  constructor(spec: LayerSpec, cols: number, rows: number) {
    this.spec = spec;
    this.cols = cols;
    this.rows = rows;
    const Ctor = ARRAY_FOR[spec.dtype] as unknown as new (n: number) => TypedArray;
    this.values = new Ctor(cols * rows);
    this.values.fill(spec.default);
  }

  index(cx: number, cy: number): number {
    return cy * this.cols + cx;
  }

  get(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return this.spec.default;
    return this.values[this.index(cx, cy)];
  }

  /** Decoded value, i.e. what the number actually means. */
  real(cx: number, cy: number): number {
    return this.get(cx, cy) * this.spec.scale + this.spec.offset;
  }

  isEmpty(): boolean {
    for (let i = 0; i < this.values.length; i++) if (this.values[i] !== this.spec.default) return false;
    return true;
  }
}

/** All layers of one project, plus the coordinate mapping. */
export class MapModel {
  readonly cols: number;
  readonly rows: number;
  readonly resolution: number;
  readonly widthBlocks: number;
  readonly heightBlocks: number;
  readonly origin: { x: number; z: number };
  readonly layers: Map<LayerId, Field> = new Map();
  biomePalette: string[] = ["<none>"];

  constructor(doc: ProjectDoc) {
    this.resolution = doc.map.resolution;
    this.widthBlocks = doc.map.width;
    this.heightBlocks = doc.map.height;
    this.origin = { ...doc.map.origin };
    this.cols = Math.max(1, Math.round(doc.map.width / doc.map.resolution));
    this.rows = Math.max(1, Math.round(doc.map.height / doc.map.resolution));
    for (const spec of LAYER_SPECS) this.layers.set(spec.id, new Field(spec, this.cols, this.rows));
  }

  layer(id: LayerId): Field {
    const found = this.layers.get(id);
    if (!found) throw new Error(`unknown layer ${id}`);
    return found;
  }

  /** Minecraft block coordinate of a cell centre. */
  cellToWorld(cx: number, cy: number): { x: number; z: number } {
    return {
      x: this.origin.x - this.widthBlocks / 2 + (cx + 0.5) * this.resolution,
      z: this.origin.z - this.heightBlocks / 2 + (cy + 0.5) * this.resolution,
    };
  }

  worldToCell(x: number, z: number): { cx: number; cy: number } {
    return {
      cx: Math.floor((x - this.origin.x + this.widthBlocks / 2) / this.resolution),
      cy: Math.floor((z - this.origin.z + this.heightBlocks / 2) / this.resolution),
    };
  }
}

// ------------------------------------------------------------------- brushes
function falloff(distance: number, radius: number, slopeStrength: number): number {
  if (radius <= 0) return 1;
  const t = Math.min(1, distance / radius);
  if (slopeStrength <= 0) return t <= 1 ? 1 : 0; // flat stamp, hard edge
  // smoothstep shoulder; slopeStrength picks how far in the slope starts
  const inner = 1 - slopeStrength;
  if (t <= inner) return 1;
  const u = (t - inner) / Math.max(1e-6, 1 - inner);
  return 1 - u * u * (3 - 2 * u);
}

export interface StrokeCell {
  index: number;
  before: number;
}

/**
 * Applies one brush dab and records what it overwrote.
 *
 * The falloff is applied here, while the terrain is being edited, not as a
 * later smoothing pass — so the slope is part of the edit itself.
 */
export function applyBrush(
  field: Field,
  map: MapModel,
  worldX: number,
  worldZ: number,
  brush: BrushSettings,
  touched: Map<number, number>,
): void {
  const centre = map.worldToCell(worldX, worldZ);
  if (brush.mode === "fill") {
    floodFill(field, centre.cx, centre.cy, brush, touched);
    return;
  }

  const radiusCells = Math.max(0.5, brush.size / 2 / map.resolution);
  const span = Math.ceil(radiusCells);

  // Smoothing has to read the terrain as it was before this dab, or the pass
  // would smear its own output across the brush.
  const snapshot = NEIGHBOURHOOD_MODES.has(brush.mode)
    ? snapshotAround(field, centre.cx, centre.cy, span + 1)
    : null;

  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      const cx = centre.cx + dx;
      const cy = centre.cy + dy;
      if (cx < 0 || cy < 0 || cx >= field.cols || cy >= field.rows) continue;

      const distance = shapeDistance(brush.shape, dx, dy);
      if (distance > radiusCells) continue;

      const weight = falloff(distance, radiusCells, brush.slopeStrength) * brush.flow;
      if (weight <= 0) continue;

      const index = field.index(cx, cy);
      const before = field.values[index];
      if (!touched.has(index)) touched.set(index, before);

      const neighbourhood = snapshot ? snapshot.mean(cx, cy) : before;
      field.values[index] = nextValue(field, before, weight, brush, index, neighbourhood);
    }
  }
}

/**
 * Distance from the brush centre in the brush's own metric: Euclidean for a
 * circle, Chebyshev for a square, Manhattan for a diamond.
 */
function shapeDistance(shape: BrushShape, dx: number, dy: number): number {
  if (shape === "circle") return Math.hypot(dx, dy);
  if (shape === "diamond") return Math.abs(dx) + Math.abs(dy);
  return Math.max(Math.abs(dx), Math.abs(dy));
}

interface Snapshot {
  mean(cx: number, cy: number): number;
}

/** A copy of the cells the dab can reach, plus one ring for the 3x3 average. */
function snapshotAround(field: Field, cx: number, cy: number, span: number): Snapshot {
  const x0 = Math.max(0, cx - span);
  const y0 = Math.max(0, cy - span);
  const x1 = Math.min(field.cols - 1, cx + span);
  const y1 = Math.min(field.rows - 1, cy + span);
  const width = x1 - x0 + 1;
  const height = y1 - y0 + 1;
  const cells = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      cells[y * width + x] = field.values[(y0 + y) * field.cols + (x0 + x)];
    }
  }
  const at = (px: number, py: number): number => {
    const qx = Math.min(x1, Math.max(x0, px));
    const qy = Math.min(y1, Math.max(y0, py));
    return cells[(qy - y0) * width + (qx - x0)];
  };
  return {
    mean(px: number, py: number): number {
      let sum = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) sum += at(px + ox, py + oy);
      return sum / 9;
    },
  };
}

/**
 * Replaces the contiguous run of cells holding the same value as the one under
 * the cursor. Bounded by the map, so it cannot escape the design surface.
 */
function floodFill(
  field: Field,
  seedX: number,
  seedY: number,
  brush: BrushSettings,
  touched: Map<number, number>,
): void {
  if (seedX < 0 || seedY < 0 || seedX >= field.cols || seedY >= field.rows) return;
  const seedIndex = field.index(seedX, seedY);
  const match = field.values[seedIndex];
  const replacement = fillValue(field, match, brush);
  if (replacement === match) return;

  const queue = new Int32Array(field.cols * field.rows);
  let head = 0;
  let tail = 0;
  queue[tail++] = seedIndex;
  touched.set(seedIndex, match);
  field.values[seedIndex] = replacement;

  while (head < tail) {
    const index = queue[head++];
    const x = index % field.cols;
    const y = (index - x) / field.cols;
    const visit = (nx: number, ny: number): void => {
      if (nx < 0 || ny < 0 || nx >= field.cols || ny >= field.rows) return;
      const next = ny * field.cols + nx;
      if (field.values[next] !== match) return;
      if (!touched.has(next)) touched.set(next, match);
      field.values[next] = replacement;
      queue[tail++] = next;
    };
    visit(x - 1, y);
    visit(x + 1, y);
    visit(x, y - 1);
    visit(x, y + 1);
  }
}

function fillValue(field: Field, match: number, brush: BrushSettings): number {
  if (field.spec.id === "feature") return match | brush.value;
  return brush.value;
}

/** Repeatable per-cell jitter, so re-running the noise brush is not a lottery. */
function cellNoise(index: number): number {
  let h = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * Storage limits per cell type. Assigning past them would wrap silently — an
 * Int16Array turns 40000 into a negative number — so values are clamped here
 * rather than left to the typed array.
 */
const STORE_RANGE: Record<Dtype, [number, number]> = {
  u8: [0, 255],
  i8: [-128, 127],
  u16: [0, 65535],
  i16: [-32768, 32767],
  u32: [0, 4294967295],
  f32: [-3.4e38, 3.4e38],
};

function nextValue(
  field: Field,
  before: number,
  weight: number,
  brush: BrushSettings,
  index: number,
  neighbourhood: number,
): number {
  const [low, high] = STORE_RANGE[field.spec.dtype];
  const clampStore = (value: number): number => {
    const rounded = field.spec.dtype === "f32" ? value : Math.round(value);
    return Math.min(high, Math.max(low, rounded));
  };
  /** Moves part of the way toward a target, scaled by the dab's weight. */
  const toward = (target: number): number => clampStore(before + (target - before) * Math.min(1, weight));

  switch (brush.mode) {
    case "paint":
      // a full-weight dab writes the value; a partial one blends toward it,
      // which matters for elevation and temperature but not for enums
      return field.spec.dtype === "u16" || field.spec.dtype === "u8" ? brush.value : toward(brush.value);
    case "erase":
      return field.spec.default;
    case "raise":
      return clampStore(before + brush.amount * weight);
    case "lower":
      return clampStore(before - brush.amount * weight);
    case "raise_to":
      return before >= brush.targetY ? before : clampStore(Math.min(brush.targetY, before + brush.amount * weight));
    case "lower_to":
      return before <= brush.targetY ? before : clampStore(Math.max(brush.targetY, before - brush.amount * weight));
    case "set":
      return toward(brush.targetY);
    case "smooth":
      return toward(neighbourhood);
    case "sharpen":
      // the mirror of smooth: push away from the local average
      return clampStore(before + (before - neighbourhood) * Math.min(1, weight));
    case "noise":
      return clampStore(before + (cellNoise(index) * 2 - 1) * brush.amount * weight);
    case "flatten":
      return toward(brush.anchor ?? before);
    case "terrace": {
      const step = Math.max(1, Math.abs(brush.amount));
      return toward(Math.round(before / step) * step);
    }
    case "add_flag":
      return clampStore(before | brush.value);
    case "remove_flag":
      return clampStore(before & ~brush.value);
    default:
      return before;
  }
}

// ------------------------------------------------------------------- history
export interface Stroke {
  layer: LayerId;
  cells: Uint32Array;
  before: Float64Array;
  after: Float64Array;
}

export class History {
  private undoStack: Stroke[] = [];
  private redoStack: Stroke[] = [];
  private limit = 200;

  push(stroke: Stroke): void {
    this.undoStack.push(stroke);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(map: MapModel): boolean {
    const stroke = this.undoStack.pop();
    if (!stroke) return false;
    const field = map.layer(stroke.layer);
    for (let i = 0; i < stroke.cells.length; i++) field.values[stroke.cells[i]] = stroke.before[i];
    this.redoStack.push(stroke);
    return true;
  }

  redo(map: MapModel): boolean {
    const stroke = this.redoStack.pop();
    if (!stroke) return false;
    const field = map.layer(stroke.layer);
    for (let i = 0; i < stroke.cells.length; i++) field.values[stroke.cells[i]] = stroke.after[i];
    this.undoStack.push(stroke);
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

/** Turns the touched-cell map collected during a stroke into an undo record. */
export function finishStroke(field: Field, layer: LayerId, touched: Map<number, number>): Stroke | null {
  if (touched.size === 0) return null;
  const cells = new Uint32Array(touched.size);
  const before = new Float64Array(touched.size);
  const after = new Float64Array(touched.size);
  let slot = 0;
  let changed = false;
  for (const [index, previous] of touched) {
    cells[slot] = index;
    before[slot] = previous;
    after[slot] = field.values[index];
    if (before[slot] !== after[slot]) changed = true;
    slot++;
  }
  return changed ? { layer, cells, before, after } : null;
}

// ------------------------------------------------------------------- codec IO
export async function layersToDoc(map: MapModel): Promise<Record<string, LayerDoc>> {
  const out: Record<string, LayerDoc> = {};
  for (const spec of LAYER_SPECS) {
    const field = map.layer(spec.id);
    if (field.isEmpty()) continue;
    out[spec.id] = await encodeLayer(field.values, {
      dtype: spec.dtype,
      default: spec.default,
      scale: spec.scale,
      offset: spec.offset,
      strength: spec.strength,
      ...(spec.id === "biome" ? { palette: map.biomePalette } : {}),
      ...(spec.id === "feature" ? { flags: [...FEATURE_FLAGS] } : {}),
    });
  }
  return out;
}

export async function layersFromDoc(map: MapModel, docs: Record<string, LayerDoc>): Promise<void> {
  for (const spec of LAYER_SPECS) {
    const doc = docs[spec.id];
    if (!doc) continue;
    const values = await decodeLayer(doc, map.cols * map.rows);
    const field = map.layer(spec.id);
    field.values.set(values as never);
    if (spec.id === "biome" && doc.palette) map.biomePalette = doc.palette;
  }
}
