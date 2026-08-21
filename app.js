// src/project.ts
var EDITOR_VERSION = "0.1.0";
var ARRAY_FOR = {
  u8: Uint8Array,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  f32: Float32Array
};
function toBase64(bytes) {
  let binary = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
async function deflate(bytes) {
  if (typeof CompressionStream === "undefined") return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function inflate(bytes) {
  if (typeof DecompressionStream === "undefined") return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function encodeSparse(values, fallback) {
  const indices = [];
  for (let i = 0; i < values.length; i++) if (values[i] !== fallback) indices.push(i);
  const out = new Uint32Array(1 + indices.length * 2);
  out[0] = indices.length;
  indices.forEach((index, slot) => {
    out[1 + slot * 2] = index;
    out[2 + slot * 2] = values[index];
  });
  return new Uint8Array(out.buffer);
}
function decodeSparse(bytes, target, fallback) {
  target.fill(fallback);
  const view = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
  const count = view[0];
  for (let slot = 0; slot < count; slot++) {
    target[view[1 + slot * 2]] = view[2 + slot * 2];
  }
}
async function encodeLayer(values, spec) {
  const fallback = spec.default ?? 0;
  let encoding = spec.encoding ?? "deflate";
  if (encoding === "deflate") {
    let painted = 0;
    for (let i = 0; i < values.length; i++) if (values[i] !== fallback) painted++;
    if (painted < values.length * 0.08) encoding = "sparse";
  }
  const raw = encoding === "sparse" ? encodeSparse(values, fallback) : new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  const payload = encoding === "raw" ? raw : await deflate(raw);
  return { ...spec, encoding, data: toBase64(payload) };
}
async function decodeLayer(doc, cells) {
  const Ctor = ARRAY_FOR[doc.dtype];
  const target = new Ctor(cells);
  let bytes = fromBase64(doc.data);
  if (doc.encoding !== "raw") bytes = await inflate(bytes);
  if (doc.encoding === "sparse") {
    decodeSparse(bytes, target, doc.default ?? 0);
    return target;
  }
  const usable = Math.min(cells, Math.floor(bytes.byteLength / target.BYTES_PER_ELEMENT));
  const view = new DataView(bytes.buffer, bytes.byteOffset, usable * target.BYTES_PER_ELEMENT);
  for (let i = 0; i < usable; i++) target[i] = readElement(view, i, doc.dtype);
  return target;
}
function readElement(view, index, dtype) {
  switch (dtype) {
    case "u8":
      return view.getUint8(index);
    case "i8":
      return view.getInt8(index);
    case "u16":
      return view.getUint16(index * 2, true);
    case "i16":
      return view.getInt16(index * 2, true);
    case "u32":
      return view.getUint32(index * 4, true);
    case "f32":
      return view.getFloat32(index * 4, true);
  }
}
function defaultGenerator() {
  return {
    continents: {
      land_ratio: 0.32,
      width: 6e3,
      height: 6e3,
      width_variation_percent: 30,
      height_variation_percent: 30,
      erosion_scale: 1,
      ridge_scale: 1,
      flat_terrain_skew: 0.1,
      mountain_ranges: 1,
      plateaus: 1,
      tepui: 0.6,
      rolling_hills: true
    },
    center: { type: "default", radius: 2500, strength: 1 },
    rivers: { enabled: true, width: 1, depth_blocks: 10 },
    inland_seas: { enabled: true, frequency: 0.35, size: 3e3, depth_blocks: 26 },
    fjords: { enabled: true, frequency: 0.6, width: 1, depth_blocks: 24 },
    islands: {
      enabled: true,
      size: 700,
      frequency: 1,
      clustering: 0.5,
      arc_strength: 0.6,
      noise_offset: 0.05,
      atoll_chance: 0.18,
      volcanic_chance: 0.2,
      cliff_chance: 0.22
    },
    oceans: {
      ocean_depth_blocks: 28,
      deep_ocean_depth_blocks: 58,
      seafloor_relief: 1,
      trenches: true,
      trench_depth_blocks: 34
    },
    coast: { cliffs: 0.6, sea_stacks: 0.5, columnar_jointing: 0.5 },
    biomes: {
      scale_with_continents: true,
      temperature_scale: 1,
      temperature_offset: 0,
      temperature_multiplier: 1,
      vegetation_scale: 1,
      vegetation_offset: 0,
      vegetation_multiplier: 1
    },
    caves: { scale_with_continents: true, size_multiplier: 1, carvers_enabled: true },
    structures: { scale_with_continents: true, spacing_multiplier: 1 },
    spawn: { force_land_spawn: true }
  };
}
function emptyProject(width = 2e3, height = 2e3, resolution = 4) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return {
    format: 1,
    meta: { name: "Untitled world", created: now, modified: now, editor_version: EDITOR_VERSION },
    world: {
      seed: 0,
      sea_level: 63,
      build_min_y: -64,
      build_height: 384,
      terrain_max_y: 312,
      terrain_min_y: -40,
      vertical_scale: 1,
      height_limit: true
    },
    map: {
      width,
      height,
      origin: { x: 0, z: 0 },
      resolution,
      edge_mode: "falloff",
      edge_falloff: 256,
      layers: {}
    },
    generator: defaultGenerator(),
    export: { mode: "procedural", namespace: "mwg", pack_name: "MyWorld", field_precision: 8 }
  };
}

// src/field.ts
var LAYER_SPECS = [
  { id: "land", dtype: "u8", default: 0, scale: 1, offset: 0, strength: 1 },
  { id: "elevation", dtype: "i16", default: 63, scale: 1, offset: 0, strength: 1 },
  // temperature is stored as hundredths so it fits an i16 without losing detail
  { id: "temperature", dtype: "i16", default: 0, scale: 0.01, offset: 0, strength: 0.6 },
  { id: "biome", dtype: "u16", default: 0, scale: 1, offset: 0, strength: 1 },
  { id: "feature", dtype: "u32", default: 0, scale: 1, offset: 0, strength: 1 }
];
var FEATURE_FLAGS = [
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
  "coral_reef"
];
var BRUSH_MODES = {
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
    "erase"
  ],
  temperature: ["paint", "smooth", "noise", "erase"],
  biome: ["paint", "fill", "erase"],
  feature: ["add_flag", "remove_flag", "fill", "erase"]
};
var NEIGHBOURHOOD_MODES = /* @__PURE__ */ new Set(["smooth", "sharpen"]);
var DEFAULT_BRUSH = {
  shape: "circle",
  size: 64,
  mode: "paint",
  targetY: 100,
  amount: 8,
  slopeStrength: 0,
  flow: 0.35,
  value: 1
};
var Field = class {
  spec;
  cols;
  rows;
  values;
  palette = [];
  constructor(spec, cols, rows) {
    this.spec = spec;
    this.cols = cols;
    this.rows = rows;
    const Ctor = ARRAY_FOR[spec.dtype];
    this.values = new Ctor(cols * rows);
    this.values.fill(spec.default);
  }
  index(cx, cy) {
    return cy * this.cols + cx;
  }
  get(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return this.spec.default;
    return this.values[this.index(cx, cy)];
  }
  /** Decoded value, i.e. what the number actually means. */
  real(cx, cy) {
    return this.get(cx, cy) * this.spec.scale + this.spec.offset;
  }
  isEmpty() {
    for (let i = 0; i < this.values.length; i++) if (this.values[i] !== this.spec.default) return false;
    return true;
  }
};
var MapModel = class _MapModel {
  cols;
  rows;
  resolution;
  widthBlocks;
  heightBlocks;
  origin;
  layers = /* @__PURE__ */ new Map();
  biomePalette = ["<none>"];
  constructor(doc) {
    this.resolution = doc.map.resolution;
    this.widthBlocks = doc.map.width;
    this.heightBlocks = doc.map.height;
    this.origin = { ...doc.map.origin };
    this.cols = Math.max(1, Math.round(doc.map.width / doc.map.resolution));
    this.rows = Math.max(1, Math.round(doc.map.height / doc.map.resolution));
    for (const spec of LAYER_SPECS) this.layers.set(spec.id, new Field(spec, this.cols, this.rows));
  }
  layer(id) {
    const found = this.layers.get(id);
    if (!found) throw new Error(`unknown layer ${id}`);
    return found;
  }
  /** Minecraft block coordinate of a cell centre. */
  cellToWorld(cx, cy) {
    return {
      x: this.origin.x - this.widthBlocks / 2 + (cx + 0.5) * this.resolution,
      z: this.origin.z - this.heightBlocks / 2 + (cy + 0.5) * this.resolution
    };
  }
  worldToCell(x, z) {
    return {
      cx: Math.floor((x - this.origin.x + this.widthBlocks / 2) / this.resolution),
      cy: Math.floor((z - this.origin.z + this.heightBlocks / 2) / this.resolution)
    };
  }
  /**
   * A copy of this map at a new size, keeping what was drawn.
   *
   * Cells are matched by world coordinate rather than by index, so the drawing
   * stays where it is on the ground: growing the map reveals more default
   * ground around it, shrinking it crops, and changing the resolution
   * resamples. Anything outside the new bounds is dropped, which is what
   * cropping means.
   */
  resized(doc) {
    const next = new _MapModel(doc);
    for (const spec of LAYER_SPECS) {
      const from = this.layer(spec.id);
      const to = next.layer(spec.id);
      for (let cy = 0; cy < next.rows; cy++) {
        for (let cx = 0; cx < next.cols; cx++) {
          const { x, z } = next.cellToWorld(cx, cy);
          const source = this.worldToCell(x, z);
          if (source.cx < 0 || source.cy < 0 || source.cx >= this.cols || source.cy >= this.rows) continue;
          to.values[cy * next.cols + cx] = from.values[source.cy * this.cols + source.cx];
        }
      }
    }
    next.biomePalette = [...this.biomePalette];
    return next;
  }
};
function falloff(distance, radius, slopeStrength) {
  if (radius <= 0) return 1;
  const t2 = Math.min(1, distance / radius);
  if (slopeStrength <= 0) return t2 <= 1 ? 1 : 0;
  const inner = 1 - slopeStrength;
  if (t2 <= inner) return 1;
  const u = (t2 - inner) / Math.max(1e-6, 1 - inner);
  return 1 - u * u * (3 - 2 * u);
}
function applyBrush(field, map, worldX, worldZ, brush, touched2) {
  const centre = map.worldToCell(worldX, worldZ);
  if (brush.mode === "fill") {
    floodFill(field, centre.cx, centre.cy, brush, touched2);
    return;
  }
  const radiusCells = Math.max(0.5, brush.size / 2 / map.resolution);
  const span = Math.ceil(radiusCells);
  const snapshot = NEIGHBOURHOOD_MODES.has(brush.mode) ? snapshotAround(field, centre.cx, centre.cy, span + 1) : null;
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
      if (!touched2.has(index)) touched2.set(index, before);
      const neighbourhood = snapshot ? snapshot.mean(cx, cy) : before;
      field.values[index] = nextValue(field, before, weight, brush, index, neighbourhood);
    }
  }
}
function shapeDistance(shape, dx, dy) {
  if (shape === "circle") return Math.hypot(dx, dy);
  if (shape === "diamond") return Math.abs(dx) + Math.abs(dy);
  return Math.max(Math.abs(dx), Math.abs(dy));
}
function snapshotAround(field, cx, cy, span) {
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
  const at = (px, py) => {
    const qx = Math.min(x1, Math.max(x0, px));
    const qy = Math.min(y1, Math.max(y0, py));
    return cells[(qy - y0) * width + (qx - x0)];
  };
  return {
    mean(px, py) {
      let sum = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) sum += at(px + ox, py + oy);
      return sum / 9;
    }
  };
}
function floodFill(field, seedX, seedY, brush, touched2) {
  if (seedX < 0 || seedY < 0 || seedX >= field.cols || seedY >= field.rows) return;
  const seedIndex = field.index(seedX, seedY);
  const match = field.values[seedIndex];
  const replacement = fillValue(field, match, brush);
  if (replacement === match) return;
  const queue = new Int32Array(field.cols * field.rows);
  let head = 0;
  let tail = 0;
  queue[tail++] = seedIndex;
  touched2.set(seedIndex, match);
  field.values[seedIndex] = replacement;
  while (head < tail) {
    const index = queue[head++];
    const x = index % field.cols;
    const y = (index - x) / field.cols;
    const visit = (nx, ny) => {
      if (nx < 0 || ny < 0 || nx >= field.cols || ny >= field.rows) return;
      const next = ny * field.cols + nx;
      if (field.values[next] !== match) return;
      if (!touched2.has(next)) touched2.set(next, match);
      field.values[next] = replacement;
      queue[tail++] = next;
    };
    visit(x - 1, y);
    visit(x + 1, y);
    visit(x, y - 1);
    visit(x, y + 1);
  }
}
function fillValue(field, match, brush) {
  if (field.spec.id === "feature") return match | brush.value;
  return brush.value;
}
function cellNoise(index) {
  let h = Math.imul(index ^ 2654435769, 2246822507) >>> 0;
  h = Math.imul(h ^ h >>> 13, 3266489909) >>> 0;
  return ((h ^ h >>> 16) >>> 0) / 4294967295;
}
var STORE_RANGE = {
  u8: [0, 255],
  i8: [-128, 127],
  u16: [0, 65535],
  i16: [-32768, 32767],
  u32: [0, 4294967295],
  f32: [-34e37, 34e37]
};
function nextValue(field, before, weight, brush, index, neighbourhood) {
  const [low, high] = STORE_RANGE[field.spec.dtype];
  const clampStore = (value) => {
    const rounded = field.spec.dtype === "f32" ? value : Math.round(value);
    return Math.min(high, Math.max(low, rounded));
  };
  const toward = (target) => clampStore(before + (target - before) * Math.min(1, weight));
  switch (brush.mode) {
    case "paint":
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
var History = class {
  undoStack = [];
  redoStack = [];
  limit = 200;
  push(stroke) {
    this.undoStack.push(stroke);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  canUndo() {
    return this.undoStack.length > 0;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }
  undo(map) {
    const stroke = this.undoStack.pop();
    if (!stroke) return false;
    const field = map.layer(stroke.layer);
    for (let i = 0; i < stroke.cells.length; i++) field.values[stroke.cells[i]] = stroke.before[i];
    this.redoStack.push(stroke);
    return true;
  }
  redo(map) {
    const stroke = this.redoStack.pop();
    if (!stroke) return false;
    const field = map.layer(stroke.layer);
    for (let i = 0; i < stroke.cells.length; i++) field.values[stroke.cells[i]] = stroke.after[i];
    this.undoStack.push(stroke);
    return true;
  }
  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
};
function finishStroke(field, layer, touched2) {
  if (touched2.size === 0) return null;
  const cells = new Uint32Array(touched2.size);
  const before = new Float64Array(touched2.size);
  const after = new Float64Array(touched2.size);
  let slot = 0;
  let changed = false;
  for (const [index, previous] of touched2) {
    cells[slot] = index;
    before[slot] = previous;
    after[slot] = field.values[index];
    if (before[slot] !== after[slot]) changed = true;
    slot++;
  }
  return changed ? { layer, cells, before, after } : null;
}
async function layersToDoc(map) {
  const out = {};
  for (const spec of LAYER_SPECS) {
    const field = map.layer(spec.id);
    if (field.isEmpty()) continue;
    out[spec.id] = await encodeLayer(field.values, {
      dtype: spec.dtype,
      default: spec.default,
      scale: spec.scale,
      offset: spec.offset,
      strength: spec.strength,
      ...spec.id === "biome" ? { palette: map.biomePalette } : {},
      ...spec.id === "feature" ? { flags: [...FEATURE_FLAGS] } : {}
    });
  }
  return out;
}
async function layersFromDoc(map, docs) {
  for (const spec of LAYER_SPECS) {
    const doc = docs[spec.id];
    if (!doc) continue;
    const values = await decodeLayer(doc, map.cols * map.rows);
    const field = map.layer(spec.id);
    field.values.set(values);
    if (spec.id === "biome" && doc.palette) map.biomePalette = doc.palette;
  }
}

// src/compile.ts
function findBlobs(land, cols, rows) {
  const seen = new Uint8Array(cols * rows);
  const blobs = [];
  const queue = new Int32Array(cols * rows);
  for (let start = 0; start < land.length; start++) {
    if (seen[start] || land[start] === 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    const blob = {
      cells: 0,
      minX: cols,
      maxX: -1,
      minY: rows,
      maxY: -1,
      touchesEdge: false
    };
    while (head < tail) {
      const index = queue[head++];
      const x = index % cols;
      const y = (index - x) / cols;
      blob.cells++;
      if (x < blob.minX) blob.minX = x;
      if (x > blob.maxX) blob.maxX = x;
      if (y < blob.minY) blob.minY = y;
      if (y > blob.maxY) blob.maxY = y;
      if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) blob.touchesEdge = true;
      if (x > 0 && !seen[index - 1] && land[index - 1]) seen[index - 1] = 1, queue[tail++] = index - 1;
      if (x < cols - 1 && !seen[index + 1] && land[index + 1]) seen[index + 1] = 1, queue[tail++] = index + 1;
      if (y > 0 && !seen[index - cols] && land[index - cols]) seen[index - cols] = 1, queue[tail++] = index - cols;
      if (y < rows - 1 && !seen[index + cols] && land[index + cols]) seen[index + cols] = 1, queue[tail++] = index + cols;
    }
    blobs.push(blob);
  }
  return blobs;
}
function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
function coefficientOfVariation(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  if (m === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) / m;
}
function analyseMap(map, doc) {
  const notes = [];
  const res = map.resolution;
  const land = map.layer("land").values;
  const elevation = map.layer("elevation");
  const temperature = map.layer("temperature");
  const feature = map.layer("feature").values;
  const total = map.cols * map.rows;
  let landCells = 0;
  for (let i = 0; i < total; i++) if (land[i]) landCells++;
  const landRatio = landCells / total;
  const blobs = findBlobs(land, map.cols, map.rows).filter((b) => b.cells >= 2);
  const usable = blobs.filter((b) => !b.touchesEdge);
  if (blobs.length && !usable.length) {
    notes.push("note.clippedLandmasses");
  }
  const pool = usable.length ? usable : blobs;
  const areas = pool.map((b) => b.cells).sort((a, b) => a - b);
  const median = areas.length ? areas[Math.floor(areas.length / 2)] : 0;
  const continentCut = Math.max(median * 3, 16);
  const continents = pool.filter((b) => b.cells >= continentCut);
  const islands = pool.filter((b) => b.cells < continentCut);
  const widths = continents.map((b) => (b.maxX - b.minX + 1) * res);
  const heights = continents.map((b) => (b.maxY - b.minY + 1) * res);
  const islandSizes = islands.map((b) => Math.max(b.maxX - b.minX + 1, b.maxY - b.minY + 1) * res);
  const largest = pool.reduce((best, b) => !best || b.cells > best.cells ? b : best, null);
  const fallbackWidth = largest ? (largest.maxX - largest.minX + 1) * res : 6e3;
  const fallbackHeight = largest ? (largest.maxY - largest.minY + 1) * res : 6e3;
  if (!widths.length && largest) notes.push("note.noContinents");
  let clustering = 0.5;
  if (islands.length >= 3) {
    const centres = islands.map((b) => ({
      x: (b.minX + b.maxX) / 2 * res,
      y: (b.minY + b.maxY) / 2 * res
    }));
    const nearest = centres.map((a, i) => {
      let best = Infinity;
      centres.forEach((b, j) => {
        if (i === j) return;
        best = Math.min(best, Math.hypot(a.x - b.x, a.y - b.y));
      });
      return best;
    });
    const observed = mean(nearest);
    const expected = 0.5 * Math.sqrt(map.widthBlocks * map.heightBlocks / islands.length);
    clustering = Math.max(0, Math.min(1, 1 - observed / Math.max(1, expected)));
  }
  const seaLevel = doc.world.sea_level;
  let landHeightSum = 0;
  let landHeightCount = 0;
  let maxLandHeight = -Infinity;
  let minLandHeight = Infinity;
  let oceanDepthSum = 0;
  let oceanDepthCount = 0;
  let maxOceanDepth = -Infinity;
  let tempSum = 0;
  for (let i = 0; i < total; i++) {
    const y = elevation.values[i] * elevation.spec.scale + elevation.spec.offset;
    if (land[i]) {
      landHeightSum += y;
      landHeightCount++;
      if (y < minLandHeight) minLandHeight = y;
      if (y > maxLandHeight) maxLandHeight = y;
    } else {
      const depth = seaLevel - y;
      oceanDepthSum += depth;
      oceanDepthCount++;
      if (depth > maxOceanDepth) maxOceanDepth = depth;
    }
    tempSum += temperature.values[i] * temperature.spec.scale;
  }
  const featureShare = {};
  FEATURE_FLAGS.forEach((flag, bit) => {
    let count = 0;
    for (let i = 0; i < total; i++) if (feature[i] & 1 << bit) count++;
    if (count) featureShare[flag] = count / total;
  });
  const probeRadius = Math.min(map.widthBlocks, map.heightBlocks) * 0.2;
  const centre = map.worldToCell(doc.map.origin.x, doc.map.origin.z);
  const probeCells = Math.max(1, Math.round(probeRadius / res));
  let probeLand = 0;
  let probeTotal = 0;
  for (let dy = -probeCells; dy <= probeCells; dy++) {
    for (let dx = -probeCells; dx <= probeCells; dx++) {
      if (Math.hypot(dx, dy) > probeCells) continue;
      const cx = centre.cx + dx;
      const cy = centre.cy + dy;
      if (cx < 0 || cy < 0 || cx >= map.cols || cy >= map.rows) continue;
      probeTotal++;
      if (land[cy * map.cols + cx]) probeLand++;
    }
  }
  const probeRatio = probeTotal ? probeLand / probeTotal : 0;
  const centreBlobs = continents.filter(
    (b) => centre.cx >= b.minX && centre.cx <= b.maxX && centre.cy >= b.minY && centre.cy <= b.maxY
  );
  let centerType = "default";
  if (probeTotal === 0) centerType = "default";
  else if (probeRatio < 0.06) centerType = "ocean";
  else if (centreBlobs.length) centerType = "continent";
  else if (islands.filter((b) => Math.hypot(((b.minX + b.maxX) / 2 - centre.cx) * res, ((b.minY + b.maxY) / 2 - centre.cy) * res) < probeRadius).length >= 3)
    centerType = "archipelago";
  else if (probeRatio > 0.12) centerType = "island";
  if (landCells === 0) notes.push("note.allOcean");
  return {
    landRatio,
    landmassCount: pool.length,
    continentWidth: widths.length ? mean(widths) : fallbackWidth,
    continentHeight: heights.length ? mean(heights) : fallbackHeight,
    widthVariationPercent: Math.round(coefficientOfVariation(widths) * 100),
    heightVariationPercent: Math.round(coefficientOfVariation(heights) * 100),
    islandCount: islands.length,
    islandSize: islandSizes.length ? mean(islandSizes) : 700,
    islandClustering: clustering,
    archipelagoStrength: Math.min(1, islands.length / Math.max(1, pool.length)),
    meanLandElevation: landHeightCount ? landHeightSum / landHeightCount : seaLevel + 20,
    maxLandElevation: landHeightCount ? maxLandHeight : seaLevel + 100,
    minLandElevation: landHeightCount ? minLandHeight : seaLevel,
    meanOceanDepth: oceanDepthCount ? Math.max(0, oceanDepthSum / oceanDepthCount) : 28,
    maxOceanDepth: oceanDepthCount ? Math.max(0, maxOceanDepth) : 58,
    meanTemperature: total ? tempSum / total : 0,
    centerType,
    centerRadius: Math.max(200, Math.round(probeRadius)),
    featureShare,
    notes
  };
}
var TERRAIN_HEADROOM = 64;
var WORLD_FLOOR = -64;
var HEIGHT_LIMIT_TERRAIN_MAX = 448;
var HEIGHT_LIMIT_BUILD_MAX = HEIGHT_LIMIT_TERRAIN_MAX + TERRAIN_HEADROOM;
function up16(value) {
  return Math.ceil(value / 16) * 16;
}
function analysisToWorld(analysis, world) {
  const limited = world.height_limit !== false;
  const wanted = Math.round(analysis.maxLandElevation) + TERRAIN_HEADROOM;
  const maxY = limited ? Math.min(wanted, HEIGHT_LIMIT_TERRAIN_MAX) : wanted;
  const drawnFloor = Math.min(
    world.sea_level - Math.max(analysis.maxOceanDepth, 16),
    analysis.minLandElevation
  );
  const floor = Math.round(drawnFloor) - 16;
  const buildMinY = WORLD_FLOOR;
  const ceiling = limited ? HEIGHT_LIMIT_BUILD_MAX : 4064 + buildMinY;
  const buildHeight = Math.min(
    ceiling - buildMinY,
    Math.max(16, up16(maxY + 16 - buildMinY))
  );
  const top = buildMinY + buildHeight;
  return {
    terrain_max_y: Math.min(top - 16, maxY),
    // 16 clear of the world floor, so the surface never arrives in the bedrock
    terrain_min_y: Math.max(buildMinY + 16, Math.min(floor, maxY - 16)),
    build_min_y: buildMinY,
    build_height: buildHeight
  };
}
function analysisToGenerator(analysis, base) {
  const out = structuredClone(base);
  const share = (flag) => analysis.featureShare[flag] ?? 0;
  out.continents = {
    ...out.continents,
    land_ratio: Number(analysis.landRatio.toFixed(3)),
    width: Math.round(analysis.continentWidth),
    height: Math.round(analysis.continentHeight),
    width_variation_percent: analysis.widthVariationPercent,
    height_variation_percent: analysis.heightVariationPercent,
    mountain_ranges: share("mountain_range") > 0 ? Math.min(2, 0.8 + share("mountain_range") * 8) : out.continents.mountain_ranges,
    plateaus: share("plateau") > 0 ? Math.min(2, 0.8 + share("plateau") * 8) : out.continents.plateaus,
    tepui: share("tepui") > 0 ? Math.min(2, 0.5 + share("tepui") * 10) : out.continents.tepui
  };
  out.islands = {
    ...out.islands,
    enabled: analysis.islandCount > 0,
    size: Math.round(analysis.islandSize),
    clustering: Number(analysis.islandClustering.toFixed(2)),
    arc_strength: share("island_arc") > 0 ? Math.min(2, 0.4 + share("island_arc") * 12) : out.islands.arc_strength,
    atoll_chance: share("atoll") > 0 ? Math.min(0.6, share("atoll") * 10) : out.islands.atoll_chance,
    volcanic_chance: share("volcano") > 0 ? Math.min(0.6, share("volcano") * 10) : out.islands.volcanic_chance
  };
  out.oceans = {
    ...out.oceans,
    ocean_depth_blocks: Math.round(analysis.meanOceanDepth),
    deep_ocean_depth_blocks: Math.round(Math.max(analysis.meanOceanDepth + 8, analysis.maxOceanDepth))
  };
  out.center = {
    ...out.center,
    type: analysis.centerType,
    radius: analysis.centerRadius
  };
  out.fjords = { ...out.fjords, enabled: share("fjord") > 0 || out.fjords.enabled };
  out.inland_seas = { ...out.inland_seas, enabled: share("inland_sea") > 0 || out.inland_seas.enabled };
  out.coast = {
    ...out.coast,
    sea_stacks: share("sea_stack") > 0 ? Math.min(2, 0.4 + share("sea_stack") * 15) : out.coast.sea_stacks,
    columnar_jointing: share("columnar_jointing") > 0 ? Math.min(2, 0.4 + share("columnar_jointing") * 15) : out.coast.columnar_jointing
  };
  out.biomes = {
    ...out.biomes,
    temperature_offset: Math.max(-1, Math.min(1, Number(analysis.meanTemperature.toFixed(2))))
  };
  return out;
}
function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 1274126177;
  h = (h ^ h >>> 13) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ h >>> 16) >>> 0) / 4294967295;
}
function valueNoise(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 2 - 1;
}
function fbm(x, y, seed, octaves) {
  let sum = 0;
  let amplitude = 1;
  let norm = 0;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * frequency, y * frequency, seed + i * 7919) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / norm;
}
function quantile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((1 - fraction) * (sorted.length - 1))));
  return sorted[index];
}
function previewHeights(generator, options) {
  const cont = generator.continents ?? {};
  const oceans = generator.oceans ?? {};
  const islands = generator.islands ?? {};
  const width = Number(cont.width) || 6e3;
  const height = Number(cont.height) || 6e3;
  const landRatio = Math.min(0.95, Math.max(0.02, Number(cont.land_ratio) || 0.32));
  const mountains = Number(cont.mountain_ranges ?? 1);
  const oceanDepth = Number(oceans.ocean_depth_blocks ?? 28);
  const deepDepth = Number(oceans.deep_ocean_depth_blocks ?? 58);
  const islandSize = Math.max(80, Number(islands.size ?? 700));
  const islandFrequency = Math.max(0, Number(islands.frequency ?? 1));
  const islandsOn = islands.enabled !== false && islandFrequency > 0;
  const size = options.size;
  const cells = size * size;
  const step = options.spanBlocks / size;
  const sea = options.seaLevel;
  const shaped = new Float32Array(cells);
  const islandField = new Float32Array(islandsOn ? cells : 0);
  for (let iy = 0; iy < size; iy++) {
    const worldZ = (iy - size / 2) * step;
    for (let ix = 0; ix < size; ix++) {
      const worldX = (ix - size / 2) * step;
      const continent = fbm(worldX / width, worldZ / height, options.seed, 4);
      shaped[iy * size + ix] = Math.abs(continent) * 2 - 1;
      if (islandsOn) {
        islandField[iy * size + ix] = fbm(worldX / islandSize, worldZ / islandSize, options.seed + 4242, 3);
      }
    }
  }
  const islandCover = islandsOn ? Math.min(landRatio * 0.5, 0.03 * islandFrequency) : 0;
  const continentShare = Math.max(2e-3, landRatio - islandCover);
  const threshold = quantile(shaped, continentShare);
  const spread = Math.max(1e-3, quantile(shaped, continentShare * 0.25) - threshold);
  const deepAt = (index) => Math.min(1, -(shaped[index] - threshold) / Math.max(1e-3, threshold + 1));
  let continentCells = 0;
  const candidates = [];
  for (let i = 0; i < cells; i++) {
    if (shaped[i] - threshold > 0) continentCells++;
    else if (islandsOn && deepAt(i) > 0.3) candidates.push(islandField[i]);
  }
  const budget = Math.round(landRatio * cells) - continentCells;
  let islandCut = Infinity;
  let islandSpread = 1;
  if (islandsOn && budget > 0 && candidates.length > 0) {
    const pool = Float32Array.from(candidates);
    islandCut = quantile(pool, Math.min(1, budget / pool.length));
    islandSpread = Math.max(1e-3, quantile(pool, Math.min(1, budget / pool.length) * 0.3) - islandCut);
  }
  const out = new Float32Array(cells);
  for (let iy = 0; iy < size; iy++) {
    const worldZ = (iy - size / 2) * step;
    for (let ix = 0; ix < size; ix++) {
      const worldX = (ix - size / 2) * step;
      const index = iy * size + ix;
      const inland = shaped[index] - threshold;
      let y;
      if (inland > 0) {
        const erosion = fbm(worldX / (width * 0.35), worldZ / (height * 0.35), options.seed + 5150, 3);
        const ridge = 1 - Math.abs(fbm(worldX / (width * 0.5), worldZ / (height * 0.5), options.seed + 8675, 2));
        const relief = (0.25 + 0.75 * Math.max(0, -erosion)) * mountains * ridge;
        const inshore = Math.min(1, inland / spread);
        y = sea + 4 + inshore * (18 + relief * 150);
      } else {
        const deep = deepAt(index);
        y = sea - (oceanDepth + (deepDepth - oceanDepth) * deep);
        if (islandsOn && deep > 0.3 && islandField[index] > islandCut) {
          y = sea + 3 + Math.min(1, (islandField[index] - islandCut) / islandSpread) * 90;
        }
      }
      out[index] = y;
    }
  }
  return out;
}

