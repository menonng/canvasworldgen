/**
 * The data pack compiler, in the browser.
 *
 * A faithful port of tools/mwgbuild/builder.py. The pack is vanilla Minecraft
 * 26.2 worldgen data plus a patch: at mode "vanilla" no world generation file
 * is written at all, so terrain is identical to vanilla by construction. At
 * "custom" the vanilla files are fetched, the six density functions that shape
 * the Overworld are rewritten, and everything else stays vanilla — so only
 * vanilla biomes and blocks can appear.
 */

import * as calib from "./calib";
import { normalise, VANILLA_CONTINENT_SIZE, type Adjustment, type Section } from "./config";
import * as vanilla from "./vanilla";
import {
  abs_,
  add,
  addAll,
  cache2d,
  clamp,
  flat,
  mn,
  mul,
  mx,
  nested,
  noise,
  pt,
  rangeChoice,
  round8,
  shiftedNoise,
  spline,
  sub,
  type DF,
  type SplinePoint,
} from "./dsl";

const NS = "mwg";
const BLOCKS = calib.BLOCKS_PER_OFFSET;

const cfgRef = (name: string): string => `${NS}:config/${name}`;

/**
 * Round half to even, matching Python's round(). The reference generator in
 * tools/ uses it, and structure spacing lands on exact halves often enough
 * that Math.round would quietly disagree.
 */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
/** value * <config constant>, as a one-point spline. */
const scaled = (constName: string, value: number): DF => nested(cfgRef(constName), [pt(0, 0, value)]);

export interface BuildResult {
  files: Map<string, string>;
  notes: Record<string, unknown>;
  adjustments: Adjustment[];
}

type Band = [string, number, number];

