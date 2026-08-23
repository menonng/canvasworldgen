/**
 * Port a 1.21.10 world generation data pack to Minecraft 26.2, in the browser.
 *
 * A faithful port of tools/port_pack.py. The site cannot ship Overhauled
 * Overworld itself — that would be redistributing someone else's pack — so the
 * player points at their own copy and this does the conversion locally,
 * producing one pack that carries both the generated terrain and the ported
 * decoration. companion.ts holds the policy half, from
 * tools/build_companion.py.
 *
 * web/test/port-parity.mjs runs this and the Python tool over the same zip and
 * requires every file to match, so neither can drift from the other. The
 * comparison is on parsed values rather than bytes for the JSON files, because
 * Python writes a whole float as `1.0` where JSON.stringify writes `1` — the
 * same number to any reader, and the only difference the two produce.
 */

const TARGET_PACK_FORMAT = 107;
const TARGET_PACK_FORMAT_MINOR = 1;
const SOURCE_PACK_FORMAT = 88;

type Json = unknown;
type Obj = Record<string, Json>;

const isObj = (v: Json): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Derived by diffing the vanilla configured_feature listings: 24 ids vanished
 * in 26.2 and the same names reappeared without the "patch_" prefix, because
 * the scattering that made them "patches" moved out of the feature and into
 * the placement list.
 */
const CONFIGURED_FEATURE_RENAMES: Record<string, string> = {
  "minecraft:pale_forest_flowers": "minecraft:pale_forest_flower",
  "minecraft:patch_berry_bush": "minecraft:berry_bush",
  "minecraft:patch_brown_mushroom": "minecraft:brown_mushroom",
  "minecraft:patch_bush": "minecraft:bush",
  "minecraft:patch_cactus": "minecraft:cactus",
  "minecraft:patch_crimson_roots": "minecraft:crimson_roots",
  "minecraft:patch_dead_bush": "minecraft:dead_bush",
  "minecraft:patch_dry_grass": "minecraft:dry_grass",
  "minecraft:patch_firefly_bush": "minecraft:firefly_bush",
  "minecraft:patch_grass": "minecraft:grass",
  "minecraft:patch_grass_jungle": "minecraft:grass_jungle",
  "minecraft:patch_large_fern": "minecraft:large_fern",
  "minecraft:patch_leaf_litter": "minecraft:leaf_litter",
  "minecraft:patch_melon": "minecraft:melon",
  "minecraft:patch_pumpkin": "minecraft:pumpkin",
  "minecraft:patch_red_mushroom": "minecraft:red_mushroom",
  "minecraft:patch_sugar_cane": "minecraft:sugar_cane",
  "minecraft:patch_sunflower": "minecraft:sunflower",
  "minecraft:patch_taiga_grass": "minecraft:taiga_grass",
  "minecraft:patch_tall_grass": "minecraft:tall_grass",
  "minecraft:patch_waterlily": "minecraft:waterlily",
  "minecraft:single_piece_of_grass": "minecraft:grass",
  "minecraft:wildflowers_birch_forest": "minecraft:wildflower",
  "minecraft:wildflowers_meadow": "minecraft:wildflower",
  "minecraft:patch_grass_meadow": "minecraft:grass",
};

/**
 * Block tags 26.2 renamed, plus one Overhauled Overworld gets wrong in its own
 * files: minecraft:stone is a block, not a tag, so a tag_match against it can
 * never match anything. base_stone_overworld is what "stone" means here.
 */
const BLOCK_TAG_RENAMES: Record<string, string> = {
  "minecraft:dry_vegetation_may_place_on": "minecraft:supports_dry_vegetation",
  "minecraft:vegetation_may_place_on": "minecraft:supports_vegetation",
  "minecraft:stone": "minecraft:base_stone_overworld",
};

/** Not a placed feature in 1.21.10 either; the game already logs and skips it. */
const DROP_REFERENCES = new Set(["minecraft:seagrass_simple"]);