// src/palette.ts
var LAND_COLOUR = [176, 178, 172];
var OCEAN_COLOUR = [66, 84, 104];
var OUTSIDE_COLOUR = [30, 33, 38];
var NEUTRAL_COLOUR = [52, 56, 62];
var FEATURE_COLOURS = {
  volcano: [214, 74, 48],
  // basalt and lava
  atoll: [86, 214, 196],
  // lagoon turquoise
  fjord: [64, 122, 200],
  // deep cold inlet
  island_arc: [236, 158, 62],
  // volcanic chain
  mountain_range: [150, 128, 176],
  // rock violet
  plateau: [198, 154, 96],
  // dry tableland
  tepui: [232, 108, 168],
  // steep-sided mesa
  sea_stack: [176, 196, 216],
  // pale wet rock
  columnar_jointing: [122, 148, 160],
  // basalt columns
  inland_sea: [56, 154, 186],
  // enclosed water
  river: [92, 178, 232],
  // running water
  coral_reef: [244, 132, 176]
  // reef pink
};
function fallbackFeatureColour(flag) {
  let h = 0;
  for (let i = 0; i < flag.length; i++) h = Math.imul(h, 31) + flag.charCodeAt(i) | 0;
  const u = (h >>> 0) / 4294967295;
  return [Math.round(120 + 110 * u), Math.round(150 - 60 * u), Math.round(190 - 40 * u)];
}
function featureColour(flag) {
  return FEATURE_COLOURS[flag] ?? fallbackFeatureColour(flag);
}
function blendFeatureColours(flags) {
  if (flags.length === 1) return featureColour(flags[0]);
  let r = 0;
  let g = 0;
  let b = 0;
  for (const flag of flags) {
    const c = featureColour(flag);
    r += c[0];
    g += c[1];
    b += c[2];
  }
  return [r / flags.length, g / flags.length, b / flags.length];
}
var BIOME_COLOURS = {
  // oceans, shallow to deep, warm to frozen
  warm_ocean: [58, 130, 200],
  lukewarm_ocean: [52, 116, 190],
  ocean: [46, 100, 178],
  cold_ocean: [50, 92, 160],
  frozen_ocean: [130, 158, 186],
  deep_lukewarm_ocean: [36, 88, 158],
  deep_ocean: [28, 72, 142],
  deep_cold_ocean: [30, 64, 124],
  deep_frozen_ocean: [96, 124, 156],
  river: [66, 132, 208],
  frozen_river: [148, 186, 214],
  // temperate greens
  plains: [142, 186, 100],
  sunflower_plains: [176, 200, 92],
  meadow: [134, 190, 128],
  forest: [78, 140, 70],
  flower_forest: [126, 168, 96],
  birch_forest: [130, 168, 118],
  old_growth_birch_forest: [116, 154, 106],
  dark_forest: [48, 92, 48],
  pale_garden: [156, 168, 150],
  windswept_forest: [96, 134, 96],
  windswept_hills: [118, 138, 118],
  windswept_gravelly_hills: [140, 146, 138],
  cherry_grove: [232, 168, 196],
  // taiga and cold
  taiga: [58, 110, 96],
  snowy_taiga: [150, 176, 176],
  old_growth_pine_taiga: [64, 102, 78],
  old_growth_spruce_taiga: [56, 94, 72],
  grove: [148, 172, 160],
  snowy_plains: [226, 234, 240],
  ice_spikes: [200, 226, 240],
  snowy_slopes: [214, 226, 236],
  frozen_peaks: [196, 216, 234],
  jagged_peaks: [232, 238, 244],
  stony_peaks: [146, 142, 136],
  snowy_beach: [224, 226, 214],
  // warm and dry
  desert: [232, 214, 152],
  badlands: [190, 122, 66],
  eroded_badlands: [204, 138, 78],
  wooded_badlands: [172, 132, 78],
  savanna: [190, 182, 106],
  savanna_plateau: [178, 170, 104],
  windswept_savanna: [166, 164, 108],
  // jungle and swamp
  jungle: [42, 122, 48],
  sparse_jungle: [78, 138, 62],
  bamboo_jungle: [104, 156, 56],
  swamp: [82, 106, 74],
  mangrove_swamp: [66, 110, 82],
  // shores and oddities
  beach: [238, 224, 176],
  stony_shore: [148, 148, 142],
  mushroom_fields: [170, 118, 168],
  // caves
  dripstone_caves: [140, 112, 92],
  lush_caves: [96, 150, 84],
  deep_dark: [40, 46, 56],
  sulfur_caves: [196, 186, 92],
  // nether
  nether_wastes: [150, 54, 40],
  crimson_forest: [166, 44, 44],
  warped_forest: [40, 128, 126],
  soul_sand_valley: [110, 92, 78],
  basalt_deltas: [86, 80, 84],
  // end
  the_end: [216, 212, 168],
  end_highlands: [206, 202, 156],
  end_midlands: [198, 194, 150],
  end_barrens: [176, 172, 134],
  small_end_islands: [160, 156, 124],
  the_void: [22, 22, 26]
};
function biomeColourFromName(id) {
  const has = (...words) => words.some((w) => id.includes(w));
  if (has("deep_frozen", "frozen_ocean")) return [110, 140, 170];
  if (has("deep_")) return [30, 72, 140];
  if (has("ocean")) return [46, 100, 178];
  if (has("river")) return [66, 132, 208];
  if (has("frozen", "snowy", "ice", "peaks")) return [214, 228, 238];
  if (has("desert", "badlands")) return [206, 160, 96];
  if (has("savanna")) return [184, 176, 106];
  if (has("jungle")) return [52, 130, 54];
  if (has("swamp")) return [78, 106, 76];
  if (has("taiga", "grove")) return [62, 108, 88];
  if (has("forest")) return [72, 132, 68];
  if (has("beach", "shore")) return [226, 216, 176];
  if (has("caves", "dark")) return [96, 90, 88];
  if (has("nether", "crimson", "warped", "soul", "basalt")) return [140, 62, 52];
  if (has("end")) return [200, 196, 152];
  return [140, 160, 120];
}
function biomeColour(id) {
  const bare = id.replace(/^[a-z0-9_.-]+:/, "");
  return BIOME_COLOURS[bare] ?? biomeColourFromName(bare);
}
function temperatureColour(value) {
  const u = Math.max(0, Math.min(1, (value + 1) / 2));
  const stops = [
    [0, [96, 148, 220]],
    [0.28, [120, 196, 214]],
    [0.5, [150, 200, 130]],
    [0.72, [226, 186, 96]],
    [1, [214, 96, 72]]
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (u <= b || i === stops.length - 2) {
      const t2 = Math.max(0, Math.min(1, (u - a) / (b - a)));
      return [ca[0] + (cb[0] - ca[0]) * t2, ca[1] + (cb[1] - ca[1]) * t2, ca[2] + (cb[2] - ca[2]) * t2];
    }
  }
  return [255, 255, 255];
}
function elevationColour(y, seaLevel, isLand) {
  const d = y - seaLevel;
  if (!isLand) {
    const t2 = Math.max(0, Math.min(1, -d / 96));
    return [Math.round(46 - 34 * t2), Math.round(106 - 74 * t2), Math.round(170 - 90 * t2)];
  }
  const stops = [
    [-32, [120, 130, 110]],
    [0, [226, 214, 168]],
    [12, [150, 190, 110]],
    [48, [92, 152, 84]],
    [110, [140, 128, 84]],
    [170, [138, 126, 118]],
    [230, [198, 198, 200]],
    [300, [246, 249, 252]]
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (d <= b || i === stops.length - 2) {
      const t2 = Math.max(0, Math.min(1, (d - a) / (b - a)));
      return [
        Math.round(ca[0] + (cb[0] - ca[0]) * t2),
        Math.round(ca[1] + (cb[1] - ca[1]) * t2),
        Math.round(ca[2] + (cb[2] - ca[2]) * t2)
      ];
    }
  }
  return [255, 255, 255];
}
function css(colour) {
  return `rgb(${Math.round(colour[0])}, ${Math.round(colour[1])}, ${Math.round(colour[2])})`;
}

