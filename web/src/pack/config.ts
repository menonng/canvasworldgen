/**
 * Generator config: defaults, and clamping every value into range.
 *
 * Nothing is ever rejected. A value past its bound is pulled back, an
 * unusable one falls back to the default, and an impossible combination is
 * resolved in favour of whichever setting the player most likely cares about.
 * Mirrors tools/mwgbuild/config.py.
 */

import { landRatioBounds, maxStretch } from "./calib";

export type Mode = "vanilla" | "custom";
export type CenterType = "archipelago" | "continent" | "island" | "ocean" | "default";

export const MODES: Mode[] = ["vanilla", "custom"];
export const CENTER_TYPES: CenterType[] = ["archipelago", "continent", "island", "ocean", "default"];

/** Continent size that matches vanilla's own scale, from tools/calibrate.py. */
export const VANILLA_CONTINENT_SIZE = 1400;

export type Section = Record<string, number | boolean | string | null>;
export type Config = Record<string, Section | string | number>;

export const DEFAULTS: Record<string, Section> = {
  world: {
    sea_level: 63,
    build_min_y: -64,
    build_height: 384,
    terrain_max_y: 312,
    terrain_min_y: -40,
    vertical_scale: 1.0,
  },
  center: { type: "default", radius: 2500, strength: 1.0 },
  continents: {
    land_ratio: 0.32,
    ocean_offset: null,
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

const RANGES: Record<string, Record<string, [number, number]>> = {
  world: {
    sea_level: [-2032, 2032],
    build_min_y: [-2032, 0],
    build_height: [16, 4064],
    terrain_max_y: [-2032, 4032],
    terrain_min_y: [-2032, 4032],
    vertical_scale: [0.1, 4.0],
  },
  center: { radius: [200, 200000], strength: [0, 2] },
  continents: {
    land_ratio: [0.02, 0.95],
    ocean_offset: [-2, 1],
    width: [300, 400000],
    height: [300, 400000],
    width_variation_percent: [0, 80],
    height_variation_percent: [0, 80],
    erosion_scale: [0.1, 8],
    ridge_scale: [0.1, 8],
    flat_terrain_skew: [0, 1],
    mountain_ranges: [0, 2],
    plateaus: [0, 2],
    tepui: [0, 2],
  },
  rivers: { width: [0.1, 4], depth_blocks: [0, 120] },
  inland_seas: { frequency: [0, 1], size: [500, 100000], depth_blocks: [0, 200] },
  fjords: { frequency: [0, 1], width: [0.1, 4], depth_blocks: [0, 200] },
  islands: {
    size: [80, 20000],
    frequency: [0, 3],
    clustering: [0, 1],
    arc_strength: [0, 2],
    noise_offset: [-0.6, 0.6],
    atoll_chance: [0, 1],
    volcanic_chance: [0, 1],
    cliff_chance: [0, 1],
  },
  oceans: {
    ocean_depth_blocks: [0, 1000],
    deep_ocean_depth_blocks: [0, 1000],
    seafloor_relief: [0, 4],
    trench_depth_blocks: [0, 1000],
  },
  coast: { cliffs: [0, 2], sea_stacks: [0, 2], columnar_jointing: [0, 2] },
  biomes: {
    temperature_scale: [0.05, 8],
    temperature_offset: [-1, 1],
    temperature_multiplier: [0.05, 8],
    vegetation_scale: [0.05, 8],
    vegetation_offset: [-1, 1],
    vegetation_multiplier: [0.05, 8],
  },
  caves: { size_multiplier: [0.25, 4] },
  structures: { spacing_multiplier: [0.25, 8] },
};

const BOOLEAN_KEYS: Array<[string, string]> = [
  ["continents", "rolling_hills"],
  ["rivers", "enabled"],
  ["inland_seas", "enabled"],
  ["fjords", "enabled"],
  ["islands", "enabled"],
  ["oceans", "trenches"],
  ["biomes", "scale_with_continents"],
  ["caves", "scale_with_continents"],
  ["caves", "carvers_enabled"],
  ["structures", "scale_with_continents"],
  ["spawn", "force_land_spawn"],
];

/**
 * One clamping decision, reported rather than applied silently.
 *
 * `text` is the English wording, kept identical to the Python tool's output.
 * `key` and `params` let the editor render the same message in another
 * language without either copy drifting from the other.
 */
export interface Adjustment {
  key: string;
  params: Record<string, string | number>;
  text: string;
}

export interface Normalised {
  mode: Mode;
  cfg: Record<string, Section>;
  adjustments: Adjustment[];
}

const roundTo = (value: number, step: number): number => Math.round(value / step) * step;

export function normalise(input: Record<string, unknown>): Normalised {
  const adjustments: Adjustment[] = [];
  const note = (key: string, params: Record<string, string | number>, text: string): void =>
    void adjustments.push({ key, params, text });

  const cfg: Record<string, Section> = {};
  for (const [section, defaults] of Object.entries(DEFAULTS)) {
    const given = (input[section] ?? {}) as Section;
    cfg[section] = { ...defaults, ...given };
  }

  let mode = String(input.mode ?? "vanilla").trim().toLowerCase() as Mode;
  if (!MODES.includes(mode)) {
    note("adjust.mode", { value: String(input.mode) }, `mode "${String(input.mode)}" is not recognised, falling back to "vanilla"`);
    mode = "vanilla";
  }

  let centerType = String(cfg.center.type ?? "default").trim().toLowerCase() as CenterType;
  if (!CENTER_TYPES.includes(centerType)) {
    note(
      "adjust.centerType",
      { value: String(cfg.center.type) },
      `center.type "${String(cfg.center.type)}" is not recognised, using "default"`,
    );
    centerType = "default";
  }
  cfg.center.type = centerType;

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
          `${section}.${key} is not a number, using the default ${String(fallback)}`,
        );
        cfg[section][key] = fallback;
        continue;
      }
      if (value < lo) {
        note(
          "adjust.min",
          { path: `${section}.${key}`, value, bound: lo },
          `${section}.${key} raised from ${value} to the minimum ${lo}`,
        );
        cfg[section][key] = lo;
      } else if (value > hi) {
        note(
          "adjust.max",
          { path: `${section}.${key}`, value, bound: hi },
          `${section}.${key} lowered from ${value} to the maximum ${hi}`,
        );
        cfg[section][key] = hi;
      }
    }
  }

  const world = cfg.world as Record<string, number>;
  for (const key of ["build_min_y", "build_height"] as const) {
    const [lo, hi] = RANGES.world[key];
    const rounded = Math.max(lo, Math.min(hi, roundTo(world[key], 16)));
    if (rounded !== world[key]) {
      note(
        "adjust.multiple16",
        { path: `world.${key}`, from: world[key], to: rounded },
        `world.${key} rounded from ${world[key]} to ${rounded} (must be a multiple of 16)`,
      );
      world[key] = rounded;
    }
  }
  const buildMax = world.build_min_y + world.build_height;
  const top = buildMax - 8;
  const bottom = world.build_min_y + 8;

  for (const [key, lo, hi] of [
    ["terrain_max_y", bottom + 2, top],
    ["terrain_min_y", bottom, top - 2],
  ] as Array<[string, number, number]>) {
    const clamped = Math.max(lo, Math.min(hi, world[key]));
    if (clamped !== world[key]) {
      note(
        "adjust.buildLimits",
        { path: `world.${key}`, from: world[key], to: clamped },
        `world.${key} moved from ${world[key]} to ${clamped} to fit the build limits`,
      );
      world[key] = clamped;
    }
  }
  if (world.terrain_min_y >= world.terrain_max_y) {
    world.terrain_min_y = Math.max(bottom, world.terrain_max_y - 16);
    note(
      "adjust.terrainMinY",
      { to: world.terrain_min_y },
      `world.terrain_min_y was at or above terrain_max_y, lowered to ${world.terrain_min_y}`,
    );
  }
  const sea = Math.max(world.terrain_min_y + 1, Math.min(world.terrain_max_y - 1, world.sea_level));
  if (sea !== world.sea_level) {
    note(
      "adjust.seaLevel",
      { from: world.sea_level, to: sea },
      `world.sea_level moved from ${world.sea_level} to ${sea} to sit between the limits`,
    );
    world.sea_level = sea;
  }

  const cont = cfg.continents as Record<string, number | boolean | null>;
  const limit = maxStretch();
  const width = cont.width as number;
  const height = cont.height as number;
  const ratio = Math.max(width / height, height / width);
  if (ratio > limit) {
    if (width >= height) {
      const next = Math.round(height * limit);
      note(
        "adjust.continentWidth",
        { from: width, to: next, limit: limit.toFixed(2) },
        `continents.width lowered from ${width} to ${next} (max ratio 1:${limit.toFixed(2)})`,
      );
      cont.width = next;
    } else {
      const next = Math.round(width * limit);
      note(
        "adjust.continentHeight",
        { from: height, to: next, limit: limit.toFixed(2) },
        `continents.height lowered from ${height} to ${next} (max ratio 1:${limit.toFixed(2)})`,
      );
      cont.height = next;
    }
  }

  if (cont.ocean_offset === null || cont.ocean_offset === undefined) {
    const [loLand, hiLand] = landRatioBounds();
    const target = cont.land_ratio as number;
    const clamped = Math.max(loLand, Math.min(hiLand, target));
    if (Math.abs(clamped - target) > 1e-6) {
      note(
        "adjust.landRatio",
        { from: target, to: clamped.toFixed(3) },
        `continents.land_ratio moved from ${target} to ${clamped.toFixed(3)} ` +
          "(reachable range with the current island settings)",
      );
      cont.land_ratio = Number(clamped.toFixed(4));
    }
  }

  const oceans = cfg.oceans as Record<string, number | boolean>;
  const trench = oceans.trenches ? (oceans.trench_depth_blocks as number) : 0;
  const floor = world.sea_level - ((oceans.deep_ocean_depth_blocks as number) + trench);
  if (floor < world.terrain_min_y) {
    const room = world.sea_level - Math.max(bottom, world.build_min_y + 8);
    const wanted = (oceans.deep_ocean_depth_blocks as number) + trench;
    if (wanted <= room) {
      note(
        "adjust.terrainMinYForOcean",
        { from: world.terrain_min_y, to: floor },
        `world.terrain_min_y lowered from ${world.terrain_min_y} to ${floor} ` +
          "to make room for the configured ocean depth",
      );
      world.terrain_min_y = Math.trunc(floor);
    } else {
      const scale = wanted ? room / wanted : 1;
      oceans.deep_ocean_depth_blocks = Math.trunc((oceans.deep_ocean_depth_blocks as number) * scale);
      if (oceans.trenches) oceans.trench_depth_blocks = Math.trunc((oceans.trench_depth_blocks as number) * scale);
      world.terrain_min_y = Math.trunc(
        world.sea_level -
          (oceans.deep_ocean_depth_blocks as number) -
          (oceans.trenches ? (oceans.trench_depth_blocks as number) : 0),
      );
      note(
        "adjust.oceanDepthScaled",
        {
          deep: oceans.deep_ocean_depth_blocks as number,
          trench: oceans.trench_depth_blocks as number,
        },
        "the configured ocean depth does not fit in the world, depths scaled to " +
          `${oceans.deep_ocean_depth_blocks} / ${oceans.trench_depth_blocks} blocks`,
      );
    }
  }
  if ((oceans.ocean_depth_blocks as number) > (oceans.deep_ocean_depth_blocks as number)) {
    note(
      "adjust.oceanDepthOrder",
      { to: oceans.deep_ocean_depth_blocks as number },
      "oceans.ocean_depth_blocks was deeper than deep_ocean_depth_blocks, " +
        `lowered to ${oceans.deep_ocean_depth_blocks}`,
    );
    oceans.ocean_depth_blocks = oceans.deep_ocean_depth_blocks;
  }

  const isl = cfg.islands as Record<string, number | boolean>;
  const total =
    (isl.atoll_chance as number) + (isl.volcanic_chance as number) + (isl.cliff_chance as number);
  if (total > 0.95) {
    const scale = 0.95 / total;
    for (const key of ["atoll_chance", "volcanic_chance", "cliff_chance"] as const) {
      isl[key] = Number(((isl[key] as number) * scale).toFixed(4));
    }
    note(
      "adjust.islandChances",
      {
        atoll: isl.atoll_chance as number,
        volcanic: isl.volcanic_chance as number,
        cliff: isl.cliff_chance as number,
      },
      "island archetype chances summed above 0.95, scaled down to " +
        `${isl.atoll_chance} / ${isl.volcanic_chance} / ${isl.cliff_chance}`,
    );
  }

  return { mode, cfg, adjustments };
}