/** Feature types that no longer exist in 26.2. */
const SCATTER_TYPES = new Set([
  "minecraft:random_patch",
  "minecraft:flower",
  "minecraft:no_bonemeal_flower",
]);

/** Providers whose bounds 1.21 wrapped in a "value" object and 26.2 spells out. */
const RANGED_PROVIDERS = new Set([
  "minecraft:uniform",
  "minecraft:biased_to_bottom",
  "minecraft:very_biased_to_bottom",
  "minecraft:clamped_normal",
  "minecraft:trapezoid",
  "minecraft:clamped",
]);

/** Effect keys that stayed inside 26.2's `effects`, from all 66 vanilla files. */
const BIOME_EFFECTS_KEEP = new Set([
  "water_color",
  "foliage_color",
  "grass_color",
  "grass_color_modifier",
  "dry_foliage_color",
]);

/** Fields holding a packed RGB colour, wherever they end up living. */
const COLOR_FIELDS = new Set([
  "water_color",
  "foliage_color",
  "grass_color",
  "dry_foliage_color",
  "sky_color",
  "fog_color",
  "water_fog_color",
]);

const asHexColor = (value: Json): Json =>
  typeof value === "number" && Number.isInteger(value)
    ? `#${(value & 0xffffff).toString(16).padStart(6, "0")}`
    : value;

/**
 * The 26.2 spelling of what xz_spread/y_spread used to mean. From vanilla:
 * 1.21.10 patch_grass_jungle had tries 32, xz_spread 7 and y_spread 3; 26.2
 * places the same feature with count 32 and a random_offset whose xz_spread is
 * a trapezoid from -7 to 7.
 */
const trapezoid = (spread: number): Obj => ({
  type: "minecraft:trapezoid",
  max: Math.trunc(spread),
  min: -Math.trunc(spread),
  plateau: 0,
});

function scatterModifiers(config: Obj): Obj[] {
  const out: Obj[] = [{ type: "minecraft:count", count: config.tries ?? 128 }];
  const xz = (config.xz_spread ?? 7) as number;
  const y = (config.y_spread ?? 3) as number;
  if (xz || y) {
    out.push({ type: "minecraft:random_offset", xz_spread: trapezoid(xz), y_spread: trapezoid(y) });
  }
  return out;
}

const isPlacedFeature = (node: Json): node is Obj =>
  isObj(node) && "feature" in node && "placement" in node;

/**
 * Split a 1.21-style flat `effects` object into 26.2's `effects` + `attributes`.
 *
 * 26.2 moved everything about ambience that is not a direct block or water
 * tint out of `effects` into a namespaced `attributes` map. A pack still
 * carrying the old flat shape is caught by no name or type check: nothing is
 * misspelled and nothing references a missing id, the fields are simply in the
 * wrong place.
 */
function portBiomeEffects(effects: Obj): { kept: Obj; attributes: Obj } {
  const kept: Obj = {};
  for (const [key, value] of Object.entries(effects)) {
    if (BIOME_EFFECTS_KEEP.has(key)) kept[key] = COLOR_FIELDS.has(key) ? asHexColor(value) : value;
  }
  const attributes: Obj = {};
  if ("sky_color" in effects) attributes["minecraft:visual/sky_color"] = asHexColor(effects.sky_color);
  if ("fog_color" in effects) attributes["minecraft:visual/fog_color"] = asHexColor(effects.fog_color);
  if ("water_fog_color" in effects) {
    attributes["minecraft:visual/water_fog_color"] = asHexColor(effects.water_fog_color);
  }
  if ("music_volume" in effects) attributes["minecraft:audio/music_volume"] = effects.music_volume;

  const music = effects.music;
  if (isObj(music)) {
    const rest: Obj = {};
    for (const [k, v] of Object.entries(music)) if (k !== "replace_current_music") rest[k] = v;
    attributes["minecraft:audio/background_music"] = { default: rest };
  }

  const particle = effects.particle;
  if (isObj(particle)) {
    const entry: Obj = { ...particle };
    if ("options" in entry) {
      entry.particle = entry.options;
      delete entry.options;
    }
    attributes["minecraft:visual/ambient_particles"] = [entry];
  }

  const ambient: Obj = {};
  if (isObj(effects.mood_sound)) ambient.mood = effects.mood_sound;
  if (isObj(effects.additions_sound)) ambient.additions = effects.additions_sound;
  if ("ambient_sound" in effects) ambient.loop = effects.ambient_sound;
  if (Object.keys(ambient).length) attributes["minecraft:audio/ambient_sounds"] = ambient;

  return { kept, attributes };
}

