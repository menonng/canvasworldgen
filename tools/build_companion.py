#!/usr/bin/env python3
"""Build the decoration pack that sits on top of a MineWorldGen pack.

    python3 tools/build_companion.py \
        --woo William_Wythers_Overhauled_Overworld_v2.6.0.zip \
        --pack out/ --out WOO_26.2.zip

MineWorldGen writes terrain and nothing else: it never adds a biome, so it can
never collide with a decoration pack. The cost of that is that its own block
skins - the plateau strata, the volcanic resurfacing, the karst face - have
nowhere to be listed, because Minecraft 26.2 has no feature-injection registry
and a feature can only reach world generation through a biome file.

This resolves that by editing the biome files the decoration pack already
ships, so nothing new is introduced, and does three other things while it is
there:

  * ports Overhauled Overworld from 1.21.10 (pack format 88) to 26.2 (107),
  * limits its decoration to about half the world, so the other half is the
    vanilla biome - WOO adds to vanilla's feature lists rather than replacing
    them, so gating its own namespace is exactly a half-and-half world,
  * offers Towering Tepuis' features to every land biome instead of only to
    the jungle and stony peaks. They filter themselves by height, so a biome
    that never rises high enough simply never grows one.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

# Every land biome: tepuis and plateau strata are terrain features that decide
# for themselves whether the ground is high enough, so the only places worth
# excluding are the ones where the question cannot arise.
LAND = (
    r"^(?!.*(ocean|river|beach|swamp|nether|end_|the_end|void|deep_dark|lush_caves"
    r"|dripstone_caves|basalt_deltas|crimson|warped|soul_sand|small_end|the_void)).*$"
)
# The bare-rock biomes a volcano cone or a karst tower turns into: the
# generator pushes the biome copy of erosion to the eroded end under both, so
# vanilla picks one of these rather than a meadow.
ROCK = r"(peaks|windswept|stony|badlands|grove|snowy_slopes)"

# Towering Tepuis' own feature list, with the step each one belongs to, read
# off that pack's jungle.json rather than guessed.
TEPUI: list[tuple[int, str]] = [
    (0, "wythers:terrain/feature/tepui"),
    (0, "wythers:terrain/local/tepui_cap"),
    (1, "wythers:terrain/feature/tepui_filler"),
    (2, "wythers:terrain/feature/tepui_basalt_layer"),
    (2, "wythers:terrain/feature/tepui_tuff_layer"),
    (4, "wythers:terrain/feature/tepui_falls"),
    (4, "wythers:terrain/feature/tepui_terrain"),
    (4, "wythers:terrain/feature/tepui_caverns"),
    (4, "wythers:terrain/feature/tepui_chasms"),
    (5, "wythers:terrain/feature/tepui_lakes"),
    (5, "wythers:terrain/feature/tepui_surface"),
    (5, "wythers:terrain/feature/tepui_cavern_lakes"),
    (5, "wythers:terrain/feature/tepui_cavern_moss"),
    (8, "wythers:terrain/feature/tepui_cavern_dripstone"),
    (9, "wythers:vegetation/extended/patch/tepui_plants"),
]

# MineWorldGen's own skins, and where each belongs. Which of them exist depends
# on the config - karst is off by default, and so are volcanoes at frequency 0
# - so the list is filtered against what the pack actually wrote; injecting an
# id that nothing defines would leave a dangling reference in every biome.
MWG: list[tuple[int, str, str]] = [
    (2, "plateau/cap", LAND),
    (2, "plateau/strata", LAND),
    (2, "volcano/resurface", ROCK),
    (2, "volcano/flows", ROCK),
    (3, "volcano/pools", ROCK),
    (2, "karst/face", ROCK),
]
# Dripstone caves are as close as the game gets to a limestone cave system, so
# where there is karst vanilla's own are asked for a second time.
KARST_CAVES = ["minecraft:dripstone_cluster", "minecraft:large_dripstone"]


def mwg_features(pack_dir: str) -> list[str]:
    """The mwg: placed features this generated pack actually defines."""
    root = os.path.join(pack_dir, "data", "mwg", "worldgen", "placed_feature")
    return [name for _, name, _ in MWG if os.path.exists(os.path.join(root, name + ".json"))]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--woo", required=True, help="Overhauled Overworld zip, any version")
    parser.add_argument("--pack", required=True, help="generated MineWorldGen pack directory")
    parser.add_argument("--out", required=True, help="companion pack zip to write")
    parser.add_argument(
        "--no-split",
        action="store_true",
        help="let the decoration cover the whole world instead of half of it",
    )
    parser.add_argument("--no-tepui", action="store_true", help="leave tepuis in the jungle")
    args = parser.parse_args(argv)

    if not os.path.isdir(os.path.join(args.pack, "data")):
        print(f"{args.pack} does not look like a generated pack", file=sys.stderr)
        return 1

    present = set(mwg_features(args.pack))
    # Everything the injection points at has to be defined by this pack too.
    # A data pack that names an id nothing defines is refused on sight, so a
    # companion carrying mwg: ids but not the mwg: files cannot be applied on
    # its own - or before the terrain pack, or while the player is adding packs
    # one at a time, which is how the world creation screen works.
    staging = tempfile.mkdtemp(prefix="mwg-companion-")
    carried = 0
    for registry in ("configured_feature", "placed_feature"):
        source = os.path.join(args.pack, "data", "mwg", "worldgen", registry)
        if not os.path.isdir(source):
            continue
        for base, _, names in os.walk(source):
            for name in names:
                if not name.endswith(".json"):
                    continue
                full = os.path.join(base, name)
                ident = os.path.relpath(full, source)[: -len(".json")].replace(os.sep, "/")
                if ident not in present:
                    continue
                target = os.path.join(staging, "data", "mwg", "worldgen", registry, ident + ".json")
                os.makedirs(os.path.dirname(target), exist_ok=True)
                shutil.copyfile(full, target)
                carried += 1
    command = [
        sys.executable,
        os.path.join(HERE, "port_pack.py"),
        args.woo,
        "--out",
        args.out,
        "--description",
        "ported to 26.2 by MineWorldGen",
    ]
    if carried:
        command += ["--merge", staging]
    if not args.no_split:
        command += ["--split", "wythers"]
    if not args.no_tepui:
        for step, ident in TEPUI:
            command += ["--inject", f"{step}:{ident}={LAND}"]
    for step, name, where in MWG:
        if name in present:
            command += ["--inject", f"{step}:mwg:{name}={where}"]
    if "karst/face" in present:
        for ident in KARST_CAVES:
            command += ["--inject", f"8:{ident}={ROCK}"]

    print(f"injecting {len(present)} MineWorldGen features: {', '.join(sorted(present)) or 'none'}"
          f"; carrying {carried} definitions so the pack is self-sufficient")
    try:
        return subprocess.call(command)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
