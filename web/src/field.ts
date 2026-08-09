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

export type BrushShape = "circle" | "square";
export type BrushMode = "paint" | "erase" | "raise" | "lower" | "raise_to" | "lower_to" | "set";

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
  const radiusCells = Math.max(0.5, brush.size / 2 / map.resolution);
  const span = Math.ceil(radiusCells);

  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      const cx = centre.cx + dx;
      const cy = centre.cy + dy;
      if (cx < 0 || cy < 0 || cx >= field.cols || cy >= field.rows) continue;

      let distance: number;
      if (brush.shape === "circle") {
        distance = Math.hypot(dx, dy);
        if (distance > radiusCells) continue;
      } else {
        distance = Math.max(Math.abs(dx), Math.abs(dy));
        if (distance > radiusCells) continue;
      }

      const weight = falloff(distance, radiusCells, brush.slopeStrength) * brush.flow;
      if (weight <= 0) continue;

      const index = field.index(cx, cy);
      const before = field.values[index];
      if (!touched.has(index)) touched.set(index, before);

      field.values[index] = nextValue(field, before, weight, brush);
    }
  }
}

function nextValue(field: Field, before: number, weight: number, brush: BrushSettings): number {
  const clampStore = (value: number): number => {
    const rounded = field.spec.dtype === "f32" ? value : Math.round(value);
    // let the typed array do the range clamping for us
    field.values[0] === undefined; // no-op, keeps the intent obvious
    return rounded;
  };

  switch (brush.mode) {
    case "paint":
      // a full-weight dab writes the value; a partial one blends toward it,
      // which matters for elevation and temperature but not for enums
      return field.spec.dtype === "u16" || field.spec.dtype === "u8"
        ? brush.value
        : clampStore(before + (brush.value - before) * weight);
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
      return clampStore(before + (brush.targetY - before) * weight);
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