class Porter {
  readonly counts = new Map<string, number>();
  /** Configured features that lost their scatter, and the modifiers to move. */
  private readonly hoisted = new Map<string, Obj[]>();

  bump(key: string, n = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
  }

  /** Migrate one configured-feature node, returning it. */
  portFeature(node: Json): Json {
    if (!isObj(node)) return node;
    const kind = node.type;

    // forest_rock became block_blob and gained an explicit placement predicate
    if (kind === "minecraft:forest_rock") {
      this.bump("forest_rock");
      const config: Obj = { ...((node.config ?? {}) as Obj) };
      config.can_place_on = {
        type: "minecraft:matching_block_tag",
        tag: "minecraft:forest_rock_can_place_on",
      };
      return { type: "minecraft:block_blob", config };
    }

    // pointed_dripstone became speleothem, which names its blocks instead of
    // taking spread chances
    if (kind === "minecraft:pointed_dripstone") {
      this.bump("pointed_dripstone");
      return {
        type: "minecraft:speleothem",
        config: {
          base_block: { Name: "minecraft:dripstone_block" },
          pointed_block: {
            Name: "minecraft:pointed_dripstone",
            Properties: { thickness: "tip", vertical_direction: "up", waterlogged: "false" },
          },
          replaceable_blocks: "#minecraft:dripstone_replaceable_blocks",
        },
      };
    }

    // ice_spike became spike, which spells out what the old type hard-coded
    if (kind === "minecraft:ice_spike") {
      this.bump("ice_spike");
      return {
        type: "minecraft:spike",
        config: {
          can_place_on: { type: "minecraft:matching_blocks", blocks: "minecraft:snow_block" },
          can_replace: {
            type: "minecraft:matching_block_tag",
            tag: "minecraft:ice_spike_replaceable",
          },
          state: { Name: "minecraft:packed_ice" },
        },
      };
    }

    if (kind === "minecraft:dripstone_cluster") {
      this.bump("dripstone_cluster");
      const config: Obj = { ...((node.config ?? {}) as Obj) };
      delete config.dripstone_block_layer_thickness;
      if ("chance_of_dripstone_column_at_max_distance_from_center" in config) {
        config.chance_of_speleothem_at_max_distance_from_center =
          config.chance_of_dripstone_column_at_max_distance_from_center;
        delete config.chance_of_dripstone_column_at_max_distance_from_center;
      }
      config.base_block = { Name: "minecraft:dripstone_block" };
      return { type: "minecraft:speleothem_cluster", config };
    }

    return node;
  }

  /** Migrate a placed-feature node: {feature, placement}. */
  portPlaced(node: Obj): Obj {
    let feature = node.feature as Json;
    let placement = [...((node.placement ?? []) as Json[])];

    if (typeof feature === "string") {
      const renamed = CONFIGURED_FEATURE_RENAMES[feature];
      if (renamed) {
        this.bump("renamed reference");
        feature = renamed;
      } else if (this.hoisted.has(feature)) {
        placement = [...placement, ...this.hoisted.get(feature)!];
        this.bump("scatter moved into referencing placement");
      }
    }

    // an inline configured feature that is a scatter wrapper: unwrap it and
    // move the scatter into this placement list, which is what vanilla did to
    // its own patch features
    while (isObj(feature) && SCATTER_TYPES.has(feature.type as string)) {
      this.bump((feature.type as string).split(":").pop()!);
      const config = (feature.config ?? {}) as Obj;
      const inner = config.feature as Json;
      const modifiers = scatterModifiers(config);
      if (isPlacedFeature(inner)) {
        placement = [...placement, ...modifiers, ...((inner.placement ?? []) as Json[])];
        feature = inner.feature as Json;
      } else {
        placement = [...placement, ...modifiers];
        feature = inner;
      }
    }

    if (isObj(feature)) feature = this.portFeature(this.walk(feature));
    return { ...node, feature, placement: placement.map((p) => this.walk(p)) };
  }

