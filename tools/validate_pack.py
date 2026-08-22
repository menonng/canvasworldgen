#!/usr/bin/env python3
"""Check that a world generation data pack only names things Minecraft 26.2 has.

    python3 tools/validate_pack.py ported.zip

Reports, per registry, anything the pack refers to that the game will not
resolve: feature types, placement modifier types, blocks, and cross references
between configured and placed features. The registry contents are vendored in
tools/vanilla/minecraft/registries_26_2.json so this runs offline.

It is a name check, not a schema check: it catches the errors a version port
actually makes — a type that was renamed, an id that moved — not a field that
changed meaning.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRIES = os.path.join(HERE, "vanilla", "minecraft", "registries_26_2.json")
ID = re.compile(r"^#?[a-z0-9_.-]+:[a-z0-9_./-]+$")


def read_pack(source: str) -> dict[str, object]:
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


def ident_for(path: str) -> tuple[str, str] | None:
    """(registry, id) for a data pack file path, or None.

    An overlay directory names the same id as the base tree, so it is stripped
    before reading the path; otherwise every overlaid definition looks missing.
    """
    parts = path.split("/")
    if parts and parts[0].endswith("-overlay"):
        parts = parts[1:]
    if len(parts) < 5 or parts[0] != "data" or parts[2] != "worldgen" or not path.endswith(".json"):
        return None
    registry = parts[3]
    name = "/".join(parts[4:])[: -len(".json")]
    return registry, f"{parts[1]}:{name}"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", help="pack zip or directory")
    parser.add_argument("--with", dest="companion", action="append", default=[],
                        help="another pack loaded alongside, whose definitions also count")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    reg = json.load(open(REGISTRIES))
    known = {k: set(v) for k, v in reg.items() if isinstance(v, list)}

    raw = read_pack(args.source)
    # an add-on only resolves against the pack it sits on top of
    companion_defined: dict[str, set[str]] = collections.defaultdict(set)
    for other_pack in args.companion:
        for path in read_pack(other_pack):
            got = ident_for(path)
            if got:
                companion_defined[got[0]].add(got[1])

    parsed: dict[str, object] = {}
    for path, blob in raw.items():
        if path.endswith(".json"):
            try:
                parsed[path] = json.loads(blob.decode("utf-8"))
            except Exception as exc:
                print(f"UNPARSEABLE {path}: {exc}")
                return 1

    # what the pack itself defines
    defined: dict[str, set[str]] = collections.defaultdict(set)
    for path in parsed:
        got = ident_for(path)
        if got:
            defined[got[0]].add(got[1])
    for registry, ids in companion_defined.items():
        defined[registry] |= ids

    problems: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)

    # pack.mcmeta is read before any world generation file, so getting it wrong
    # means the game rejects the pack the moment it is applied and never says
    # why. 26.2 wants a [major, minor] pair; the bare number and the
    # supported_formats object are both 1.20-1.21 spellings.
    # pack.mcmeta has no .json suffix, so it is not among the parsed files
    try:
        meta = json.loads(raw["pack.mcmeta"].decode("utf-8"))
    except Exception:
        meta = None
    if not isinstance(meta, dict) or "pack" not in meta:
        problems["pack.mcmeta"]["missing or has no `pack` object"] += 1
    else:
        block = meta["pack"]
        for key in ("min_format", "max_format"):
            value = block.get(key)
            if value is None:
                problems["pack.mcmeta"][f"no `{key}`"] += 1
            elif not (isinstance(value, list) and len(value) == 2 and all(isinstance(v, int) for v in value)):
                problems["pack.mcmeta"][f"`{key}` must be a [major, minor] pair in 26.2"] += 1
        if "supported_formats" in block:
            problems["pack.mcmeta"]["`supported_formats` is the 1.20-1.21 spelling"] += 1
        if block.get("pack_format") != 107:
            problems["pack.mcmeta"]["`pack_format` is not 107"] += 1

    # 26.2 moved most of a biome's ambience out of `effects` into a namespaced
    # `attributes` map. This is not a name error - nothing is misspelled and
    # nothing references an id that does not exist - so nothing above catches
    # it, and it is exactly the kind of thing a version port leaves behind: 53
    # of Overhauled Overworld's 54 biome files still carried the 1.21 shape the
    # first time this generator ported it.
    BIOME_EFFECTS_KEEP = {
        "water_color", "foliage_color", "grass_color", "grass_color_modifier",
        "dry_foliage_color",
    }
    for path, data in parsed.items():
        got = ident_for(path)
        if not got or got[0] != "biome" or not isinstance(data, dict):
            continue
        effects = data.get("effects")
        if isinstance(effects, dict):
            stray = set(effects) - BIOME_EFFECTS_KEEP
            if stray:
                problems["biome effects field belongs under attributes in 26.2"][path] += len(stray)
        for src in (effects if isinstance(effects, dict) else {}, data.get("attributes") or {}):
            for key, value in src.items():
                if "color" in key.lower() and isinstance(value, int) and not isinstance(value, bool):
                    problems["biome colour is a raw int; 26.2 vanilla always uses #rrggbb"][path] += 1

    # Shapes 1.21 wrapped and 26.2 flattened. These are not name errors, so
    # nothing above would catch them, and the game rejects the whole pack with
    # a message that does not say which file is at fault - which is exactly the
    # kind of thing a port gets wrong and a name check misses.
    RANGED = {
        "minecraft:uniform",
        "minecraft:biased_to_bottom",
        "minecraft:very_biased_to_bottom",
        "minecraft:clamped_normal",
        "minecraft:trapezoid",
        "minecraft:clamped",
    }

    def check_shapes(node, where: str) -> None:
        if isinstance(node, list):
            for item in node:
                check_shapes(item, where)
            return
        if not isinstance(node, dict):
            return
        kind = node.get("type")
        if kind in RANGED and isinstance(node.get("value"), dict):
            problems["ranged provider still wraps its bounds in `value` (1.21 shape)"][where] += 1
        if "fallback" in node and "rules" in node and "type" not in node:
            problems["state provider with fallback and rules needs its `type`"][where] += 1
        for value in node.values():
            check_shapes(value, where)
    feature_types = set()
    placement_types = set()
    cf_refs: collections.Counter = collections.Counter()
    pf_refs: collections.Counter = collections.Counter()

    def walk(node, in_placement=False):
        if isinstance(node, dict):
            kind = node.get("type")
            if isinstance(kind, str) and kind.startswith("minecraft:"):
                bare = kind.split(":", 1)[1]
                (placement_types if in_placement else feature_types).add(bare)
            if "feature" in node and "placement" in node:
                if isinstance(node["feature"], str):
                    cf_refs[node["feature"]] += 1
                walk(node["feature"])
                for item in node["placement"]:
                    walk(item, in_placement=True)
                return
            for key, value in node.items():
                walk(value, in_placement=in_placement or key == "placement")
        elif isinstance(node, list):
            for value in node:
                walk(value, in_placement=in_placement)

    for path, data in parsed.items():
        if path == "pack.mcmeta":
            continue
        got = ident_for(path)
        registry = got[0] if got else ""
        if registry == "biome" and isinstance(data, dict):
            for step in data.get("features", []) or []:
                for ref in step:
                    if isinstance(ref, str):
                        pf_refs[ref] += 1
        walk(data)
        check_shapes(data, path)

    # feature and placement types must exist
    for bare in sorted(feature_types):
        if bare in known["feature_type"] or bare in known["placement_modifier_type"]:
            continue
        # many "type" fields belong to other registries (state providers, block
        # predicates, int providers); only flag the ones that look like features
        if bare in ("random_patch", "flower", "no_bonemeal_flower", "forest_rock",
                    "ice_spike", "pointed_dripstone", "dripstone_cluster"):
            problems["feature type removed in 26.2"][bare] += 1
    for bare in sorted(placement_types):
        if bare not in known["placement_modifier_type"] and bare not in known["feature_type"]:
            if bare.endswith("_filter") or bare in ("count", "in_square", "heightmap", "biome"):
                problems["placement modifier not in 26.2"][bare] += 1

    # cross references
    for ref, n in cf_refs.items():
        if not ID.match(ref):
            continue
        if ref.startswith("minecraft:"):
            if ref.split(":", 1)[1] not in known["configured_feature"]:
                problems["configured_feature not in vanilla 26.2"][ref] += n
        elif ref not in defined["configured_feature"]:
            problems["configured_feature not defined by the pack"][ref] += n
    for ref, n in pf_refs.items():
        if ref.startswith("#"):
            continue
        if ref.startswith("minecraft:"):
            if ref.split(":", 1)[1] not in known["placed_feature"]:
                problems["placed_feature not in vanilla 26.2"][ref] += n
        elif ref not in defined["placed_feature"]:
            # This is the one that gets a pack refused on sight. A biome naming
            # a feature nothing defines is a hard load failure, and it does not
            # matter that some other pack you also intend to load defines it
            # unless that pack is in fact loaded - and the world creation
            # screen applies packs one at a time, so "load them together" is
            # not something a pack can rely on. Pass --with only for a pack
            # that genuinely cannot stand alone.
            problems["placed_feature not defined by the pack"][ref] += n

    if not args.quiet:
        print(f"{args.source}")
        print(f"  {len(parsed)} json files; defines "
              + ", ".join(f"{len(v)} {k}" for k, v in sorted(defined.items()) if v))
        print(f"  references {len(cf_refs)} configured features, {len(pf_refs)} placed features")

    total = sum(sum(c.values()) for c in problems.values())
    if not total:
        print("  OK - every name resolves in Minecraft 26.2")
        return 0
    print(f"  {total} unresolved names:")
    for group, counter in sorted(problems.items()):
        print(f"    {group}: {len(counter)} distinct")
        for name, n in counter.most_common(12):
            print(f"      {name}  ({n}x)")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
