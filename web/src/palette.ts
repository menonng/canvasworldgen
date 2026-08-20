/**
 * Every colour the map draws, in one place.
 *
 * The map render and the legend read the same tables, so a swatch in the panel
 * is by construction the colour that lands on the canvas. Colours follow what
 * the thing looks like from above in Minecraft — sand for desert, dark green
 * for jungle, white for snow — rather than a hash, so a painted map reads as a
 * map instead of as confetti.
 */

export type RGB = readonly [number, number, number];

// --------------------------------------------------------------- land / ocean
export const LAND_COLOUR: RGB = [176, 178, 172];
export const OCEAN_COLOUR: RGB = [66, 84, 104];
/** Outside the design surface: neither land nor sea, so neither colour. */
export const OUTSIDE_COLOUR: RGB = [30, 33, 38];
/** A layer that is hidden still needs a ground for the others to sit on. */
export const NEUTRAL_COLOUR: RGB = [52, 56, 62];

// ------------------------------------------------------------- terrain features
/**
 * One colour per terrain-feature flag, in the order FEATURE_FLAGS declares
 * them. Chosen to stay apart from each other and from the elevation ramp, so a
 * feature painted over green hills still reads as that feature.
 */
export const FEATURE_COLOURS: Record<string, RGB> = {
  volcano: [214, 74, 48], // basalt and lava
  atoll: [86, 214, 196], // lagoon turquoise
  fjord: [64, 122, 200], // deep cold inlet
  island_arc: [236, 158, 62], // volcanic chain
  mountain_range: [150, 128, 176], // rock violet
  plateau: [198, 154, 96], // dry tableland
  tepui: [232, 108, 168], // steep-sided mesa
  sea_stack: [176, 196, 216], // pale wet rock
  columnar_jointing: [122, 148, 160], // basalt columns
  inland_sea: [56, 154, 186], // enclosed water
  river: [92, 178, 232], // running water
  coral_reef: [244, 132, 176], // reef pink
};

/** Fallback for a flag with no colour yet, stable per name. */
function fallbackFeatureColour(flag: string): RGB {
  let h = 0;
  for (let i = 0; i < flag.length; i++) h = (Math.imul(h, 31) + flag.charCodeAt(i)) | 0;
  const u = (h >>> 0) / 4294967295;
  return [Math.round(120 + 110 * u), Math.round(150 - 60 * u), Math.round(190 - 40 * u)];
}

export function featureColour(flag: string): RGB {
  return FEATURE_COLOURS[flag] ?? fallbackFeatureColour(flag);
}

/**
 * A cell can carry several flags at once, so the fill is their mean. Painting a
 * volcano onto an island arc has to look like both, not like whichever bit
 * happens to be lowest.
 */
export function blendFeatureColours(flags: readonly string[]): RGB {
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

// --------------------------------------------------------------------- biomes
/**
 * Map colours for the vanilla registry. Keyed by the bare id; the namespace is
 * stripped before lookup so `minecraft:plains` and `plains` both work.
 */
const BIOME_COLOURS: Record<string, RGB> = {
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

  the_void: [22, 22, 26],
};

/**
 * Keyword fallback, so a biome the table has not caught up with still gets a
 * colour in the right family rather than grey.
 */
function biomeColourFromName(id: string): RGB {
  const has = (...words: string[]): boolean => words.some((w) => id.includes(w));
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

export function biomeColour(id: string): RGB {
  const bare = id.replace(/^[a-z0-9_.-]+:/, "");
  return BIOME_COLOURS[bare] ?? biomeColourFromName(bare);
}

// ---------------------------------------------------------------- temperature
/** Blue through green to red across the -1..1 climate parameter. */
export function temperatureColour(value: number): RGB {
  const u = Math.max(0, Math.min(1, (value + 1) / 2));
  const stops: Array<[number, RGB]> = [
    [0.0, [96, 148, 220]],
    [0.28, [120, 196, 214]],
    [0.5, [150, 200, 130]],
    [0.72, [226, 186, 96]],
    [1.0, [214, 96, 72]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (u <= b || i === stops.length - 2) {
      const t = Math.max(0, Math.min(1, (u - a) / (b - a)));
      return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
    }
  }
  return [255, 255, 255];
}

// ------------------------------------------------------------------ elevation
/** Land above sea runs sand to green to rock to snow; below it goes blue. */
export function elevationColour(y: number, seaLevel: number, isLand: boolean): RGB {
  const d = y - seaLevel;
  if (!isLand) {
    const t = Math.max(0, Math.min(1, -d / 96));
    return [Math.round(46 - 34 * t), Math.round(106 - 74 * t), Math.round(170 - 90 * t)];
  }
  const stops: Array<[number, RGB]> = [
    [-32, [120, 130, 110]],
    [0, [226, 214, 168]],
    [12, [150, 190, 110]],
    [48, [92, 152, 84]],
    [110, [140, 128, 84]],
    [170, [138, 126, 118]],
    [230, [198, 198, 200]],
    [300, [246, 249, 252]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (d <= b || i === stops.length - 2) {
      const t = Math.max(0, Math.min(1, (d - a) / (b - a)));
      return [
        Math.round(ca[0] + (cb[0] - ca[0]) * t),
        Math.round(ca[1] + (cb[1] - ca[1]) * t),
        Math.round(ca[2] + (cb[2] - ca[2]) * t),
      ];
    }
  }
  return [255, 255, 255];
}

/** CSS colour, for legend swatches. */
export function css(colour: RGB): string {
  return `rgb(${Math.round(colour[0])}, ${Math.round(colour[1])}, ${Math.round(colour[2])})`;
}