// src/render.ts
function mix(base, over, amount) {
  const t2 = Math.max(0, Math.min(1, amount));
  return [
    base[0] + (over[0] - base[0]) * t2,
    base[1] + (over[1] - base[1]) * t2,
    base[2] + (over[2] - base[2]) * t2
  ];
}
function renderMap(canvas2, map, view, options) {
  const ctx = canvas2.getContext("2d");
  if (!ctx) return;
  const w = canvas2.width;
  const h = canvas2.height;
  const image = ctx.createImageData(w, h);
  const pixels = image.data;
  const land = map.layer("land");
  const elevation = map.layer("elevation");
  const temperature = map.layer("temperature");
  const biome = map.layer("biome");
  const feature = map.layer("feature");
  const showElevation = options.visible.has("elevation");
  const showTemperature = options.visible.has("temperature");
  const showBiome = options.visible.has("biome");
  const showLand = options.visible.has("land");
  const showFeature = options.visible.has("feature");
  const strength = (layer) => options.activeLayer === layer ? 0.92 : 0.68;
  const flagCache = /* @__PURE__ */ new Map();
  const featureFill = (bits) => {
    const hit = flagCache.get(bits);
    if (hit) return hit;
    const names = FEATURE_FLAGS.filter((_, bit) => bits & 1 << bit);
    const colour = blendFeatureColours(names);
    flagCache.set(bits, colour);
    return colour;
  };
  for (let py = 0; py < h; py++) {
    const worldZ = view.centreZ + (py - h / 2) * view.scale;
    for (let px = 0; px < w; px++) {
      const worldX = view.centreX + (px - w / 2) * view.scale;
      const { cx, cy } = map.worldToCell(worldX, worldZ);
      const offset = (py * w + px) * 4;
      const inside = cx >= 0 && cy >= 0 && cx < map.cols && cy < map.rows;
      let colour;
      if (!inside) {
        colour = OUTSIDE_COLOUR;
      } else {
        const isLand = land.get(cx, cy) !== 0;
        colour = showLand ? isLand ? LAND_COLOUR : OCEAN_COLOUR : NEUTRAL_COLOUR;
        if (showElevation) colour = elevationColour(elevation.real(cx, cy), options.seaLevel, isLand);
        if (showTemperature) {
          colour = mix(colour, temperatureColour(temperature.real(cx, cy)), strength("temperature"));
        }
        if (showBiome) {
          const index = biome.get(cx, cy);
          if (index > 0) colour = mix(colour, biomeColour(map.biomePalette[index] ?? ""), strength("biome"));
        }
        if (showFeature) {
          const bits = feature.get(cx, cy);
          if (bits) colour = mix(colour, featureFill(bits), strength("feature"));
        }
      }
      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
      pixels[offset + 3] = 255;
    }
  }
  if (options.contours) {
    const interval = Math.max(1, options.contourInterval);
    for (let py = 1; py < h; py++) {
      const worldZ = view.centreZ + (py - h / 2) * view.scale;
      for (let px = 1; px < w; px++) {
        const worldX = view.centreX + (px - w / 2) * view.scale;
        const a = map.worldToCell(worldX, worldZ);
        const b = map.worldToCell(worldX - view.scale, worldZ);
        const c = map.worldToCell(worldX, worldZ - view.scale);
        if (a.cx < 0 || a.cy < 0 || a.cx >= map.cols || a.cy >= map.rows) continue;
        const here = elevation.real(a.cx, a.cy);
        const west = elevation.real(b.cx, b.cy);
        const north = elevation.real(c.cx, c.cy);
        const crossed = Math.floor(here / interval) !== Math.floor(west / interval) || Math.floor(here / interval) !== Math.floor(north / interval);
        if (!crossed) continue;
        const offset = (py * w + px) * 4;
        const isLand = land.get(a.cx, a.cy) !== 0;
        const tint = isLand ? [70, 50, 30] : [190, 225, 255];
        pixels[offset] = (pixels[offset] + tint[0]) / 2;
        pixels[offset + 1] = (pixels[offset + 1] + tint[1]) / 2;
        pixels[offset + 2] = (pixels[offset + 2] + tint[2]) / 2;
      }
    }
  }
  ctx.putImageData(image, 0, 0);
  if (options.grid) drawGrid(ctx, w, h, view);
  drawMapBorder(ctx, w, h, view, map);
}
function niceStep(scale) {
  const target = scale * 90;
  const steps = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
  return steps.find((s) => s >= target) ?? steps[steps.length - 1];
}
function drawGrid(ctx, w, h, view) {
  const step = niceStep(view.scale);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.font = "11px ui-monospace, monospace";
  const left = view.centreX - w / 2 * view.scale;
  const top = view.centreZ - h / 2 * view.scale;
  for (let x = Math.ceil(left / step) * step; x < left + w * view.scale; x += step) {
    const px = Math.round((x - left) / view.scale) + 0.5;
    ctx.strokeStyle = x === 0 ? "rgba(255,220,120,0.55)" : "rgba(255,255,255,0.10)";
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillText(String(x), px + 3, 12);
  }
  for (let z = Math.ceil(top / step) * step; z < top + h * view.scale; z += step) {
    const py = Math.round((z - top) / view.scale) + 0.5;
    ctx.strokeStyle = z === 0 ? "rgba(255,220,120,0.55)" : "rgba(255,255,255,0.10)";
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillText(String(z), 3, py - 3);
  }
  ctx.restore();
}
function drawMapBorder(ctx, w, h, view, map) {
  const left = map.origin.x - map.widthBlocks / 2;
  const top = map.origin.z - map.heightBlocks / 2;
  const toPx = (x, z) => ({
    px: (x - view.centreX) / view.scale + w / 2,
    py: (z - view.centreZ) / view.scale + h / 2
  });
  const a = toPx(left, top);
  const b = toPx(left + map.widthBlocks, top + map.heightBlocks);
  ctx.save();
  ctx.strokeStyle = "rgba(120,200,255,0.7)";
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(a.px, a.py, b.px - a.px, b.py - a.py);
  ctx.restore();
}
function renderHeightGrid(canvas2, heights, size, seaLevel, landMask) {
  const ctx = canvas2.getContext("2d");
  if (!ctx) return;
  canvas2.width = size;
  canvas2.height = size;
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < heights.length; i++) {
    const y = heights[i];
    const colour = elevationColour(y, seaLevel, landMask ? landMask[i] !== 0 : y > seaLevel);
    image.data[i * 4] = colour[0];
    image.data[i * 4 + 1] = colour[1];
    image.data[i * 4 + 2] = colour[2];
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

// src/i18n.ts
var EN = {
  "app.title": "MineWorldGen \u2014 World Designer",
  "app.subtitle": "Design a world, compile it to a Minecraft 26.2 data pack",
  "panel.map": "Map",
  "panel.presets": "Presets",
  "panel.layers": "Layers",
  "panel.brush": "Brush",
  "panel.analysis": "Analysis",
  "panel.preview": "Preview",
  "panel.export": "Export",
  "map.width": "Width (blocks)",
  "map.height": "Height (blocks)",
  "map.resolution": "Resolution (blocks per cell)",
  "map.seaLevel": "Sea level",
  "map.seed": "Seed (0 = random)",
  "map.new": "Clear map",
  "map.heightLimit": "Limit height to 448",
  "map.heightLimitHint": "Terrain stops at y=448 and the build ceiling at y=512",
  "map.grid": "Grid",
  "map.contours": "Contours",
  "map.contourInterval": "Contour interval (blocks)",
  "map.navHint": "Left-drag paints \xB7 right or middle-drag pans \xB7 wheel zooms \xB7 [ ] resize the brush",
  "map.resetView": "Reset view",
  "preset.pick": "Preset",
  "preset.load": "Load preset settings",
  "preset.hint": "A preset replaces the generator settings only. Your drawn map is left untouched, so you can start from a preset and refine it by hand.",
  "layer.land": "Land / Ocean",
  "layer.elevation": "Elevation",
  "layer.temperature": "Temperature",
  "layer.biome": "Biome",
  "layer.feature": "Terrain feature",
  "layer.visible": "Visible",
  "legend.noBiomes": "No biome painted yet \u2014 the key fills in as you paint.",
  "brush.shape": "Shape",
  "brush.circle": "Circle",
  "brush.square": "Square",
  "brush.diamond": "Diamond",
  "brush.size": "Size",
  "brush.mode": "Mode",
  "brush.value": "Value",
  "brush.flag": "Feature",
  "brush.filter": "Filter biomes",
  "brush.band": "Climate band",
  "biomeGroup.overworld": "Overworld",
  "biomeGroup.nether": "Nether",
  "biomeGroup.end": "End",
  "biomeGroup.other": "Other",
  "climate.frozen": "Frozen",
  "climate.cold": "Cold",
  "climate.temperate": "Temperate",
  "climate.warm": "Warm",
  "climate.hot": "Hot",
  "brush.amount": "Amount per stroke",
  "brush.targetY": "Target Y",
  "brush.step": "Step height",
  "brush.jitter": "Jitter",
  "brush.slope": "Slope strength",
  "brush.flow": "Flow",
  "brush.paint": "Paint",
  "brush.erase": "Erase",
  "brush.fill": "Fill area",
  "brush.raise": "Raise",
  "brush.lower": "Lower",
  "brush.raiseTo": "Raise to Y",
  "brush.lowerTo": "Lower to Y",
  "brush.set": "Set to Y",
  "brush.smooth": "Smooth",
  "brush.sharpen": "Sharpen",
  "brush.noise": "Roughen",
  "brush.flatten": "Flatten",
  "brush.terrace": "Terrace",
  "brush.addFlag": "Add feature",
  "brush.removeFlag": "Remove feature",
  "brush.hint.fill": "One click replaces the whole connected area under the cursor.",
  "brush.hint.flatten": "Levels everything to the height where the stroke began.",
  "brush.hint.smooth": "Averages each cell with its neighbours.",
  "brush.hint.sharpen": "Pushes each cell away from its neighbours, deepening what is there.",
  "brush.hint.terrace": "Snaps heights to multiples of the step, for plateaus and tepuis.",
  "brush.hint.noise": "Adds a repeatable per-cell jitter, so the same spot always roughens the same way.",
  "brush.hint.biome": "All {count} biomes in the vanilla registry. Ids are shown exactly as the data pack writes them.",
  "brush.hint.range": "Y {min} to {max}; sea level is {sea}.",
  "value.land": "Land",
  "value.ocean": "Ocean",
  "value.clear": "Clear",
  "feature.volcano": "Volcano",
  "feature.atoll": "Atoll",
  "feature.fjord": "Fjord",
  "feature.island_arc": "Island arc",
  "feature.mountain_range": "Mountain range",
  "feature.plateau": "Plateau",
  "feature.tepui": "Tepui",
  "feature.sea_stack": "Sea stack",
  "feature.columnar_jointing": "Columnar jointing",
  "feature.inland_sea": "Inland sea",
  "feature.river": "River",
  "feature.coral_reef": "Coral reef",
  "center.archipelago": "archipelago",
  "center.continent": "continent",
  "center.island": "island",
  "center.ocean": "ocean",
  "center.default": "unforced",
  "hover.outside": "outside the design surface \u2014 procedural generation",
  "action.undo": "Undo",
  "action.redo": "Redo",
  "action.importProject": "Import project",
  "action.exportProject": "Export project",
  "action.analyse": "Analyse map",
  "action.exportPack": "Export world",
  "analysis.landRatio": "Land ratio",
  "analysis.landmasses": "Landmasses",
  "analysis.continentSize": "Continent size",
  "analysis.variation": "Size variation",
  "analysis.islands": "Islands",
  "analysis.clustering": "Clustering",
  "analysis.oceanDepth": "Ocean depth mean/max",
  "analysis.center": "Centre",
  "analysis.worldRange": "World Y {min} \u2026 {max}  (highest drawn land {peak} + {headroom})",
  "analysis.config": "Generator config (editable)",
  "analysis.apply": "Apply edits",
  "analysis.reset": "Reset",
  "note.clippedLandmasses": "every landmass touches the map edge, so sizes were taken from the clipped shapes",
  "note.allOcean": "the map is entirely ocean, so continent settings were left at their defaults",
  "note.noContinents": "nothing drawn is large enough to count as a continent, so the continent scale was taken from the largest landmass",
  "preview.user": "Your design",
  "preview.procedural": "Procedural result",
  "preview.refresh": "Refresh",
  "preview.refreshUser": "Redraw from the map as it is now",
  "preview.refreshProcedural": "Re-analyse the map and rebuild the procedural preview",
  "preview.scale": "Both previews show the same window: {size} \xD7 {size} blocks",
  "preview.caption": "Procedural Export reproduces the character and scale of your design, not its exact coastlines. Exact Export preserves position.",
  "preview.stale": "The map has changed since this was drawn \u2014 press refresh.",
  "preview.neverAnalysed": "These are the current generator settings, not an analysis of your map \u2014 press refresh to match them to what you drew.",
  "export.mode": "Export mode",
  "export.vanilla": "Vanilla \u2014 identical to vanilla terrain",
  "export.procedural": "Procedural \u2014 vanilla data pack, no mod",
  "export.exact": "Exact \u2014 data pack + companion mod",
  "export.packName": "Pack name",
  "status.newMap": "New map created",
  "status.resized": "Map resized to {width} x {height} blocks at {resolution} blocks per cell",
  "status.imported": "Project imported",
  "status.importFailed": "Could not import project",
  "status.restored": "Restored the autosaved project",
  "status.building": "Building the data pack...",
  "status.filesWritten": "files written",
  "status.buildFailed": "Could not build the data pack",
  "status.exactPending": "Exact Export needs the companion mod, which is not built yet",
  "status.configApplied": "Generator settings applied",
  "status.configInvalid": "That is not valid JSON",
  "status.configReset": "Generator settings restored",
  "status.presetLoaded": "Preset loaded",
  "status.presetFailed": "Could not load that preset",
  "status.presetNone": "Pick a preset first",
  "adjust.mode": 'mode "{value}" is not recognised, falling back to "vanilla"',
  "adjust.centerType": 'center.type "{value}" is not recognised, using "default"',
  "adjust.notNumber": "{path} is not a number, using the default {fallback}",
  "adjust.min": "{path} raised from {value} to the minimum {bound}",
  "adjust.max": "{path} lowered from {value} to the maximum {bound}",
  "adjust.multiple16": "{path} rounded from {from} to {to} (must be a multiple of 16)",
  "adjust.buildLimits": "{path} moved from {from} to {to} to fit the build limits",
  "adjust.terrainMinY": "world.terrain_min_y was at or above terrain_max_y, lowered to {to}",
  "adjust.seaLevel": "world.sea_level moved from {from} to {to} to sit between the limits",
  "adjust.continentWidth": "continents.width lowered from {from} to {to} (max ratio 1:{limit})",
  "adjust.continentHeight": "continents.height lowered from {from} to {to} (max ratio 1:{limit})",
  "adjust.landRatio": "continents.land_ratio moved from {from} to {to} (reachable range with the current island settings)",
  "adjust.terrainMinYForOcean": "world.terrain_min_y lowered from {from} to {to} to make room for the configured ocean depth",
  "adjust.oceanDepthScaled": "the configured ocean depth does not fit in the world, depths scaled to {deep} / {trench} blocks",
  "adjust.oceanDepthOrder": "oceans.ocean_depth_blocks was deeper than deep_ocean_depth_blocks, lowered to {to}",
  "adjust.islandChances": "island archetype chances summed above 0.95, scaled down to {atoll} / {volcanic} / {cliff}"
};
var KO = {
  "app.title": "MineWorldGen \u2014 \uC6D4\uB4DC \uB514\uC790\uC774\uB108",
  "app.subtitle": "\uC6D4\uB4DC\uB97C \uADF8\uB9AC\uACE0 \uB9C8\uC778\uD06C\uB798\uD504\uD2B8 26.2 \uB370\uC774\uD130\uD329\uC73C\uB85C \uCEF4\uD30C\uC77C\uD569\uB2C8\uB2E4",
  "panel.map": "\uC9C0\uB3C4",
  "panel.presets": "\uD504\uB9AC\uC14B",
  "panel.layers": "\uB808\uC774\uC5B4",
  "panel.brush": "\uBE0C\uB7EC\uC2DC",
  "panel.analysis": "\uBD84\uC11D",
  "panel.preview": "\uBBF8\uB9AC\uBCF4\uAE30",
  "panel.export": "\uB0B4\uBCF4\uB0B4\uAE30",
  "map.width": "\uAC00\uB85C (\uBE14\uB85D)",
  "map.height": "\uC138\uB85C (\uBE14\uB85D)",
  "map.resolution": "\uD574\uC0C1\uB3C4 (\uC140\uB2F9 \uBE14\uB85D \uC218)",
  "map.seaLevel": "\uD574\uC218\uBA74 \uB192\uC774",
  "map.seed": "\uC2DC\uB4DC (0 = \uBB34\uC791\uC704)",
  "map.new": "\uC9C0\uB3C4 \uBE44\uC6B0\uAE30",
  "map.heightLimit": "\uB192\uC774\uB97C 448\uB85C \uC81C\uD55C",
  "map.heightLimitHint": "\uC9C0\uD615\uC740 y=448\uC5D0\uC11C, \uAC74\uCD95 \uCC9C\uC7A5\uC740 y=512\uC5D0\uC11C \uBA48\uCDA5\uB2C8\uB2E4",
  "map.grid": "\uACA9\uC790",
  "map.contours": "\uB4F1\uACE0\uC120",
  "map.contourInterval": "\uB4F1\uACE0\uC120 \uAC04\uACA9 (\uBE14\uB85D)",
  "map.navHint": "\uC67C\uCABD \uB4DC\uB798\uADF8\uB85C \uADF8\uB9AC\uAE30 \xB7 \uC624\uB978\uCABD\xB7\uAC00\uC6B4\uB370 \uB4DC\uB798\uADF8\uB85C \uC774\uB3D9 \xB7 \uD720\uB85C \uD655\uB300 \xB7 [ ] \uB85C \uBE0C\uB7EC\uC2DC \uD06C\uAE30 \uC870\uC808",
  "map.resetView": "\uD654\uBA74 \uB9DE\uCDA4",
  "preset.pick": "\uD504\uB9AC\uC14B",
  "preset.load": "\uD504\uB9AC\uC14B \uC124\uC815 \uBD88\uB7EC\uC624\uAE30",
  "preset.hint": "\uD504\uB9AC\uC14B\uC740 \uC0DD\uC131\uAE30 \uC124\uC815\uB9CC \uBC14\uAFC9\uB2C8\uB2E4. \uADF8\uB824 \uB454 \uC9C0\uB3C4\uB294 \uADF8\uB300\uB85C \uB0A8\uC73C\uBBC0\uB85C, \uD504\uB9AC\uC14B\uC5D0\uC11C \uCD9C\uBC1C\uD574 \uC9C1\uC811 \uB2E4\uB4EC\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4.",
  "layer.land": "\uC721\uC9C0 / \uBC14\uB2E4",
  "layer.elevation": "\uACE0\uB3C4",
  "layer.temperature": "\uAE30\uC628",
  "layer.biome": "\uC0DD\uBB3C \uAD70\uACC4",
  "layer.feature": "\uC9C0\uD615 \uC694\uC18C",
  "layer.visible": "\uD45C\uC2DC",
  "legend.noBiomes": "\uC544\uC9C1 \uCE60\uD55C \uC0DD\uBB3C \uAD70\uACC4\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4 \u2014 \uCE60\uD558\uBA74 \uC5EC\uAE30\uC5D0 \uD45C\uC2DC\uB429\uB2C8\uB2E4.",
  "brush.shape": "\uBAA8\uC591",
  "brush.circle": "\uC6D0",
  "brush.square": "\uC815\uC0AC\uAC01\uD615",
  "brush.diamond": "\uB9C8\uB984\uBAA8",
  "brush.size": "\uD06C\uAE30",
  "brush.mode": "\uBC29\uC2DD",
  "brush.value": "\uAC12",
  "brush.flag": "\uC9C0\uD615 \uC694\uC18C",
  "brush.filter": "\uC0DD\uBB3C \uAD70\uACC4 \uAC80\uC0C9",
  "brush.band": "\uAE30\uD6C4\uB300",
  "biomeGroup.overworld": "\uC624\uBC84\uC6D4\uB4DC",
  "biomeGroup.nether": "\uB124\uB354",
  "biomeGroup.end": "\uC5D4\uB4DC",
  "biomeGroup.other": "\uAE30\uD0C0",
  "climate.frozen": "\uD639\uD55C",
  "climate.cold": "\uD55C\uB7AD",
  "climate.temperate": "\uC628\uD654",
  "climate.warm": "\uC628\uB09C",
  "climate.hot": "\uACE0\uC628",
  "brush.amount": "\uD55C \uD68D\uB2F9 \uBCC0\uD654\uB7C9",
  "brush.targetY": "\uBAA9\uD45C Y",
  "brush.step": "\uACC4\uB2E8 \uB192\uC774",
  "brush.jitter": "\uC694\uCCA0 \uD06C\uAE30",
  "brush.slope": "\uACBD\uC0AC \uAC15\uB3C4",
  "brush.flow": "\uB18D\uB3C4",
  "brush.paint": "\uCE60\uD558\uAE30",
  "brush.erase": "\uC9C0\uC6B0\uAE30",
  "brush.fill": "\uC601\uC5ED \uCC44\uC6B0\uAE30",
  "brush.raise": "\uB192\uC774\uAE30",
  "brush.lower": "\uB0AE\uCD94\uAE30",
  "brush.raiseTo": "Y\uAE4C\uC9C0 \uB192\uC774\uAE30",
  "brush.lowerTo": "Y\uAE4C\uC9C0 \uB0AE\uCD94\uAE30",
  "brush.set": "Y\uB85C \uB9DE\uCD94\uAE30",
  "brush.smooth": "\uBD80\uB4DC\uB7FD\uAC8C",
  "brush.sharpen": "\uB69C\uB837\uD558\uAC8C",
  "brush.noise": "\uAC70\uCE60\uAC8C",
  "brush.flatten": "\uD3C9\uD0C4\uD654",
  "brush.terrace": "\uACC4\uB2E8\uC2DD",
  "brush.addFlag": "\uC694\uC18C \uCD94\uAC00",
  "brush.removeFlag": "\uC694\uC18C \uC81C\uAC70",
  "brush.hint.fill": "\uD55C \uBC88 \uB204\uB974\uBA74 \uCEE4\uC11C \uC544\uB798\uB85C \uC774\uC5B4\uC9C4 \uC601\uC5ED \uC804\uCCB4\uAC00 \uBC14\uB01D\uB2C8\uB2E4.",
  "brush.hint.flatten": "\uD68D\uC744 \uC2DC\uC791\uD55C \uC9C0\uC810\uC758 \uB192\uC774\uB85C \uC804\uBD80 \uB9DE\uCDA5\uB2C8\uB2E4.",
  "brush.hint.smooth": "\uAC01 \uCE78\uC744 \uC8FC\uBCC0 \uCE78\uB4E4\uACFC \uD3C9\uADE0\uB0C5\uB2C8\uB2E4.",
  "brush.hint.sharpen": "\uAC01 \uCE78\uC744 \uC8FC\uBCC0 \uD3C9\uADE0\uC5D0\uC11C \uBC00\uC5B4\uB0B4 \uAE30\uBCF5\uC744 \uAC15\uC870\uD569\uB2C8\uB2E4.",
  "brush.hint.terrace": "\uACE0\uB3C4\uB97C \uACC4\uB2E8 \uB192\uC774\uC758 \uBC30\uC218\uB85C \uB9DE\uCDA5\uB2C8\uB2E4. \uACE0\uC6D0\uACFC \uD14C\uD478\uC774\uC5D0 \uC801\uD569\uD569\uB2C8\uB2E4.",
  "brush.hint.noise": "\uCE78\uB9C8\uB2E4 \uC815\uD574\uC9C4 \uC694\uCCA0\uC744 \uB354\uD569\uB2C8\uB2E4. \uAC19\uC740 \uC790\uB9AC\uB294 \uD56D\uC0C1 \uAC19\uC740 \uBAA8\uC591\uC73C\uB85C \uAC70\uCE60\uC5B4\uC9D1\uB2C8\uB2E4.",
  "brush.hint.biome": "\uBC14\uB2D0\uB77C \uB808\uC9C0\uC2A4\uD2B8\uB9AC\uC758 \uC0DD\uBB3C \uAD70\uACC4 {count}\uC885 \uC804\uBD80\uC785\uB2C8\uB2E4. ID\uB294 \uB370\uC774\uD130\uD329\uC774 \uC4F0\uB294 \uD615\uD0DC \uADF8\uB300\uB85C \uD45C\uC2DC\uD569\uB2C8\uB2E4.",
  "brush.hint.range": "Y {min} ~ {max}, \uD574\uC218\uBA74\uC740 {sea}.",
  "value.land": "\uC721\uC9C0",
  "value.ocean": "\uBC14\uB2E4",
  "value.clear": "\uC5C6\uC74C",
  "feature.volcano": "\uD654\uC0B0",
  "feature.atoll": "\uD658\uC0C1\uC0B0\uD638\uB3C4",
  "feature.fjord": "\uD53C\uC624\uB974",
  "feature.island_arc": "\uD638\uC0C1\uC5F4\uB3C4",
  "feature.mountain_range": "\uC0B0\uB9E5",
  "feature.plateau": "\uACE0\uC6D0",
  "feature.tepui": "\uD14C\uD478\uC774",
  "feature.sea_stack": "\uC2DC\uC2A4\uD0DD",
  "feature.columnar_jointing": "\uC8FC\uC0C1\uC808\uB9AC",
  "feature.inland_sea": "\uB0B4\uD574",
  "feature.river": "\uAC15",
  "feature.coral_reef": "\uC0B0\uD638\uCD08",
  "center.archipelago": "\uC5F4\uB3C4",
  "center.continent": "\uB300\uB959",
  "center.island": "\uC12C",
  "center.ocean": "\uBC14\uB2E4",
  "center.default": "\uC9C0\uC815 \uC5C6\uC74C",
  "hover.outside": "\uC124\uACC4 \uC601\uC5ED \uBC16 \u2014 \uC808\uCC28\uC801 \uC0DD\uC131 \uAD6C\uAC04",
  "action.undo": "\uC2E4\uD589 \uCDE8\uC18C",
  "action.redo": "\uB2E4\uC2DC \uC2E4\uD589",
  "action.importProject": "\uD504\uB85C\uC81D\uD2B8 \uC5F4\uAE30",
  "action.exportProject": "\uD504\uB85C\uC81D\uD2B8 \uC800\uC7A5",
  "action.analyse": "\uC9C0\uB3C4 \uBD84\uC11D",
  "action.exportPack": "\uC6D4\uB4DC \uB0B4\uBCF4\uB0B4\uAE30",
  "analysis.landRatio": "\uC721\uC9C0 \uBE44\uC728",
  "analysis.landmasses": "\uC721\uAD34 \uAC1C\uC218",
  "analysis.continentSize": "\uB300\uB959 \uD06C\uAE30",
  "analysis.variation": "\uD06C\uAE30 \uD3B8\uCC28",
  "analysis.islands": "\uC12C",
  "analysis.clustering": "\uAD70\uC9D1\uB3C4",
  "analysis.oceanDepth": "\uBC14\uB2E4 \uAE4A\uC774 \uD3C9\uADE0/\uCD5C\uB300",
  "analysis.center": "\uC911\uC2EC",
  "analysis.worldRange": "\uC6D4\uB4DC Y {min} \u2026 {max}  (\uC9C0\uB3C4 \uCD5C\uACE0 \uACE0\uB3C4 {peak} + {headroom})",
  "analysis.config": "\uC0DD\uC131\uAE30 \uC124\uC815 (\uC9C1\uC811 \uC218\uC815 \uAC00\uB2A5)",
  "analysis.apply": "\uC218\uC815 \uC801\uC6A9",
  "analysis.reset": "\uB418\uB3CC\uB9AC\uAE30",
  "note.clippedLandmasses": "\uBAA8\uB4E0 \uC721\uAD34\uAC00 \uC9C0\uB3C4 \uAC00\uC7A5\uC790\uB9AC\uC5D0 \uB2FF\uC544 \uC788\uC5B4, \uC798\uB9B0 \uBAA8\uC591\uC744 \uAE30\uC900\uC73C\uB85C \uD06C\uAE30\uB97C \uC7C0\uC2B5\uB2C8\uB2E4",
  "note.allOcean": "\uC9C0\uB3C4\uAC00 \uC804\uBD80 \uBC14\uB2E4\uC5EC\uC11C \uB300\uB959 \uC124\uC815\uC740 \uAE30\uBCF8\uAC12 \uADF8\uB300\uB85C \uB450\uC5C8\uC2B5\uB2C8\uB2E4",
  "note.noContinents": "\uB300\uB959\uC774\uB77C \uD560 \uB9CC\uD07C \uD070 \uC721\uC9C0\uAC00 \uC5C6\uC5B4, \uAC00\uC7A5 \uD070 \uC721\uAD34 \uD06C\uAE30\uB97C \uB300\uB959 \uADDC\uBAA8\uB85C \uC0BC\uC558\uC2B5\uB2C8\uB2E4",
  "preview.user": "\uB0B4\uAC00 \uADF8\uB9B0 \uC9C0\uB3C4",
  "preview.procedural": "\uC808\uCC28\uC801 \uC0DD\uC131 \uACB0\uACFC",
  "preview.refresh": "\uC0C8\uB85C \uACE0\uCE68",
  "preview.refreshUser": "\uD604\uC7AC \uC9C0\uB3C4 \uC0C1\uD0DC\uB85C \uB2E4\uC2DC \uADF8\uB9BD\uB2C8\uB2E4",
  "preview.refreshProcedural": "\uC9C0\uB3C4\uB97C \uB2E4\uC2DC \uBD84\uC11D\uD558\uACE0 \uC808\uCC28\uC801 \uBBF8\uB9AC\uBCF4\uAE30\uB97C \uC0C8\uB85C \uB9CC\uB4ED\uB2C8\uB2E4",
  "preview.scale": "\uB450 \uBBF8\uB9AC\uBCF4\uAE30\uAC00 \uBCF4\uC5EC \uC8FC\uB294 \uBC94\uC704: {size} \xD7 {size} \uBE14\uB85D",
  "preview.caption": "\uC808\uCC28\uC801 \uB0B4\uBCF4\uB0B4\uAE30\uB294 \uC124\uACC4\uC758 \uC131\uACA9\uACFC \uADDC\uBAA8\uB97C \uC7AC\uD604\uD560 \uBFD0, \uD574\uC548\uC120\uC744 \uADF8\uB300\uB85C \uC62E\uAE30\uC9C0\uB294 \uC54A\uC2B5\uB2C8\uB2E4. \uC815\uBC00 \uB0B4\uBCF4\uB0B4\uAE30\uB294 \uC704\uCE58\uAE4C\uC9C0 \uBCF4\uC874\uD569\uB2C8\uB2E4.",
  "preview.stale": "\uADF8\uB9B0 \uB4A4\uB85C \uC9C0\uB3C4\uAC00 \uBC14\uB00C\uC5C8\uC2B5\uB2C8\uB2E4 \u2014 \uC0C8\uB85C \uACE0\uCE68\uC744 \uB204\uB974\uC138\uC694.",
  "preview.neverAnalysed": "\uC9C0\uAE08 \uC0DD\uC131\uAE30 \uC124\uC815\uC744 \uBCF4\uC5EC \uC904 \uBFD0, \uADF8\uB9B0 \uC9C0\uB3C4\uB97C \uBD84\uC11D\uD55C \uACB0\uACFC\uAC00 \uC544\uB2D9\uB2C8\uB2E4 \u2014 \uC0C8\uB85C \uACE0\uCE68\uC744 \uB20C\uB7EC \uC9C0\uB3C4\uC5D0 \uB9DE\uCD94\uC138\uC694.",
  "export.mode": "\uB0B4\uBCF4\uB0B4\uAE30 \uBC29\uC2DD",
  "export.vanilla": "\uBC14\uB2D0\uB77C \u2014 \uBC14\uB2D0\uB77C \uC9C0\uD615\uACFC \uC644\uC804\uD788 \uB3D9\uC77C",
  "export.procedural": "\uC808\uCC28\uC801 \u2014 \uC21C\uC218 \uB370\uC774\uD130\uD329, \uBAA8\uB4DC \uBD88\uD544\uC694",
  "export.exact": "\uC815\uBC00 \u2014 \uB370\uC774\uD130\uD329 + \uC804\uC6A9 \uBAA8\uB4DC",
  "export.packName": "\uB370\uC774\uD130\uD329 \uC774\uB984",
  "status.newMap": "\uC0C8 \uC9C0\uB3C4\uB97C \uB9CC\uB4E4\uC5C8\uC2B5\uB2C8\uB2E4",
  "status.resized": "\uC9C0\uB3C4\uB97C {width} x {height} \uBE14\uB85D, \uC140\uB2F9 {resolution} \uBE14\uB85D\uC73C\uB85C \uBC14\uAFE8\uC2B5\uB2C8\uB2E4",
  "status.imported": "\uD504\uB85C\uC81D\uD2B8\uB97C \uBD88\uB7EC\uC654\uC2B5\uB2C8\uB2E4",
  "status.importFailed": "\uD504\uB85C\uC81D\uD2B8\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4",
  "status.restored": "\uC790\uB3D9 \uC800\uC7A5\uB41C \uD504\uB85C\uC81D\uD2B8\uB97C \uBCF5\uC6D0\uD588\uC2B5\uB2C8\uB2E4",
  "status.building": "\uB370\uC774\uD130\uD329\uC744 \uB9CC\uB4DC\uB294 \uC911...",
  "status.filesWritten": "\uAC1C \uD30C\uC77C \uC0DD\uC131",
  "status.buildFailed": "\uB370\uC774\uD130\uD329\uC744 \uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4",
  "status.exactPending": "\uC815\uBC00 \uB0B4\uBCF4\uB0B4\uAE30\uB294 \uC804\uC6A9 \uBAA8\uB4DC\uAC00 \uD544\uC694\uD558\uBA70, \uC544\uC9C1 \uB9CC\uB4E4\uC5B4\uC9C0\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4",
  "status.configApplied": "\uC0DD\uC131\uAE30 \uC124\uC815\uC744 \uC801\uC6A9\uD588\uC2B5\uB2C8\uB2E4",
  "status.configInvalid": "\uC62C\uBC14\uB978 JSON\uC774 \uC544\uB2D9\uB2C8\uB2E4",
  "status.configReset": "\uC0DD\uC131\uAE30 \uC124\uC815\uC744 \uB418\uB3CC\uB838\uC2B5\uB2C8\uB2E4",
  "status.presetLoaded": "\uD504\uB9AC\uC14B\uC744 \uBD88\uB7EC\uC654\uC2B5\uB2C8\uB2E4",
  "status.presetFailed": "\uD504\uB9AC\uC14B\uC744 \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4",
  "status.presetNone": "\uBA3C\uC800 \uD504\uB9AC\uC14B\uC744 \uACE0\uB974\uC138\uC694",
  "adjust.mode": 'mode \uAC12 "{value}" \uC744(\uB97C) \uC54C \uC218 \uC5C6\uC5B4 "vanilla" \uB85C \uB418\uB3CC\uB838\uC2B5\uB2C8\uB2E4',
  "adjust.centerType": 'center.type \uAC12 "{value}" \uC744(\uB97C) \uC54C \uC218 \uC5C6\uC5B4 "default" \uB97C \uC0AC\uC6A9\uD569\uB2C8\uB2E4',
  "adjust.notNumber": "{path} \uC774(\uAC00) \uC22B\uC790\uAC00 \uC544\uB2C8\uC5B4\uC11C \uAE30\uBCF8\uAC12 {fallback} \uC744(\uB97C) \uC0AC\uC6A9\uD569\uB2C8\uB2E4",
  "adjust.min": "{path} \uC744(\uB97C) {value} \uC5D0\uC11C \uCD5C\uC19F\uAC12 {bound} \uC73C\uB85C \uC62C\uB838\uC2B5\uB2C8\uB2E4",
  "adjust.max": "{path} \uC744(\uB97C) {value} \uC5D0\uC11C \uCD5C\uB313\uAC12 {bound} \uC73C\uB85C \uB0B4\uB838\uC2B5\uB2C8\uB2E4",
  "adjust.multiple16": "{path} \uC744(\uB97C) {from} \uC5D0\uC11C {to} \uC73C\uB85C \uBC18\uC62C\uB9BC\uD588\uC2B5\uB2C8\uB2E4 (16\uC758 \uBC30\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4)",
  "adjust.buildLimits": "{path} \uC744(\uB97C) {from} \uC5D0\uC11C {to} \uC73C\uB85C \uC62E\uACA8 \uAC74\uCD95 \uD55C\uACC4\uC5D0 \uB9DE\uCDC4\uC2B5\uB2C8\uB2E4",
  "adjust.terrainMinY": "world.terrain_min_y \uAC00 terrain_max_y \uC774\uC0C1\uC774\uC5B4\uC11C {to} \uB85C \uB0B4\uB838\uC2B5\uB2C8\uB2E4",
  "adjust.seaLevel": "world.sea_level \uC744 {from} \uC5D0\uC11C {to} \uC73C\uB85C \uC62E\uACA8 \uC0C1\uD558\uD55C \uC0AC\uC774\uC5D0 \uB9DE\uCDC4\uC2B5\uB2C8\uB2E4",
  "adjust.continentWidth": "continents.width \uB97C {from} \uC5D0\uC11C {to} \uC73C\uB85C \uB0AE\uCDC4\uC2B5\uB2C8\uB2E4 (\uCD5C\uB300 \uBE44\uC728 1:{limit})",
  "adjust.continentHeight": "continents.height \uB97C {from} \uC5D0\uC11C {to} \uC73C\uB85C \uB0AE\uCDC4\uC2B5\uB2C8\uB2E4 (\uCD5C\uB300 \uBE44\uC728 1:{limit})",
  "adjust.landRatio": "continents.land_ratio \uB97C {from} \uC5D0\uC11C {to} \uC73C\uB85C \uC62E\uACBC\uC2B5\uB2C8\uB2E4 (\uD604\uC7AC \uC12C \uC124\uC815\uC5D0\uC11C \uB3C4\uB2EC \uAC00\uB2A5\uD55C \uBC94\uC704)",
  "adjust.terrainMinYForOcean": "world.terrain_min_y \uB97C {from} \uC5D0\uC11C {to} \uC73C\uB85C \uB0B4\uB824 \uC124\uC815\uD55C \uBC14\uB2E4 \uAE4A\uC774\uB97C \uB2F4\uC744 \uACF5\uAC04\uC744 \uB9CC\uB4E4\uC5C8\uC2B5\uB2C8\uB2E4",
  "adjust.oceanDepthScaled": "\uC124\uC815\uD55C \uBC14\uB2E4 \uAE4A\uC774\uAC00 \uC6D4\uB4DC\uC5D0 \uB4E4\uC5B4\uAC00\uC9C0 \uC54A\uC544 {deep} / {trench} \uBE14\uB85D\uC73C\uB85C \uC904\uC600\uC2B5\uB2C8\uB2E4",
  "adjust.oceanDepthOrder": "oceans.ocean_depth_blocks \uAC00 deep_ocean_depth_blocks \uBCF4\uB2E4 \uAE4A\uC5B4\uC11C {to} \uB85C \uB0AE\uCDC4\uC2B5\uB2C8\uB2E4",
  "adjust.islandChances": "\uC12C \uC720\uD615 \uD655\uB960\uC758 \uD569\uC774 0.95\uB97C \uB118\uC5B4 {atoll} / {volcanic} / {cliff} \uB85C \uC904\uC600\uC2B5\uB2C8\uB2E4"
};
var TABLES = { en: EN, ko: KO };
var locale = localStorage.getItem("mwg.locale") ?? "en";
function currentLocale() {
  return locale;
}
function setLocale(next) {
  locale = next;
  localStorage.setItem("mwg.locale", next);
}
function t(key) {
  return TABLES[locale][key] ?? EN[key] ?? key;
}
function tf(key, params) {
  return t(key).replace(
    /\{(\w+)\}/g,
    (whole, name) => name in params ? String(params[name]) : whole
  );
}
function translationKeys() {
  return Object.keys(EN).sort();
}
function missingKeys(target) {
  return translationKeys().filter((key) => !(key in TABLES[target]));
}

// src/biomes.ts
var VANILLA_OVERWORLD_BIOMES = [
  "minecraft:badlands",
  "minecraft:bamboo_jungle",
  "minecraft:beach",
  "minecraft:birch_forest",
  "minecraft:cherry_grove",
  "minecraft:cold_ocean",
  "minecraft:dark_forest",
  "minecraft:deep_cold_ocean",
  "minecraft:deep_dark",
  "minecraft:deep_frozen_ocean",
  "minecraft:deep_lukewarm_ocean",
  "minecraft:deep_ocean",
  "minecraft:desert",
  "minecraft:dripstone_caves",
  "minecraft:eroded_badlands",
  "minecraft:flower_forest",
  "minecraft:forest",
  "minecraft:frozen_ocean",
  "minecraft:frozen_peaks",
  "minecraft:frozen_river",
  "minecraft:grove",
  "minecraft:ice_spikes",
  "minecraft:jagged_peaks",
  "minecraft:jungle",
  "minecraft:lukewarm_ocean",
  "minecraft:lush_caves",
  "minecraft:mangrove_swamp",
  "minecraft:meadow",
  "minecraft:mushroom_fields",
  "minecraft:ocean",
  "minecraft:old_growth_birch_forest",
  "minecraft:old_growth_pine_taiga",
  "minecraft:old_growth_spruce_taiga",
  "minecraft:pale_garden",
  "minecraft:plains",
  "minecraft:river",
  "minecraft:savanna",
  "minecraft:savanna_plateau",
  "minecraft:snowy_beach",
  "minecraft:snowy_plains",
  "minecraft:snowy_slopes",
  "minecraft:snowy_taiga",
  "minecraft:sparse_jungle",
  "minecraft:stony_peaks",
  "minecraft:stony_shore",
  "minecraft:sulfur_caves",
  "minecraft:sunflower_plains",
  "minecraft:swamp",
  "minecraft:taiga",
  "minecraft:warm_ocean",
  "minecraft:windswept_forest",
  "minecraft:windswept_gravelly_hills",
  "minecraft:windswept_hills",
  "minecraft:windswept_savanna",
  "minecraft:wooded_badlands"
];
var VANILLA_NETHER_BIOMES = [
  "minecraft:basalt_deltas",
  "minecraft:crimson_forest",
  "minecraft:nether_wastes",
  "minecraft:soul_sand_valley",
  "minecraft:warped_forest"
];
var VANILLA_END_BIOMES = [
  "minecraft:end_barrens",
  "minecraft:end_highlands",
  "minecraft:end_midlands",
  "minecraft:small_end_islands",
  "minecraft:the_end"
];
var VANILLA_OTHER_BIOMES = [
  "minecraft:the_void"
];
var BIOME_GROUPS = [
  { key: "biomeGroup.overworld", biomes: VANILLA_OVERWORLD_BIOMES },
  { key: "biomeGroup.nether", biomes: VANILLA_NETHER_BIOMES },
  { key: "biomeGroup.end", biomes: VANILLA_END_BIOMES },
  { key: "biomeGroup.other", biomes: VANILLA_OTHER_BIOMES }
];
var ALL_VANILLA_BIOMES = BIOME_GROUPS.flatMap((group) => group.biomes);

// ../tools/mwgbuild/calibration.json
var calibration_default = {
  amp_per_percent: 968585e-8,
  anisotropy_taps: 7,
  blur_gain: [
    [
      0,
      1
    ],
    [
      0.25,
      1.05738
    ],
    [
      0.5,
      1.14824
    ],
    [
      0.75,
      1.26973
    ],
    [
      1,
      1.41393
    ],
    [
      1.5,
      1.72197
    ],
    [
      2,
      1.99289
    ],
    [
      2.5,
      2.22851
    ],
    [
      3,
      2.43918
    ],
    [
      4,
      2.69686
    ]
  ],
  blur_stretch: [
    [
      0,
      1
    ],
    [
      0.25,
      1.27267
    ],
    [
      0.5,
      1.48018
    ],
    [
      0.75,
      1.66784
    ],
    [
      1,
      1.80732
    ],
    [
      1.5,
      1.80742
    ],
    [
      2,
      1.80752
    ],
    [
      2.5,
      1.80762
    ],
    [
      3,
      1.80772
    ],
    [
      4,
      1.80782
    ]
  ],
  cell_cut_2: [
    [
      0.02,
      4412e-6
    ],
    [
      0.05,
      0.011481
    ],
    [
      0.1,
      0.023792
    ],
    [
      0.16,
      0.039608
    ],
    [
      0.25,
      0.064798
    ],
    [
      0.34,
      0.093039
    ],
    [
      0.45,
      0.1331
    ],
    [
      0.6,
      0.200458
    ]
  ],
  cell_cut_3: [
    [
      0.02,
      0.019298
    ],
    [
      0.05,
      0.037631
    ],
    [
      0.1,
      0.062862
    ],
    [
      0.16,
      0.090055
    ],
    [
      0.25,
      0.12848
    ],
    [
      0.34,
      0.167866
    ],
    [
      0.45,
      0.221168
    ],
    [
      0.6,
      0.307305
    ]
  ],
  cell_width_2: [
    [
      0.02,
      7.8954
    ],
    [
      0.05,
      12.1865
    ],
    [
      0.1,
      17.3663
    ],
    [
      0.16,
      22.8591
    ],
    [
      0.25,
      30.9957
    ],
    [
      0.34,
      40.7689
    ],
    [
      0.45,
      32.7222
    ],
    [
      0.6,
      64.3873
    ]
  ],
  cell_width_3: [
    [
      0.02,
      10.4003
    ],
    [
      0.05,
      14.5206
    ],
    [
      0.1,
      19.3871
    ],
    [
      0.16,
      23.1974
    ],
    [
      0.25,
      29.0728
    ],
    [
      0.34,
      35.5165
    ],
    [
      0.45,
      34.7336
    ],
    [
      0.6,
      24.9675
    ]
  ],
  center_ring_delta: 0.02,
  center_slope_per_1000: 2578e-6,
  coast_gradient_per_unit_scale: 436968e-8,
  continent_base_wavelength: 1024,
  continent_lobe_ratio: [
    [
      0.12,
      0.27378
    ],
    [
      0.2,
      0.39865
    ],
    [
      0.32,
      0.42847
    ],
    [
      0.45,
      0.4625
    ],
    [
      0.6,
      0.7532
    ]
  ],
  inland_sea_quantiles: [
    [
      0,
      -2
    ],
    [
      0.025,
      -0.63913
    ],
    [
      0.05,
      -0.57172
    ],
    [
      0.075,
      -0.51615
    ],
    [
      0.1,
      -0.48027
    ],
    [
      0.125,
      -0.44777
    ],
    [
      0.15,
      -0.41762
    ],
    [
      0.175,
      -0.39022
    ],
    [
      0.2,
      -0.36398
    ],
    [
      0.225,
      -0.33952
    ],
    [
      0.25,
      -0.31748
    ],
    [
      0.275,
      -0.29829
    ],
    [
      0.3,
      -0.27877
    ],
    [
      0.325,
      -0.25988
    ],
    [
      0.35,
      -0.2413
    ],
    [
      0.375,
      -0.22156
    ],
    [
      0.4,
      -0.20079
    ],
    [
      0.425,
      -0.18004
    ],
    [
      0.45,
      -0.16009
    ],
    [
      0.475,
      -0.14122
    ],
    [
      0.5,
      -0.1218
    ],
    [
      0.525,
      -0.10092
    ],
    [
      0.55,
      -0.08105
    ],
    [
      0.575,
      -0.06011
    ],
    [
      0.6,
      -0.03699
    ],
    [
      0.625,
      -0.01247
    ],
    [
      0.65,
      0.01272
    ],
    [
      0.675,
      0.03732
    ],
    [
      0.7,
      0.061
    ],
    [
      0.725,
      0.08203
    ],
    [
      0.75,
      0.10307
    ],
    [
      0.775,
      0.12353
    ],
    [
      0.8,
      0.14492
    ],
    [
      0.825,
      0.16735
    ],
    [
      0.85,
      0.19688
    ],
    [
      0.875,
      0.22961
    ],
    [
      0.9,
      0.27581
    ],
    [
      0.925,
      0.3245
    ],
    [
      0.95,
      0.39849
    ],
    [
      0.975,
      0.50879
    ],
    [
      1,
      2
    ]
  ],
  island_base_wavelength: 256,
  island_lobe_ratio: 0.392,
  island_type_quantiles: [
    [
      0,
      -2
    ],
    [
      0.025,
      -0.659
    ],
    [
      0.05,
      -0.55729
    ],
    [
      0.075,
      -0.47961
    ],
    [
      0.1,
      -0.41789
    ],
    [
      0.125,
      -0.37281
    ],
    [
      0.15,
      -0.33301
    ],
    [
      0.175,
      -0.29667
    ],
    [
      0.2,
      -0.26398
    ],
    [
      0.225,
      -0.23414
    ],
    [
      0.25,
      -0.206
    ],
    [
      0.275,
      -0.18033
    ],
    [
      0.3,
      -0.1562
    ],
    [
      0.325,
      -0.13317
    ],
    [
      0.35,
      -0.11065
    ],
    [
      0.375,
      -0.08788
    ],
    [
      0.4,
      -0.06622
    ],
    [
      0.425,
      -0.04609
    ],
    [
      0.45,
      -0.02643
    ],
    [
      0.475,
      -681e-5
    ],
    [
      0.5,
      0.012
    ],
    [
      0.525,
      0.0309
    ],
    [
      0.55,
      0.05035
    ],
    [
      0.575,
      0.0698
    ],
    [
      0.6,
      0.08918
    ],
    [
      0.625,
      0.1088
    ],
    [
      0.65,
      0.12888
    ],
    [
      0.675,
      0.15069
    ],
    [
      0.7,
      0.17363
    ],
    [
      0.725,
      0.19754
    ],
    [
      0.75,
      0.22239
    ],
    [
      0.775,
      0.24779
    ],
    [
      0.8,
      0.27539
    ],
    [
      0.825,
      0.30593
    ],
    [
      0.85,
      0.34072
    ],
    [
      0.875,
      0.37819
    ],
    [
      0.9,
      0.41648
    ],
    [
      0.925,
      0.46095
    ],
    [
      0.95,
      0.51821
    ],
    [
      0.975,
      0.6101
    ],
    [
      1,
      2
    ]
  ],
  land_ratio_table: [
    [
      -1.7,
      0.14531
    ],
    [
      -1.6,
      0.15301
    ],
    [
      -1.5,
      0.1641
    ],
    [
      -1.4,
      0.17583
    ],
    [
      -1.3,
      0.1872
    ],
    [
      -1.2,
      0.21335
    ],
    [
      -1.1,
      0.25687
    ],
    [
      -1,
      0.31256
    ],
    [
      -0.9,
      0.37514
    ],
    [
      -0.8,
      0.43179
    ],
    [
      -0.7,
      0.4818
    ],
    [
      -0.6,
      0.5416
    ],
    [
      -0.5,
      0.60407
    ],
    [
      -0.4,
      0.66793
    ],
    [
      -0.3,
      0.74224
    ],
    [
      -0.2,
      0.81998
    ],
    [
      -0.1,
      0.87787
    ],
    [
      0,
      0.90179
    ],
    [
      0.1,
      0.90712
    ]
  ]
};

// src/pack/calib.ts
var DATA = calibration_default;
var BLOCKS_PER_OFFSET = 128;
function interp(pairs, x) {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  if (x <= sorted[0][0]) return sorted[0][1];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [x0, y0] = sorted[i];
    const [x1, y1] = sorted[i + 1];
    if (x >= x0 && x <= x1) return x1 === x0 ? y1 : y0 + (x - x0) * (y1 - y0) / (x1 - x0);
  }
  return sorted[sorted.length - 1][1];
}
function invert(pairs, y) {
  const sorted = [...pairs].sort((a, b) => a[1] - b[1]);
  if (y <= sorted[0][1]) return sorted[0][0];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [x0, y0] = sorted[i];
    const [x1, y1] = sorted[i + 1];
    if (y >= y0 && y <= y1) return y1 === y0 ? x1 : x0 + (y - y0) * (x1 - x0) / (y1 - y0);
  }
  return sorted[sorted.length - 1][0];
}
var continentBaseWavelength = DATA.continent_base_wavelength;
var anisotropyTaps = DATA.anisotropy_taps;
var centerRingDelta = DATA.center_ring_delta;
var continentLobeRatio = (landRatio) => interp(DATA.continent_lobe_ratio, landRatio);
var continentScaleForSize = (sizeBlocks, landRatio) => DATA.continent_base_wavelength * continentLobeRatio(landRatio) / sizeBlocks;
var islandScaleForSize = (sizeBlocks) => DATA.island_base_wavelength * DATA.island_lobe_ratio / sizeBlocks;
function landRatioBounds() {
  const values = DATA.land_ratio_table.map((row) => row[1]);
  return [Math.min(...values), Math.max(...values)];
}
function oceanOffsetForLandRatio(ratio) {
  const [lo, hi] = landRatioBounds();
  return Number(invert(DATA.land_ratio_table, Math.max(lo, Math.min(hi, ratio))).toFixed(4));
}
var landRatioForOceanOffset = (offset) => Number(interp(DATA.land_ratio_table, offset).toFixed(4));
var blurGain = (r) => interp(DATA.blur_gain, Math.max(0, r));
var maxStretch = () => Math.max(...DATA.blur_stretch.map((row) => row[1]));
function blurForStretch(stretch) {
  const limit = maxStretch();
  return Number(invert(DATA.blur_stretch, Math.max(1, Math.min(limit, stretch))).toFixed(4));
}
var ampForPercent = (percent) => Number((DATA.amp_per_percent * Math.max(0, percent)).toFixed(8));
var islandTypeThreshold = (p) => Number(interp(DATA.island_type_quantiles, Math.max(0, Math.min(1, p))).toFixed(4));
var MAX_CELL_COVERAGE = 0.35;
var cellTable = (prefix, crossings) => DATA[`${prefix}_${crossings}`];
var cellCut = (crossings, coverage) => Number(
  interp(cellTable("cell_cut", crossings), Math.max(5e-3, Math.min(MAX_CELL_COVERAGE, coverage))).toFixed(6)
);
var cellScale = (crossings, coverage, widthBlocks) => Number(
  (interp(cellTable("cell_width", crossings), Math.max(5e-3, Math.min(MAX_CELL_COVERAGE, coverage))) / Math.max(widthBlocks, 1)).toFixed(8)
);
var INLAND_SEA_INTERIOR_BIAS = 0.3;
var inlandSeaShare = (frequency) => Math.max(0, Math.min(0.9, 0.45 * frequency));
function inlandSeaBand(frequency) {
  const share = inlandSeaShare(frequency);
  if (share <= 0) return [2, 2];
  const at = (p) => Number((interp(DATA.inland_sea_quantiles, p) + INLAND_SEA_INTERIOR_BIAS).toFixed(4));
  const low = at(1 - share);
  return [low, Math.max(at(1 - share * 0.55), low + 0.01)];
}
var centerThreshold = (radiusBlocks) => Number((DATA.center_slope_per_1000 * radiusBlocks / 1e3).toFixed(6));