  /** Fix the shapes that changed without any name changing. */
  portShape(node: Obj): Obj {
    const kind = node.type;
    if (typeof kind === "string" && RANGED_PROVIDERS.has(kind) && isObj(node.value)) {
      const inner = node.value;
      delete node.value;
      Object.assign(node, inner);
      this.bump("ranged provider bounds unwrapped");
    }
    if ("fallback" in node && "rules" in node && !("type" in node)) {
      node.type = "minecraft:rule_based_state_provider";
      this.bump("rule-based state provider given its type");
    }
    const tag = node.tag;
    if (typeof tag === "string") {
      const renamed = BLOCK_TAG_RENAMES[tag.replace(/^#/, "")];
      if (renamed) {
        node.tag = (tag.startsWith("#") ? "#" : "") + renamed;
        this.bump("block tag renamed");
      }
    }
    return node;
  }

  walk(node: Json): Json {
    if (isPlacedFeature(node)) return this.portPlaced(node);
    if (isObj(node)) {
      const ported = this.portFeature(node);
      const shaped = this.portShape(isObj(ported) ? { ...ported } : ({ ...node } as Obj));
      const out: Obj = {};
      for (const [k, v] of Object.entries(shaped)) out[k] = this.walk(v);
      return out;
    }
    if (Array.isArray(node)) return node.map((v) => this.walk(v));
    return node;
  }

  /**
   * First pass: unwrap scatter wrappers that are whole files. A configured
   * feature that *is* a random_patch has nowhere to put its scatter, so the
   * wrapper is stripped and the modifiers recorded against the file's id.
   */
  hoistScatterFiles(files: Map<string, Json>): void {
    for (const [path, data] of [...files]) {
      const parts = path.split("/");
      if (parts.length < 5 || parts[0] !== "data" || parts[2] !== "worldgen") continue;
      if (parts[3] !== "configured_feature") continue;
      if (!isObj(data) || !SCATTER_TYPES.has(data.type as string)) continue;

      const ident = `${parts[1]}:${parts.slice(4).join("/").slice(0, -".json".length)}`;
      const config = (data.config ?? {}) as Obj;
      let inner = config.feature as Json;
      let modifiers = scatterModifiers(config);
      if (isPlacedFeature(inner)) {
        modifiers = [...modifiers, ...((inner.placement ?? []) as Obj[])];
        inner = inner.feature as Json;
      }
      if (typeof inner === "string") {
        // the wrapper only pointed at another configured feature; a file cannot
        // become a plain reference, so leave a sequence of one
        files.set(path, { type: "minecraft:sequence", config: { features: [inner] } });
      } else {
        files.set(path, isObj(inner) ? inner : {});
      }
      this.hoisted.set(ident, modifiers);
      this.bump("scatter hoisted out of its own file");
    }
  }
}

/**
 * Collapse the pack's overlays into one data/ tree, in the order the mcmeta
 * lists them with later ones winning, which is what the game does.
 */
function flattenOverlays(
  raw: Map<string, Uint8Array>,
  meta: Obj,
): { flat: Map<string, Uint8Array>; applied: string[] } {
  const listed = (meta.overlays as Obj | undefined)?.entries;
  const entries: Obj[] = Array.isArray(listed) ? (listed as Obj[]) : [];
  const applicable: string[] = [];
  for (const entry of entries) {
    let low = entry.min_format ?? entry.formats;
    let high = entry.max_format ?? entry.formats;
    if (Array.isArray(low)) {
      high = low[low.length - 1];
      low = low[0];
    }
    if (typeof low === "number" && typeof high === "number" && low <= SOURCE_PACK_FORMAT && SOURCE_PACK_FORMAT <= high) {
      applicable.push(entry.directory as string);
    }
  }
  const directories = entries.map((e) => e.directory as string);
  const flat = new Map<string, Uint8Array>();
  for (const [path, blob] of raw) {
    if (!directories.some((d) => path.startsWith(d + "/"))) flat.set(path, blob);
  }
  for (const directory of applicable) {
    const prefix = directory + "/";
    for (const [path, blob] of raw) {
      if (path.startsWith(prefix)) flat.set(path.slice(prefix.length), blob);
    }
  }
  return { flat, applied: applicable };
}

export interface PortOptions {
  /** Files of the generated MineWorldGen pack, folded in so one zip suffices. */
  merge?: Map<string, string>;
  /** Namespaces whose features are limited to about half the world. */
  split?: string[];
  splitLevel?: number;
  /** `step:id=regex` entries, matching tools/port_pack.py's --inject. */
  inject?: string[];
  description?: string;
}

export interface PortResult {
  files: Map<string, string | Uint8Array>;
  changes: Array<[string, number]>;
  overlays: string[];
}

export async function portPack(
  source: Map<string, Uint8Array>,
  options: PortOptions = {},
): Promise<PortResult> {
  const decoder = new TextDecoder();
  const rawMeta = source.get("pack.mcmeta");
  if (!rawMeta) throw new Error("no pack.mcmeta: this is not a data pack");
  const meta = JSON.parse(decoder.decode(rawMeta)) as Obj;
  const { flat, applied } = flattenOverlays(source, meta);

  const parsed = new Map<string, Json>();
  const other = new Map<string, Uint8Array>();
  for (const [path, blob] of flat) {
    if (path.endsWith(".json")) {
      try {
        parsed.set(path, JSON.parse(decoder.decode(blob)));
        continue;
      } catch {
        /* not JSON after all */
      }
    }
    other.set(path, blob);
  }

  const porter = new Porter();

  // biome feature lists name placed features; drop the ones that resolve
  // nowhere before anything else looks at them, and migrate the ambience
  for (const [path, data] of parsed) {
    if (!path.includes("/worldgen/biome/") || !isObj(data)) continue;
    const steps = data.features;
    if (Array.isArray(steps)) {
      for (const step of steps) {
        if (!Array.isArray(step)) continue;
        for (const ref of [...step]) {
          if (DROP_REFERENCES.has(ref as string)) {
            step.splice(step.indexOf(ref), 1);
            porter.bump("dangling reference dropped");
          }
        }
      }
    }
    const effects = data.effects;
    if (isObj(effects) && Object.keys(effects).some((k) => !BIOME_EFFECTS_KEEP.has(k))) {
      const { kept, attributes } = portBiomeEffects(effects);
      data.effects = kept;
      if (Object.keys(attributes).length) {
        const existing = data.attributes;
        data.attributes = isObj(existing) ? { ...attributes, ...existing } : attributes;
      }
      porter.bump("biome effects migrated to the 26.2 attributes shape");
    }
  }

  porter.hoistScatterFiles(parsed);
  for (const path of [...parsed.keys()]) {
    if (path !== "pack.mcmeta") parsed.set(path, porter.walk(parsed.get(path)));
  }
  // second pass: placed features referencing a file whose scatter was hoisted
  // are only reachable now that the hoisted map is populated
  for (const path of [...parsed.keys()]) {
    if (path !== "pack.mcmeta") parsed.set(path, porter.walk(parsed.get(path)));
  }

  // pack.mcmeta has no .json suffix, so it landed in `other`; it is rewritten
  // below and must not also be copied through verbatim
  other.delete("pack.mcmeta");

  if (options.merge?.size) {
    let added = 0;
    for (const [path, text] of options.merge) {
      if (path === "pack.mcmeta" || path === "pack.png") continue;
      if (path.endsWith(".json")) parsed.set(path, JSON.parse(text));
      else other.set(path, new TextEncoder().encode(text));
      added++;
    }
    porter.bump("file brought in so the pack defines what it references", added);
  }

  if (options.split?.length) {
    // Overhauled Overworld adds to vanilla's feature lists rather than
    // replacing them, so gating only its own namespace is exactly a
    // half-and-half world. noise_threshold_count is the one placement modifier
    // in 26.2 that asks about the region rather than the block, and its count
    // multiplies whatever follows, so 1 above and 0 below leaves the original
    // placement untouched on one side and removes it on the other.
    const gate: Obj = {
      type: "minecraft:noise_threshold_count",
      noise_level: options.splitLevel ?? 0,
      above_noise: 1,
      below_noise: 0,
    };
    const gateJson = JSON.stringify(gate);
    let split = 0;
    for (const [path, data] of parsed) {
      if (!path.includes("/worldgen/placed_feature/") || !isObj(data)) continue;
      if (!options.split.includes(path.split("/")[1])) continue;
      const placement = data.placement;
      if (!Array.isArray(placement)) continue;
      if (placement.length && JSON.stringify(placement[0]) === gateJson) continue;
      data.placement = [gate, ...placement];
      split++;
    }
    porter.bump(`feature limited to half the world (${options.split.join(", ")})`, split);
  }

  if (options.inject?.length) {
    const wanted: Array<[number, string, RegExp | null]> = [];
    for (const raw of options.inject) {
      const eq = raw.indexOf("=");
      const spec = eq < 0 ? raw : raw.slice(0, eq);
      const pattern = eq < 0 ? "" : raw.slice(eq + 1);
      let step = 2;
      let ident = spec;
      const head = spec.split(":", 1)[0];
      if ((spec.match(/:/g)?.length ?? 0) > 1 && /^\d+$/.test(head)) {
        step = Number(head);
        ident = spec.slice(head.length + 1);
      }
      wanted.push([step, ident, pattern ? new RegExp(pattern) : null]);
    }
    let added = 0;
    for (const [path, data] of parsed) {
      // tags live at data/<ns>/tags/worldgen/biome/, hold `values`, and would
      // silently gain a bogus `features` key
      if (path.includes("/tags/") || !path.includes("/worldgen/biome/")) continue;
      if (!isObj(data) || !("features" in data)) continue;
      const biome = path.split("/worldgen/biome/")[1].slice(0, -".json".length);
      const steps = data.features as Json[][];
      while (steps.length < 11) steps.push([]);
      for (const [step, ident, pattern] of wanted) {
        if (pattern && !pattern.test(biome)) continue;
        if (!steps[step].includes(ident)) {
          steps[step].push(ident);
          added++;
        }
      }
    }
    porter.bump("feature injected into a biome", added);
  }

  delete meta.overlays;
  const pack = (meta.pack ?? (meta.pack = {})) as Obj;
  // exactly what 26.2's own pack.mcmeta carries: a [major, minor] pair, and no
  // supported_formats, which is the 1.20-1.21 spelling
  pack.pack_format = TARGET_PACK_FORMAT;
  pack.min_format = [TARGET_PACK_FORMAT, TARGET_PACK_FORMAT_MINOR];
  pack.max_format = [TARGET_PACK_FORMAT, TARGET_PACK_FORMAT_MINOR];
  delete pack.supported_formats;
  if (options.description) {
    const desc = pack.description;
    pack.description = [
      ...(Array.isArray(desc) ? desc : [{ text: String(desc) }]),
      { text: `\n${options.description}`, color: "gray" },
    ];
  }
  parsed.set("pack.mcmeta", meta);

  const files = new Map<string, string | Uint8Array>();
  for (const path of [...parsed.keys()].sort()) {
    files.set(path, JSON.stringify(parsed.get(path), null, 2) + "\n");
  }
  for (const path of [...other.keys()].sort()) files.set(path, other.get(path)!);

  return {
    files,
    changes: [...porter.counts].sort((a, b) => b[1] - a[1]),
    overlays: applied,
  };
}
