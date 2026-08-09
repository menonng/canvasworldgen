/**
 * Phase 5 — map analysis into procedural generator parameters.
 * Phase 6 — a preview of what those parameters actually produce.
 *
 * Analysis reads the drawn map and extracts the quantities a pure data pack
 * can reproduce: ratios, sizes, densities, and how they vary with distance
 * from the origin. It deliberately does not try to preserve absolute
 * positions, because vanilla density functions cannot read world X/Z. Exact
 * Export is where positions survive.
 */

import { FEATURE_FLAGS, type MapModel } from "./field";
import type { ProjectDoc } from "./project";

// ------------------------------------------------------------------ analysis
export interface Analysis {
  landRatio: number;
  landmassCount: number;
  continentWidth: number;
  continentHeight: number;
  widthVariationPercent: number;
  heightVariationPercent: number;
  islandCount: number;
  islandSize: number;
  islandClustering: number;
  archipelagoStrength: number;
  meanLandElevation: number;
  maxLandElevation: number;
  meanOceanDepth: number;
  maxOceanDepth: number;
  meanTemperature: number;
  centerType: "archipelago" | "continent" | "island" | "ocean" | "default";
  centerRadius: number;
  featureShare: Record<string, number>;
  notes: string[];
}

interface Blob {
  cells: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  touchesEdge: boolean;
}