// src/pack/config.ts
var MODES = ["vanilla", "custom"];
var CENTER_TYPES = ["archipelago", "continent", "island", "ocean", "default"];
var KARST_SETTINGS = ["land", "sea", "both"];
var VANILLA_CONTINENT_SIZE = 1400;
var DEFAULTS = {
  world: {
    sea_level: 63,
    build_min_y: -64,
    build_height: 384,
    terrain_max_y: 312,
    terrain_min_y: -40,
    vertical_scale: 1
  },
  center: { type: "default", radius: 2500, strength: 1 },
  continents: {
    land_ratio: 0.32,
    ocean_offset: null,
    width: 6e3,
    height: 6e3,
    width_variation_percent: 30,
    height_variation_percent: 30,
    erosion_scale: 1,
    ridge_scale: 1,
    flat_terrain_skew: 0.1,
    mountain_ranges: 1,
    plateaus: 1,
    tepui: 0.6,
    rolling_hills: true
  },
  rivers: { enabled: true, width: 1, depth_blocks: 10 },
  inland_seas: { enabled: true, frequency: 0.35, size: 3e3, depth_blocks: 26 },
  fjords: { enabled: true, frequency: 0.6, width: 1, depth_blocks: 24 },
  islands: {
    enabled: true,
    size: 700,
    frequency: 1,
    clustering: 0.5,
    arc_strength: 0.6,
    noise_offset: 0.05,
    atoll_chance: 0.18,
    volcanic_chance: 0.2,
    cliff_chance: 0.22
  },
  // Cone-and-crater volcanoes, placed as discrete cells rather than picked out
  // of the terrain noise, so they appear on continents as well as on islands
  // and always have the same profile.
  volcanoes: {
    enabled: true,
    // Share of the land the cones cover (0 - 1).
    frequency: 0.1,
    // Mean base diameter of one cone, in blocks.
    size: 900,
    height_blocks: 130,
    crater_blocks: 30
  },
  // Karst: steep isolated towers. In the sea these are the limestone towers of
  // a drowned karst bay; on land they are the same shape in local stone.
  karst: {
    enabled: false,
    frequency: 0.14,
    size: 70,
    height_blocks: 55,
    // Where the towers stand: land | sea | both
    setting: "both"
  },
  oceans: {
    ocean_depth_blocks: 28,
    deep_ocean_depth_blocks: 58,
    seafloor_relief: 1,
    trenches: true,
    trench_depth_blocks: 34
  },
  coast: { cliffs: 0.6, sea_stacks: 0.5, columnar_jointing: 0.5 },
  biomes: {
    scale_with_continents: true,
    temperature_scale: 1,
    temperature_offset: 0,
    temperature_multiplier: 1,
    vegetation_scale: 1,
    vegetation_offset: 0,
    vegetation_multiplier: 1
  },
  // caves.scale_with_continents is off by default: caves belong to whatever
  // decoration pack is loaded. Rewriting vanilla's cave noises here would
  // fight with Overhauled Overworld and Tectonic, which both have their own,
  // and the winner would come down to pack order rather than to anything the
  // player chose. Set it, or size_multiplier, to take them over deliberately.
  caves: { scale_with_continents: false, size_multiplier: 1, carvers_enabled: true },
  structures: { scale_with_continents: true, spacing_multiplier: 1 },
  spawn: { force_land_spawn: true }
};
var RANGES = {
  world: {
    sea_level: [-2032, 2032],
    build_min_y: [-2032, 0],
    build_height: [16, 4064],
    terrain_max_y: [-2032, 4032],
    terrain_min_y: [-2032, 4032],
    vertical_scale: [0.1, 4]
  },
  center: { radius: [200, 2e5], strength: [0, 2] },
  continents: {
    land_ratio: [0.02, 0.95],
    ocean_offset: [-2, 1],
    width: [300, 4e5],
    height: [300, 4e5],
    width_variation_percent: [0, 80],
    height_variation_percent: [0, 80],
    erosion_scale: [0.1, 8],
    ridge_scale: [0.1, 8],
    flat_terrain_skew: [0, 1],
    mountain_ranges: [0, 2],
    plateaus: [0, 2],
    tepui: [0, 2]
  },
  rivers: { width: [0.1, 4], depth_blocks: [0, 120] },
  inland_seas: { frequency: [0, 1], size: [500, 1e5], depth_blocks: [0, 200] },
  fjords: { frequency: [0, 1], width: [0.1, 4], depth_blocks: [0, 200] },
  islands: {
    size: [80, 2e4],
    frequency: [0, 3],
    clustering: [0, 1],
    arc_strength: [0, 2],
    noise_offset: [-0.6, 0.6],
    atoll_chance: [0, 1],
    volcanic_chance: [0, 1],
    cliff_chance: [0, 1]
  },
  volcanoes: {
    frequency: [0, 1],
    size: [120, 6e3],
    height_blocks: [0, 2e3],
    crater_blocks: [0, 400]
  },
  karst: { frequency: [0, 1], size: [20, 2e3], height_blocks: [0, 600] },
  oceans: {
    ocean_depth_blocks: [0, 1e3],
    deep_ocean_depth_blocks: [0, 1e3],
    seafloor_relief: [0, 4],
    trench_depth_blocks: [0, 1e3]
  },
  coast: { cliffs: [0, 2], sea_stacks: [0, 2], columnar_jointing: [0, 2] },
  biomes: {
    temperature_scale: [0.05, 8],
    temperature_offset: [-1, 1],
    temperature_multiplier: [0.05, 8],
    vegetation_scale: [0.05, 8],
    vegetation_offset: [-1, 1],
    vegetation_multiplier: [0.05, 8]
  },
  caves: { size_multiplier: [0.25, 4] },
  structures: { spacing_multiplier: [0.25, 8] }
};
var BOOLEAN_KEYS = [
  ["continents", "rolling_hills"],
  ["rivers", "enabled"],
  ["inland_seas", "enabled"],
  ["fjords", "enabled"],
  ["islands", "enabled"],
  ["volcanoes", "enabled"],
  ["karst", "enabled"],
  ["oceans", "trenches"],
  ["biomes", "scale_with_continents"],
  ["caves", "scale_with_continents"],
  ["caves", "carvers_enabled"],
  ["structures", "scale_with_continents"],
  ["spawn", "force_land_spawn"]
];
var roundTo = (value, step) => Math.round(value / step) * step;
function normalise(input) {
  const adjustments = [];
  const note = (key, params, text) => void adjustments.push({ key, params, text });
  const cfg = {};
  for (const [section, defaults] of Object.entries(DEFAULTS)) {
    const given = input[section] ?? {};
    cfg[section] = { ...defaults, ...given };
  }
  let mode = String(input.mode ?? "vanilla").trim().toLowerCase();
  if (!MODES.includes(mode)) {
    note("adjust.mode", { value: String(input.mode) }, `mode "${String(input.mode)}" is not recognised, falling back to "vanilla"`);
    mode = "vanilla";
  }
  let centerType = String(cfg.center.type ?? "default").trim().toLowerCase();
  if (!CENTER_TYPES.includes(centerType)) {
    note(
      "adjust.centerType",
      { value: String(cfg.center.type) },
      `center.type "${String(cfg.center.type)}" is not recognised, using "default"`
    );
    centerType = "default";
  }
  cfg.center.type = centerType;
  let karstSetting = String(cfg.karst.setting ?? "both").trim().toLowerCase();
  if (!KARST_SETTINGS.includes(karstSetting)) {
    note(
      "adjust.karstSetting",
      { value: String(cfg.karst.setting) },
      `karst.setting "${String(cfg.karst.setting)}" is not recognised, using "both"`
    );
    karstSetting = "both";
  }
  cfg.karst.setting = karstSetting;
  for (const [section, key] of BOOLEAN_KEYS) {
    cfg[section][key] = Boolean(cfg[section][key] ?? DEFAULTS[section][key]);
  }
  if (mode !== "custom") return { mode, cfg, adjustments };
  for (const [section, keys] of Object.entries(RANGES)) {
    for (const [key, [lo, hi]] of Object.entries(keys)) {
      const value = cfg[section][key];
      if (key === "ocean_offset" && value === null) continue;
      if (typeof value !== "number" || Number.isNaN(value)) {
        const fallback = DEFAULTS[section][key];
        note(
          "adjust.notNumber",
          { path: `${section}.${key}`, fallback: String(fallback) },
          `${section}.${key} is not a number, using the default ${String(fallback)}`
        );
        cfg[section][key] = fallback;
        continue;
      }
      if (value < lo) {
        note(
          "adjust.min",
          { path: `${section}.${key}`, value, bound: lo },
          `${section}.${key} raised from ${value} to the minimum ${lo}`
        );
        cfg[section][key] = lo;
      } else if (value > hi) {
        note(
          "adjust.max",
          { path: `${section}.${key}`, value, bound: hi },
          `${section}.${key} lowered from ${value} to the maximum ${hi}`
        );
        cfg[section][key] = hi;
      }
    }
  }
  const world = cfg.world;
  for (const key of ["build_min_y", "build_height"]) {
    const [lo, hi] = RANGES.world[key];
    const rounded = Math.max(lo, Math.min(hi, roundTo(world[key], 16)));
    if (rounded !== world[key]) {
      note(
        "adjust.multiple16",
        { path: `world.${key}`, from: world[key], to: rounded },
        `world.${key} rounded from ${world[key]} to ${rounded} (must be a multiple of 16)`
      );
      world[key] = rounded;
    }
  }
  const buildMax = world.build_min_y + world.build_height;
  const top = buildMax - 16;
  const bottom = world.build_min_y + 16;
  for (const [key, lo, hi] of [
    ["terrain_max_y", bottom + 2, top],
    ["terrain_min_y", bottom, top - 2]
  ]) {
    const clamped = Math.max(lo, Math.min(hi, world[key]));
    if (clamped !== world[key]) {
      note(
        "adjust.buildLimits",
        { path: `world.${key}`, from: world[key], to: clamped },
        `world.${key} moved from ${world[key]} to ${clamped} to fit the build limits`
      );
      world[key] = clamped;
    }
  }
  if (world.terrain_min_y >= world.terrain_max_y) {
    world.terrain_min_y = Math.max(bottom, world.terrain_max_y - 16);
    note(
      "adjust.terrainMinY",
      { to: world.terrain_min_y },
      `world.terrain_min_y was at or above terrain_max_y, lowered to ${world.terrain_min_y}`
    );
  }
  const sea = Math.max(world.terrain_min_y + 1, Math.min(world.terrain_max_y - 1, world.sea_level));
  if (sea !== world.sea_level) {
    note(
      "adjust.seaLevel",
      { from: world.sea_level, to: sea },
      `world.sea_level moved from ${world.sea_level} to ${sea} to sit between the limits`
    );
    world.sea_level = sea;
  }
  const cont = cfg.continents;
  const limit = maxStretch();
  const width = cont.width;
  const height = cont.height;
  const ratio = Math.max(width / height, height / width);
  if (ratio > limit) {
    if (width >= height) {
      const next = Math.round(height * limit);
      note(
        "adjust.continentWidth",
        { from: width, to: next, limit: limit.toFixed(2) },
        `continents.width lowered from ${width} to ${next} (max ratio 1:${limit.toFixed(2)})`
      );
      cont.width = next;
    } else {
      const next = Math.round(width * limit);
      note(
        "adjust.continentHeight",
        { from: height, to: next, limit: limit.toFixed(2) },
        `continents.height lowered from ${height} to ${next} (max ratio 1:${limit.toFixed(2)})`
      );
      cont.height = next;
    }
  }
  if (cont.ocean_offset === null || cont.ocean_offset === void 0) {
    const [loLand, hiLand] = landRatioBounds();
    const target = cont.land_ratio;
    const clamped = Math.max(loLand, Math.min(hiLand, target));
    if (Math.abs(clamped - target) > 1e-6) {
      note(
        "adjust.landRatio",
        { from: target, to: clamped.toFixed(3) },
        `continents.land_ratio moved from ${target} to ${clamped.toFixed(3)} (reachable range with the current island settings)`
      );
      cont.land_ratio = Number(clamped.toFixed(4));
    }
  }
  const oceans = cfg.oceans;
  const trench = oceans.trenches ? oceans.trench_depth_blocks : 0;
  const floor = world.sea_level - (oceans.deep_ocean_depth_blocks + trench);
  if (floor < world.terrain_min_y) {
    const room = world.sea_level - Math.max(bottom, world.build_min_y + 8);
    const wanted = oceans.deep_ocean_depth_blocks + trench;
    if (wanted <= room) {
      note(
        "adjust.terrainMinYForOcean",
        { from: world.terrain_min_y, to: floor },
        `world.terrain_min_y lowered from ${world.terrain_min_y} to ${floor} to make room for the configured ocean depth`
      );
      world.terrain_min_y = Math.trunc(floor);
    } else {
      const scale = wanted ? room / wanted : 1;
      oceans.deep_ocean_depth_blocks = Math.trunc(oceans.deep_ocean_depth_blocks * scale);
      if (oceans.trenches) oceans.trench_depth_blocks = Math.trunc(oceans.trench_depth_blocks * scale);
      world.terrain_min_y = Math.trunc(
        world.sea_level - oceans.deep_ocean_depth_blocks - (oceans.trenches ? oceans.trench_depth_blocks : 0)
      );
      note(
        "adjust.oceanDepthScaled",
        {
          deep: oceans.deep_ocean_depth_blocks,
          trench: oceans.trench_depth_blocks
        },
        `the configured ocean depth does not fit in the world, depths scaled to ${oceans.deep_ocean_depth_blocks} / ${oceans.trench_depth_blocks} blocks`
      );
    }
  }
  if (oceans.ocean_depth_blocks > oceans.deep_ocean_depth_blocks) {
    note(
      "adjust.oceanDepthOrder",
      { to: oceans.deep_ocean_depth_blocks },
      `oceans.ocean_depth_blocks was deeper than deep_ocean_depth_blocks, lowered to ${oceans.deep_ocean_depth_blocks}`
    );
    oceans.ocean_depth_blocks = oceans.deep_ocean_depth_blocks;
  }
  const isl = cfg.islands;
  const total = isl.atoll_chance + isl.volcanic_chance + isl.cliff_chance;
  if (total > 0.95) {
    const scale = 0.95 / total;
    for (const key of ["atoll_chance", "volcanic_chance", "cliff_chance"]) {
      isl[key] = Number((isl[key] * scale).toFixed(4));
    }
    note(
      "adjust.islandChances",
      {
        atoll: isl.atoll_chance,
        volcanic: isl.volcanic_chance,
        cliff: isl.cliff_chance
      },
      `island archetype chances summed above 0.95, scaled down to ${isl.atoll_chance} / ${isl.volcanic_chance} / ${isl.cliff_chance}`
    );
  }
  return { mode, cfg, adjustments };
}

