/**
 * The project document: types, layer codec, and load/save.
 *
 * A project is design data. Minecraft never reads it — the compilers do.
 * Mirrors schema/project.schema.json; keep the two in step.
 */

export type Dtype = "u8" | "i8" | "u16" | "i16" | "u32" | "f32";
export type Encoding = "raw" | "deflate" | "rle" | "sparse";

export interface LayerDoc {
  dtype: Dtype;
  encoding: Encoding;
  data: string;
  default?: number | null;
  scale?: number;
  offset?: number;
  palette?: string[];
  flags?: string[];
  strength?: number;
}

export interface ProjectDoc {
  format: 1;
  meta?: {
    name?: string;
    author?: string;
    description?: string;
    created?: string;
    modified?: string;
    editor_version?: string;
  };
  world: {
    seed: number;
    sea_level: number;
    build_min_y: number;
    build_height: number;
    terrain_max_y: number;
    terrain_min_y: number;
    vertical_scale: number;
    /** Cap generated terrain at y=448 and the build ceiling at y=512. */
    height_limit: boolean;
  };
  map: {
    width: number;
    height: number;
    origin: { x: number; z: number };
    resolution: number;
    edge_mode: "falloff" | "hard";
    edge_falloff: number;
    layers: Record<string, LayerDoc>;
  };
  generator: Record<string, unknown>;
  export: {
    mode: "vanilla" | "procedural" | "exact";
    namespace: string;
    pack_name: string;
    field_precision?: number;
  };
  editor?: Record<string, unknown>;
}

export const EDITOR_VERSION = "0.1.0";

export const ARRAY_FOR: Record<Dtype, new (n: number) => ArrayLike<number> & { fill(v: number): void }> = {
  u8: Uint8Array,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  f32: Float32Array,
};

export type TypedArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Float32Array;

// --------------------------------------------------------------------- base64
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------------- deflate
// CompressionStream is available in every browser that supports the rest of
// this app; the raw path is the fallback when it is not.
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --------------------------------------------------------------------- sparse
/** Index/value pairs for layers where most cells hold the default. */
function encodeSparse(values: TypedArray, fallback: number): Uint8Array {
  const indices: number[] = [];
  for (let i = 0; i < values.length; i++) if (values[i] !== fallback) indices.push(i);
  const out = new Uint32Array(1 + indices.length * 2);
  out[0] = indices.length;
  indices.forEach((index, slot) => {
    out[1 + slot * 2] = index;
    out[2 + slot * 2] = values[index];
  });
  return new Uint8Array(out.buffer);
}

function decodeSparse(bytes: Uint8Array, target: TypedArray, fallback: number): void {
  target.fill(fallback);
  const view = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
  const count = view[0];
  for (let slot = 0; slot < count; slot++) {
    target[view[1 + slot * 2]] = view[2 + slot * 2];
  }
}

// ------------------------------------------------------------------- codec
export async function encodeLayer(
  values: TypedArray,
  spec: Omit<LayerDoc, "data" | "encoding"> & { encoding?: Encoding },
): Promise<LayerDoc> {
  const fallback = spec.default ?? 0;
  let encoding: Encoding = spec.encoding ?? "deflate";

  // A mostly-empty layer is far smaller as index/value pairs than as a
  // compressed dense array, which is the usual case for biome painting.
  if (encoding === "deflate") {
    let painted = 0;
    for (let i = 0; i < values.length; i++) if (values[i] !== fallback) painted++;
    if (painted < values.length * 0.08) encoding = "sparse";
  }

  const raw =
    encoding === "sparse"
      ? encodeSparse(values, fallback)
      : new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  const payload = encoding === "raw" ? raw : await deflate(raw);
  return { ...spec, encoding, data: toBase64(payload) };
}

export async function decodeLayer(doc: LayerDoc, cells: number): Promise<TypedArray> {
  const Ctor = ARRAY_FOR[doc.dtype] as unknown as new (n: number) => TypedArray;
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

function readElement(view: DataView, index: number, dtype: Dtype): number {
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

// ------------------------------------------------------------------ defaults
export function defaultGenerator(): Record<string, unknown> {
  return {
    continents: {
      land_ratio: 0.32,
      width: 6000,
      height: 6000,
      width_variation_percent: 30,
      height_variation_percent: 30,
      erosion_scale: 1.0,
      ridge_scale: 1.0,
      flat_terrain_skew: 0.1,
      mountain_ranges: 1.0,
      plateaus: 1.0,
      tepui: 0.6,
      rolling_hills: true,
    },
    center: { type: "default", radius: 2500, strength: 1.0 },
    rivers: { enabled: true, width: 1.0, depth_blocks: 10 },
    inland_seas: { enabled: true, frequency: 0.35, size: 3000, depth_blocks: 26 },
    fjords: { enabled: true, frequency: 0.6, width: 1.0, depth_blocks: 24 },
    islands: {
      enabled: true,
      size: 700,
      frequency: 1.0,
      clustering: 0.5,
      arc_strength: 0.6,
      noise_offset: 0.05,
      atoll_chance: 0.18,
      volcanic_chance: 0.2,
      cliff_chance: 0.22,
    },
    oceans: {
      ocean_depth_blocks: 28,
      deep_ocean_depth_blocks: 58,
      seafloor_relief: 1.0,
      trenches: true,
      trench_depth_blocks: 34,
    },
    coast: { cliffs: 0.6, sea_stacks: 0.5, columnar_jointing: 0.5 },
    biomes: {
      scale_with_continents: true,
      temperature_scale: 1.0,
      temperature_offset: 0.0,
      temperature_multiplier: 1.0,
      vegetation_scale: 1.0,
      vegetation_offset: 0.0,
      vegetation_multiplier: 1.0,
    },
    caves: { scale_with_continents: true, size_multiplier: 1.0, carvers_enabled: true },
    structures: { scale_with_continents: true, spacing_multiplier: 1.0 },
    spawn: { force_land_spawn: true },
  };
}

export function emptyProject(width = 2000, height = 2000, resolution = 4): ProjectDoc {
  const now = new Date().toISOString();
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
      vertical_scale: 1.0,
      height_limit: true,
    },
    map: {
      width,
      height,
      origin: { x: 0, z: 0 },
      resolution,
      edge_mode: "falloff",
      edge_falloff: 256,
      layers: {},
    },
    generator: defaultGenerator(),
    export: { mode: "procedural", namespace: "mwg", pack_name: "MyWorld", field_precision: 8 },
  };
}
