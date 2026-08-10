/**
 * Access to the vanilla Minecraft 26.2 worldgen files the pack is built from.
 *
 * Pages serves the whole repository, so the same files the Python generator
 * patches are fetchable from the site; there is no second copy to keep in
 * step. Fetched lazily and cached, so opening the editor costs nothing.
 */

const ROOT = new URL("./tools/vanilla/minecraft/", document.baseURI).href;

export const MINECRAFT_VERSION = "26.2";
export const PACK_FORMAT = 107;

const cache = new Map<string, unknown>();

async function load<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit !== undefined) return structuredClone(hit) as T;
  const response = await fetch(ROOT + path);
  if (!response.ok) throw new Error(`missing vanilla file ${path} (${response.status})`);
  const value = (await response.json()) as unknown;
  cache.set(path, value);
  return structuredClone(value) as T;
}

export function noise(name: string): Promise<Record<string, unknown>> {
  return load(`worldgen/noise/${name}.json`);
}

export function densityFunction(path: string): Promise<unknown> {
  return load(`worldgen/density_function/${path}.json`);
}

export function noiseSettings(name = "overworld"): Promise<Record<string, unknown>> {
  return load(`worldgen/noise_settings/${name}.json`);
}

export function dimensionType(name = "overworld"): Promise<Record<string, unknown>> {
  return load(`dimension_type/${name}.json`);
}

export function structureSet(name: string): Promise<Record<string, unknown>> {
  return load(`worldgen/structure_set/${name}.json`);
}

export const OVERWORLD_STRUCTURE_SETS = [
  "ancient_cities", "buried_treasures", "desert_pyramids", "igloos", "jungle_temples",
  "mineshafts", "ocean_monuments", "ocean_ruins", "pillager_outposts", "ruined_portals",
  "shipwrecks", "strongholds", "swamp_huts", "trail_ruins", "trial_chambers", "villages",
  "woodland_mansions",
] as const;

export const CAVE_NOISES = [
  "cave_cheese", "cave_entrance", "cave_layer", "noodle", "noodle_ridge_a", "noodle_ridge_b",
  "noodle_thickness", "pillar", "pillar_rareness", "pillar_thickness", "spaghetti_2d",
  "spaghetti_2d_elevation", "spaghetti_2d_modulator", "spaghetti_2d_thickness",
  "spaghetti_3d_1", "spaghetti_3d_2", "spaghetti_3d_rarity", "spaghetti_3d_thickness",
  "spaghetti_roughness", "spaghetti_roughness_modulator",
] as const;

/**
 * Noise parameters whose features are `factor` times larger.
 *
 * firstOctave only moves in whole octaves, so a fractional factor blends the
 * amplitude arrays of the two neighbouring shifts. The result is a genuinely
 * continuous scale rather than a rounded one.
 */
export function scaleNoise(params: Record<string, unknown>, factor: number): Record<string, unknown> {
  if (Math.abs(factor - 1) < 1e-6) return structuredClone(params);
  const exponent = Math.log2(factor);
  const whole = Math.floor(exponent);
  const frac = exponent - whole;
  const amplitudes = (params.amplitudes as number[]).map(Number);
  const low = [0, ...amplitudes];
  const high = [...amplitudes, 0];
  const blended = low.map((a, i) => Number(((1 - frac) * a + frac * high[i]).toFixed(6)));
  while (blended.length > 1 && blended[blended.length - 1] === 0) blended.pop();
  return { firstOctave: Number(params.firstOctave) - whole - 1, amplitudes: blended };
}