// src/pack/vanilla.ts
var ROOT = new URL("./tools/vanilla/minecraft/", document.baseURI).href;
var MINECRAFT_VERSION = "26.2";
var PACK_FORMAT = 107;
var cache = /* @__PURE__ */ new Map();
async function load(path) {
  const hit = cache.get(path);
  if (hit !== void 0) return structuredClone(hit);
  const response = await fetch(ROOT + path);
  if (!response.ok) throw new Error(`missing vanilla file ${path} (${response.status})`);
  const value = await response.json();
  cache.set(path, value);
  return structuredClone(value);
}
function noise(name) {
  return load(`worldgen/noise/${name}.json`);
}
function noiseSettings(name = "overworld") {
  return load(`worldgen/noise_settings/${name}.json`);
}
function dimensionType(name = "overworld") {
  return load(`dimension_type/${name}.json`);
}
function structureSet(name) {
  return load(`worldgen/structure_set/${name}.json`);
}
var OVERWORLD_STRUCTURE_SETS = [
  "ancient_cities",
  "buried_treasures",
  "desert_pyramids",
  "igloos",
  "jungle_temples",
  "mineshafts",
  "ocean_monuments",
  "ocean_ruins",
  "pillager_outposts",
  "ruined_portals",
  "shipwrecks",
  "strongholds",
  "swamp_huts",
  "trail_ruins",
  "trial_chambers",
  "villages",
  "woodland_mansions"
];
var CAVE_NOISES = [
  "cave_cheese",
  "cave_entrance",
  "cave_layer",
  "noodle",
  "noodle_ridge_a",
  "noodle_ridge_b",
  "noodle_thickness",
  "pillar",
  "pillar_rareness",
  "pillar_thickness",
  "spaghetti_2d",
  "spaghetti_2d_elevation",
  "spaghetti_2d_modulator",
  "spaghetti_2d_thickness",
  "spaghetti_3d_1",
  "spaghetti_3d_2",
  "spaghetti_3d_rarity",
  "spaghetti_3d_thickness",
  "spaghetti_roughness",
  "spaghetti_roughness_modulator"
];
function scaleNoise(params, factor) {
  if (Math.abs(factor - 1) < 1e-6) return structuredClone(params);
  const exponent = Math.log2(factor);
  const whole = Math.floor(exponent);
  const frac = exponent - whole;
  const amplitudes = params.amplitudes.map(Number);
  const low = [0, ...amplitudes];
  const high = [...amplitudes, 0];
  const blended = low.map((a, i) => Number(((1 - frac) * a + frac * high[i]).toFixed(6)));
  while (blended.length > 1 && blended[blended.length - 1] === 0) blended.pop();
  return { firstOctave: Number(params.firstOctave) - whole - 1, amplitudes: blended };
}

// src/pack/dsl.ts
function add(a, b) {
  if (a === 0) return b;
  if (b === 0) return a;
  return { type: "minecraft:add", argument1: a, argument2: b };
}
function addAll(...args) {
  let result = 0;
  for (const arg of args) result = add(result, arg);
  return result;
}
function mul(a, b) {
  if (a === 1) return b;
  if (b === 1) return a;
  if (a === 0 || b === 0) return 0;
  return { type: "minecraft:mul", argument1: a, argument2: b };
}
var sub = (a, b) => add(a, mul(-1, b));
var mn = (a, b) => ({ type: "minecraft:min", argument1: a, argument2: b });
var mx = (a, b) => ({ type: "minecraft:max", argument1: a, argument2: b });
var clamp = (v, lo, hi) => ({ type: "minecraft:clamp", input: v, min: lo, max: hi });
var abs_ = (v) => ({ type: "minecraft:abs", argument: v });
var square = (v) => ({ type: "minecraft:square", argument: v });
var flat = (v) => ({ type: "minecraft:flat_cache", argument: v });
var cache2d = (v) => ({ type: "minecraft:cache_2d", argument: v });
function noise2(name, xzScale = 1, yScale = 0) {
  return { type: "minecraft:noise", noise: name, xz_scale: xzScale, y_scale: yScale };
}
function shiftedNoise(name, xzScale, yScale, shiftX, shiftY, shiftZ) {
  return {
    type: "minecraft:shifted_noise",
    noise: name,
    xz_scale: xzScale,
    y_scale: yScale,
    shift_x: shiftX,
    shift_y: shiftY,
    shift_z: shiftZ
  };
}
function rangeChoice(value, lo, hi, inside, outside) {
  return {
    type: "minecraft:range_choice",
    input: value,
    min_inclusive: lo,
    max_exclusive: hi,
    when_in_range: inside,
    when_out_of_range: outside
  };
}
var pt = (location, value, derivative = 0) => ({
  location,
  value,
  derivative
});
var spline = (coordinate, points) => ({
  type: "minecraft:spline",
  spline: { coordinate, points }
});
var nested = (coordinate, points) => ({ coordinate, points });
var asDF = (value) => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value;
    if ("coordinate" in obj && !("type" in obj)) {
      return { type: "minecraft:spline", spline: obj };
    }
  }
  return value;
};
var round8 = (v) => Number(v.toFixed(8));

