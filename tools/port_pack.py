#!/usr/bin/env python3
"""Port a 1.21.10 world generation data pack to Minecraft 26.2.

    python3 tools/port_pack.py <pack.zip|dir> --out ported.zip

Every rule here was derived by diffing the vanilla data of the two versions
rather than from memory, and the derivation is repeated in the comment above
each one so it can be checked. Run ``--report`` to see what a pack needs
without writing anything.

What changes between 1.21.10 (pack format 88) and 26.2 (format 107), for the
registries a world generation pack uses:

* ``placed_feature``: nothing. All 258 vanilla ids still exist, and the 15
  placement modifier types are identical.
* ``configured_feature``: seven feature types were replaced, and 24 vanilla
  ``patch_*`` ids were renamed as part of the same change.
* ``density_function``: 34 types in both versions; only
  ``weird_scaled_sampler`` (1.21.10) versus ``interval_select`` (26.2) differ,
  and the field names are unchanged.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import shutil
import sys
import tempfile
import zipfile

TARGET_PACK_FORMAT = 107
SOURCE_PACK_FORMAT = 88

# ---------------------------------------------------------------- id renames
# Derived by diffing the vanilla configured_feature listings: 24 ids vanished
# in 26.2 and the same names reappeared without the "patch_" prefix, because
# the scattering that made them "patches" moved out of the feature and into the
# placement list. Verified against minecraft:patch_grass_jungle, whose 26.2
# configured feature is minecraft:grass_jungle.
CONFIGURED_FEATURE_RENAMES = {
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
    # The two biome-specific wildflower features became one, which the
    # placement list now varies instead.
    "minecraft:wildflowers_birch_forest": "minecraft:wildflower",
    "minecraft:wildflowers_meadow": "minecraft:wildflower",
    # Meadow grass folded into the shared grass feature.
    "minecraft:patch_grass_meadow": "minecraft:grass",
}

# References that resolve in neither version: pre-existing dangling ids the pack
# carries from an older Minecraft, which the game logs and skips. Dropping them
# is what the game already does, only without the error.
DROP_REFERENCES = {
    # not a placed feature in 1.21.10 either; every biome listing it also lists
    # minecraft:seagrass_normal on the same step
    "minecraft:seagrass_simple",
}

# Feature types that no longer exist in 26.2.
SCATTER_TYPES = {
    "minecraft:random_patch",
    "minecraft:flower",
    "minecraft:no_bonemeal_flower",
}


def trapezoid(spread: int) -> dict:
    """The 26.2 spelling of what xz_spread/y_spread used to mean.

    From vanilla: 1.21.10 patch_grass_jungle had tries 32, xz_spread 7 and
    y_spread 3; 26.2 places the same feature with count 32 and a random_offset
    whose xz_spread is a trapezoid from -7 to 7 and y_spread -3 to 3.
    """
    value = int(spread)
    return {"type": "minecraft:trapezoid", "max": value, "min": -value, "plateau": 0}


def scatter_modifiers(config: dict) -> list:
    """The placement modifiers that replace a random_patch/flower wrapper."""
    out = [{"type": "minecraft:count", "count": config.get("tries", 128)}]
    xz = config.get("xz_spread", 7)
    y = config.get("y_spread", 3)
    if xz or y:
        out.append(
            {
                "type": "minecraft:random_offset",
                "xz_spread": trapezoid(xz),
                "y_spread": trapezoid(y),
            }
        )
    return out


def is_placed_feature(node) -> bool:
    return isinstance(node, dict) and "feature" in node and "placement" in node


class Porter:
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}
        # configured features that lost their scatter, and the modifiers that
        # every placed feature referencing them has to gain instead
        self.hoisted: dict[str, list] = {}

    def bump(self, key: str, n: int = 1) -> None:
        self.counts[key] = self.counts.get(key, 0) + n

    # ------------------------------------------------------------ feature types
    def port_feature(self, node):
        """Migrate one configured-feature node in place, returning it.

        A scatter type is not returned as a feature at all: the caller has to
        pull the wrapper apart, so this raises for those.
        """
        if not isinstance(node, dict):
            return node
        kind = node.get("type")

        # forest_rock became block_blob and gained an explicit placement
        # predicate; vanilla's own forest_rock names the tag it used to imply.
        if kind == "minecraft:forest_rock":
            self.bump("forest_rock")
            config = dict(node.get("config", {}))
            config["can_place_on"] = {
                "type": "minecraft:matching_block_tag",
                "tag": "minecraft:forest_rock_can_place_on",
            }
            return {"type": "minecraft:block_blob", "config": config}

        # pointed_dripstone became speleothem, which names its blocks instead of
        # taking spread chances. The chance_of_* fields have no equivalent in
        # 26.2 and are dropped; vanilla's 26.2 speleothem is copied field for
        # field.
        if kind == "minecraft:pointed_dripstone":
            self.bump("pointed_dripstone")
            return {
                "type": "minecraft:speleothem",
                "config": {
                    "base_block": {"Name": "minecraft:dripstone_block"},
                    "pointed_block": {
                        "Name": "minecraft:pointed_dripstone",
                        "Properties": {
                            "thickness": "tip",
                            "vertical_direction": "up",
                            "waterlogged": "false",
                        },
                    },
                    "replaceable_blocks": "#minecraft:dripstone_replaceable_blocks",
                },
            }

        # ice_spike became spike; vanilla's 26.2 spike spells out what the old
        # type hard-coded.
        if kind == "minecraft:ice_spike":
            self.bump("ice_spike")
            return {
                "type": "minecraft:spike",
                "config": {
                    "can_place_on": {
                        "type": "minecraft:matching_blocks",
                        "blocks": "minecraft:snow_block",
                    },
                    "can_replace": {
                        "type": "minecraft:matching_block_tag",
                        "tag": "minecraft:ice_spike_replaceable",
                    },
                    "state": {"Name": "minecraft:packed_ice"},
                },
            }

        if kind == "minecraft:dripstone_cluster":
            self.bump("dripstone_cluster")
            config = dict(node.get("config", {}))
            config.pop("dripstone_block_layer_thickness", None)
            if "chance_of_dripstone_column_at_max_distance_from_center" in config:
                config["chance_of_speleothem_at_max_distance_from_center"] = config.pop(
                    "chance_of_dripstone_column_at_max_distance_from_center"
                )
            config["base_block"] = {"Name": "minecraft:dripstone_block"}
            return {"type": "minecraft:speleothem_cluster", "config": config}

        return node

    # --------------------------------------------------------- placed features
    def port_placed(self, node: dict) -> dict:
        """Migrate a placed-feature node: {feature: ..., placement: [...]}."""
        feature = node.get("feature")
        placement = list(node.get("placement", []))

        # a reference to a renamed vanilla configured feature
        if isinstance(feature, str):
            renamed = CONFIGURED_FEATURE_RENAMES.get(feature)
            if renamed:
                self.bump("renamed reference")
                feature = renamed
            elif feature in self.hoisted:
                placement = placement + self.hoisted[feature]
                self.bump("scatter moved into referencing placement")

        # an inline configured feature that is a scatter wrapper: unwrap it and
        # move the scatter into this placement list, which is exactly what
        # vanilla did to its own patch features
        while isinstance(feature, dict) and feature.get("type") in SCATTER_TYPES:
            self.bump(feature["type"].split(":")[-1])
            config = feature.get("config", {})
            inner = config.get("feature")
            modifiers = scatter_modifiers(config)
            if is_placed_feature(inner):
                placement = placement + modifiers + list(inner.get("placement", []))
                feature = inner.get("feature")
            else:
                placement = placement + modifiers
                feature = inner

        if isinstance(feature, dict):
            feature = self.port_feature(self.walk(feature))
        node = dict(node)
        node["feature"] = feature
        node["placement"] = [self.walk(p) for p in placement]
        return node

    # ------------------------------------------------------------------ walker
    #: Providers whose bounds 1.21 wrapped in a "value" object and 26.2 spells
    #: out directly. The wrapper is not a name the registry check can catch, so
    #: a pack that keeps it is rejected wholesale by the game with no clue as
    #: to which file is at fault.
    RANGED_PROVIDERS = {
        "minecraft:uniform",
        "minecraft:biased_to_bottom",
        "minecraft:very_biased_to_bottom",
        "minecraft:clamped_normal",
        "minecraft:trapezoid",
        "minecraft:clamped",
    }

    def port_shape(self, node: dict) -> dict:
        """Fix the two shapes that changed without any name changing.

        A rule-based state provider used to be an untyped ``{fallback, rules}``
        pair, because it was not a provider in its own right; in 26.2 it is one
        and has to say so. And every ranged provider used to hold its bounds
        under ``value``.
        """
        kind = node.get("type")
        if kind in self.RANGED_PROVIDERS and isinstance(node.get("value"), dict):
            inner = node.pop("value")
            node.update(inner)
            self.bump("ranged provider bounds unwrapped")
        if "fallback" in node and "rules" in node and "type" not in node:
            node["type"] = "minecraft:rule_based_state_provider"
            self.bump("rule-based state provider given its type")
        return node

    def walk(self, node):
        if is_placed_feature(node):
            return self.port_placed(node)
        if isinstance(node, dict):
            ported = self.port_feature(node)
            if ported is not node:
                node = ported
            node = self.port_shape(dict(node))
            return {k: self.walk(v) for k, v in node.items()}
        if isinstance(node, list):
            return [self.walk(v) for v in node]
        return node

    # -------------------------------------------------- top-level pack passes
    def hoist_scatter_files(self, files: dict[str, dict]) -> None:
        """First pass: unwrap scatter wrappers that are whole files.

        A configured feature that *is* a random_patch has nowhere to put its
        scatter, so the wrapper is stripped here and the modifiers are recorded
        against the file's id for the placed features that reference it.
        """
        for path, data in list(files.items()):
            parts = path.split("/")
            if len(parts) < 5 or parts[0] != "data" or parts[2] != "worldgen":
                continue
            if parts[3] != "configured_feature":
                continue
            if not isinstance(data, dict) or data.get("type") not in SCATTER_TYPES:
                continue
            ident = f"{parts[1]}:{'/'.join(parts[4:])[:-len('.json')]}"
            config = data.get("config", {})
            inner = config.get("feature")
            modifiers = scatter_modifiers(config)
            if is_placed_feature(inner):
                modifiers = modifiers + list(inner.get("placement", []))
                inner = inner.get("feature")
            if isinstance(inner, str):
                # the wrapper only pointed at another configured feature; the
                # file cannot become a plain reference, so leave a sequence of
                # one, which 26.2 does have
                files[path] = {"type": "minecraft:sequence", "config": {"features": [inner]}}
            else:
                files[path] = inner if isinstance(inner, dict) else {}
            self.hoisted[ident] = modifiers
            self.bump("scatter hoisted out of its own file")


# --------------------------------------------------------------------- pack IO
def read_pack(source: str) -> dict[str, object]:
    """Every file in the pack, keyed by its path, JSON parsed where it parses."""
    files: dict[str, object] = {}
    if os.path.isdir(source):
        for root, _, names in os.walk(source):
            for name in names:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, source).replace(os.sep, "/")
                files[rel] = open(full, "rb").read()
    else:
        with zipfile.ZipFile(source) as zf:
            for info in zf.infolist():
                if not info.is_dir():
                    files[info.filename] = zf.read(info)
    return files


def flatten_overlays(raw: dict[str, object], meta: dict) -> dict[str, object]:
    """Collapse the pack's overlays into one data/ tree.

    A pack aimed at a single version has no use for overlays, and leaving them
    in would mean porting each copy. Overlays are applied in the order the
    mcmeta lists them, later ones winning, which is what the game does.
    """
    applicable = []
    for entry in meta.get("overlays", {}).get("entries", []):
        low = entry.get("min_format", entry.get("formats"))
        high = entry.get("max_format", entry.get("formats"))
        if isinstance(low, list):
            low, high = low[0], low[-1]
        if isinstance(low, int) and isinstance(high, int) and low <= SOURCE_PACK_FORMAT <= high:
            applicable.append(entry["directory"])

    out = {k: v for k, v in raw.items() if not any(k.startswith(d + "/") for d in
                                                   [e["directory"] for e in meta.get("overlays", {}).get("entries", [])])}
    for directory in applicable:
        prefix = directory + "/"
        for path, blob in raw.items():
            if path.startswith(prefix):
                out[path[len(prefix):]] = blob
    return out, applicable


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", help="pack zip or directory")
    parser.add_argument("--out", help="output zip")
    parser.add_argument("--report", action="store_true", help="say what would change, write nothing")
    parser.add_argument("--description", default=None, help="pack.mcmeta description suffix")
    parser.add_argument(
        "--split",
        metavar="NAMESPACE",
        action="append",
        default=[],
        help="place this namespace's features on only half the world, so the "
        "other half keeps vanilla's own decoration. Repeatable.",
    )
    parser.add_argument(
        "--split-level",
        type=float,
        default=0.0,
        help="noise level the split is taken at (default 0.0, the median of a "
        "zero-mean noise, so about half the world either way)",
    )
    parser.add_argument(
        "--inject",
        action="append",
        default=[],
        help="placed feature id to add to overworld biomes, as step:id "
        "(step 0-10, default 2 = LOCAL_MODIFICATIONS), optionally followed by "
        "=REGEX to restrict it to biomes whose name matches. 26.2 has no "
        "feature injection registry, so a feature can only reach world "
        "generation through a biome file; this edits the biomes this pack "
        "already ships rather than adding new ones, so nothing new collides.",
    )
    args = parser.parse_args(argv)

    raw = read_pack(args.source)
    if "pack.mcmeta" not in raw:
        print("no pack.mcmeta: this is not a data pack", file=sys.stderr)
        return 1
    meta = json.loads(raw["pack.mcmeta"].decode("utf-8"))
    flat, overlays = flatten_overlays(raw, meta)
    print(f"read {len(raw)} files; {len(flat)} after flattening {len(overlays)} overlays {overlays}")

    parsed: dict[str, dict] = {}
    other: dict[str, bytes] = {}
    for path, blob in flat.items():
        if path.endswith(".json"):
            try:
                parsed[path] = json.loads(blob.decode("utf-8"))
                continue
            except Exception:
                pass
        other[path] = blob

    porter = Porter()
    # biome feature lists name placed features; drop the ones that resolve
    # nowhere before anything else looks at them
    for path, data in parsed.items():
        if "/worldgen/biome/" not in path or not isinstance(data, dict):
            continue
        steps = data.get("features")
        if not isinstance(steps, list):
            continue
        for step in steps:
            if not isinstance(step, list):
                continue
            for ref in [r for r in step if r in DROP_REFERENCES]:
                step.remove(ref)
                porter.bump("dangling reference dropped")

    porter.hoist_scatter_files(parsed)
    for path in list(parsed):
        if path != "pack.mcmeta":
            parsed[path] = porter.walk(parsed[path])

    # second pass: placed features referencing a file whose scatter was hoisted
    # are only reachable now that self.hoisted is populated
    for path in list(parsed):
        if path != "pack.mcmeta":
            parsed[path] = porter.walk(parsed[path])

    # pack.mcmeta has no .json suffix, so it landed in `other`; it is rewritten
    # below and must not also be copied through verbatim
    other.pop("pack.mcmeta", None)

    if args.split:
        # A pack like Overhauled Overworld does not replace vanilla's biome
        # decoration, it adds to it: its plains.json carries 41 vanilla feature
        # ids alongside 15 of its own. So gating only its own namespace is
        # exactly a half-and-half world - where the gate is closed you get
        # vanilla's biome, where it is open you get the pack's version of it.
        #
        # noise_threshold_count is the only placement modifier in 26.2 that
        # asks a question about the region rather than the block, and its count
        # multiplies whatever follows it, so 1 above and 0 below leaves the
        # original placement untouched on one side and removes it on the other.
        gate = {
            "type": "minecraft:noise_threshold_count",
            "noise_level": args.split_level,
            "above_noise": 1,
            "below_noise": 0,
        }
        split = 0
        for path, data in parsed.items():
            if "/worldgen/placed_feature/" not in path or not isinstance(data, dict):
                continue
            namespace = path.split("/")[1]
            if namespace not in args.split:
                continue
            placement = data.get("placement")
            if not isinstance(placement, list) or (placement and placement[0] == gate):
                continue
            data["placement"] = [gate, *placement]
            split += 1
        porter.bump(f"feature limited to half the world ({', '.join(args.split)})", split)

    if args.inject:
        wanted = []
        for spec in args.inject:
            spec, _, pattern = spec.partition("=")
            # "2:mwg:plateau/cap" splits to step 2; a bare id defaults to step 2
            if spec.count(":") > 1 and spec.split(":", 1)[0].isdigit():
                step = int(spec.split(":", 1)[0])
                ident = spec.split(":", 1)[1]
            else:
                step, ident = 2, spec
            wanted.append((step, ident, re.compile(pattern) if pattern else None))
        added = 0
        for path, data in parsed.items():
            # tags live at data/<ns>/tags/worldgen/biome/, hold `values`, and
            # would silently gain a bogus `features` key
            if "/tags/" in path or "/worldgen/biome/" not in path:
                continue
            if not isinstance(data, dict) or "features" not in data:
                continue
            biome = path.rsplit("/worldgen/biome/", 1)[1][: -len(".json")]
            steps = data["features"]
            while len(steps) < 11:
                steps.append([])
            for step, ident, pattern in wanted:
                if pattern is not None and not pattern.search(biome):
                    continue
                if ident not in steps[step]:
                    steps[step].append(ident)
                    added += 1
        porter.bump("feature injected into a biome", added)

    meta.pop("overlays", None)
    pack = meta.setdefault("pack", {})
    pack["pack_format"] = TARGET_PACK_FORMAT
    pack["min_format"] = TARGET_PACK_FORMAT
    pack["max_format"] = TARGET_PACK_FORMAT
    pack["supported_formats"] = {
        "min_inclusive": TARGET_PACK_FORMAT,
        "max_inclusive": TARGET_PACK_FORMAT,
    }
    if args.description:
        desc = pack.get("description")
        pack["description"] = (desc if isinstance(desc, list) else [{"text": str(desc)}]) + [
            {"text": f"\n{args.description}", "color": "gray"}
        ]
    parsed["pack.mcmeta"] = meta

    print("\nchanges:")
    for key, count in sorted(porter.counts.items(), key=lambda kv: -kv[1]):
        print(f"  {count:5d}  {key}")
    if not porter.counts:
        print("  (nothing to do)")

    if args.report or not args.out:
        return 0

    with zipfile.ZipFile(args.out, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, data in sorted(parsed.items()):
            zf.writestr(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        for path, blob in sorted(other.items()):
            zf.writestr(path, blob)
    print(f"\nwrote {args.out} ({len(parsed) + len(other)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