export async function buildPack(input: Record<string, unknown>, packName = "MineWorldGen"): Promise<BuildResult> {
  const { mode, cfg, adjustments } = normalise(input);
  const files = new Map<string, string>();
  const write = (path: string, value: unknown): void => {
    files.set(path, JSON.stringify(value, null, 2) + "\n");
  };

  const packMeta = (label: string): unknown => ({
    pack: {
      description: [
        { text: "MineWorldGen", color: "#4fc3f7" },
        { text: `\n${label} - Minecraft ${vanilla.MINECRAFT_VERSION}`, color: "gray" },
      ],
      pack_format: vanilla.PACK_FORMAT,
      min_format: vanilla.PACK_FORMAT,
      max_format: vanilla.PACK_FORMAT,
      supported_formats: { min_inclusive: vanilla.PACK_FORMAT, max_inclusive: vanilla.PACK_FORMAT },
    },
  });

  if (mode !== "custom") {
    write("pack.mcmeta", packMeta("vanilla fallback"));
    write(`data/${NS}/worldgen/density_function/unused.json`, { type: "minecraft:constant", argument: 0 });
    return {
      files,
      adjustments,
      notes: {
        mode: "vanilla",
        minecraft_version: vanilla.MINECRAFT_VERSION,
        note: "no world generation files are written; terrain is 100% vanilla",
      },
    };
  }

  const world = cfg.world as Record<string, number>;
  const cont = cfg.continents as Record<string, number | boolean | null>;
  const isl = cfg.islands as Record<string, number | boolean>;
  const oceans = cfg.oceans as Record<string, number | boolean>;
  const coast = cfg.coast as Record<string, number>;
  const rivers = cfg.rivers as Record<string, number | boolean>;
  const seas = cfg.inland_seas as Record<string, number | boolean>;
  const fjords = cfg.fjords as Record<string, number | boolean>;
  const biomes = cfg.biomes as Record<string, number | boolean>;

  // ---------------------------------------------------------------- derive
  const seaLevel = world.sea_level;
  const buildMinY = world.build_min_y;
  const buildHeight = world.build_height;
  const buildMaxY = buildMinY + buildHeight;

  // depth loses exactly 1/128 per block whatever the world height is, so one
  // unit of offset is always 128 blocks
  const depthTop = buildHeight / 256;
  const baseOffset = -(depthTop - (seaLevel - buildMinY) / BLOCKS);
  const maxOffset = (world.terrain_max_y - seaLevel) / BLOCKS;
  const minOffset = (world.terrain_min_y - seaLevel) / BLOCKS;

  const width = cont.width as number;
  const height = cont.height as number;
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const probeLand =
    cont.ocean_offset === null || cont.ocean_offset === undefined
      ? (cont.land_ratio as number)
      : calib.landRatioForOceanOffset(cont.ocean_offset as number);
  const continentScale = calib.continentScaleForSize(short, probeLand);
  const stretch = long / short;
  const blurR = calib.blurForStretch(stretch);
  const blurAxis: "x" | "z" = width >= height ? "x" : "z";
  const blurGain = calib.blurGain(blurR);
  const blurWidth = (blurR * calib.continentBaseWavelength) / continentScale;
  const meanSize = Math.sqrt(width * height);
  const sizeFactor = meanSize / VANILLA_CONTINENT_SIZE;

  const oceanOffset =
    cont.ocean_offset === null || cont.ocean_offset === undefined
      ? calib.oceanOffsetForLandRatio(cont.land_ratio as number)
      : (cont.ocean_offset as number);

  const widthAmp = calib.ampForPercent(cont.width_variation_percent as number);
  const heightAmp = calib.ampForPercent(cont.height_variation_percent as number);

  const islandScale = calib.islandScaleForSize(isl.size as number);
  const islandClusterScale = islandScale * 0.32;
  const islandArcScale = islandScale * 0.22;
  const islandTypeScale = islandScale * 0.45;

  const bands: Band[] = [];
  let cursor = 0;
  for (const [name, share] of [
    ["atoll", isl.atoll_chance as number],
    ["volcano", isl.volcanic_chance as number],
    ["cliff", isl.cliff_chance as number],
  ] as Array<[string, number]>) {
    if (share > 0) {
      const lo = calib.islandTypeThreshold(cursor);
      cursor += share;
      bands.push([name, lo, calib.islandTypeThreshold(cursor)]);
    }
  }

  const centerType = String((cfg.center as Section).type);
  const centerRadius = Number((cfg.center as Section).radius);
  const centerThreshold = calib.centerThreshold(centerRadius);

  let climateFactor = biomes.temperature_scale as number;
  let vegFactor = biomes.vegetation_scale as number;
  if (biomes.scale_with_continents) {
    climateFactor *= sizeFactor;
    vegFactor *= sizeFactor;
  }
  let caveFactor = (cfg.caves as Record<string, number>).size_multiplier;
  if ((cfg.caves as Section).scale_with_continents) {
    caveFactor *= Math.min(2.5, Math.max(0.5, sizeFactor ** 0.35));
  }
  let structureFactor = (cfg.structures as Record<string, number>).spacing_multiplier;
  if ((cfg.structures as Section).scale_with_continents) {
    structureFactor *= Math.min(6, Math.max(0.4, sizeFactor ** 0.5));
  }

  // ------------------------------------------------------------- emitters
  const df = (name: string, value: DF): string => {
    write(`data/${NS}/worldgen/density_function/${name}.json`, value);
    return `${NS}:${name}`;
  };
  const noiseDef = (name: string, firstOctave: number, amplitudes: number[]): void => {
    write(`data/${NS}/worldgen/noise/${name}.json`, { firstOctave, amplitudes });
  };
  const constant = (name: string, value: number): void => {
    write(`data/${NS}/worldgen/density_function/config/${name}.json`, {
      type: "minecraft:constant",
      argument: round8(value),
    });
  };

  const blur = (
    makeSample: (shiftX: number, shiftZ: number) => DF,
    axis: "x" | "z",
    widthBlocks: number,
    taps: number,
    scale: number,
  ): DF => {
    if (taps <= 1 || widthBlocks <= 0) return makeSample(0, 0);
    const spacing = widthBlocks / (taps - 1);
    let total: DF = 0;
    for (let i = 0; i < taps; i++) {
      const shift = (i - (taps - 1) / 2) * spacing * scale;
      total = add(total, axis === "x" ? makeSample(shift, 0) : makeSample(0, shift));
    }
    return mul(round8(1 / taps), total);
  };

  /** Spline over the island-type noise, one profile per archetype band. */
  const byIslandType = (overrides: Record<string, DF>, fallback: DF): DF => {
    if (bands.length === 0) return fallback;
    const points: SplinePoint[] = [pt(-1.4, overrides[bands[0][0]] ?? fallback, 0)];
    for (const [name, lo, hi] of bands) {
      const value = overrides[name] ?? fallback;
      points.push(pt(lo, value, 0), pt(hi - 2e-3, value, 0), pt(hi, fallback, 0));
    }
    points.push(pt(1.4, fallback, 0));
    const cleaned: SplinePoint[] = [];
    for (const point of points) {
      const previous = cleaned[cleaned.length - 1];
      cleaned.push(
        previous && point.location <= previous.location
          ? { ...point, location: Number((previous.location + 1e-4).toFixed(6)) }
          : point,
      );
    }
    return spline(`${NS}:noise/island_type`, cleaned);
  };

  // ------------------------------------------------------------ constants
  constant("ocean_offset", oceanOffset);
  constant("max_offset", maxOffset);
  constant("min_offset", minOffset);
  constant("vertical_scale", world.vertical_scale);
  constant("ocean_depth", -Math.abs(oceans.ocean_depth_blocks as number) / BLOCKS);
  constant("deep_ocean_depth", -Math.abs(oceans.deep_ocean_depth_blocks as number) / BLOCKS);
  constant("seafloor_relief", oceans.seafloor_relief as number);
  constant("trench_depth", oceans.trenches ? Math.abs(oceans.trench_depth_blocks as number) / BLOCKS : 0);
  constant("mountain_strength", cont.mountain_ranges as number);
  constant("plateau_strength", cont.plateaus as number);
  constant("tepui_strength", cont.tepui as number);
  constant("rolling_hills", cont.rolling_hills ? 1 : 0);
  constant("flat_terrain_skew", cont.flat_terrain_skew as number);
  constant("river_depth", rivers.enabled ? Math.abs(rivers.depth_blocks as number) / BLOCKS : 0);
  constant("fjord_depth", fjords.enabled ? Math.abs(fjords.depth_blocks as number) / BLOCKS : 0);
  constant("inland_sea_depth", seas.enabled ? Math.abs(seas.depth_blocks as number) / BLOCKS : 0);
  constant("island_frequency", isl.enabled ? (isl.frequency as number) : 0);
  constant("island_offset", isl.noise_offset as number);
  constant("arc_strength", isl.arc_strength as number);
  constant("coast_cliffs", coast.cliffs);
  constant("sea_stacks", coast.sea_stacks);
  constant("columnar_jointing", coast.columnar_jointing);
  constant("width_variation", widthAmp);
  constant("height_variation", heightAmp);
  constant("temperature_multiplier", biomes.temperature_multiplier as number);
  constant("temperature_offset", biomes.temperature_offset as number);
  constant("vegetation_multiplier", biomes.vegetation_multiplier as number);
  constant("vegetation_offset", biomes.vegetation_offset as number);
  const centerStrength =
    ({ continent: 0.95, island: 0.8, archipelago: -0.72, ocean: -1.2, default: 0 } as Record<string, number>)[
      centerType
    ] ?? 0;
  constant("center_strength", centerStrength * Number((cfg.center as Section).strength));

  // --------------------------------------------------------------- noises
  noiseDef("parameter/continentalness", -10, [1.75, 1, 2, 3, 2, 2, 1, 1, 1]);
  noiseDef("parameter/erosion", -10, [2, 1.75, 1.5, 1.5, 1.3, 1, 1, 1, 1]);
  noiseDef("parameter/ridge", -8, [1, 2, 1]);
  noiseDef("size_bias/width", -10, [1, 0.6]);
  noiseDef("size_bias/height", -10, [1, 0.6]);
  // Six octaves, not nine: the last three sat at 5-20 block wavelengths and,
  // once the island spline had multiplied them up, dithered the shoreline into
  // speckle instead of shaping an island.
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
  // three octaves so the plateau has a shape, none fine enough to break up its top
  noiseDef("region/tepui", -9, [1, 0.6, 0.25]);
  noiseDef("coast/stack_a", -5, [1, 0.5]);
  noiseDef("coast/stack_b", -5, [1, 0.5]);
  noiseDef("coast/column_a", -3, [1]);
  noiseDef("coast/column_b", -3, [1]);
  noiseDef("coast/fjord", -6, [1, 0.6]);
  noiseDef("ocean/floor_a", -7, [1, 1, 0.6]);
  noiseDef("ocean/floor_b", -5, [1, 0.7]);
  noiseDef("ocean/trench", -10, [1, 0.4]);
  noiseDef("inland_sea", -10, [1, 0.5, 0.25]);
  if (centerType !== "default") {
    for (let i = 1; i <= 4; i++) noiseDef(`center/ring${i}`, -10 - i, [1, 0.25]);
  }

  // ------------------------------------------------------ continent field
  const scale = round8(continentScale);
  const sample = (shiftX: number, shiftZ: number): DF =>
    shiftedNoise(
      `${NS}:parameter/continentalness`,
      scale,
      0,
      add(Number(shiftX.toFixed(6)), "minecraft:shift_x"),
      0,
      add(Number(shiftZ.toFixed(6)), "minecraft:shift_z"),
    );
  df(
    "noise/continent_raw",
    flat(cache2d(mul(Number(blurGain.toFixed(6)), blur(sample, blurAxis, blurWidth, calib.anisotropyTaps, continentScale)))),
  );

  const biasTerms: DF[] = [];
  for (const [axis, constName, noiseName, amp] of [
    ["width", "width_variation", `${NS}:size_bias/width`, widthAmp],
    ["height", "height_variation", `${NS}:size_bias/height`, heightAmp],
  ] as Array<[string, string, string, number]>) {
    if (amp <= 0) continue;
    // a width bias must be constant along z, and the other way round, so it is
    // blurred hard along the axis it must not vary on
    const biasAxis: "x" | "z" = axis === "width" ? "z" : "x";
    const biasScale = continentScale * 0.45;
    const biasWidth = (1.6 * calib.continentBaseWavelength) / biasScale;
    const biasGain = calib.blurGain(1.6);
    const make = (shiftX: number, shiftZ: number): DF =>
      shiftedNoise(noiseName, round8(biasScale), 0, Number(shiftX.toFixed(6)), 0, Number(shiftZ.toFixed(6)));
    biasTerms.push(mul(cfgRef(constName), mul(Number(biasGain.toFixed(6)), blur(make, biasAxis, biasWidth, 9, biasScale))));
  }
  df("noise/size_bias", biasTerms.length ? flat(cache2d(addAll(...biasTerms))) : 0);

  if (centerType === "default") {
    df("center/mask", 0);
    df("center/bias", 0);
  } else {
    const delta = calib.centerRingDelta;
    let rings: DF = 0;
    for (let i = 1; i <= 4; i++) {
      const base = 0.75 + 0.05 * i;
      rings = add(
        rings,
        abs_(
          sub(
            noise(`${NS}:center/ring${i}`, Number(base.toFixed(6)), 0),
            noise(`${NS}:center/ring${i}`, round8(base * (1 - delta)), 0),
          ),
        ),
      );
    }
    df(
      "center/mask",
      flat(
        cache2d(
          spline(mul(0.25, rings), [
            pt(0, 1, 0),
            pt(Number((centerThreshold * 0.55).toFixed(6)), 1, 0),
            pt(Number(centerThreshold.toFixed(6)), 0, 0),
          ]),
        ),
      ),
    );
    df("center/bias", mul(`${NS}:center/mask`, cfgRef("center_strength")));
  }

  const landShape = spline(abs_(`${NS}:noise/continent_raw`), [pt(0, 0, 0), pt(0.4, 0.575, 1), pt(0.48, 0.68, 1)]);
  df(
    "noise/raw_continents",
    flat(
      cache2d(
        clamp(addAll(cfgRef("ocean_offset"), `${NS}:noise/size_bias`, `${NS}:center/bias`, landShape), -1, 2),
      ),
    ),
  );
  df("selector/island", flat(cache2d(rangeChoice(`${NS}:noise/raw_continents`, -1, -0.5, 1, 0))));
  df("selector/continent", flat(cache2d(sub(1, `${NS}:selector/island`))));

  if (seas.enabled && (seas.frequency as number) > 0 && (seas.depth_blocks as number) > 0) {
    const seaScale = calib.continentScaleForSize(seas.size as number, cont.land_ratio as number);
    const threshold = 0.62 - 0.62 * (seas.frequency as number);
    const inlandGate = spline(`${NS}:noise/raw_continents`, [pt(0.02, 0, 0), pt(0.18, 1, 0)]);
    const body = spline(abs_(noise(`${NS}:inland_sea`, round8(seaScale), 0)), [
      pt(Number(threshold.toFixed(4)), 0, 0),
      pt(Number((threshold + 0.06).toFixed(4)), 1, 0),
    ]);
    df("water/inland_sea", flat(cache2d(mul(inlandGate, body))));
  } else {
    df("water/inland_sea", 0);
  }

  // -------------------------------------------------------------- islands
  const islandScaleR = round8(islandScale);
  df(
    "noise/island_core",
    flat(
      cache2d(
        add(mx(noise(`${NS}:island/a`, islandScaleR, 0), noise(`${NS}:island/b`, islandScaleR, 0)), cfgRef("island_offset")),
      ),
    ),
  );
  const clustering = isl.clustering as number;
  const lo = -1 + 1.35 * clustering;
  const hi = lo + Math.max(0.12, 0.55 * (1 - clustering));
  const cluster = spline(noise(`${NS}:island/cluster`, round8(islandClusterScale), 0), [
    pt(Number(lo.toFixed(4)), 0, 0),
    pt(Number(hi.toFixed(4)), 1, 0),
  ]);
  const arc = spline(abs_(noise(`${NS}:island/arc`, round8(islandArcScale), 0)), [pt(0, 1, 0), pt(0.09, 0, 0)]);
  df(
    "noise/island_gate",
    flat(cache2d(clamp(mul(cfgRef("island_frequency"), mul(cluster, add(1, mul(cfgRef("arc_strength"), arc)))), 0, 1.7))),
  );

  // islands fade in over the deep-ocean band; knot locations must strictly
  // increase, so the flat shoulders use an epsilon rather than a repeat
  const falloff = spline(`${NS}:noise/raw_continents`, [
    pt(-0.802, 0.7, 0),
    pt(-0.8, 0.7, -1),
    pt(-0.5, 0, -2.5),
    pt(-0.498, 0, 0),
  ]);
  df(
    "noise/raw_islands",
    flat(cache2d(add(mul(mul(`${NS}:noise/island_core`, `${NS}:noise/island_gate`), falloff), -0.7))),
  );
  df("noise/island_type", flat(cache2d(noise(`${NS}:island/type`, round8(islandTypeScale), 0))));

  // atolls reshape continentalness itself so the lagoon really is water
  const atollShape = nested(`${NS}:noise/raw_islands`, [
    pt(-1, -1, 1),
    pt(-0.3, -0.3, 0.6),
    pt(-0.16, 0.04, 0),
    pt(-0.04, 0.06, 0),
    pt(0.06, -0.22, 0),
    pt(0.45, -0.3, 0),
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
          mul(`${NS}:selector/continent`, add(continentPart, seaPull)),
        ),
      ),
    ),
  );

  // ----------------------------------------------------- biome parameters
  const erosionScale = (continentScale * 2.4) / (cont.erosion_scale as number);
  const ridgeScale = (continentScale * 3.2) / (cont.ridge_scale as number);
  const warp = mul(2.4, noise(`${NS}:mountain/warp`, round8(continentScale * 1.1), 0));
  const ridgeLine = spline(
    abs_(shiftedNoise(`${NS}:mountain/base`, round8(continentScale * 1.8), 0, warp, 0, mul(-1, warp))),
    // Vanilla keeps 9% of land in its mountainous erosion band; a 0.30 cut-off
    // put 54% of land inside a "range".
    [pt(0, 1, 0), pt(0.16, 0, 0)],
  );
  // was continentScale * 5, i.e. 50-100 block wavelengths: the mask flickered
  // inside a single range and left isolated peaks standing on flat ground
  const detail = spline(abs_(noise(`${NS}:mountain/detail`, round8(continentScale * 1.5), 0)), [
    pt(0, 1, 0),
    pt(0.55, 0.62, 0),
  ]);
  df("mountain/ridges", flat(cache2d(mul(ridgeLine, detail))));

  df(
    "erosion/continents",
    flat(
      cache2d(
        clamp(
          addAll(
            mul(0.78, noise(`${NS}:parameter/erosion`, round8(erosionScale), 0)),
            0.12,
            // -1.35 pushed erosion past its clamp over most land, flattening it
            // into one terrain type with abrupt edges. Vanilla erosion on land
            // averages -0.055.
            mul(-0.75, mul(cfgRef("mountain_strength"), `${NS}:mountain/ridges`)),
          ),
          -1,
          1,
        ),
      ),
    ),
  );

  const islandErosion = byIslandType(
    {
      cliff: nested(`${NS}:noise/raw_islands`, [pt(-0.3, -0.35, 0), pt(0.05, -0.95, 0)]),
      volcano: nested(`${NS}:noise/raw_islands`, [pt(-0.3, -0.25, 0), pt(0.05, -0.8, 0)]),
      atoll: 0.62,
    },
    nested(abs_(noise(`${NS}:island/erosion`, round8(islandScale * 1.6), 0)), [pt(0, -0.15, 0), pt(0.6, 0.55, 0)]),
  );
  df("erosion/islands", flat(cache2d(clamp(islandErosion, -1, 1))));
  df(
    "biome/erosion",
    flat(
      cache2d(
        add(
          mul(`${NS}:selector/island`, `${NS}:erosion/islands`),
          mul(`${NS}:selector/continent`, `${NS}:erosion/continents`),
        ),
      ),
    ),
  );
  df(
    "biome/ridges",
    flat(
      cache2d(
        clamp(
          add(
            mul(`${NS}:selector/island`, noise(`${NS}:island/ridge`, round8(islandScale * 2.2), 0)),
            mul(`${NS}:selector/continent`, noise(`${NS}:parameter/ridge`, round8(ridgeScale), 0)),
          ),
          -1,
          1,
        ),
      ),
    ),
  );
  // vanilla's peaks-and-valleys fold: 1 - 3 * ||ridges| - 2/3|
  df(
    "biome/ridges_folded",
    flat(
      cache2d(
        mul(-3, add(-0.3333333333333333, abs_(add(-0.6666666666666666, abs_(`${NS}:biome/ridges`))))),
      ),
    ),
  );

  // --------------------------------------------------------------- climate
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
              shiftedNoise("minecraft:temperature", round8(tempScale), 0, "minecraft:shift_x", 0, "minecraft:shift_z"),
            ),
            // atolls and volcanic islands belong in warm water
            mul(`${NS}:selector/island`, byIslandType({ atoll: 0.35, volcano: 0.15 }, 0)),
          ),
          -2,
          2,
        ),
      ),
    ),
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
              shiftedNoise("minecraft:vegetation", round8(vegScale), 0, "minecraft:shift_x", 0, "minecraft:shift_z"),
            ),
          ),
          -2,
          2,
        ),
      ),
    ),
  );

  // ---------------------------------------------------------- water carving
  const folded = `${NS}:biome/ridges_folded`;
  if (rivers.enabled && (rivers.depth_blocks as number) > 0) {
    const band = Math.min(0.55, 0.15 * (rivers.width as number));
    const channel = spline(folded, [pt(-1, 1, 0), pt(Number((-1 + band).toFixed(4)), 0, 0)]);
    const inland = spline(`${NS}:noise/raw_continents`, [pt(-0.06, 0, 0), pt(0.04, 1, 0)]);
    df("water/river", flat(cache2d(mul(channel, inland))));
  } else {
    df("water/river", 0);
  }
  if (fjords.enabled && (fjords.depth_blocks as number) > 0 && (fjords.frequency as number) > 0) {
    // Four multiplied gates used to leave fjords on 0.2% of the world. Each is
    // widened so their product lands nearer the river coverage, and the picker
    // now opens up as frequency rises instead of closing down.
    const band = Math.min(0.55, 0.18 * (fjords.width as number));
    const channel = spline(folded, [pt(-1, 1, 0), pt(Number((-1 + band).toFixed(4)), 0, 0)]);
    const steep = spline(`${NS}:biome/erosion`, [pt(-0.85, 1, 0), pt(-0.3, 0, 0)]);
    const coastal = spline(`${NS}:noise/raw_continents`, [
      pt(-0.44, 0, 0),
      pt(-0.3, 1, 0),
      pt(0.16, 1, 0),
      pt(0.32, 0, 0),
    ]);
    const picker = spline(abs_(noise(`${NS}:coast/fjord`, round8(continentScale * 2.5), 0)), [
      pt(0, 1, 0),
      pt(Number((0.12 + 0.62 * (fjords.frequency as number)).toFixed(4)), 0, 0),
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
          addAll(
            mul(cfgRef("river_depth"), `${NS}:water/river`),
            mul(cfgRef("fjord_depth"), `${NS}:water/fjord`),
            mul(cfgRef("inland_sea_depth"), `${NS}:water/inland_sea`),
          ),
        ),
      ),
    ),
  );

  // --------------------------------------------------------------- offsets
  // Gains here are blocks-per-unit of a field that swings its whole range every
  // ~150 blocks, so they set the terrain's slope. Vanilla's ridges-driven
  // splines have a median local gain of 0.378 across 43 leaves; these used to
  // run 0.75-1.02, which is what turned ridges into spikes.
  const mountains = nested(folded, [
    pt(-1, scaled("mountain_strength", 0.3), 0),
    pt(-0.2, scaled("mountain_strength", 0.52), 0),
    pt(0.45, scaled("mountain_strength", 0.86), 0),
    pt(1, scaled("mountain_strength", 1.16), 0),
  ]);
  const highHills = nested(folded, [
    pt(-1, 0.18, 0),
    pt(0.2, 0.38, 0),
    pt(1, scaled("mountain_strength", 0.62), 0),
  ]);
  const plateau = nested(noise(`${NS}:region/plateau`, round8(continentScale * 3.6), 0), [
    pt(-0.6, 0.11, 0),
    pt(-0.16, 0.12, 0),
    pt(-0.1, scaled("plateau_strength", 0.34), 0),
    pt(0.18, scaled("plateau_strength", 0.36), 0),
    pt(0.24, scaled("plateau_strength", 0.62), 0),
    pt(0.6, scaled("plateau_strength", 0.65), 0),
  ]);
  // A plateau on the Tibetan scale, not a mesa. The field runs an order of
  // magnitude coarser than it did, so one plateau spans thousands of blocks
  // instead of a few hundred, and it is emitted as its own density function
  // because both the profile and the selector below read it.
  const plateauField = df(
    "terrain/plateau_field",
    flat(cache2d(noise(`${NS}:region/tepui`, round8(continentScale * 0.85), 0))),
  );
  // The flank rises across a wide band of the field rather than a 0.04 sliver,
  // which had put a vertical wall around every one, and the cap is deliberately
  // almost level: 0.06 of offset across it is 8 blocks of relief over the whole
  // plateau.
  const tepui = nested(plateauField, [
    pt(0.1, 0.16, 0),
    pt(0.3, 0.3, 0),
    pt(0.46, scaled("tepui_strength", 0.78), 0),
    pt(0.62, scaled("tepui_strength", 0.86), 0),
    pt(1.0, scaled("tepui_strength", 0.92), 0),
  ]);
  // Which of the two a place gets is decided by the plateau field, not by
  // humidity: vegetation only reaches 0.61 with a p90 of 0.31, so the old
  // "vegetation > 0.42" gate fired on 4.5% of land and, multiplied by the
  // erosion band, left tepuis on 0.9% of it — measured, they never appeared.
  const plateauOrTepui = nested(plateauField, [pt(0.18, plateau, 0), pt(0.3, tepui, 0)]);
  const rolling = nested(noise(`${NS}:region/plateau`, round8(continentScale * 7), 0), [
    pt(-0.6, 0.055, 0),
    pt(0, scaled("rolling_hills", 0.135), 0),
    pt(0.6, 0.06, 0),
  ]);
  const skew = cont.flat_terrain_skew as number;
  const plateauEdge = Number((0.05 + (skew - 0.1) * 1.5).toFixed(4));

  const inland = nested(`${NS}:biome/erosion`, [
    pt(-1, mountains, 0),
    pt(-0.58, mountains, 0),
    pt(-0.45, highHills, 0),
    pt(-0.22, plateauOrTepui, 0),
    pt(plateauEdge, plateauOrTepui, 0),
    pt(Number((plateauEdge + 0.11).toFixed(4)), rolling, 0),
    pt(0.55, 0.055, 0),
    pt(1, 0.035, 0),
  ]);
  const nearInland = nested(`${NS}:biome/erosion`, [
    pt(-1, nested(folded, [pt(-0.4, 0.2, 0), pt(1, scaled("mountain_strength", 0.7), 0)]), 0),
    pt(-0.45, 0.22, 0),
    pt(-0.1, 0.14, 0),
    pt(0.4, 0.055, 0),
    pt(1, 0.03, 0),
  ]);
  const coastProfile = nested(`${NS}:biome/erosion`, [
    pt(-1, scaled("coast_cliffs", 0.52), 0),
    pt(-0.35, scaled("coast_cliffs", 0.3), 0),
    pt(-0.05, 0.045, 0),
    pt(1, 0.01, 0),
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
          pt(0.7, inland, 0),
        ]),
      ),
    ),
  );

  const normalIsland = nested(`${NS}:noise/raw_islands`, [
    pt(-0.72, shelf, 0),
    pt(-0.3, -0.1, 0),
    pt(-0.08, 0.02, 0),
    pt(0.06, 0.14, 0),
    pt(0.4, 0.34, 0),
  ]);
  const atollIsland = nested(`${NS}:noise/raw_islands`, [
    pt(-0.72, shelf, 0),
    pt(-0.34, -0.09, 0),
    pt(-0.12, -0.015, 0),
    pt(-0.02, 0.032, 0),
    pt(0.05, -0.035, 0),
    pt(0.4, -0.055, 0),
  ]);
  const volcanoIsland = nested(`${NS}:noise/raw_islands`, [
    pt(-0.72, shelf, 0),
    pt(-0.3, -0.07, 0),
    pt(-0.05, 0.22, 0),
    pt(0.12, scaled("mountain_strength", 0.95), 0),
    pt(0.22, scaled("mountain_strength", 1.42), 0),
    pt(0.27, scaled("mountain_strength", 1.5), 0),
    pt(0.32, scaled("mountain_strength", 1.28), 0),
  ]);
  const cliffIsland = nested(`${NS}:noise/raw_islands`, [
    pt(-0.72, shelf, 0),
    pt(-0.28, -0.08, 0),
    pt(-0.22, scaled("coast_cliffs", 0.55), 0),
    pt(0.02, scaled("mountain_strength", 0.95), 0),
    pt(0.36, scaled("mountain_strength", 1.4), 0),
  ]);
  df(
    "terrain/offset_islands",
    flat(cache2d(byIslandType({ atoll: atollIsland, volcano: volcanoIsland, cliff: cliffIsland }, normalIsland))),
  );

  const relief = mul(
    cfgRef("seafloor_relief"),
    add(mul(0.055, noise(`${NS}:ocean/floor_a`, 0.55, 0)), mul(0.022, noise(`${NS}:ocean/floor_b`, 1.4, 0))),
  );
  const trench = mul(
    mul(-1, cfgRef("trench_depth")),
    spline(abs_(noise(`${NS}:ocean/trench`, round8(continentScale * 2), 0)), [pt(0, 1, 0), pt(0.05, 0, 0)]),
  );
  const oceanMask = spline(`${NS}:noise/raw_continents`, [pt(-1, 1, 0), pt(-0.26, 1, 0), pt(-0.16, 0, 0)]);
  df("terrain/ocean_relief", flat(cache2d(mul(oceanMask, add(relief, trench)))));

  df(
    "terrain/coast_mask",
    flat(
      cache2d(
        spline(`${NS}:noise/raw_continents`, [pt(-0.34, 0, 0), pt(-0.26, 1, 0), pt(-0.11, 1, 0), pt(-0.04, 0, 0)]),
      ),
    ),
  );
  // Sea stacks and columns are cliff features: they belong on a steep, rocky
  // coast, not sprayed across every shoreline. Without this gate they reached 8
  // blocks or more on 4-8% of all land, at 16-32 block wavelengths.
  const coastSteep = spline(`${NS}:biome/erosion`, [pt(-1, 1, 0), pt(-0.62, 0, 0)]);
  const stackBand = spline(`${NS}:noise/raw_continents`, [
    pt(-0.32, 0, 0),
    pt(-0.26, 1, 0),
    pt(-0.17, 1, 0),
    pt(-0.12, 0, 0),
  ]);
  const stackField = mn(
    spline(abs_(noise(`${NS}:coast/stack_a`, 1, 0)), [pt(0, 1, 0), pt(0.34, 0, 0)]),
    spline(abs_(noise(`${NS}:coast/stack_b`, 1, 0)), [pt(0, 1, 0), pt(0.34, 0, 0)]),
  );
  // 0.42 let roughly one point in twenty qualify; a stack field is meant to be a
  // handful of pillars, so the threshold is far higher now
  const seaStacks = mul(
    mul(cfgRef("sea_stacks"), mul(coastSteep, stackBand)),
    spline(stackField, [pt(0, 0, 0), pt(0.7, 0, 0), pt(1, 0.3, 0)]),
  );
  const columnField = mn(
    spline(abs_(noise(`${NS}:coast/column_a`, 1, 0)), [pt(0, 1, 0), pt(0.4, 0, 0)]),
    spline(abs_(noise(`${NS}:coast/column_b`, 1, 0)), [pt(0, 1, 0), pt(0.4, 0, 0)]),
  );
  // flat treads of 3 blocks each give the stepped, flat-topped look; 3/128
  const columnar = mul(
    mul(cfgRef("columnar_jointing"), coastSteep),
    spline(columnField, [
      pt(0, 0, 0),
      pt(0.24, 0, 0),
      pt(0.26, 0.0234, 0),
      pt(0.48, 0.0234, 0),
      pt(0.5, 0.0469, 0),
      pt(0.72, 0.0469, 0),
      pt(0.74, 0.0703, 0),
      pt(1, 0.0703, 0),
    ]),
  );
  df("terrain/coast_features", flat(cache2d(mul(`${NS}:terrain/coast_mask`, add(seaStacks, columnar)))));

  const vscale = rangeChoice(`${NS}:terrain/offset_continents`, 0, 64, cfgRef("vertical_scale"), 1);
  const islandVscale = rangeChoice(`${NS}:terrain/offset_islands`, 0, 64, cfgRef("vertical_scale"), 1);
  const rawOffset = addAll(
    mul(`${NS}:selector/continent`, mul(vscale, `${NS}:terrain/offset_continents`)),
    mul(`${NS}:selector/island`, mul(islandVscale, `${NS}:terrain/offset_islands`)),
    `${NS}:terrain/ocean_relief`,
    `${NS}:terrain/coast_features`,
    `${NS}:water/carve`,
  );
  const body = add(round8(baseOffset), mx(mn(rawOffset, cfgRef("max_offset")), cfgRef("min_offset")));
  write(
    "data/minecraft/worldgen/density_function/overworld/offset.json",
    flat(
      cache2d(
        add(
          mul({ type: "minecraft:blend_offset" }, sub(1, { type: "minecraft:blend_alpha" })),
          mul(body, { type: "minecraft:blend_alpha" }),
        ),
      ),
    ),
  );

  // -------------------------------------------------- factor / jaggedness
  const inlandFactor = nested(`${NS}:biome/erosion`, [
    pt(-1, 1.05, 0),
    pt(-0.55, 1.9, 0),
    pt(-0.3, 4.4, 0),
    pt(-0.05, 6, 0),
    pt(0.35, 6.4, 0),
    pt(1, 6.6, 0),
  ]);
  // steep coastal transitions are what make cliffs, sea stacks and columns
  // read as vertical rock instead of gentle mounds
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
          pt(0.7, inlandFactor, 0),
        ]),
      ),
    ),
  );

  const jagInland = nested(`${NS}:biome/erosion`, [
    pt(-1, nested(folded, [pt(0, 0, 0), pt(1, scaled("mountain_strength", 0.62), 0)]), 0),
    pt(-0.5, nested(folded, [pt(0.2, 0, 0), pt(1, scaled("mountain_strength", 0.28), 0)]), 0),
    pt(-0.25, 0, 0),
    pt(1, 0, 0),
  ]);
  write(
    "data/minecraft/worldgen/density_function/overworld/jaggedness.json",
    flat(cache2d(spline(`${NS}:noise/raw_continents`, [pt(0, 0, 0), pt(0.16, jagInland, 0), pt(0.7, jagInland, 0)]))),
  );

  // --------------------------------------------------------------- routers
  write(
    "data/minecraft/worldgen/density_function/overworld/continents.json",
    flat(cache2d(add(`${NS}:noise/full_continents`, 0))),
  );
  write(
    "data/minecraft/worldgen/density_function/overworld/erosion.json",
    flat(cache2d(add(`${NS}:biome/erosion`, 0))),
  );
  write(
    "data/minecraft/worldgen/density_function/overworld/ridges.json",
    flat(cache2d(add(`${NS}:biome/ridges`, 0))),
  );
  write(
    "data/minecraft/worldgen/density_function/overworld/depth.json",
    add(
      {
        type: "minecraft:y_clamped_gradient",
        from_y: buildMinY,
        to_y: buildMaxY,
        from_value: round8(depthTop),
        to_value: round8(-depthTop),
      },
      "minecraft:overworld/offset",
    ),
  );

  const settings = await vanilla.noiseSettings("overworld");
  settings.sea_level = Math.trunc(seaLevel);
  (settings.noise as Record<string, number>).min_y = buildMinY;
  (settings.noise as Record<string, number>).height = buildHeight;
  const router = settings.noise_router as Record<string, unknown>;
  router.temperature = `${NS}:climate/temperature`;
  router.vegetation = `${NS}:climate/vegetation`;
  if ((cfg.spawn as Section).force_land_spawn) {
    // vanilla looks for continentalness >= -0.11, which includes coast and
    // shallow ocean; mid-inland guarantees dry land
    for (const target of settings.spawn_target as Array<Record<string, unknown>>) {
      target.continentalness = [0.03, 1.0];
    }
  }
  write("data/minecraft/worldgen/noise_settings/overworld.json", settings);

  if (buildMinY !== -64 || buildHeight !== 384) {
    const dimension = await vanilla.dimensionType("overworld");
    dimension.min_y = buildMinY;
    dimension.height = buildHeight;
    dimension.logical_height = buildHeight;
    write("data/minecraft/dimension_type/overworld.json", dimension);
  }

  // ------------------------------------------------------ caves/structures
  if (Math.abs(caveFactor - 1) > 1e-3) {
    for (const name of vanilla.CAVE_NOISES) {
      write(`data/minecraft/worldgen/noise/${name}.json`, vanilla.scaleNoise(await vanilla.noise(name), caveFactor));
    }
  }
  if (Math.abs(structureFactor - 1) > 1e-3) {
    for (const name of vanilla.OVERWORLD_STRUCTURE_SETS) {
      const data = await vanilla.structureSet(name);
      const placement = (data.placement ?? {}) as Record<string, unknown>;
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

  // -------------------------------------------------------------- spawn
  if ((cfg.spawn as Section).force_land_spawn) {
    const sea = Math.trunc(seaLevel);
    const radii = [400, 900, 1800, 3200, 6000, 11000, 20000, 36000];
    files.set(
      `data/${NS}/function/spawn/load.mcfunction`,
      "# MineWorldGen - keeps players off the open ocean at spawn\nscoreboard objectives add mwg.try dummy\n\n",
    );
    files.set(
      `data/${NS}/function/spawn/tick.mcfunction`,
      "# runs only for players who have not been checked yet\n" +
        "execute as @a[tag=!mwg.spawn_ok] at @s run function mwg:spawn/check\n\n",
    );
    const check = [
      "# already on solid ground above sea level? then we are done",
      `execute if entity @s[y=${sea},dy=2048] unless block ~ ~ ~ water unless block ~ ~-1 ~ water run function mwg:spawn/settle`,
      "execute if entity @s[tag=mwg.spawn_ok] run return 0",
      "scoreboard players add @s mwg.try 1",
      ...radii.map((radius, index) => `execute if score @s mwg.try matches ${index + 1} run spreadplayers 0 0 1 ${radius} false @s`),
      `execute if score @s mwg.try matches ${radii.length + 1}.. run tag @s add mwg.spawn_ok`,
      "",
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
        "",
      ].join("\n"),
    );
    write("data/minecraft/tags/function/load.json", { values: [`${NS}:spawn/load`] });
    write("data/minecraft/tags/function/tick.json", { values: [`${NS}:spawn/tick`] });
  }

  write("pack.mcmeta", packMeta("custom terrain"));

  return {
    files,
    adjustments,
    notes: {
      mode: "custom",
      minecraft_version: vanilla.MINECRAFT_VERSION,
      pack_name: packName,
      sea_level: seaLevel,
      build_range: [buildMinY, buildMaxY],
      base_offset: Number(baseOffset.toFixed(6)),
      max_offset: Number(maxOffset.toFixed(6)),
      min_offset: Number(minOffset.toFixed(6)),
      continent_xz_scale: Number(continentScale.toFixed(6)),
      continent_stretch: Number(stretch.toFixed(4)),
      anisotropy_blur_blocks: Number(blurWidth.toFixed(1)),
      anisotropy_gain: Number(blurGain.toFixed(5)),
      ocean_offset: Number(oceanOffset.toFixed(4)),
      predicted_land_ratio: calib.landRatioForOceanOffset(oceanOffset),
      island_xz_scale: Number(islandScale.toFixed(6)),
      island_bands: bands,
      center_threshold: centerThreshold,
      climate_scale_factor: Number(climateFactor.toFixed(4)),
      cave_scale_factor: Number(caveFactor.toFixed(4)),
      structure_spacing_factor: Number(structureFactor.toFixed(4)),
      file_count: files.size,
    },
  };
}
