"""Access to the vanilla Minecraft 26.2 worldgen files the pack is built from.

The pack is produced as "vanilla plus a patch": when nothing is configured the
generator emits no overrides at all, so the world is bit-for-bit vanilla. When
something is configured, the affected vanilla file is loaded from here, patched
and written out.

The files under ``tools/vanilla/minecraft`` are unmodified Minecraft 26.2
worldgen data (data pack format 107).
"""

from __future__ import annotations

import copy
import json
import os

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vanilla")
MC = os.path.join(ROOT, "minecraft")

MINECRAFT_VERSION = "26.2"
PACK_FORMAT = 107


def load(*parts: str):
    with open(os.path.join(MC, *parts)) as fh:
        return json.load(fh)


def load_copy(*parts: str):
    return copy.deepcopy(load(*parts))


def noise(name: str) -> dict:
    return load_copy("worldgen", "noise", name + ".json")


def density_function(path: str) -> dict:
    return load_copy("worldgen", "density_function", path + ".json")


def noise_settings(name: str = "overworld") -> dict:
    return load_copy("worldgen", "noise_settings", name + ".json")


def dimension_type(name: str = "overworld") -> dict:
    return load_copy("dimension_type", name + ".json")


def structure_sets() -> dict:
    folder = os.path.join(MC, "worldgen", "structure_set")
    result = {}
    for entry in sorted(os.listdir(folder)):
        if entry.endswith(".json"):
            with open(os.path.join(folder, entry)) as fh:
                result[entry[:-5]] = json.load(fh)
    return result


# Structure sets that live in the Overworld; the others are left alone.
OVERWORLD_STRUCTURE_SETS = (
    "ancient_cities",
    "buried_treasures",
    "desert_pyramids",
    "igloos",
    "jungle_temples",
    "mineshafts",
    "ocean_monuments",
    "ocean_ruins",
    "pillager_outposts",
    "ruined_portals",
    "shipwrecks",
    "strongholds",
    "swamp_huts",
    "trail_ruins",
    "trial_chambers",
    "villages",
    "woodland_mansions",
)

# Noise parameters that control the size of cave systems.
CAVE_NOISES = (
    "cave_cheese",
    "cave_entrance",
    "cave_layer",
    "noodle",
    "noodle_ridge_a",
    "noodle_ridge_b",
    "noodle_thickness",
    "pillar",
    "pillar_rareness",
    "pillar_thickness",
    "spaghetti_2d",
    "spaghetti_2d_elevation",
    "spaghetti_2d_modulator",
    "spaghetti_2d_thickness",
    "spaghetti_3d_1",
    "spaghetti_3d_2",
    "spaghetti_3d_rarity",
    "spaghetti_3d_thickness",
    "spaghetti_roughness",
    "spaghetti_roughness_modulator",
)


def scale_noise(params: dict, factor: float) -> dict:
    """Return noise parameters whose features are ``factor`` times larger.

    ``firstOctave`` only moves in whole octaves, so a fractional factor is
    reached by blending the amplitude arrays of the two neighbouring octave
    shifts. The result is a genuine continuous scale, not a rounded one.
    """
    import math

    if abs(factor - 1.0) < 1e-6:
        return copy.deepcopy(params)
    exponent = math.log2(float(factor))
    whole = math.floor(exponent)
    frac = exponent - whole

    amplitudes = [float(a) for a in params["amplitudes"]]
    # at shift `whole`   -> firstOctave - whole,   amplitudes A
    # at shift `whole+1` -> firstOctave - whole-1, amplitudes A
    # express both on firstOctave - whole - 1
    low = [0.0] + amplitudes  # the smaller shift, re-indexed
    high = amplitudes + [0.0]
    blended = [round((1.0 - frac) * a + frac * b, 6) for a, b in zip(low, high)]
    while len(blended) > 1 and blended[-1] == 0.0:
        blended.pop()
    return {
        "firstOctave": int(params["firstOctave"]) - whole - 1,
        "amplitudes": blended,
    }


def multiply_amplitudes(params: dict, factor: float) -> dict:
    out = copy.deepcopy(params)
    out["amplitudes"] = [round(float(a) * factor, 6) for a in out["amplitudes"]]
    return out
