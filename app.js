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
      vertical_scale: 1
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
var MapModel = class {
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
  const radiusCells = Math.max(0.5, brush.size / 2 / map.resolution);
  const span = Math.ceil(radiusCells);
  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      const cx = centre.cx + dx;
      const cy = centre.cy + dy;
      if (cx < 0 || cy < 0 || cx >= field.cols || cy >= field.rows) continue;
      let distance;
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
      if (!touched2.has(index)) touched2.set(index, before);
      field.values[index] = nextValue(field, before, weight, brush);
    }
  }
}
function nextValue(field, before, weight, brush) {
  const clampStore = (value) => {
    const rounded = field.spec.dtype === "f32" ? value : Math.round(value);
    field.values[0] === void 0;
    return rounded;
  };
  switch (brush.mode) {
    case "paint":
      return field.spec.dtype === "u16" || field.spec.dtype === "u8" ? brush.value : clampStore(before + (brush.value - before) * weight);
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
    notes.push("every landmass touches the map edge, so sizes were taken from the clipped shapes");
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
  const landHeights = [];
  const oceanDepths = [];
  const temps = [];
  for (let i = 0; i < total; i++) {
    const y = elevation.values[i] * elevation.spec.scale + elevation.spec.offset;
    if (land[i]) landHeights.push(y);
    else oceanDepths.push(seaLevel - y);
    temps.push(temperature.values[i] * temperature.spec.scale);
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
  if (landCells === 0) notes.push("the map is entirely ocean, so continent settings were left at their defaults");
  return {
    landRatio,
    landmassCount: pool.length,
    continentWidth: widths.length ? mean(widths) : 6e3,
    continentHeight: heights.length ? mean(heights) : 6e3,
    widthVariationPercent: Math.round(coefficientOfVariation(widths) * 100),
    heightVariationPercent: Math.round(coefficientOfVariation(heights) * 100),
    islandCount: islands.length,
    islandSize: islandSizes.length ? mean(islandSizes) : 700,
    islandClustering: clustering,
    archipelagoStrength: Math.min(1, islands.length / Math.max(1, pool.length)),
    meanLandElevation: landHeights.length ? mean(landHeights) : seaLevel + 20,
    maxLandElevation: landHeights.length ? Math.max(...landHeights) : seaLevel + 100,
    meanOceanDepth: oceanDepths.length ? Math.max(0, mean(oceanDepths)) : 28,
    maxOceanDepth: oceanDepths.length ? Math.max(0, Math.max(...oceanDepths)) : 58,
    meanTemperature: mean(temps),
    centerType,
    centerRadius: Math.max(200, Math.round(probeRadius)),
    featureShare,
    notes
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
function previewHeights(generator, options) {
  const cont = generator.continents;
  const oceans = generator.oceans;
  const islands = generator.islands;
  const width = Number(cont.width) || 6e3;
  const height = Number(cont.height) || 6e3;
  const landRatio = Number(cont.land_ratio) || 0.32;
  const mountains = Number(cont.mountain_ranges ?? 1);
  const oceanDepth = Number(oceans.ocean_depth_blocks ?? 28);
  const deepDepth = Number(oceans.deep_ocean_depth_blocks ?? 58);
  const islandSize = Number(islands.size ?? 700);
  const islandsOn = islands.enabled !== false;
  const out = new Float32Array(options.size * options.size);
  const step = options.spanBlocks / options.size;
  const sea = options.seaLevel;
  const threshold = 1 - 2 * landRatio;
  for (let iy = 0; iy < options.size; iy++) {
    for (let ix = 0; ix < options.size; ix++) {
      const worldX = (ix - options.size / 2) * step;
      const worldZ = (iy - options.size / 2) * step;
      const continent = fbm(worldX / width, worldZ / height, options.seed, 4);
      const shaped = Math.abs(continent) * 2 - 1;
      const inland = shaped - threshold;
      let y;
      if (inland > 0) {
        const erosion = fbm(worldX / (width * 0.35), worldZ / (height * 0.35), options.seed + 5150, 3);
        const ridge = 1 - Math.abs(fbm(worldX / (width * 0.5), worldZ / (height * 0.5), options.seed + 8675, 2));
        const relief = (0.25 + 0.75 * Math.max(0, -erosion)) * mountains * ridge;
        y = sea + 4 + Math.min(1, inland * 4) * (18 + relief * 150);
      } else {
        const deep = Math.min(1, -inland * 2.2);
        y = sea - (oceanDepth + (deepDepth - oceanDepth) * deep);
        if (islandsOn && deep > 0.35) {
          const island = fbm(worldX / islandSize, worldZ / islandSize, options.seed + 4242, 3);
          if (island > 0.55) y = sea + (island - 0.55) * 120;
        }
      }
      out[iy * options.size + ix] = y;
    }
  }
  return out;
}

// src/render.ts
var OCEAN = [66, 84, 104];
var LAND = [176, 178, 172];
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
function temperatureColour(t2) {
  const u = Math.max(0, Math.min(1, (t2 + 0.5) / 2.5));
  return [Math.round(40 + 200 * u), Math.round(90 + 60 * (1 - Math.abs(u - 0.5) * 2)), Math.round(230 - 190 * u)];
}
function biomeColour(index) {
  const h = index * 2654435761 >>> 0;
  return [110 + (h & 127), 110 + (h >>> 8 & 127), 110 + (h >>> 16 & 127)];
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
  const showElevation = options.visible.has("elevation");
  const showTemperature = options.visible.has("temperature");
  const showBiome = options.visible.has("biome");
  const showLand = options.visible.has("land");
  for (let py = 0; py < h; py++) {
    const worldZ = view.centreZ + (py - h / 2) * view.scale;
    for (let px = 0; px < w; px++) {
      const worldX = view.centreX + (px - w / 2) * view.scale;
      const { cx, cy } = map.worldToCell(worldX, worldZ);
      const offset = (py * w + px) * 4;
      const inside = cx >= 0 && cy >= 0 && cx < map.cols && cy < map.rows;
      let colour;
      if (!inside) {
        colour = [30, 33, 38];
      } else {
        const isLand = land.get(cx, cy) !== 0;
        colour = showLand ? isLand ? LAND : OCEAN : [52, 56, 62];
        if (showElevation) colour = elevationColour(elevation.real(cx, cy), options.seaLevel, isLand);
        if (showTemperature) {
          const t2 = temperatureColour(temperature.real(cx, cy));
          colour = [(colour[0] + t2[0] * 2) / 3, (colour[1] + t2[1] * 2) / 3, (colour[2] + t2[2] * 2) / 3];
        }
        if (showBiome) {
          const index = biome.get(cx, cy);
          if (index > 0) {
            const b = biomeColour(index);
            colour = [(colour[0] + b[0] * 3) / 4, (colour[1] + b[1] * 3) / 4, (colour[2] + b[2] * 3) / 4];
          }
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
function renderHeightGrid(canvas2, heights, size, seaLevel) {
  const ctx = canvas2.getContext("2d");
  if (!ctx) return;
  canvas2.width = size;
  canvas2.height = size;
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < heights.length; i++) {
    const y = heights[i];
    const colour = elevationColour(y, seaLevel, y > seaLevel);
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
  "map.new": "New map",
  "map.grid": "Grid",
  "map.contours": "Contours",
  "layer.land": "Land / Ocean",
  "layer.elevation": "Elevation",
  "layer.temperature": "Temperature",
  "layer.biome": "Biome",
  "layer.feature": "Terrain feature",
  "layer.visible": "Visible",
  "brush.shape": "Shape",
  "brush.circle": "Circle",
  "brush.square": "Square",
  "brush.size": "Size",
  "brush.mode": "Mode",
  "brush.value": "Value",
  "brush.amount": "Amount per stroke",
  "brush.targetY": "Target Y",
  "brush.slope": "Slope strength",
  "brush.flow": "Flow",
  "brush.raise": "Raise",
  "brush.lower": "Lower",
  "brush.raiseTo": "Raise to Y",
  "brush.lowerTo": "Lower to Y",
  "brush.set": "Set to Y",
  "value.land": "Land",
  "value.ocean": "Ocean",
  "value.clear": "Clear",
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
  "preview.user": "Your design",
  "preview.procedural": "Procedural result",
  "preview.caption": "Procedural Export reproduces the character and scale of your design, not its exact coastlines. Exact Export preserves position.",
  "export.mode": "Export mode",
  "export.procedural": "Procedural \u2014 vanilla data pack, no mod",
  "export.exact": "Exact \u2014 data pack + companion mod",
  "status.newMap": "New map created",
  "status.imported": "Project imported",
  "status.importFailed": "Could not import project",
  "status.restored": "Restored the autosaved project",
  "status.configExported": "Generator config exported",
  "status.exactPending": "Exact Export needs the companion mod, which is not built yet"
};
var KO = {
  // Korean strings arrive from the project owner; anything missing falls back
  // to English automatically.
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
  "minecraft:deep_frozen_ocean",
  "minecraft:deep_lukewarm_ocean",
  "minecraft:deep_ocean",
  "minecraft:desert",
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

// src/main.ts
var state = createState(emptyProject());
function createState(doc) {
  const map = new MapModel(doc);
  return {
    doc,
    map,
    history: new History(),
    view: { scale: Math.max(1, doc.map.width / 900), centreX: doc.map.origin.x, centreZ: doc.map.origin.z },
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
}
function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = Math.max(320, Math.floor(rect.width));
  canvas.height = Math.max(320, Math.floor(rect.height));
  draw();
}
var painting = false;
var touched = /* @__PURE__ */ new Map();
function canvasToWorld(event) {
  const rect = canvas.getBoundingClientRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  return {
    x: state.view.centreX + (px - canvas.width / 2) * state.view.scale,
    z: state.view.centreZ + (py - canvas.height / 2) * state.view.scale
  };
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
    const active = FEATURE_FLAGS.filter((_, bit) => flags & 1 << bit);
    if (active.length) rows.push(`${t("layer.feature")}: ${active.join(", ")}`);
  }
  $("hover").textContent = rows.join("\n");
}
function bindCanvas() {
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    painting = true;
    touched = /* @__PURE__ */ new Map();
    paintAt(event);
  });
  canvas.addEventListener("pointermove", (event) => {
    updateHover(event);
    if (painting) paintAt(event);
  });
  const stop = () => {
    if (!painting) return;
    painting = false;
    const stroke = finishStroke(state.map.layer(state.activeLayer), state.activeLayer, touched);
    if (stroke) state.history.push(stroke);
    touched = /* @__PURE__ */ new Map();
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
    { passive: false }
  );
  window.addEventListener("keydown", (event) => {
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === "z" && !event.shiftKey) {
      event.preventDefault();
      if (state.history.undo(state.map)) draw();
    } else if (ctrl && (event.key.toLowerCase() === "y" || event.shiftKey && event.key.toLowerCase() === "z")) {
      event.preventDefault();
      if (state.history.redo(state.map)) draw();
    } else if (event.key === "[") {
      state.brush.size = Math.max(1, Math.round(state.brush.size / 1.3));
      syncBrushInputs();
    } else if (event.key === "]") {
      state.brush.size = Math.min(1e5, Math.round(state.brush.size * 1.3));
      syncBrushInputs();
    }
  });
}
function syncBrushInputs() {
  $("brush-size").value = String(state.brush.size);
  $("brush-size-label").textContent = `${state.brush.size}`;
}
function buildLayerButtons() {
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
function buildBrushOptions() {
  const host = $("brush-options");
  host.innerHTML = "";
  const layer = state.activeLayer;
  const addSelect = (label, options, value, onChange) => {
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
  const addNumber = (label, value, onChange, step = 1) => {
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
        ["0", t("value.ocean")]
      ],
      String(state.brush.value),
      (v) => state.brush.value = Number(v)
    );
  } else if (layer === "elevation") {
    addSelect(
      t("brush.mode"),
      [
        ["raise", t("brush.raise")],
        ["lower", t("brush.lower")],
        ["raise_to", t("brush.raiseTo")],
        ["lower_to", t("brush.lowerTo")],
        ["set", t("brush.set")]
      ],
      state.brush.mode === "paint" ? "raise" : state.brush.mode,
      (v) => {
        state.brush.mode = v;
        buildBrushOptions();
      }
    );
    if (state.brush.mode === "raise" || state.brush.mode === "lower") {
      addNumber(t("brush.amount"), state.brush.amount, (v) => state.brush.amount = v);
    } else {
      addNumber(t("brush.targetY"), state.brush.targetY, (v) => state.brush.targetY = v);
    }
  } else if (layer === "temperature") {
    state.brush.mode = "paint";
    addNumber(t("brush.value"), state.brush.value / 100, (v) => state.brush.value = Math.round(v * 100), 0.05);
  } else if (layer === "biome") {
    state.brush.mode = "paint";
    const options = [["0", t("value.clear")]];
    VANILLA_OVERWORLD_BIOMES.forEach((id) => {
      let index = state.map.biomePalette.indexOf(id);
      if (index < 0) index = state.map.biomePalette.push(id) - 1;
      options.push([String(index), id]);
    });
    addSelect(t("brush.value"), options, String(state.brush.value), (v) => state.brush.value = Number(v));
  } else {
    state.brush.mode = "paint";
    const options = FEATURE_FLAGS.map((flag, bit) => [String(1 << bit), flag]);
    addSelect(t("brush.value"), options, String(state.brush.value), (v) => state.brush.value = Number(v));
  }
  addNumber(t("brush.slope"), state.brush.slopeStrength, (v) => state.brush.slopeStrength = Math.max(0, Math.min(1, v)), 0.05);
  addNumber(t("brush.flow"), state.brush.flow, (v) => state.brush.flow = Math.max(0.01, Math.min(1, v)), 0.05);
}
function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
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
  Object.assign(state, next);
  buildLayerButtons();
  buildBrushOptions();
  syncBrushInputs();
  draw();
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
function runAnalysis() {
  const analysis = analyseMap(state.map, state.doc);
  state.analysis = analysis;
  state.doc.generator = analysisToGenerator(analysis, state.doc.generator);
  const lines = [
    `${t("analysis.landRatio")}: ${(analysis.landRatio * 100).toFixed(1)}%`,
    `${t("analysis.landmasses")}: ${analysis.landmassCount}`,
    `${t("analysis.continentSize")}: ${Math.round(analysis.continentWidth)} \xD7 ${Math.round(analysis.continentHeight)}`,
    `${t("analysis.variation")}: ${analysis.widthVariationPercent}% / ${analysis.heightVariationPercent}%`,
    `${t("analysis.islands")}: ${analysis.islandCount} @ ${Math.round(analysis.islandSize)}`,
    `${t("analysis.clustering")}: ${analysis.islandClustering.toFixed(2)}`,
    `${t("analysis.oceanDepth")}: ${Math.round(analysis.meanOceanDepth)} / ${Math.round(analysis.maxOceanDepth)}`,
    `${t("analysis.center")}: ${analysis.centerType} r=${analysis.centerRadius}`,
    ...analysis.notes.map((n) => `! ${n}`)
  ];
  $("analysis-output").textContent = lines.join("\n");
  $("config-json").textContent = JSON.stringify(state.doc.generator, null, 2);
  renderPreviews();
}
function renderPreviews() {
  const size = 256;
  const span = Math.max(state.doc.map.width, state.doc.map.height) * 1.6;
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
      design[iy * size + ix] = inside ? elevation.real(cx, cy) : state.doc.world.sea_level - 30;
    }
  }
  renderHeightGrid(previewUser, design, size, state.doc.world.sea_level);
  void land;
  const heights = previewHeights(state.doc.generator, {
    seed: state.doc.world.seed || 1234,
    size,
    spanBlocks: span,
    seaLevel: state.doc.world.sea_level
  });
  renderHeightGrid(previewProcedural, heights, size, state.doc.world.sea_level);
}
async function exportDatapack() {
  const mode = $("export-mode").value;
  if (mode === "exact") {
    status(t("status.exactPending"), true);
    return;
  }
  if (!state.analysis) runAnalysis();
  const doc = await currentDoc();
  doc.export.mode = mode;
  download(
    `${doc.export.pack_name}-config.json`,
    new Blob([JSON.stringify({ format: 1, mode: "custom", ...doc.generator }, null, 2)], {
      type: "application/json"
    })
  );
  status(t("status.configExported"));
}
function status(message, isError = false) {
  const el = $("status");
  el.textContent = message;
  el.className = isError ? "status error" : "status";
}
function bindPanels() {
  $("map-width").value = String(state.doc.map.width);
  $("map-height").value = String(state.doc.map.height);
  $("map-resolution").value = String(state.doc.map.resolution);
  $("sea-level").value = String(state.doc.world.sea_level);
  $("seed").value = String(state.doc.world.seed);
  $("new-map").onclick = async () => {
    const width = Number($("map-width").value);
    const height = Number($("map-height").value);
    const resolution = Number($("map-resolution").value);
    const doc = emptyProject(width, height, resolution);
    doc.world.sea_level = Number($("sea-level").value);
    doc.world.seed = Number($("seed").value);
    await loadProject(doc);
    status(t("status.newMap"));
  };
  $("brush-shape").onchange = (event) => {
    state.brush.shape = event.target.value;
  };
  $("brush-size").oninput = (event) => {
    state.brush.size = Number(event.target.value);
    $("brush-size-label").textContent = `${state.brush.size}`;
  };
  $("toggle-grid").onchange = (event) => {
    state.grid = event.target.checked;
    draw();
  };
  $("toggle-contours").onchange = (event) => {
    state.contours = event.target.checked;
    draw();
  };
  $("btn-undo").onclick = () => state.history.undo(state.map) && draw();
  $("btn-redo").onclick = () => state.history.redo(state.map) && draw();
  $("btn-import").onclick = importProject;
  $("btn-export-project").onclick = () => void exportProject();
  $("btn-analyse").onclick = runAnalysis;
  $("btn-export-pack").onclick = () => void exportDatapack();
  const locale2 = $("locale");
  locale2.value = currentLocale();
  locale2.onchange = () => {
    setLocale(locale2.value);
    applyStaticText();
    buildLayerButtons();
    buildBrushOptions();
  };
}
function applyStaticText() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.title = t("app.title");
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
  syncBrushInputs();
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  void restoreAutosave();
}
boot();
