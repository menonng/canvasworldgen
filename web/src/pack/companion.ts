/**
 * Fold a player's own copy of Overhauled Overworld into the generated pack.
 *
 * The policy half of tools/build_companion.py, so the site produces the same
 * one-zip result the command line does. Overhauled Overworld is not in this
 * repository and is not served from the site — it only ever arrives as a file
 * the player picked themselves, and everything here runs in their browser.
 *
 * MineWorldGen writes terrain and nothing else: it never adds a biome, so it
 * never collides with a decoration pack, and Overhauled Overworld never touches
 * terrain shaping. Because the two do not overlap, the whole generated pack is
 * folded into the ported one rather than downloaded as a second zip.
 *
 * On top of the version port it does two things:
 *
 *   * limits the decoration to about half the world, so the other half is the
 *     vanilla biome — Overhauled Overworld adds to vanilla's feature lists
 *     rather than replacing them, so gating its own namespace is exactly a
 *     half-and-half world,
 *   * offers Towering Tepuis' features to every land biome instead of only to
 *     the jungle and stony peaks. They filter themselves by height, so a biome
 *     that never rises high enough simply never grows one.
 *
 * MineWorldGen's own block skins — the plateau strata, the volcanic
 * resurfacing, the karst face — have nowhere to be listed on their own, because
 * 26.2 has no feature-injection registry and a feature can only reach world
 * generation through a biome file. Injecting their ids into the decoration
 * pack's biome files is what makes them appear at all.
 */

import { portPack, type PortResult } from "./port";
import { readZip } from "./zip";

/**
 * Every land biome: tepuis and plateau strata are terrain features that decide
 * for themselves whether the ground is high enough, so the only places worth
 * excluding are the ones where the question cannot arise.
 */
const LAND =
  "^(?!.*(ocean|river|beach|swamp|nether|end_|the_end|void|deep_dark|lush_caves" +
  "|dripstone_caves|basalt_deltas|crimson|warped|soul_sand|small_end|the_void)).*$";

/**
 * The bare-rock biomes a volcano cone or a karst tower turns into: the
 * generator pushes the biome copy of erosion to the eroded end under both, so
 * vanilla picks one of these rather than a meadow.
 */
const ROCK = "(peaks|windswept|stony|badlands|grove|snowy_slopes)";

/**
 * Towering Tepuis' own feature list, with the step each one belongs to, read
 * off that pack's jungle.json rather than guessed.
 */
const TEPUI: Array<[number, string]> = [
  [0, "wythers:terrain/feature/tepui"],
  [0, "wythers:terrain/local/tepui_cap"],
  [1, "wythers:terrain/feature/tepui_filler"],
  [2, "wythers:terrain/feature/tepui_basalt_layer"],
  [2, "wythers:terrain/feature/tepui_tuff_layer"],
  [4, "wythers:terrain/feature/tepui_falls"],
  [4, "wythers:terrain/feature/tepui_terrain"],
  [4, "wythers:terrain/feature/tepui_caverns"],
  [4, "wythers:terrain/feature/tepui_chasms"],
  [5, "wythers:terrain/feature/tepui_lakes"],
  [5, "wythers:terrain/feature/tepui_surface"],
  [5, "wythers:terrain/feature/tepui_cavern_lakes"],
  [5, "wythers:terrain/feature/tepui_cavern_moss"],
  [8, "wythers:terrain/feature/tepui_cavern_dripstone"],
  [9, "wythers:vegetation/extended/patch/tepui_plants"],
];

/**
 * MineWorldGen's own skins, and where each belongs. Which of them exist depends
 * on the config — karst is off by default, and so are volcanoes at frequency 0
 * — so the list is filtered against what the pack actually wrote; injecting an
 * id that nothing defines would leave a dangling reference in every biome.
 */
const MWG: Array<[number, string, string]> = [
  [2, "plateau/cap", LAND],
  [2, "plateau/strata", LAND],
  [2, "volcano/resurface", ROCK],
  [2, "volcano/flows", ROCK],
  [3, "volcano/pools", ROCK],
  [2, "karst/face", ROCK],
];

/**
 * Dripstone caves are as close as the game gets to a limestone cave system, so
 * where there is karst vanilla's own are asked for a second time.
 */
const KARST_CAVES = ["minecraft:dripstone_cluster", "minecraft:large_dripstone"];

export interface CombineOptions {
  /** Let the decoration cover the whole world instead of half of it. */
  noSplit?: boolean;
  /** Leave tepuis in the jungle. */
  noTepui?: boolean;
  description?: string;
}

/** The --inject arguments build_companion.py would pass for this pack. */
export function injectionsFor(
  pack: Map<string, string>,
  options: CombineOptions = {},
): string[] {
  const present = new Set(
    MWG.map(([, name]) => name).filter((name) =>
      pack.has(`data/mwg/worldgen/placed_feature/${name}.json`),
    ),
  );
  const inject: string[] = [];
  if (!options.noTepui) {
    for (const [step, ident] of TEPUI) inject.push(`${step}:${ident}=${LAND}`);
  }
  for (const [step, name, where] of MWG) {
    if (present.has(name)) inject.push(`${step}:mwg:${name}=${where}`);
  }
  if (present.has("karst/face")) {
    for (const ident of KARST_CAVES) inject.push(`8:${ident}=${ROCK}`);
  }
  return inject;
}

/**
 * Port the decoration pack and fold the generated one into it.
 *
 * `decoration` is the zip the player picked, either as bytes or already read —
 * the editor reads it once when the file is chosen, to say what it found, and
 * hands the same entries back here rather than inflating it twice. `pack` is
 * what buildPack() just produced. The result is the single pack to download.
 */
export async function combinePack(
  decoration: Blob | ArrayBuffer | Uint8Array | Map<string, Uint8Array>,
  pack: Map<string, string>,
  options: CombineOptions = {},
): Promise<PortResult> {
  const source = decoration instanceof Map ? decoration : await readZip(decoration);
  if (!source.has("pack.mcmeta")) {
    throw new Error("that zip has no pack.mcmeta, so it is not a data pack");
  }
  // Everything the generated pack wrote under data/, which is all of it apart
  // from its own pack.mcmeta and pack.png - the combined pack keeps the
  // decoration pack's, rewritten to the 26.2 shape by portPack. The two never
  // write to the same path: MineWorldGen shapes terrain and touches nothing
  // under data/minecraft/worldgen/biome, and the decoration pack touches
  // nothing under density_function, noise_settings or dimension_type.
  const merge = new Map<string, string>();
  for (const [path, text] of pack) {
    if (!path.startsWith("data/")) continue;
    if (!path.endsWith(".json") && !path.endsWith(".mcfunction")) continue;
    merge.set(path, text);
  }
  return portPack(source, {
    merge,
    split: options.noSplit ? [] : ["wythers"],
    splitLevel: 0,
    inject: injectionsFor(pack, options),
    description: options.description ?? "ported to 26.2 by MineWorldGen",
  });
}