// src/pack/builder.ts
var NS = "mwg";
var BLOCKS = BLOCKS_PER_OFFSET;
var cfgRef = (name) => `${NS}:config/${name}`;
function roundHalfEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
var scaled = (constName, value) => nested(cfgRef(constName), [pt(0, 0, value)]);
var FLOOR_GUARD = { from_y: -64, to_y: -40, from_value: 0, to_value: 1 };
var CEILING_FADE = { from_y: 240, to_y: 256, from_value: 1, to_value: 0 };
function moveDensityGuards(router, buildMinY, buildMaxY, terrainMaxY) {
  const floor = [buildMinY, buildMinY + 24];
  const fade = [terrainMaxY, Math.min(buildMaxY, terrainMaxY + 16)];
  let moved = 0;
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const obj = node;
    if (obj.type === "minecraft:y_clamped_gradient") {
      const matches = (want) => Object.keys(want).every((k) => obj[k] === want[k]);
      if (matches(FLOOR_GUARD)) {
        [obj.from_y, obj.to_y] = floor;
        moved++;
      } else if (matches(CEILING_FADE)) {
        [obj.from_y, obj.to_y] = fade;
        moved++;
      }
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(router.final_density);
  if (moved !== 2) {
    throw new Error(`expected vanilla's two height guards in final_density, found ${moved}`);
  }
}
var surfaceBand = (low, high, heightmap = "WORLD_SURFACE_WG") => ({
  type: "minecraft:surface_relative_threshold_filter",
  heightmap,
  min_inclusive: -high,
  max_inclusive: -low
});
async function buildPack(input, packName = "MineWorldGen") {
  const { mode, cfg, adjustments } = normalise(input);
  const files = /* @__PURE__ */ new Map();
  const write = (path, value) => {
    files.set(path, JSON.stringify(value, null, 2) + "\n");
  };
  const packMeta = (label) => ({
    pack: {
      description: [
        { text: "MineWorldGen", color: "#4fc3f7" },
        { text: `
${label} - Minecraft ${MINECRAFT_VERSION}`, color: "gray" }
      ],
      pack_format: PACK_FORMAT,
      min_format: PACK_FORMAT,
      max_format: PACK_FORMAT,
      supported_formats: { min_inclusive: PACK_FORMAT, max_inclusive: PACK_FORMAT }
    }
  });
  if (mode !== "custom") {
    write("pack.mcmeta", packMeta("vanilla fallback"));
    write(`data/${NS}/worldgen/density_function/unused.json`, { type: "minecraft:constant", argument: 0 });
    return {
      files,
      adjustments,
      notes: {
        mode: "vanilla",
        minecraft_version: MINECRAFT_VERSION,
        note: "no world generation files are written; terrain is 100% vanilla"
      }
    };
  }
  const world = cfg.world;
  const cont = cfg.continents;
  const isl = cfg.islands;
  const oceans = cfg.oceans;
  const coast = cfg.coast;
  const rivers = cfg.rivers;
  const seas = cfg.inland_seas;
  const fjords = cfg.fjords;
  const biomes = cfg.biomes;
  const seaLevel = world.sea_level;
  const buildMinY = world.build_min_y;
  const buildHeight = world.build_height;
  const buildMaxY = buildMinY + buildHeight;
  const depthTop = buildHeight / 256;
  const baseOffset = -(depthTop - (seaLevel - buildMinY) / BLOCKS);
  const maxOffset = (world.terrain_max_y - seaLevel) / BLOCKS;
  const minOffset = (world.terrain_min_y - seaLevel) / BLOCKS;
  const width = cont.width;
  const height = cont.height;
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const probeLand = cont.ocean_offset === null || cont.ocean_offset === void 0 ? cont.land_ratio : landRatioForOceanOffset(cont.ocean_offset);
  const continentScale = continentScaleForSize(short, probeLand);
  const stretch = long / short;
  const blurR = blurForStretch(stretch);
  const blurAxis = width >= height ? "x" : "z";
  const blurGain2 = blurGain(blurR);
  const blurWidth = blurR * continentBaseWavelength / continentScale;
  const meanSize = Math.sqrt(width * height);
  const sizeFactor = meanSize / VANILLA_CONTINENT_SIZE;
  const oceanOffset = cont.ocean_offset === null || cont.ocean_offset === void 0 ? oceanOffsetForLandRatio(cont.land_ratio) : cont.ocean_offset;
  const widthAmp = ampForPercent(cont.width_variation_percent);
  const heightAmp = ampForPercent(cont.height_variation_percent);
  const islandScale = islandScaleForSize(isl.size);
  const islandClusterScale = islandScale * 0.32;
  const islandArcScale = islandScale * 0.22;
  const islandTypeScale = islandScale * 0.45;
  const bands = [];
  let cursor2 = 0;
  for (const [name, share] of [
    ["atoll", isl.atoll_chance],
    ["volcano", isl.volcanic_chance],
    ["cliff", isl.cliff_chance]
  ]) {
    if (share > 0) {
      const lo2 = islandTypeThreshold(cursor2);
      cursor2 += share;
      bands.push([name, lo2, islandTypeThreshold(cursor2)]);
    }
  }
  const centerType = String(cfg.center.type);
  const centerRadius = Number(cfg.center.radius);
  const centerThreshold2 = centerThreshold(centerRadius);
  let climateFactor = biomes.temperature_scale;
  let vegFactor = biomes.vegetation_scale;
  if (biomes.scale_with_continents) {
    climateFactor *= sizeFactor;
    vegFactor *= sizeFactor;
  }
  let caveFactor = cfg.caves.size_multiplier;
  if (cfg.caves.scale_with_continents) {
    caveFactor *= Math.min(2.5, Math.max(0.5, sizeFactor ** 0.35));
  }
  let structureFactor = cfg.structures.spacing_multiplier;
  if (cfg.structures.scale_with_continents) {
    structureFactor *= Math.min(6, Math.max(0.4, sizeFactor ** 0.5));
  }
  const df = (name, value) => {
    write(`data/${NS}/worldgen/density_function/${name}.json`, value);
    return `${NS}:${name}`;
  };
  const noiseDef = (name, firstOctave, amplitudes) => {
    write(`data/${NS}/worldgen/noise/${name}.json`, { firstOctave, amplitudes });
  };
  const constant = (name, value) => {
    write(`data/${NS}/worldgen/density_function/config/${name}.json`, {
      type: "minecraft:constant",
      argument: round8(value)
    });
  };
  const radialCells = (name, widthBlocks, coverage, crossings = 3) => {
    const cut = cellCut(crossings, coverage);
    const scale2 = cellScale(crossings, coverage, widthBlocks);
    const parts = [];
    for (let index = 0; index < crossings; index++) {
      const noiseName = `cell/${name}_${index}`;
      noiseDef(noiseName, -6, [1]);
      parts.push(square(noise2(`${NS}:${noiseName}`, scale2, 0)));
    }
    return [df(`cell/${name}`, flat(cache2d(addAll(...parts)))), cut];
  };
  const blur = (makeSample, axis, widthBlocks, taps, scale2) => {
    if (taps <= 1 || widthBlocks <= 0) return makeSample(0, 0);
    const spacing = widthBlocks / (taps - 1);
    let total = 0;
    for (let i = 0; i < taps; i++) {
      const shift = (i - (taps - 1) / 2) * spacing * scale2;
      total = add(total, axis === "x" ? makeSample(shift, 0) : makeSample(0, shift));
    }
    return mul(round8(1 / taps), total);
  };
  const byIslandType = (overrides, fallback) => {
    if (bands.length === 0) return asDF(fallback);
    const points = [pt(-1.4, overrides[bands[0][0]] ?? fallback, 0)];
    for (const [name, lo2, hi2] of bands) {
      const value = overrides[name] ?? fallback;
      points.push(pt(lo2, value, 0), pt(hi2 - 2e-3, value, 0), pt(hi2, fallback, 0));
    }
    points.push(pt(1.4, fallback, 0));
    const cleaned = [];
    for (const point of points) {
      const previous = cleaned[cleaned.length - 1];
      cleaned.push(
        previous && point.location <= previous.location ? { ...point, location: Number((previous.location + 1e-4).toFixed(6)) } : point
      );
    }
    return spline(`${NS}:noise/island_type`, cleaned);
  };
  constant("ocean_offset", oceanOffset);
  constant("max_offset", maxOffset);
  constant("min_offset", minOffset);
  constant("vertical_scale", world.vertical_scale);
  constant("ocean_depth", -Math.abs(oceans.ocean_depth_blocks) / BLOCKS);
  constant("deep_ocean_depth", -Math.abs(oceans.deep_ocean_depth_blocks) / BLOCKS);
  constant("seafloor_relief", oceans.seafloor_relief);
  constant("trench_depth", oceans.trenches ? Math.abs(oceans.trench_depth_blocks) / BLOCKS : 0);
  constant("mountain_strength", cont.mountain_ranges);
  constant("plateau_strength", cont.plateaus);
  constant("tepui_strength", cont.tepui);
  constant("rolling_hills", cont.rolling_hills ? 1 : 0);
  constant("flat_terrain_skew", cont.flat_terrain_skew);
  constant("river_depth", rivers.enabled ? Math.abs(rivers.depth_blocks) / BLOCKS : 0);
  constant("fjord_depth", fjords.enabled ? Math.abs(fjords.depth_blocks) / BLOCKS : 0);
  constant("inland_sea_depth", seas.enabled ? Math.abs(seas.depth_blocks) / BLOCKS : 0);
  constant("island_frequency", isl.enabled ? isl.frequency : 0);
  constant("island_offset", isl.noise_offset);
  constant("arc_strength", isl.arc_strength);
  constant("coast_cliffs", coast.cliffs);
  constant("sea_stacks", coast.sea_stacks);
  constant("columnar_jointing", coast.columnar_jointing);
  constant("width_variation", widthAmp);
  constant("height_variation", heightAmp);
  constant("temperature_multiplier", biomes.temperature_multiplier);
  constant("temperature_offset", biomes.temperature_offset);
  constant("vegetation_multiplier", biomes.vegetation_multiplier);
  constant("vegetation_offset", biomes.vegetation_offset);
  const centerStrength = { continent: 0.95, island: 0.8, archipelago: -0.72, ocean: -1.2, default: 0 }[centerType] ?? 0;
  constant("center_strength", centerStrength * Number(cfg.center.strength));
  noiseDef("parameter/continentalness", -10, [1.75, 1, 2, 3, 2, 2, 1, 1, 1]);
  noiseDef("parameter/erosion", -10, [2, 1.75, 1.5, 1.5, 1.3, 1, 1, 1, 1]);
  noiseDef("parameter/ridge", -8, [1, 2, 1]);
  noiseDef("size_bias/width", -10, [1, 0.6]);
  noiseDef("size_bias/height", -10, [1, 0.6]);
  noiseDef("island/a", -8, [2, 1, 2, 3, 2, 2]);
  noiseDef("island/b", -8, [2, 1, 2, 3, 2, 2]);
  noiseDef("island/cluster", -9, [1, 0.7, 0.4]);
  noiseDef("island/arc", -10, [1, 0.35]);
  noiseDef("island/type", -9, [1, 1]);
  noiseDef("island/erosion", -9, [1, 1, 0, 1, 1]);
  noiseDef("island/ridge", -7, [1, 2, 1, 0, 0, 0]);
  noiseDef("mountain/base", -9, [1, 0.4, 0.2]);
  noiseDef("mountain/detail", -7, [0.3, 1, 0.5]);
  noiseDef("mountain/warp", -8, [1, 0.5]);
  noiseDef("region/selector", -11, [1, 2.1, 1.5, 1.7, 1.4, 2, 2]);
  noiseDef("region/plateau", -9, [1, 1, 0.5]);
  noiseDef("region/tepui", -9, [1, 0.6, 0.25]);
  noiseDef("coast/fjord", -6, [1, 0.6]);
  noiseDef("ocean/floor_a", -7, [1, 1, 0.6]);
  noiseDef("ocean/floor_b", -5, [1, 0.7]);
  noiseDef("ocean/trench", -10, [1, 0.4]);
  noiseDef("inland_sea", -10, [1, 0.5, 0.25]);
  if (centerType !== "default") {
    for (let i = 1; i <= 4; i++) noiseDef(`center/ring${i}`, -10 - i, [1, 0.25]);
  }
  const scale = round8(continentScale);
  const sample = (shiftX, shiftZ) => shiftedNoise(
    `${NS}:parameter/continentalness`,
    scale,
    0,
    add(Number(shiftX.toFixed(6)), "minecraft:shift_x"),
    0,
    add(Number(shiftZ.toFixed(6)), "minecraft:shift_z")
  );
  df(
    "noise/continent_raw",
    flat(cache2d(mul(Number(blurGain2.toFixed(6)), blur(sample, blurAxis, blurWidth, anisotropyTaps, continentScale))))
  );
  const biasTerms = [];
  for (const [axis, constName, noiseName, amp] of [
    ["width", "width_variation", `${NS}:size_bias/width`, widthAmp],
    ["height", "height_variation", `${NS}:size_bias/height`, heightAmp]
  ]) {
    if (amp <= 0) continue;
    const biasAxis = axis === "width" ? "z" : "x";
    const biasScale = continentScale * 0.45;
    const biasWidth = 1.6 * continentBaseWavelength / biasScale;
    const biasGain = blurGain(1.6);
    const make = (shiftX, shiftZ) => shiftedNoise(noiseName, round8(biasScale), 0, Number(shiftX.toFixed(6)), 0, Number(shiftZ.toFixed(6)));
    biasTerms.push(mul(cfgRef(constName), mul(Number(biasGain.toFixed(6)), blur(make, biasAxis, biasWidth, 9, biasScale))));
  }
  df("noise/size_bias", biasTerms.length ? flat(cache2d(addAll(...biasTerms))) : 0);
  if (centerType === "default") {
    df("center/mask", 0);
    df("center/bias", 0);
  } else {
    const delta = centerRingDelta;
    let rings = 0;
    for (let i = 1; i <= 4; i++) {
      const base = 0.75 + 0.05 * i;
      rings = add(
        rings,
        abs_(
          sub(
            noise2(`${NS}:center/ring${i}`, Number(base.toFixed(6)), 0),
            noise2(`${NS}:center/ring${i}`, round8(base * (1 - delta)), 0)
          )
        )
      );
    }
    df(
      "center/mask",
      flat(
        cache2d(
          spline(mul(0.25, rings), [
            pt(0, 1, 0),
            pt(Number((centerThreshold2 * 0.55).toFixed(6)), 1, 0),
            pt(Number(centerThreshold2.toFixed(6)), 0, 0)
          ])
        )
      )
    );
    df("center/bias", mul(`${NS}:center/mask`, cfgRef("center_strength")));
  }
  const landShape = spline(abs_(`${NS}:noise/continent_raw`), [pt(0, 0, 0), pt(0.4, 0.575, 1), pt(0.48, 0.68, 1)]);
  df(
    "noise/raw_continents",
    flat(
      cache2d(
        clamp(addAll(cfgRef("ocean_offset"), `${NS}:noise/size_bias`, `${NS}:center/bias`, landShape), -1, 2)
      )
    )
  );
  df("selector/island", flat(cache2d(rangeChoice(`${NS}:noise/raw_continents`, -1, -0.5, 1, 0))));
  df("selector/continent", flat(cache2d(sub(1, `${NS}:selector/island`))));
  if (seas.enabled && seas.frequency > 0 && seas.depth_blocks > 0) {
    const seaScale = continentScaleForSize(seas.size, cont.land_ratio);
    const [shore, deep2] = inlandSeaBand(seas.frequency);
    const bias = spline(`${NS}:noise/raw_continents`, [
      pt(0.02, -1.2, 0),
      pt(0.18, 0, 0),
      // full bias by 0.34: a seed whose continents are small never reaches the
      // high continentalness of a big landmass, and it is exactly those seeds
      // that used to come out with no seas at all
      pt(0.34, INLAND_SEA_INTERIOR_BIAS, 0)
    ]);
    const field = add(noise2(`${NS}:inland_sea`, round8(seaScale), 0), bias);
    df("water/inland_sea", flat(cache2d(spline(field, [pt(shore, 0, 0), pt(deep2, 1, 0)]))));
  } else {
    df("water/inland_sea", 0);
  }
  const islandScaleR = round8(islandScale);
  df(
    "noise/island_core",
    flat(
      cache2d(
        add(mx(noise2(`${NS}:island/a`, islandScaleR, 0), noise2(`${NS}:island/b`, islandScaleR, 0)), cfgRef("island_offset"))
      )
    )
  );
  const clustering = isl.clustering;
  const lo = -1 + 1.35 * clustering;
  const hi = lo + Math.max(0.12, 0.55 * (1 - clustering));
  const cluster = spline(noise2(`${NS}:island/cluster`, round8(islandClusterScale), 0), [
    pt(Number(lo.toFixed(4)), 0, 0),
    pt(Number(hi.toFixed(4)), 1, 0)
  ]);
  const arc = spline(abs_(noise2(`${NS}:island/arc`, round8(islandArcScale), 0)), [pt(0, 1, 0), pt(0.09, 0, 0)]);
  df(
    "noise/island_gate",
    flat(cache2d(clamp(mul(cfgRef("island_frequency"), mul(cluster, add(1, mul(cfgRef("arc_strength"), arc)))), 0, 1.7)))
  );
  const falloff2 = spline(`${NS}:noise/raw_continents`, [
    pt(-0.802, 0.7, 0),
    pt(-0.8, 0.7, -1),
    pt(-0.5, 0, -2.5),
    pt(-0.498, 0, 0)
  ]);
  df(
    "noise/raw_islands",
    flat(cache2d(add(mul(mul(`${NS}:noise/island_core`, `${NS}:noise/island_gate`), falloff2), -0.7)))
  );
  df("noise/island_type", flat(cache2d(noise2(`${NS}:island/type`, round8(islandTypeScale), 0))));
  const atollShape = nested(`${NS}:noise/raw_islands`, [
    pt(-1, -1, 1),
    pt(-0.3, -0.3, 0.6),
    pt(-0.16, 0.04, 0),
    pt(-0.04, 0.06, 0),
    pt(0.06, -0.22, 0),
    pt(0.45, -0.3, 0)
  ]);
  const plainShape = nested(`${NS}:noise/raw_islands`, [pt(0, 0, 1)]);
  df("noise/islands_shaped", flat(cache2d(byIslandType({ atoll: atollShape }, plainShape))));
  const continentPart = spline(`${NS}:noise/raw_continents`, [pt(0.05, 0.05, 1), pt(0.175, 0.3, 1)]);
  const seaPull = mul(-0.55, `${NS}:water/inland_sea`);
  df(
    "noise/full_continents",
    flat(
      cache2d(
        add(
          mul(`${NS}:selector/island`, `${NS}:noise/islands_shaped`),
          mul(`${NS}:selector/continent`, add(continentPart, seaPull))
        )
      )
    )
  );
  const erosionScale = continentScale * 2.4 / cont.erosion_scale;
  const ridgeScale = continentScale * 3.2 / cont.ridge_scale;
  const warp = mul(2.4, noise2(`${NS}:mountain/warp`, round8(continentScale * 1.1), 0));
  const ridgeLine = spline(
    abs_(shiftedNoise(`${NS}:mountain/base`, round8(continentScale * 1.8), 0, warp, 0, mul(-1, warp))),
    // Vanilla keeps 9% of land in its mountainous erosion band; a 0.30 cut-off
    // put 54% of land inside a "range".
    [pt(0, 1, 0), pt(0.16, 0, 0)]
  );
  const detail = spline(abs_(noise2(`${NS}:mountain/detail`, round8(continentScale * 1.5), 0)), [
    pt(0, 1, 0),
    pt(0.55, 0.62, 0)
  ]);
  df("mountain/ridges", flat(cache2d(mul(ridgeLine, detail))));
  df(
    "erosion/continents",
    flat(
      cache2d(
        clamp(
          addAll(
            mul(0.78, noise2(`${NS}:parameter/erosion`, round8(erosionScale), 0)),
            0.12,
            // -1.35 pushed erosion past its clamp over most land, flattening it
            // into one terrain type with abrupt edges. Vanilla erosion on land
            // averages -0.055.
            mul(-0.75, mul(cfgRef("mountain_strength"), `${NS}:mountain/ridges`))
          ),
          -1,
          1
        )
      )
    )
  );
  const islandErosion = byIslandType(
    {
      cliff: nested(`${NS}:noise/raw_islands`, [pt(-0.3, -0.35, 0), pt(0.05, -0.95, 0)]),
      volcano: nested(`${NS}:noise/raw_islands`, [pt(-0.3, -0.25, 0), pt(0.05, -0.8, 0)]),
      atoll: 0.62
    },
    nested(abs_(noise2(`${NS}:island/erosion`, round8(islandScale * 1.6), 0)), [pt(0, -0.15, 0), pt(0.6, 0.55, 0)])
  );
  df("erosion/islands", flat(cache2d(clamp(islandErosion, -1, 1))));
  df(
    "biome/erosion",
    flat(
      cache2d(
        add(
          mul(`${NS}:selector/island`, `${NS}:erosion/islands`),
          mul(`${NS}:selector/continent`, `${NS}:erosion/continents`)
        )
      )
    )
  );
  df(
    "biome/ridges",
    flat(
      cache2d(
        clamp(
          add(
            mul(`${NS}:selector/island`, noise2(`${NS}:island/ridge`, round8(islandScale * 2.2), 0)),
            mul(`${NS}:selector/continent`, noise2(`${NS}:parameter/ridge`, round8(ridgeScale), 0))
          ),
          -1,
          1
        )
      )
    )
  );
  df(
    "biome/ridges_folded",
    flat(
      cache2d(
        mul(-3, add(-0.3333333333333333, abs_(add(-0.6666666666666666, abs_(`${NS}:biome/ridges`)))))
      )
    )
  );
  const tempScale = 0.25 / Math.max(0.05, climateFactor);
  const vegScale = 0.25 / Math.max(0.05, vegFactor);
  df(
    "climate/temperature",
    flat(
      cache2d(
        clamp(
          addAll(
            cfgRef("temperature_offset"),
            mul(
              cfgRef("temperature_multiplier"),
              shiftedNoise("minecraft:temperature", round8(tempScale), 0, "minecraft:shift_x", 0, "minecraft:shift_z")
            ),
            // atolls and volcanic islands belong in warm water
            mul(`${NS}:selector/island`, byIslandType({ atoll: 0.35, volcano: 0.15 }, 0))
          ),
          -2,
          2
        )
      )
    )
  );
  df(
    "climate/vegetation",
    flat(
      cache2d(
        clamp(
          add(
            cfgRef("vegetation_offset"),
            mul(
              cfgRef("vegetation_multiplier"),
              shiftedNoise("minecraft:vegetation", round8(vegScale), 0, "minecraft:shift_x", 0, "minecraft:shift_z")
            )
          ),
          -2,
          2
        )
      )
    )
  );
  const folded = `${NS}:biome/ridges_folded`;
  if (rivers.enabled && rivers.depth_blocks > 0) {
    const band = Math.min(0.55, 0.15 * rivers.width);
    const channel = spline(folded, [pt(-1, 1, 0), pt(Number((-1 + band).toFixed(4)), 0, 0)]);
    const inland2 = spline(`${NS}:noise/raw_continents`, [pt(-0.06, 0, 0), pt(0.04, 1, 0)]);
    df("water/river", flat(cache2d(mul(channel, inland2))));
  } else {
    df("water/river", 0);
  }
  if (fjords.enabled && fjords.depth_blocks > 0 && fjords.frequency > 0) {
    const band = Math.min(0.55, 0.42 * fjords.width);
    const channel = spline(folded, [pt(-1, 1, 0), pt(Number((-1 + band).toFixed(4)), 0, 0)]);
    const steep = spline(`${NS}:biome/erosion`, [pt(-0.3, 1, 0), pt(0.15, 0, 0)]);
    const coastal = spline(`${NS}:terrain/base_offset`, [
      pt(-0.16, 0, 0),
      pt(-0.04, 1, 0),
      pt(0.45, 1, 0),
      pt(0.75, 0, 0)
    ]);
    const picker = spline(abs_(noise2(`${NS}:coast/fjord`, round8(continentScale * 2.5), 0)), [
      pt(0, 1, 0),
      pt(Number((0.12 + 0.62 * fjords.frequency).toFixed(4)), 0, 0)
    ]);
    df("water/fjord", flat(cache2d(mul(mul(channel, steep), mul(coastal, picker)))));
  } else {
    df("water/fjord", 0);
  }
  df(
    "water/carve",
    flat(
      cache2d(
        mul(
          -1,
          mul(cfgRef("river_depth"), `${NS}:water/river`)
        )
      )
    )
  );
  const mountains = nested(folded, [
    pt(-1, scaled("mountain_strength", 0.3), 0),
    pt(-0.2, scaled("mountain_strength", 0.52), 0),
    pt(0.45, scaled("mountain_strength", 0.86), 0),
    pt(1, scaled("mountain_strength", 1.16), 0)
  ]);
  const highHills = nested(folded, [
    pt(-1, 0.18, 0),
    pt(0.2, 0.38, 0),
    pt(1, scaled("mountain_strength", 0.62), 0)
  ]);
  const plateau = nested(noise2(`${NS}:region/plateau`, round8(continentScale * 3.6), 0), [
    pt(-0.6, 0.11, 0),
    pt(-0.16, 0.12, 0),
    pt(-0.1, scaled("plateau_strength", 0.34), 0),
    pt(0.18, scaled("plateau_strength", 0.36), 0),
    pt(0.24, scaled("plateau_strength", 0.62), 0),
    pt(0.6, scaled("plateau_strength", 0.65), 0)
  ]);
  const plateauField = df(
    "terrain/plateau_field",
    flat(cache2d(noise2(`${NS}:region/tepui`, round8(continentScale * 0.85), 0)))
  );
  const tepui = nested(plateauField, [
    pt(0.1, 0.16, 0),
    pt(0.3, 0.3, 0),
    pt(0.46, scaled("tepui_strength", 0.78), 0),
    pt(0.62, scaled("tepui_strength", 0.86), 0),
    pt(1, scaled("tepui_strength", 0.92), 0)
  ]);
  const plateauOrTepui = nested(plateauField, [pt(0.18, plateau, 0), pt(0.3, tepui, 0)]);
  const rolling = nested(noise2(`${NS}:region/plateau`, round8(continentScale * 7), 0), [
    pt(-0.6, 0.055, 0),
    pt(0, scaled("rolling_hills", 0.135), 0),
    pt(0.6, 0.06, 0)
  ]);
  const skew = cont.flat_terrain_skew;
  const plateauEdge = Number((0.05 + (skew - 0.1) * 1.5).toFixed(4));
  const inland = nested(`${NS}:biome/erosion`, [
    pt(-1, mountains, 0),
    pt(-0.58, mountains, 0),
    pt(-0.45, highHills, 0),
    pt(-0.22, plateauOrTepui, 0),
    pt(plateauEdge, plateauOrTepui, 0),
    pt(Number((plateauEdge + 0.11).toFixed(4)), rolling, 0),
    pt(0.55, 0.055, 0),
    pt(1, 0.035, 0)
  ]);
  const nearInland = nested(`${NS}:biome/erosion`, [
    pt(-1, nested(folded, [pt(-0.4, 0.2, 0), pt(1, scaled("mountain_strength", 0.7), 0)]), 0),
    pt(-0.45, 0.22, 0),
    pt(-0.1, 0.14, 0),
    pt(0.4, 0.055, 0),
    pt(1, 0.03, 0)
  ]);
  const coastProfile = nested(`${NS}:biome/erosion`, [
    pt(-1, scaled("coast_cliffs", 0.52), 0),
    pt(-0.35, scaled("coast_cliffs", 0.3), 0),
    pt(-0.05, 0.045, 0),
    pt(1, 0.01, 0)
  ]);
  const deep = nested(cfgRef("deep_ocean_depth"), [pt(0, 0, 1)]);
  const shelf = nested(cfgRef("ocean_depth"), [pt(0, 0, 1)]);
  df(
    "terrain/offset_continents",
    flat(
      cache2d(
        spline(`${NS}:noise/raw_continents`, [
          pt(-0.6, deep, 0),
          pt(-0.42, deep, 0),
          pt(-0.3, shelf, 0),
          pt(-0.2, nested(cfgRef("ocean_depth"), [pt(0, 0, 0.35)]), 0),
          pt(-0.13, coastProfile, 0),
          pt(-0.02, nearInland, 0),
          pt(0.14, inland, 0),
          pt(0.7, inland, 0)
        ])
      )
    )
  );
  const normalIsland = nested(`${NS}:noise/raw_islands`, [
    pt(-0.72, shelf, 0),
    pt(-0.46, -0.156, 0),
    pt(-0.24, -0.055, 0),
    pt(-0.07, -0.014, 0),
    pt(0.05, 0.035, 0),
    pt(0.16, 0.135, 0),
    pt(0.4, 0.34, 0)
  ]);
  const [atollCells, atollCut] = radialCells("atoll", isl.size, 0.1, 2);
  const atollIsland = nested(atollCells, [
    pt(0, -0.0938, 0),
    pt(round8(0.58 * atollCut), -0.0898, 0),
    pt(round8(0.68 * atollCut), 0.1562, 0),
    pt(round8(0.92 * atollCut), 0.1328, 0),
    pt(round8(1 * atollCut), shelf, 0)
  ]);
  const volcanoIsland = nested(`${NS}:noise/raw_islands`, [
    pt(-0.72, shelf, 0),
    pt(-0.3, -0.07, 0),
    pt(-0.05, 0.22, 0),
    pt(0.12, scaled("mountain_strength", 0.95), 0),
    pt(0.22, scaled("mountain_strength", 1.42), 0),
    pt(0.27, scaled("mountain_strength", 1.5), 0),
    pt(0.32, scaled("mountain_strength", 1.28), 0)
  ]);
  const cliffIsland = nested(`${NS}:noise/raw_islands`, [
    pt(-0.72, shelf, 0),
    pt(-0.28, -0.08, 0),
    pt(-0.22, scaled("coast_cliffs", 0.55), 0),
    pt(0.02, scaled("mountain_strength", 0.95), 0),
    pt(0.36, scaled("mountain_strength", 1.4), 0)
  ]);
  df(
    "terrain/offset_islands",
    flat(cache2d(byIslandType({ atoll: atollIsland, volcano: volcanoIsland, cliff: cliffIsland }, normalIsland)))
  );
  const seamounts = spline(`${NS}:biome/ridges_folded`, [
    pt(-1, -0.07, 0),
    pt(-0.2, -0.02, 0),
    pt(0.25, 0.01, 0),
    pt(0.7, 0.105, 0),
    pt(1, 0.19, 0)
  ]);
  const roughness = spline(`${NS}:biome/erosion`, [pt(-1, 1, 0), pt(0, 0.55, 0), pt(1, 0.22, 0)]);
  const relief = mul(
    cfgRef("seafloor_relief"),
    add(
      seamounts,
      mul(
        roughness,
        add(mul(0.055, noise2(`${NS}:ocean/floor_a`, 0.55, 0)), mul(0.022, noise2(`${NS}:ocean/floor_b`, 1.4, 0)))
      )
    )
  );
  const trench = mul(
    mul(-1, cfgRef("trench_depth")),
    spline(abs_(noise2(`${NS}:ocean/trench`, round8(continentScale * 2), 0)), [pt(0, 1, 0), pt(0.05, 0, 0)])
  );
  const oceanMask = spline(`${NS}:noise/raw_continents`, [pt(-1, 1, 0), pt(-0.26, 1, 0), pt(-0.16, 0, 0)]);
  df("terrain/ocean_relief", flat(cache2d(mul(oceanMask, add(relief, trench)))));
  df(
    "terrain/coast_mask",
    flat(
      cache2d(
        spline(`${NS}:noise/raw_continents`, [pt(-0.34, 0, 0), pt(-0.26, 1, 0), pt(-0.11, 1, 0), pt(-0.04, 0, 0)])
      )
    )
  );
  const coastSteep = spline(`${NS}:biome/erosion`, [pt(-0.3, 1, 0), pt(0.1, 0, 0)]);
  const stackBand = spline(`${NS}:noise/raw_continents`, [
    pt(-0.32, 0, 0),
    pt(-0.26, 1, 0),
    pt(-0.17, 1, 0),
    pt(-0.12, 0, 0)
  ]);
  const [stackCells, stackCut] = radialCells("sea_stack", 22, 0.03);
  const seaStacks = mul(
    mul(cfgRef("sea_stacks"), mul(coastSteep, stackBand)),
    spline(stackCells, [
      pt(0, 0.2812, 0),
      pt(round8(0.62 * stackCut), 0.2734, 0),
      pt(round8(0.86 * stackCut), 0.1094, 0),
      pt(round8(1 * stackCut), 0, 0)
    ])
  );
  const [columnCells, columnCut] = radialCells("column", 9, 0.34);
  const columnar = mul(
    mul(cfgRef("columnar_jointing"), coastSteep),
    spline(columnCells, [
      pt(0, 0.1875, 0),
      pt(round8(0.7 * columnCut), 0.1836, 0),
      pt(round8(0.88 * columnCut), 0.0703, 0),
      pt(round8(1 * columnCut), 0, 0)
    ])
  );
  df("terrain/coast_features", flat(cache2d(mul(`${NS}:terrain/coast_mask`, add(seaStacks, columnar)))));
  const vscale = rangeChoice(`${NS}:terrain/offset_continents`, 0, 64, cfgRef("vertical_scale"), 1);
  const islandVscale = rangeChoice(`${NS}:terrain/offset_islands`, 0, 64, cfgRef("vertical_scale"), 1);
  df(
    "terrain/base_offset",
    flat(
      cache2d(
        addAll(
          mul(`${NS}:selector/continent`, mul(vscale, `${NS}:terrain/offset_continents`)),
          mul(`${NS}:selector/island`, mul(islandVscale, `${NS}:terrain/offset_islands`)),
          `${NS}:terrain/ocean_relief`,
          `${NS}:terrain/coast_features`
        )
      )
    )
  );
  const landformParts = [];
  const bareParts = [];
  const landformNotes = {};
  const landformBands = {};
  const volcano = cfg.volcanoes;
  if (volcano.enabled && volcano.frequency > 0 && volcano.height_blocks > 0) {
    const [cells, cut] = radialCells("volcano", volcano.size, volcano.frequency, 2);
    const height2 = volcano.height_blocks / BLOCKS;
    const crater = Math.min(volcano.crater_blocks / BLOCKS, height2 * 0.6);
    const profile = [
      [0, height2 - crater],
      [0.09, height2 - crater * 0.85],
      [0.2, height2],
      [0.4, height2 * 0.62],
      [0.7, height2 * 0.24],
      [1, 0]
    ];
    const cone = spline(cells, profile.map(([u, v]) => pt(round8(u * cut), Number(v.toFixed(6)), 0)));
    const onLand = spline(`${NS}:terrain/base_offset`, [pt(0, 0, 0), pt(0.05, 1, 0)]);
    landformParts.push(mul(onLand, cone));
    bareParts.push(
      mul(onLand, spline(cells, [pt(0, 1, 0), pt(round8(0.55 * cut), 1, 0), pt(cut, 0, 0)]))
    );
    landformBands.volcano = [
      Math.trunc(seaLevel),
      Math.trunc(seaLevel + volcano.height_blocks)
    ];
    landformNotes.volcanoes = {
      cut,
      base_blocks: volcano.size,
      height_blocks: volcano.height_blocks,
      crater_blocks: Number((crater * BLOCKS).toFixed(1))
    };
  }
  const karst = cfg.karst;
  if (karst.enabled && karst.frequency > 0 && karst.height_blocks > 0) {
    const [cells, cut] = radialCells("karst", karst.size, karst.frequency);
    const height2 = karst.height_blocks / BLOCKS;
    const profile = [
      [0, height2],
      [0.55, height2 * 0.96],
      [0.82, height2 * 0.42],
      [1, 0]
    ];
    const tower = spline(cells, profile.map(([u, v]) => pt(round8(u * cut), Number(v.toFixed(6)), 0)));
    const setting = String(karst.setting);
    let gate;
    if (setting === "land") {
      gate = spline(`${NS}:terrain/base_offset`, [pt(0, 0, 0), pt(0.04, 1, 0)]);
    } else if (setting === "sea") {
      gate = spline(`${NS}:terrain/base_offset`, [
        pt(-0.32, 0, 0),
        pt(-0.22, 1, 0),
        pt(-0.03, 1, 0),
        pt(0.02, 0, 0)
      ]);
    } else {
      gate = spline(`${NS}:terrain/base_offset`, [pt(-0.32, 0, 0), pt(-0.22, 1, 0), pt(2, 1, 0)]);
    }
    landformParts.push(mul(gate, tower));
    bareParts.push(
      mul(gate, spline(cells, [pt(0, 1, 0), pt(round8(0.7 * cut), 1, 0), pt(cut, 0, 0)]))
    );
    landformBands.karst = [
      Math.trunc(seaLevel - 16),
      Math.trunc(seaLevel + karst.height_blocks)
    ];
    landformNotes.karst = {
      cut,
      tower_blocks: karst.size,
      height_blocks: karst.height_blocks,
      setting
    };
  }
  df("terrain/landforms", landformParts.length ? flat(cache2d(addAll(...landformParts))) : 0);
  df("terrain/bare_rock", bareParts.length ? flat(cache2d(clamp(addAll(...bareParts), 0, 1))) : 0);
  const rawOffset = addAll(
    `${NS}:terrain/base_offset`,
    `${NS}:terrain/landforms`,
    `${NS}:water/carve`
  );
  let basined = rawOffset;
  for (const [field, depth] of [
    [`${NS}:water/fjord`, cfgRef("fjord_depth")],
    [`${NS}:water/inland_sea`, cfgRef("inland_sea_depth")]
  ]) {
    basined = add(mul(basined, sub(1, field)), mul(mul(-1, depth), field));
  }
  const body = add(round8(baseOffset), mx(mn(basined, cfgRef("max_offset")), cfgRef("min_offset")));
  write(
    "data/minecraft/worldgen/density_function/overworld/offset.json",
    flat(
      cache2d(
        add(
          mul({ type: "minecraft:blend_offset" }, sub(1, { type: "minecraft:blend_alpha" })),
          mul(body, { type: "minecraft:blend_alpha" })
        )
      )
    )
  );
  const inlandFactor = nested(`${NS}:biome/erosion`, [
    pt(-1, 1.05, 0),
    pt(-0.55, 1.9, 0),
    pt(-0.3, 4.4, 0),
    pt(-0.05, 6, 0),
    pt(0.35, 6.4, 0),
    pt(1, 6.6, 0)
  ]);
  const coastFactor = nested(cfgRef("coast_cliffs"), [pt(0, 5.6, 0), pt(1, 9.5, 0)]);
  write(
    "data/minecraft/worldgen/density_function/overworld/factor.json",
    flat(
      cache2d(
        spline(`${NS}:noise/raw_continents`, [
          pt(-0.6, 5.4, 0),
          pt(-0.24, coastFactor, 0),
          pt(-0.1, coastFactor, 0),
          pt(0.02, inlandFactor, 0),
          pt(0.7, inlandFactor, 0)
        ])
      )
    )
  );
  const jagInland = nested(`${NS}:biome/erosion`, [
    pt(-1, nested(folded, [pt(0, 0, 0), pt(1, scaled("mountain_strength", 0.62), 0)]), 0),
    pt(-0.5, nested(folded, [pt(0.2, 0, 0), pt(1, scaled("mountain_strength", 0.28), 0)]), 0),
    pt(-0.25, 0, 0),
    pt(1, 0, 0)
  ]);
  write(
    "data/minecraft/worldgen/density_function/overworld/jaggedness.json",
    flat(cache2d(spline(`${NS}:noise/raw_continents`, [pt(0, 0, 0), pt(0.16, jagInland, 0), pt(0.7, jagInland, 0)])))
  );
  write(
    "data/minecraft/worldgen/density_function/overworld/continents.json",
    flat(cache2d(add(`${NS}:noise/full_continents`, 0)))
  );
  write(
    "data/minecraft/worldgen/density_function/overworld/erosion.json",
    flat(cache2d(clamp(sub(`${NS}:biome/erosion`, mul(2, `${NS}:terrain/bare_rock`)), -1, 1)))
  );
  write(
    "data/minecraft/worldgen/density_function/overworld/ridges.json",
    flat(cache2d(add(`${NS}:biome/ridges`, 0)))
  );
  write(
    "data/minecraft/worldgen/density_function/overworld/depth.json",
    add(
      {
        type: "minecraft:y_clamped_gradient",
        from_y: buildMinY,
        to_y: buildMaxY,
        from_value: round8(depthTop),
        to_value: round8(-depthTop)
      },
      "minecraft:overworld/offset"
    )
  );
  const settings = await noiseSettings("overworld");
  settings.sea_level = Math.trunc(seaLevel);
  settings.noise.min_y = buildMinY;
  settings.noise.height = buildHeight;
  const router = settings.noise_router;
  moveDensityGuards(router, buildMinY, buildMaxY, Math.trunc(world.terrain_max_y));
  router.temperature = `${NS}:climate/temperature`;
  router.vegetation = `${NS}:climate/vegetation`;
  if (cfg.spawn.force_land_spawn) {
    for (const target of settings.spawn_target) {
      target.continentalness = [0.03, 1];
    }
  }
  write("data/minecraft/worldgen/noise_settings/overworld.json", settings);
  if (buildMinY !== -64 || buildHeight !== 384) {
    const dimension = await dimensionType("overworld");
    dimension.min_y = buildMinY;
    dimension.height = buildHeight;
    dimension.logical_height = buildHeight;
    write("data/minecraft/dimension_type/overworld.json", dimension);
  }
  if (Math.abs(caveFactor - 1) > 1e-3) {
    for (const name of CAVE_NOISES) {
      write(`data/minecraft/worldgen/noise/${name}.json`, scaleNoise(await noise(name), caveFactor));
    }
  }
  if (Math.abs(structureFactor - 1) > 1e-3) {
    for (const name of OVERWORLD_STRUCTURE_SETS) {
      const data = await structureSet(name);
      const placement = data.placement ?? {};
      const kind = String(placement.type ?? "");
      let changed = false;
      if (kind === "minecraft:random_spread") {
        const spacing = Number(placement.spacing ?? 1);
        const separation = Number(placement.separation ?? 0);
        if (spacing > 1) {
          const nextSpacing = Math.max(2, roundHalfEven(spacing * structureFactor));
          placement.spacing = nextSpacing;
          placement.separation = Math.min(nextSpacing - 1, Math.max(0, roundHalfEven(separation * structureFactor)));
          changed = true;
        }
      } else if (kind === "minecraft:concentric_rings") {
        placement.distance = Math.max(1, roundHalfEven(Number(placement.distance ?? 32) * structureFactor));
        placement.spread = Math.max(1, roundHalfEven(Number(placement.spread ?? 3) * structureFactor));
        changed = true;
      }
      if (changed) write(`data/minecraft/worldgen/structure_set/${name}.json`, data);
    }
  }
  if (cfg.spawn.force_land_spawn) {
    const sea = Math.trunc(seaLevel);
    const radii = [400, 900, 1800, 3200, 6e3, 11e3, 2e4, 36e3];
    files.set(
      `data/${NS}/function/spawn/load.mcfunction`,
      "# MineWorldGen - keeps players off the open ocean at spawn\nscoreboard objectives add mwg.try dummy\n\n"
    );
    files.set(
      `data/${NS}/function/spawn/tick.mcfunction`,
      "# runs only for players who have not been checked yet\nexecute as @a[tag=!mwg.spawn_ok] at @s run function mwg:spawn/check\n\n"
    );
    const check = [
      "# already on solid ground above sea level? then we are done",
      `execute if entity @s[y=${sea},dy=2048] unless block ~ ~ ~ water unless block ~ ~-1 ~ water run function mwg:spawn/settle`,
      "execute if entity @s[tag=mwg.spawn_ok] run return 0",
      "scoreboard players add @s mwg.try 1",
      ...radii.map((radius, index) => `execute if score @s mwg.try matches ${index + 1} run spreadplayers 0 0 1 ${radius} false @s`),
      `execute if score @s mwg.try matches ${radii.length + 1}.. run tag @s add mwg.spawn_ok`,
      ""
    ];
    files.set(`data/${NS}/function/spawn/check.mcfunction`, check.join("\n"));
    files.set(
      `data/${NS}/function/spawn/settle.mcfunction`,
      [
        "tag @s add mwg.spawn_ok",
        "scoreboard players reset @s mwg.try",
        "# the first player to find land also fixes the world spawn",
        "execute unless score #mwg.world mwg.try matches 1.. run setworldspawn ~ ~ ~",
        "scoreboard players set #mwg.world mwg.try 1",
        ""
      ].join("\n")
    );
    write("data/minecraft/tags/function/load.json", { values: [`${NS}:spawn/load`] });
    write("data/minecraft/tags/function/tick.json", { values: [`${NS}:spawn/tick`] });
  }
  let plateauNotes = null;
  const tepuiStrength = Number(cont.tepui ?? 0);
  if (tepuiStrength > 0) {
    const capY = roundHalfEven(seaLevel + BLOCKS * 0.86 * tepuiStrength);
    const top = Math.min(Math.trunc(world.terrain_max_y), capY + 24);
    const floor = Math.max(Math.trunc(world.terrain_min_y) + 8, capY - 96);
    const stamped = (name, block, radius, halfHeight, count, low, high) => {
      write(`data/${NS}/worldgen/configured_feature/${name}.json`, {
        type: "minecraft:disk",
        config: {
          state_provider: {
            fallback: { type: "minecraft:simple_state_provider", state: { Name: block } },
            rules: []
          },
          target: { type: "minecraft:matching_block_tag", tag: "minecraft:base_stone_overworld" },
          radius: {
            type: "minecraft:uniform",
            value: { min_inclusive: radius[0], max_inclusive: radius[1] }
          },
          half_height: halfHeight
        }
      });
      write(`data/${NS}/worldgen/placed_feature/${name}.json`, {
        feature: `${NS}:${name}`,
        placement: [
          { type: "minecraft:count", count },
          { type: "minecraft:in_square" },
          { type: "minecraft:height_range", height: { type: "minecraft:constant", value: { absolute: 0 } } },
          surfaceBand(low, high),
          { type: "minecraft:heightmap", heightmap: "WORLD_SURFACE_WG" },
          { type: "minecraft:biome" }
        ]
      });
    };
    stamped("plateau/cap", "minecraft:tuff", [5, 9], 3, 24, capY - 16, top);
    stamped("plateau/strata", "minecraft:deepslate", [4, 8], 4, 20, floor, capY - 12);
    plateauNotes = {
      cap_y: capY,
      cap_band: [capY - 16, top],
      strata_band: [floor, capY - 12],
      placed_features: [`${NS}:plateau/cap`, `${NS}:plateau/strata`],
      note: "these need a biome to reference them; 26.2 has no feature injection, so run tools/port_pack.py --inject on the decoration pack, or add the ids to your own biome files"
    };
  }
  const placeOnLandform = (name, feature, count, band, heightmap = "OCEAN_FLOOR_WG") => {
    write(`data/${NS}/worldgen/configured_feature/${name}.json`, feature);
    write(`data/${NS}/worldgen/placed_feature/${name}.json`, {
      feature: `${NS}:${name}`,
      placement: [
        { type: "minecraft:count", count },
        { type: "minecraft:in_square" },
        { type: "minecraft:height_range", height: { type: "minecraft:constant", value: { absolute: 0 } } },
        surfaceBand(band[0], band[1]),
        { type: "minecraft:heightmap", heightmap },
        { type: "minecraft:biome" }
      ]
    });
  };
  let volcanoNotes = null;
  const volcanoBand = landformBands.volcano;
  if (volcanoBand) {
    placeOnLandform(
      "volcano/resurface",
      {
        type: "minecraft:ore",
        config: {
          size: 64,
          discard_chance_on_air_exposure: 0,
          targets: [
            {
              target: { predicate_type: "minecraft:tag_match", tag: "minecraft:dirt" },
              state: { Name: "minecraft:blackstone" }
            },
            {
              target: { predicate_type: "minecraft:tag_match", tag: "minecraft:base_stone_overworld" },
              state: { Name: "minecraft:blackstone" }
            }
          ]
        }
      },
      90,
      volcanoBand
    );
    placeOnLandform(
      "volcano/flows",
      {
        type: "minecraft:simple_random_selector",
        config: {
          features: ["grass_block", "dirt", "coarse_dirt", "podzol", "sand", "gravel", "snow_block"].map(
            (target) => ({
              feature: {
                type: "minecraft:netherrack_replace_blobs",
                config: {
                  state: { Name: "minecraft:smooth_basalt" },
                  target: { Name: `minecraft:${target}` },
                  radius: { type: "minecraft:uniform", value: { min_inclusive: 7, max_inclusive: 12 } }
                }
              },
              placement: []
            })
          )
        }
      },
      40,
      volcanoBand
    );
    placeOnLandform(
      "volcano/pools",
      {
        type: "minecraft:disk",
        config: {
          state_provider: {
            fallback: {
              type: "minecraft:weighted_state_provider",
              entries: [
                { weight: 1, data: { Name: "minecraft:magma_block" } },
                { weight: 5, data: { Name: "minecraft:lava", Properties: { level: "0" } } }
              ]
            },
            rules: []
          },
          target: { type: "minecraft:matching_blocks", blocks: "minecraft:blackstone" },
          radius: { type: "minecraft:uniform", value: { min_inclusive: 2, max_inclusive: 5 } },
          half_height: 1
        }
      },
      16,
      // only the top third of the cone, which is where the crater is
      [volcanoBand[0] + Math.trunc((volcanoBand[1] - volcanoBand[0]) * 2 / 3), volcanoBand[1]],
      "OCEAN_FLOOR"
    );
    volcanoNotes = {
      band: volcanoBand,
      placed_features: ["resurface", "flows", "pools"].map((n) => `${NS}:volcano/${n}`)
    };
  }
  let karstNotes = null;
  const karstBand = landformBands.karst;
  if (karstBand) {
    placeOnLandform(
      "karst/face",
      {
        type: "minecraft:ore",
        config: {
          size: 48,
          discard_chance_on_air_exposure: 0,
          targets: ["minecraft:calcite", "minecraft:calcite", "minecraft:diorite", "minecraft:tuff"].map(
            (block) => ({
              target: { predicate_type: "minecraft:tag_match", tag: "minecraft:base_stone_overworld" },
              state: { Name: block }
            })
          )
        }
      },
      80,
      karstBand
    );
    karstNotes = {
      band: karstBand,
      placed_features: [`${NS}:karst/face`],
      cave_features: [
        "minecraft:dripstone_cluster",
        "minecraft:large_dripstone",
        "minecraft:pointed_dripstone"
      ],
      note: "the cave features are vanilla's own; inject them a second time to raise the chance of a limestone-style cave inside the towers"
    };
  }
  write("pack.mcmeta", packMeta("custom terrain"));
  return {
    files,
    adjustments,
    notes: {
      ...plateauNotes ? { plateau_stamping: plateauNotes } : {},
      ...volcanoNotes ? { volcano_stamping: volcanoNotes } : {},
      ...karstNotes ? { karst_stamping: karstNotes } : {},
      mode: "custom",
      minecraft_version: MINECRAFT_VERSION,
      pack_name: packName,
      sea_level: seaLevel,
      build_range: [buildMinY, buildMaxY],
      base_offset: Number(baseOffset.toFixed(6)),
      max_offset: Number(maxOffset.toFixed(6)),
      min_offset: Number(minOffset.toFixed(6)),
      continent_xz_scale: Number(continentScale.toFixed(6)),
      continent_stretch: Number(stretch.toFixed(4)),
      anisotropy_blur_blocks: Number(blurWidth.toFixed(1)),
      anisotropy_gain: Number(blurGain2.toFixed(5)),
      ocean_offset: Number(oceanOffset.toFixed(4)),
      predicted_land_ratio: landRatioForOceanOffset(oceanOffset),
      island_xz_scale: Number(islandScale.toFixed(6)),
      island_bands: bands,
      center_threshold: centerThreshold2,
      climate_scale_factor: Number(climateFactor.toFixed(4)),
      cave_scale_factor: Number(caveFactor.toFixed(4)),
      structure_spacing_factor: Number(structureFactor.toFixed(4)),
      file_count: files.size
    }
  };
}

// src/pack/zip.ts
var CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let c = 4294967295;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
async function deflateRaw(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}
function dosDateTime(date) {
  const time = date.getHours() << 11 | date.getMinutes() << 5 | date.getSeconds() >> 1;
  const day = date.getFullYear() - 1980 << 9 | date.getMonth() + 1 << 5 | date.getDate();
  return { time, date: day };
}
async function createZip(entries, modified = /* @__PURE__ */ new Date()) {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(modified);
  const staged = [];
  const chunks = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const nameBytes = encoder.encode(entry.path);
    const compressed = await deflateRaw(raw);
    const useDeflate = compressed !== null && compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 67324752, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 2048, true);
    view.setUint16(8, useDeflate ? 8 : 0, true);
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, crc32(raw), true);
    view.setUint32(18, payload.length, true);
    view.setUint32(22, raw.length, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    header.set(nameBytes, 30);
    staged.push({
      nameBytes,
      payload,
      crc: crc32(raw),
      rawSize: raw.length,
      method: useDeflate ? 8 : 0,
      offset
    });
    chunks.push(header, payload);
    offset += header.length + payload.length;
  }
  const directoryStart = offset;
  for (const item of staged) {
    const record = new Uint8Array(46 + item.nameBytes.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, 33639248, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 2048, true);
    view.setUint16(10, item.method, true);
    view.setUint16(12, time, true);
    view.setUint16(14, date, true);
    view.setUint32(16, item.crc, true);
    view.setUint32(20, item.payload.length, true);
    view.setUint32(24, item.rawSize, true);
    view.setUint16(28, item.nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, item.offset, true);
    record.set(item.nameBytes, 46);
    chunks.push(record);
    offset += record.length;
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 101010256, true);
  endView.setUint16(8, staged.length, true);
  endView.setUint16(10, staged.length, true);
  endView.setUint32(12, offset - directoryStart, true);
  endView.setUint32(16, directoryStart, true);
  chunks.push(end);
  return new Blob(chunks, { type: "application/zip" });
}