/** Connected components of the land mask, 4-connected. */
function findBlobs(land: Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Float32Array, cols: number, rows: number): Blob[] {
  const seen = new Uint8Array(cols * rows);
  const blobs: Blob[] = [];
  const queue = new Int32Array(cols * rows);

  for (let start = 0; start < land.length; start++) {
    if (seen[start] || land[start] === 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    const blob: Blob = {
      cells: 0,
      minX: cols,
      maxX: -1,
      minY: rows,
      maxY: -1,
      touchesEdge: false,
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

      if (x > 0 && !seen[index - 1] && land[index - 1]) (seen[index - 1] = 1), (queue[tail++] = index - 1);
      if (x < cols - 1 && !seen[index + 1] && land[index + 1]) (seen[index + 1] = 1), (queue[tail++] = index + 1);
      if (y > 0 && !seen[index - cols] && land[index - cols]) (seen[index - cols] = 1), (queue[tail++] = index - cols);
      if (y < rows - 1 && !seen[index + cols] && land[index + cols]) (seen[index + cols] = 1), (queue[tail++] = index + cols);
    }
    blobs.push(blob);
  }
  return blobs;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  if (m === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) / m;
}

export function analyseMap(map: MapModel, doc: ProjectDoc): Analysis {
  const notes: string[] = [];
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

  // A landmass counts as a continent once it is well above the median size;
  // everything smaller is treated as an island.
  const areas = pool.map((b) => b.cells).sort((a, b) => a - b);
  const median = areas.length ? areas[Math.floor(areas.length / 2)] : 0;
  const continentCut = Math.max(median * 3, 16);

  const continents = pool.filter((b) => b.cells >= continentCut);
  const islands = pool.filter((b) => b.cells < continentCut);

  const widths = continents.map((b) => (b.maxX - b.minX + 1) * res);
  const heights = continents.map((b) => (b.maxY - b.minY + 1) * res);
  const islandSizes = islands.map((b) => Math.max(b.maxX - b.minX + 1, b.maxY - b.minY + 1) * res);

  // Clustering: how much more tightly islands sit together than a uniform
  // scatter would give. Compares the mean nearest-neighbour distance against
  // the expectation for the same count over the same area.
  let clustering = 0.5;
  if (islands.length >= 3) {
    const centres = islands.map((b) => ({
      x: ((b.minX + b.maxX) / 2) * res,
      y: ((b.minY + b.maxY) / 2) * res,
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
    const expected = 0.5 * Math.sqrt((map.widthBlocks * map.heightBlocks) / islands.length);
    clustering = Math.max(0, Math.min(1, 1 - observed / Math.max(1, expected)));
  }

  // Elevation and depth are read only where the matching mask says so, never
  // inferred from the height itself.
  const seaLevel = doc.world.sea_level;
  const landHeights: number[] = [];
  const oceanDepths: number[] = [];
  const temps: number[] = [];
  for (let i = 0; i < total; i++) {
    const y = elevation.values[i] * elevation.spec.scale + elevation.spec.offset;
    if (land[i]) landHeights.push(y);
    else oceanDepths.push(seaLevel - y);
    temps.push(temperature.values[i] * temperature.spec.scale);
  }

  const featureShare: Record<string, number> = {};
  FEATURE_FLAGS.forEach((flag, bit) => {
    let count = 0;
    for (let i = 0; i < total; i++) if (feature[i] & (1 << bit)) count++;
    if (count) featureShare[flag] = count / total;
  });

  // What sits at the origin is read from the map itself, inside a radius
  // proportional to the map.
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
    (b) =>
      centre.cx >= b.minX && centre.cx <= b.maxX && centre.cy >= b.minY && centre.cy <= b.maxY,
  );

  let centerType: Analysis["centerType"] = "default";
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
    continentWidth: widths.length ? mean(widths) : 6000,
    continentHeight: heights.length ? mean(heights) : 6000,
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
    notes,
  };
}

/** Folds the analysis into the generator config the data pack compiler reads. */
export function analysisToGenerator(analysis: Analysis, base: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(base) as Record<string, Record<string, unknown>>;
  const share = (flag: string): number => analysis.featureShare[flag] ?? 0;

  out.continents = {
    ...out.continents,
    land_ratio: Number(analysis.landRatio.toFixed(3)),
    width: Math.round(analysis.continentWidth),
    height: Math.round(analysis.continentHeight),
    width_variation_percent: analysis.widthVariationPercent,
    height_variation_percent: analysis.heightVariationPercent,
    mountain_ranges: share("mountain_range") > 0 ? Math.min(2, 0.8 + share("mountain_range") * 8) : out.continents.mountain_ranges,
    plateaus: share("plateau") > 0 ? Math.min(2, 0.8 + share("plateau") * 8) : out.continents.plateaus,
    tepui: share("tepui") > 0 ? Math.min(2, 0.5 + share("tepui") * 10) : out.continents.tepui,
  };

  out.islands = {
    ...out.islands,
    enabled: analysis.islandCount > 0,
    size: Math.round(analysis.islandSize),
    clustering: Number(analysis.islandClustering.toFixed(2)),
    arc_strength: share("island_arc") > 0 ? Math.min(2, 0.4 + share("island_arc") * 12) : out.islands.arc_strength,
    atoll_chance: share("atoll") > 0 ? Math.min(0.6, share("atoll") * 10) : out.islands.atoll_chance,
    volcanic_chance: share("volcano") > 0 ? Math.min(0.6, share("volcano") * 10) : out.islands.volcanic_chance,
  };

  out.oceans = {
    ...out.oceans,
    ocean_depth_blocks: Math.round(analysis.meanOceanDepth),
    deep_ocean_depth_blocks: Math.round(Math.max(analysis.meanOceanDepth + 8, analysis.maxOceanDepth)),
  };

  out.center = {
    ...out.center,
    type: analysis.centerType,
    radius: analysis.centerRadius,
  };

  out.fjords = { ...out.fjords, enabled: share("fjord") > 0 || (out.fjords.enabled as boolean) };
  out.inland_seas = { ...out.inland_seas, enabled: share("inland_sea") > 0 || (out.inland_seas.enabled as boolean) };
  out.coast = {
    ...out.coast,
    sea_stacks: share("sea_stack") > 0 ? Math.min(2, 0.4 + share("sea_stack") * 15) : out.coast.sea_stacks,
    columnar_jointing:
      share("columnar_jointing") > 0 ? Math.min(2, 0.4 + share("columnar_jointing") * 15) : out.coast.columnar_jointing,
  };

  out.biomes = {
    ...out.biomes,
    temperature_offset: Math.max(-1, Math.min(1, Number(analysis.meanTemperature.toFixed(2)))),
  };

  return out;
}

// ------------------------------------------------------------------- preview
/**
 * A fast approximation of the procedural pipeline, for the side-by-side
 * preview. It follows the same stages as the data pack — continent field,
 * land shaping, island band, erosion-driven relief — so the character of the
 * result is representative, but it uses cheap value noise rather than
 * Minecraft's Perlin stack, so it is not a seed-exact match.
 */
export interface PreviewOptions {
  seed: number;
  size: number;
  spanBlocks: number;
  seaLevel: number;
}

function hash2(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, seed: number): number {
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

function fbm(x: number, y: number, seed: number, octaves: number): number {
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

/** Returns a surface-height grid in Minecraft Y, indexed [iy * size + ix]. */
export function previewHeights(generator: Record<string, unknown>, options: PreviewOptions): Float32Array {
  const cont = generator.continents as Record<string, number | boolean>;
  const oceans = generator.oceans as Record<string, number | boolean>;
  const islands = generator.islands as Record<string, number | boolean>;

  const width = Number(cont.width) || 6000;
  const height = Number(cont.height) || 6000;
  const landRatio = Number(cont.land_ratio) || 0.32;
  const mountains = Number(cont.mountain_ranges ?? 1);
  const oceanDepth = Number(oceans.ocean_depth_blocks ?? 28);
  const deepDepth = Number(oceans.deep_ocean_depth_blocks ?? 58);
  const islandSize = Number(islands.size ?? 700);
  const islandsOn = islands.enabled !== false;

  const out = new Float32Array(options.size * options.size);
  const step = options.spanBlocks / options.size;
  const sea = options.seaLevel;

  // land threshold that reproduces the requested land ratio for this noise
  const threshold = 1 - 2 * landRatio;

  for (let iy = 0; iy < options.size; iy++) {
    for (let ix = 0; ix < options.size; ix++) {
      const worldX = (ix - options.size / 2) * step;
      const worldZ = (iy - options.size / 2) * step;

      const continent = fbm(worldX / width, worldZ / height, options.seed, 4);
      const shaped = Math.abs(continent) * 2 - 1;
      const inland = shaped - threshold;

      let y: number;
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