// src/main.ts
var state = createState(emptyProject());
function defaultScale(doc) {
  return Math.max(0.05, doc.map.width * 1.15 / 900);
}
function createState(doc) {
  const map = new MapModel(doc);
  return {
    doc,
    map,
    history: new History(),
    view: { scale: defaultScale(doc), centreX: doc.map.origin.x, centreZ: doc.map.origin.z },
    brush: { ...DEFAULT_BRUSH },
    activeLayer: "land",
    visible: /* @__PURE__ */ new Set(["land", "elevation"]),
    grid: true,
    contours: true,
    contourInterval: 16,
    analysis: null
  };
}
var $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
};
var canvas;
var previewUser;
var previewProcedural;
var cursor = null;
function draw() {
  const options = {
    visible: state.visible,
    activeLayer: state.activeLayer,
    grid: state.grid,
    contours: state.contours,
    contourInterval: state.contourInterval,
    seaLevel: state.doc.world.sea_level
  };
  renderMap(canvas, state.map, state.view, options);
  drawBrushRing();
}
function drawBrushRing() {
  if (!cursor || panning) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const radius = state.brush.size / 2 / state.view.scale;
  ctx.save();
  ctx.lineWidth = 1;
  const outline = (r) => {
    ctx.beginPath();
    if (state.brush.shape === "circle") {
      ctx.arc(cursor.px, cursor.py, r, 0, Math.PI * 2);
    } else if (state.brush.shape === "diamond") {
      ctx.moveTo(cursor.px, cursor.py - r);
      ctx.lineTo(cursor.px + r, cursor.py);
      ctx.lineTo(cursor.px, cursor.py + r);
      ctx.lineTo(cursor.px - r, cursor.py);
      ctx.closePath();
    } else {
      ctx.rect(cursor.px - r, cursor.py - r, r * 2, r * 2);
    }
    ctx.stroke();
  };
  if (state.brush.mode === "fill") {
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
  if (state.brush.slopeStrength > 0) {
    ctx.strokeStyle = "rgba(255,255,255,0.30)";
    outline(Math.max(1, radius * (1 - state.brush.slopeStrength)));
  }
  ctx.restore();
}
function fitView() {
  const scale = Math.max(state.doc.map.width / canvas.width, state.doc.map.height / canvas.height) * 1.12;
  state.view = {
    scale: Math.max(0.05, Math.min(4096, scale)),
    centreX: state.doc.map.origin.x,
    centreZ: state.doc.map.origin.z
  };
  draw();
}
function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = Math.max(320, Math.floor(rect.width));
  canvas.height = Math.max(320, Math.floor(rect.height));
  draw();
}
var painting = false;
var panning = false;
var panFrom = null;
var spaceHeld = false;
var touched = /* @__PURE__ */ new Map();
function canvasPixel(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    // the backing store is sized to the CSS box, but guard against a stale
    // resize by scaling anyway
    px: (event.clientX - rect.left) / rect.width * canvas.width,
    py: (event.clientY - rect.top) / rect.height * canvas.height
  };
}
function pixelToWorld(px, py) {
  return {
    x: state.view.centreX + (px - canvas.width / 2) * state.view.scale,
    z: state.view.centreZ + (py - canvas.height / 2) * state.view.scale
  };
}
function canvasToWorld(event) {
  const { px, py } = canvasPixel(event);
  return pixelToWorld(px, py);
}
function paintAt(event) {
  const { x, z } = canvasToWorld(event);
  applyBrush(state.map.layer(state.activeLayer), state.map, x, z, state.brush, touched);
  draw();
}
function updateHover(event) {
  const { x, z } = canvasToWorld(event);
  const { cx, cy } = state.map.worldToCell(x, z);
  const inside = cx >= 0 && cy >= 0 && cx < state.map.cols && cy < state.map.rows;
  const rows = [
    `X ${Math.round(x)}   Z ${Math.round(z)}`
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
    rows.push(`${t("layer.biome")}: ${biomeIndex > 0 ? state.map.biomePalette[biomeIndex] : "\u2014"}`);
    const active = FEATURE_FLAGS.filter((_, bit) => flags & 1 << bit).map((flag) => t(`feature.${flag}`));
    if (active.length) rows.push(`${t("layer.feature")}: ${active.join(", ")}`);
  }
  $("hover").textContent = rows.join("\n");
}
function endStroke() {
  if (!painting) return;
  painting = false;
  const stroke = finishStroke(state.map.layer(state.activeLayer), state.activeLayer, touched);
  if (stroke) {
    state.history.push(stroke);
    markPreviewsStale();
    if (state.activeLayer === "biome") buildLegend();
  }
  touched = /* @__PURE__ */ new Map();
  scheduleAutosave();
}
function endPan() {
  if (!panning) return;
  panning = false;
  panFrom = null;
  canvas.classList.remove("panning");
  draw();
  scheduleAutosave();
}
function zoomAt(px, py, factor) {
  const before = pixelToWorld(px, py);
  state.view.scale = Math.max(0.05, Math.min(4096, state.view.scale * factor));
  const after = pixelToWorld(px, py);
  state.view.centreX += before.x - after.x;
  state.view.centreZ += before.z - after.z;
  draw();
}
function bindCanvas() {
  canvas.addEventListener("pointerdown", (event) => {
    const wantsPan = event.button === 1 || event.button === 2 || event.button === 0 && spaceHeld;
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
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    painting = true;
    touched = /* @__PURE__ */ new Map();
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
  const release = () => {
    endStroke();
    endPan();
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", () => {
    cursor = null;
    if (!panning && !painting) draw();
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("auxclick", (event) => event.preventDefault());
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const { px, py } = canvasPixel(event);
      zoomAt(px, py, event.deltaY > 0 ? 1.15 : 1 / 1.15);
    },
    { passive: false }
  );
  window.addEventListener("keydown", (event) => {
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === "z" && !event.shiftKey) {
      event.preventDefault();
      if (state.history.undo(state.map)) draw();
      return;
    }
    if (ctrl && (event.key.toLowerCase() === "y" || event.shiftKey && event.key.toLowerCase() === "z")) {
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
      state.brush.size = Math.min(1e5, Math.round(state.brush.size * 1.3));
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
function syncBrushInputs() {
  const slider = $("brush-size");
  slider.value = String(Math.min(Number(slider.max), state.brush.size));
  $("brush-size-label").textContent = `${state.brush.size}`;
}
var LAYER_DEFAULT_VALUE = {
  land: 1,
  elevation: 0,
  // stored as hundredths. 0.35 is the middle of the vanilla "warm" band, and
  // unlike 0 it differs from the layer default, so the first stroke on a fresh
  // map actually does something
  temperature: 35,
  biome: 1,
  feature: 1
};
function selectLayer(id) {
  if (state.activeLayer !== id) {
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
function buildLegend() {
  const host = $("legend");
  host.innerHTML = "";
  const layer = state.activeLayer;
  const row = (colour, label, onPick) => {
    const item = document.createElement(onPick ? "button" : "div");
    item.className = onPick ? "legend-row pick" : "legend-row";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = css(colour);
    const text = document.createElement("span");
    text.className = "legend-label";
    text.textContent = label;
    item.append(swatch, text);
    if (onPick) item.onclick = onPick;
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
      row(temperatureColour(middle), `${t(band.key)}  ${band.from.toFixed(2)} \u2026 ${band.to.toFixed(2)}`, () => {
        state.brush.value = Math.round(middle * 100);
        buildBrushOptions();
      });
    }
  } else if (layer === "feature") {
    FEATURE_FLAGS.forEach((flag, bit) => {
      row(featureColour(flag), t(`feature.${flag}`), () => pickValue(1 << bit));
    });
  } else {
    const used = /* @__PURE__ */ new Set();
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
function pickValue(value) {
  state.brush.value = value;
  buildBrushOptions();
  draw();
}
function buildLayerButtons() {
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
function modeLabel(mode) {
  const camel = mode.replace(/_(\w)/g, (_, c) => c.toUpperCase());
  return t(`brush.${camel}`);
}
var ABSOLUTE_MODES = /* @__PURE__ */ new Set([
  "paint",
  "erase",
  "fill",
  "set",
  "flatten",
  "terrace",
  "add_flag",
  "remove_flag"
]);
function defaultFlow(mode) {
  return ABSOLUTE_MODES.has(mode) ? 1 : 0.35;
}
var TEMPERATURE_BANDS = [
  { key: "climate.frozen", from: -1, to: -0.45 },
  { key: "climate.cold", from: -0.45, to: -0.15 },
  { key: "climate.temperate", from: -0.15, to: 0.2 },
  { key: "climate.warm", from: 0.2, to: 0.55 },
  { key: "climate.hot", from: 0.55, to: 1 }
];
function biomePaletteIndex(id) {
  const found = state.map.biomePalette.indexOf(id);
  return found >= 0 ? found : state.map.biomePalette.push(id) - 1;
}
var biomeFilter = "";
var lastBuiltMode = null;
function buildBrushOptions() {
  const host = $("brush-options");
  host.innerHTML = "";
  const layer = state.activeLayer;
  const modes = BRUSH_MODES[layer];
  if (!modes.includes(state.brush.mode)) state.brush.mode = modes[0];
  const mode = state.brush.mode;
  if (lastBuiltMode !== mode) {
    state.brush.flow = defaultFlow(mode);
    lastBuiltMode = mode;
  }
  const addSelect = (label, options, value, onChange) => {
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
    select.value = options.some(([key]) => key === value) ? value : options[0][0];
    onChange(select.value);
    select.onchange = () => onChange(select.value);
    wrap.append(caption, select);
    host.append(wrap);
  };
  const addNumber = (label, value, onChange, step = 1, bounds) => {
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
      if (bounds) input.value = String(Math.max(bounds.min, Math.min(bounds.max, Number(input.value))));
      draw();
    };
    wrap.append(caption, input);
    host.append(wrap);
    return input;
  };
  const addHintText = (text) => {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = text;
    host.append(p);
  };
  const addHint = (key) => {
    const text = t(key);
    if (text !== key) addHintText(text);
  };
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
          (id) => !needle || id.includes(needle) || String(biomePaletteIndex(id)) === String(state.brush.value)
        );
        if (!matching.length) continue;
        const optgroup = document.createElement("optgroup");
        optgroup.label = t(group.key);
        for (const id of matching) {
          const option = document.createElement("option");
          option.value = String(biomePaletteIndex(id));
          option.textContent = id;
          optgroup.append(option);
        }
        select.append(optgroup);
      }
      select.value = String(state.brush.value);
      if (!select.value) {
        select.value = "0";
        state.brush.value = 0;
      }
    };
    fill();
    select.onchange = () => state.brush.value = Number(select.value);
    filter.oninput = () => {
      biomeFilter = filter.value;
      fill();
    };
    wrap.append(caption, filter, select);
    host.append(wrap);
    addHintText(tf("brush.hint.biome", { count: ALL_VANILLA_BIOMES.length }));
  };
  const addTemperaturePicker = () => {
    const current = state.brush.value / 100;
    const bandOf = (value) => TEMPERATURE_BANDS.findIndex((band, i) => value < band.to || i === TEMPERATURE_BANDS.length - 1);
    addSelect(
      t("brush.band"),
      TEMPERATURE_BANDS.map((band, i) => [
        String(i),
        `${t(band.key)}  (${band.from.toFixed(2)} \u2026 ${band.to.toFixed(2)})`
      ]),
      String(bandOf(current)),
      (v) => {
        const band = TEMPERATURE_BANDS[Number(v)];
        const middle = (band.from + band.to) / 2;
        if (current < band.from || current >= band.to) {
          state.brush.value = Math.round(middle * 100);
          buildBrushOptions();
        }
      }
    );
    addNumber(
      t("brush.value"),
      state.brush.value / 100,
      (v) => state.brush.value = Math.round(Math.max(-1, Math.min(1, v)) * 100),
      0.05,
      { min: -1, max: 1 }
    );
  };
  addSelect(
    t("brush.mode"),
    modes.map((id) => [id, modeLabel(id)]),
    mode,
    (value) => {
      if (value === state.brush.mode) return;
      state.brush.mode = value;
      buildBrushOptions();
      draw();
    }
  );
  const writesValue = mode === "paint" || mode === "fill" || mode === "add_flag" || mode === "remove_flag";
  if (writesValue) {
    if (layer === "land") {
      addSelect(
        t("brush.value"),
        [
          ["1", t("value.land")],
          ["0", t("value.ocean")]
        ],
        String(state.brush.value),
        (v) => state.brush.value = Number(v)
      );
    } else if (layer === "feature") {
      addSelect(
        t("brush.flag"),
        FEATURE_FLAGS.map((flag, bit) => [String(1 << bit), t(`feature.${flag}`)]),
        String(state.brush.value),
        (v) => state.brush.value = Number(v)
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
    addNumber(t("brush.amount"), state.brush.amount, (v) => state.brush.amount = v);
  } else if (mode === "raise_to" || mode === "lower_to" || mode === "set") {
    addNumber(
      t("brush.targetY"),
      state.brush.targetY,
      (v) => state.brush.targetY = Math.max(buildMin, Math.min(buildMax, Math.round(v))),
      1,
      { min: buildMin, max: buildMax }
    );
    addHintText(tf("brush.hint.range", { min: buildMin, max: buildMax, sea: world.sea_level }));
    if (mode !== "set") addNumber(t("brush.amount"), state.brush.amount, (v) => state.brush.amount = v);
  } else if (mode === "terrace") {
    addNumber(t("brush.step"), Math.max(1, Math.abs(state.brush.amount)), (v) => state.brush.amount = Math.max(1, v));
  } else if (mode === "noise") {
    addNumber(t("brush.jitter"), state.brush.amount, (v) => state.brush.amount = v);
  }
  addHint(`brush.hint.${mode}`);
  if (mode !== "fill") {
    addNumber(t("brush.slope"), state.brush.slopeStrength, (v) => state.brush.slopeStrength = Math.max(0, Math.min(1, v)), 0.05);
    addNumber(t("brush.flow"), state.brush.flow, (v) => state.brush.flow = Math.max(0.01, Math.min(1, v)), 0.05);
  }
  syncShapeInput();
}
function syncShapeInput() {
  const disabled = state.brush.mode === "fill";
  $("brush-shape").disabled = disabled;
  $("brush-size").disabled = disabled;
}
function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1e4);
}
async function exportProject() {
  const doc = await currentDoc();
  download(`${doc.meta?.name ?? "world"}.mwgproj.json`, new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
}
async function currentDoc() {
  const doc = structuredClone(state.doc);
  doc.map.layers = await layersToDoc(state.map);
  doc.meta = { ...doc.meta, modified: (/* @__PURE__ */ new Date()).toISOString() };
  doc.editor = {
    active_layer: state.activeLayer,
    visible_layers: [...state.visible],
    brush: state.brush,
    grid: state.grid,
    contours: state.contours,
    contour_interval: state.contourInterval,
    camera: { x: state.view.centreX, z: state.view.centreZ, zoom: state.view.scale }
  };
  return doc;
}
async function loadProject(doc) {
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
function restoreEditorState(next, editor) {
  if (!editor) return false;
  const layerIds = LAYER_SPECS.map((s) => s.id);
  if (typeof editor.active_layer === "string" && layerIds.includes(editor.active_layer)) {
    next.activeLayer = editor.active_layer;
  }
  if (Array.isArray(editor.visible_layers)) {
    const visible = editor.visible_layers.filter((id) => layerIds.includes(id));
    if (visible.length) next.visible = new Set(visible);
  }
  if (editor.brush && typeof editor.brush === "object") {
    next.brush = { ...next.brush, ...editor.brush };
  }
  if (typeof editor.grid === "boolean") next.grid = editor.grid;
  if (typeof editor.contours === "boolean") next.contours = editor.contours;
  if (typeof editor.contour_interval === "number" && editor.contour_interval >= 1) {
    next.contourInterval = Math.round(editor.contour_interval);
  }
  const camera = editor.camera;
  if (camera && Number.isFinite(camera.zoom) && camera.zoom > 0) {
    next.view = {
      scale: Math.max(0.05, Math.min(4096, camera.zoom)),
      centreX: Number.isFinite(camera.x) ? camera.x : next.view.centreX,
      centreZ: Number.isFinite(camera.z) ? camera.z : next.view.centreZ
    };
    return true;
  }
  return false;
}
function importProject() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const doc = JSON.parse(await file.text());
      if (doc.format !== 1) throw new Error(`unsupported project format ${doc.format}`);
      await loadProject(doc);
      status(t("status.imported"));
    } catch (error) {
      status(`${t("status.importFailed")}: ${error.message}`, true);
    }
  };
  input.click();
}
var autosaveTimer;
function scheduleAutosave() {
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(async () => {
    try {
      localStorage.setItem("mwg.autosave", JSON.stringify(await currentDoc()));
    } catch {
    }
  }, 1500);
}
async function restoreAutosave() {
  const saved = localStorage.getItem("mwg.autosave");
  if (!saved) return;
  try {
    await loadProject(JSON.parse(saved));
    status(t("status.restored"));
  } catch {
    localStorage.removeItem("mwg.autosave");
  }
}
function compilerConfig() {
  const { seed, height_limit, ...world } = state.doc.world;
  void seed;
  void height_limit;
  return { world, ...state.doc.generator };
}
function showConfig() {
  $("config-json").value = JSON.stringify(compilerConfig(), null, 2);
}
function applyConfigText() {
  const area = $("config-json");
  let parsed;
  try {
    parsed = JSON.parse(area.value);
  } catch (error) {
    status(`${t("status.configInvalid")}: ${error.message}`, true);
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    status(t("status.configInvalid"), true);
    return;
  }
  const { world, mode, format, ...generator } = parsed;
  void mode;
  void format;
  if (world && typeof world === "object") {
    for (const [key, value] of Object.entries(world)) {
      if (key === "seed") continue;
      if (typeof value === "number" && Number.isFinite(value) && key in state.doc.world) {
        state.doc.world[key] = value;
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
async function loadPreset() {
  const name = $("preset-pick").value;
  if (!name) {
    status(t("status.presetNone"), true);
    return;
  }
  try {
    const response = await fetch(`./presets/${name}.json`, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json();
    const { world, mode, format, ...generator } = config;
    void format;
    if (world && typeof world === "object") {
      state.doc.world = { ...state.doc.world, ...world };
    }
    if (Object.keys(generator).length) state.doc.generator = generator;
    analysedVersion = -1;
    const exportMode = mode === "vanilla" ? "vanilla" : "procedural";
    state.doc.export.mode = exportMode;
    $("export-mode").value = exportMode;
    state.analysis = null;
    syncPanels();
    draw();
    renderPreviews();
    scheduleAutosave();
    status(`${t("status.presetLoaded")}: ${name}`);
  } catch (error) {
    status(`${t("status.presetFailed")}: ${error.message}`, true);
  }
}
function runAnalysis() {
  const analysis = analyseMap(state.map, state.doc);
  state.analysis = analysis;
  state.doc.generator = analysisToGenerator(analysis, state.doc.generator);
  Object.assign(state.doc.world, analysisToWorld(analysis, state.doc.world));
  analysedVersion = mapVersion;
  const lines = [
    `${t("analysis.landRatio")}: ${(analysis.landRatio * 100).toFixed(1)}%`,
    `${t("analysis.landmasses")}: ${analysis.landmassCount}`,
    `${t("analysis.continentSize")}: ${Math.round(analysis.continentWidth)} \xD7 ${Math.round(analysis.continentHeight)}`,
    `${t("analysis.variation")}: ${analysis.widthVariationPercent}% / ${analysis.heightVariationPercent}%`,
    `${t("analysis.islands")}: ${analysis.islandCount} @ ${Math.round(analysis.islandSize)}`,
    `${t("analysis.clustering")}: ${analysis.islandClustering.toFixed(2)}`,
    `${t("analysis.oceanDepth")}: ${Math.round(analysis.meanOceanDepth)} / ${Math.round(analysis.maxOceanDepth)}`,
    `${t("analysis.center")}: ${t(`center.${analysis.centerType}`)} r=${analysis.centerRadius}`,
    tf("analysis.worldRange", {
      max: state.doc.world.terrain_max_y,
      min: state.doc.world.terrain_min_y,
      peak: Math.round(analysis.maxLandElevation),
      headroom: TERRAIN_HEADROOM
    }),
    ...analysis.notes.map((key) => `! ${t(key)}`)
  ];
  $("analysis-output").textContent = lines.join("\n");
  showConfig();
  renderPreviews();
  scheduleAutosave();
}
function previewSpan() {
  const cont = state.doc.generator.continents ?? {};
  const islands = state.doc.generator.islands ?? {};
  const mapSpan = Math.max(state.doc.map.width, state.doc.map.height);
  const wanted = Math.max(
    mapSpan * 1.6,
    Math.max(Number(cont.width) || 0, Number(cont.height) || 0) * 2.4,
    (Number(islands.size) || 0) * 12,
    1024
  );
  return Math.min(wanted, mapSpan * 6);
}
var PREVIEW_SIZE = 256;
var mapVersion = 0;
var analysedVersion = -1;
function markPreviewsStale() {
  mapVersion++;
  $("stale-user").hidden = false;
  refreshStaleMark();
}
function refreshStaleMark() {
  const stale = analysedVersion !== mapVersion;
  const mark = $("stale-procedural");
  mark.hidden = !stale;
  mark.textContent = analysedVersion < 0 ? t("preview.neverAnalysed") : t("preview.stale");
}
function markProceduralFresh() {
  refreshStaleMark();
}
function showPreviewScale(span) {
  const blocks = Math.round(span).toLocaleString("en-US");
  $("preview-scale").textContent = tf("preview.scale", { size: blocks });
}
function drawDesignBounds(canvas2, span) {
  const ctx = canvas2.getContext("2d");
  if (!ctx) return;
  const scale = canvas2.width / span;
  const w = state.doc.map.width * scale;
  const h = state.doc.map.height * scale;
  if (w >= canvas2.width * 0.98 && h >= canvas2.height * 0.98) return;
  ctx.save();
  ctx.strokeStyle = "rgba(120,200,255,0.75)";
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.strokeRect((canvas2.width - w) / 2, (canvas2.height - h) / 2, w, h);
  ctx.restore();
}
function renderDesignPreview() {
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
      landMask[slot] = inside && land.get(cx, cy) !== 0 ? 1 : 0;
    }
  }
  renderHeightGrid(previewUser, design, size, state.doc.world.sea_level, landMask);
  drawDesignBounds(previewUser, span);
  $("stale-user").hidden = true;
}
function renderProceduralPreview() {
  const size = PREVIEW_SIZE;
  const span = previewSpan();
  showPreviewScale(span);
  const heights = previewHeights(state.doc.generator, {
    seed: state.doc.world.seed || 1234,
    size,
    spanBlocks: span,
    seaLevel: state.doc.world.sea_level
  });
  renderHeightGrid(previewProcedural, heights, size, state.doc.world.sea_level);
  drawDesignBounds(previewProcedural, span);
  markProceduralFresh();
}
function renderPreviews() {
  renderDesignPreview();
  renderProceduralPreview();
}
async function exportDatapack() {
  const mode = $("export-mode").value;
  state.doc.export.mode = mode;
  if (mode === "exact") {
    status(t("status.exactPending"), true);
    return;
  }
  const name = ($("pack-name").value || "MyWorld").trim() || "MyWorld";
  state.doc.export.pack_name = name;
  if (mode === "procedural" && !state.analysis) runAnalysis();
  status(t("status.building"));
  try {
    const input = mode === "vanilla" ? { mode: "vanilla" } : { mode: "custom", ...compilerConfig() };
    const { files, notes, adjustments } = await buildPack(input, name);
    const blob = await createZip([...files].map(([path, data]) => ({ path, data })));
    download(`${sanitiseFileName(name)}.zip`, blob);
    const summary = [
      `${files.size} ${t("status.filesWritten")}`,
      ...adjustments.map((a) => `- ${tf(a.key, a.params)}`)
    ];
    status(summary.join("  "));
    $("analysis-output").textContent = JSON.stringify(notes, null, 2);
  } catch (error) {
    status(`${t("status.buildFailed")}: ${error.message}`, true);
  }
}
function sanitiseFileName(name) {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, "_").trim();
  return cleaned.length ? cleaned : "MyWorld";
}
function status(message, isError = false) {
  const el = $("status");
  el.textContent = message;
  el.className = isError ? "status error" : "status";
  lastStatus = message;
}
var lastStatus = "";
function syncPanels() {
  $("map-width").value = String(state.doc.map.width);
  $("map-height").value = String(state.doc.map.height);
  $("map-resolution").value = String(state.doc.map.resolution);
  $("sea-level").value = String(state.doc.world.sea_level);
  $("seed").value = String(state.doc.world.seed);
  $("contour-interval").value = String(state.contourInterval);
  $("height-limit").checked = state.doc.world.height_limit !== false;
  $("toggle-grid").checked = state.grid;
  $("toggle-contours").checked = state.contours;
  $("export-mode").value = state.doc.export.mode;
  $("pack-name").value = state.doc.export.pack_name;
  $("brush-shape").value = state.brush.shape;
  showConfig();
}
function clampedNumber(input, fallback) {
  const value = Number(input.value);
  if (!Number.isFinite(value)) return fallback;
  const min = input.min === "" ? -Infinity : Number(input.min);
  const max = input.max === "" ? Infinity : Number(input.max);
  const clamped = Math.min(max, Math.max(min, value));
  if (clamped !== value) input.value = String(clamped);
  return clamped;
}
function bindPanels() {
  syncPanels();
  $("new-map").onclick = async () => {
    const width = clampedNumber($("map-width"), 2e3);
    const height = clampedNumber($("map-height"), 2e3);
    const resolution = Number($("map-resolution").value);
    const doc = emptyProject(width, height, resolution);
    doc.world.sea_level = Number($("sea-level").value) || 63;
    doc.world.seed = Math.trunc(Number($("seed").value)) || 0;
    doc.world.height_limit = state.doc.world.height_limit;
    doc.generator = structuredClone(state.doc.generator);
    doc.export = { ...state.doc.export };
    await loadProject(doc);
    status(t("status.newMap"));
  };
  const applySize = () => {
    const width = clampedNumber($("map-width"), state.doc.map.width);
    const height = clampedNumber($("map-height"), state.doc.map.height);
    const resolution = Number($("map-resolution").value);
    if (width === state.doc.map.width && height === state.doc.map.height && resolution === state.doc.map.resolution) {
      return;
    }
    state.doc.map.width = width;
    state.doc.map.height = height;
    state.doc.map.resolution = resolution;
    state.map = state.map.resized(state.doc);
    state.history.clear();
    fitView();
    draw();
    renderPreviews();
    showConfig();
    scheduleAutosave();
    status(tf("status.resized", { width, height, resolution }));
  };
  for (const id of ["map-width", "map-height"]) {
    $(id).onchange = applySize;
  }
  $("map-resolution").onchange = applySize;
  $("height-limit").onchange = (event) => {
    state.doc.world.height_limit = event.target.checked;
    runAnalysis();
    showConfig();
    scheduleAutosave();
  };
  $("sea-level").onchange = (event) => {
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;
    state.doc.world.sea_level = Math.round(value);
    showConfig();
    draw();
    renderPreviews();
    scheduleAutosave();
  };
  $("seed").onchange = (event) => {
    const value = Number(event.target.value);
    state.doc.world.seed = Number.isFinite(value) ? Math.trunc(value) : 0;
    renderPreviews();
    scheduleAutosave();
  };
  $("contour-interval").onchange = (event) => {
    state.contourInterval = Math.max(1, Math.round(clampedNumber(event.target, 16)));
    draw();
    scheduleAutosave();
  };
  $("reset-view").onclick = fitView;
  $("brush-shape").onchange = (event) => {
    state.brush.shape = event.target.value;
    draw();
  };
  $("brush-size").oninput = (event) => {
    state.brush.size = Number(event.target.value);
    $("brush-size-label").textContent = `${state.brush.size}`;
    draw();
  };
  $("toggle-grid").onchange = (event) => {
    state.grid = event.target.checked;
    draw();
  };
  $("toggle-contours").onchange = (event) => {
    state.contours = event.target.checked;
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
  $("refresh-procedural").onclick = runAnalysis;
  $("config-apply").onclick = applyConfigText;
  $("config-reset").onclick = () => {
    showConfig();
    status(t("status.configReset"));
  };
  $("export-mode").onchange = (event) => {
    state.doc.export.mode = event.target.value;
    scheduleAutosave();
  };
  $("pack-name").onchange = (event) => {
    state.doc.export.pack_name = event.target.value || "MyWorld";
    scheduleAutosave();
  };
  const locale2 = $("locale");
  locale2.value = currentLocale();
  locale2.onchange = () => {
    setLocale(locale2.value);
    applyStaticText();
    buildLayerButtons();
    buildBrushOptions();
    buildLegend();
    renderPreviews();
  };
}
function applyStaticText() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    if (el.firstElementChild) return;
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const text = t(el.dataset.i18nTitle);
    el.title = text;
    el.setAttribute("aria-label", text);
  });
  document.title = t("app.title");
  document.documentElement.lang = currentLocale();
}
function exposeTestHooks() {
  window.mwg = {
    paintedCells: (id) => {
      const field = state.map.layer(id);
      let count = 0;
      for (let i = 0; i < field.values.length; i++) if (field.values[i] !== field.spec.default) count++;
      return count;
    },
    cellsWhere: (id, predicate) => {
      const field = state.map.layer(id);
      let count = 0;
      for (let i = 0; i < field.values.length; i++) if (predicate(field.values[i])) count++;
      return count;
    },
    snapshot: (id) => {
      const field = state.map.layer(id);
      let hash = 0;
      for (let i = 0; i < field.values.length; i++) hash = hash * 31 + field.values[i] | 0;
      return hash;
    },
    view: () => ({ ...state.view }),
    /** Land fraction of the procedural preview, straight from the heights. */
    proceduralLandFraction: () => {
      const heights = previewHeights(state.doc.generator, {
        seed: state.doc.world.seed || 1234,
        size: PREVIEW_SIZE,
        spanBlocks: previewSpan(),
        seaLevel: state.doc.world.sea_level
      });
      let land = 0;
      for (let i = 0; i < heights.length; i++) if (heights[i] > state.doc.world.sea_level) land++;
      return land / heights.length;
    },
    brush: () => ({ ...state.brush }),
    brushModes: (id) => [...BRUSH_MODES[id]],
    featureFlags: () => [...FEATURE_FLAGS],
    analysisResult: () => state.analysis,
    colourFor: (kind, key) => kind === "biome" ? [...biomeColour(key)] : [...featureColour(key)],
    setBrush: (patch) => {
      Object.assign(state.brush, patch);
      buildBrushOptions();
      syncBrushInputs();
      draw();
    },
    worldAtClient: (clientX, clientY) => canvasToWorld({ clientX, clientY }),
    biomeAtClient: (clientX, clientY) => {
      const { x, z } = canvasToWorld({ clientX, clientY });
      const { cx, cy } = state.map.worldToCell(x, z);
      return state.map.biomePalette[state.map.layer("biome").get(cx, cy)];
    },
    cellAtClient: (id, clientX, clientY) => {
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
    missingTranslations: (target) => missingKeys(target),
    lastStatus: () => lastStatus,
    runAnalysis,
    paintAtCell: (cx, cy) => {
      const { x, z } = state.map.cellToWorld(cx, cy);
      applyBrush(state.map.layer(state.activeLayer), state.map, x, z, state.brush, touched);
      draw();
    }
  };
}
function boot() {
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
