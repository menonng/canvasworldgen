"""Config schema, defaults and loading for MineWorldGen.

``mode`` decides everything: at ``"vanilla"`` the generator writes no world
generation files at all, so the data pack cannot change terrain. Every other
setting only takes effect at ``"custom"``.
"""

from __future__ import annotations

import json

from .calib import max_stretch as _max_stretch

DEFAULTS = {
    "format": 1,
    # "vanilla" -> generate nothing, terrain is 100% vanilla.
    # "custom"  -> apply everything below.
    "mode": "vanilla",
    "world": {
        "sea_level": 63,
        # Dimension build limits. Both must be multiples of 16 and
        # build_height <= 4064.
        "build_min_y": -64,
        "build_height": 384,
        # Highest / lowest y the terrain surface may reach.
        "terrain_max_y": 312,
        "terrain_min_y": -40,
        "vertical_scale": 1.0,
    },
    "center": {
        # archipelago | continent | island | ocean | default
        "type": "default",
        "radius": 2500,
        "strength": 1.0,
    },
    "continents": {
        "land_ratio": 0.32,
        "ocean_offset": None,
        # Mean west-east and north-south extent of one landmass, in blocks.
        "width": 6000,
        "height": 6000,
        # How far the coastline wanders from those figures, in percent.
        "width_variation_percent": 30,
        "height_variation_percent": 30,
        "erosion_scale": 1.0,
        "ridge_scale": 1.0,
        "flat_terrain_skew": 0.10,
        "mountain_ranges": 1.0,
        "plateaus": 1.0,
        "tepui": 0.6,
        "rolling_hills": True,
    },
    "rivers": {
        "enabled": True,
        # 1.0 keeps vanilla-width rivers, 2.0 doubles them.
        "width": 1.0,
        "depth_blocks": 10,
    },
    "inland_seas": {
        "enabled": True,
        # Share of continental interior taken up by inland seas (0 - 1).
        "frequency": 0.35,
        "size": 3000,
        "depth_blocks": 26,
    },
    "fjords": {
        "enabled": True,
        "frequency": 0.6,
        "width": 1.0,
        "depth_blocks": 24,
    },
    "islands": {
        "enabled": True,
        "size": 700,
        "frequency": 1.0,
        "clustering": 0.5,
        "arc_strength": 0.6,
        "noise_offset": 0.05,
        "atoll_chance": 0.18,
        "volcanic_chance": 0.20,
        "cliff_chance": 0.22,
    },
    "oceans": {
        "ocean_depth_blocks": 28,
        "deep_ocean_depth_blocks": 58,
        "seafloor_relief": 1.0,
        "trenches": True,
        "trench_depth_blocks": 34,
    },
    "coast": {
        "cliffs": 0.6,
        "sea_stacks": 0.5,
        "columnar_jointing": 0.5,
    },
    "biomes": {
        # Grow the climate noise together with the continents so a huge world
        # does not get a checkerboard of biomes.
        "scale_with_continents": True,
        "temperature_scale": 1.0,
        "temperature_offset": 0.0,
        "temperature_multiplier": 1.0,
        "vegetation_scale": 1.0,
        "vegetation_offset": 0.0,
        "vegetation_multiplier": 1.0,
    },
    "caves": {
        "scale_with_continents": True,
        "size_multiplier": 1.0,
        "carvers_enabled": True,
    },
    "structures": {
        "scale_with_continents": True,
        "spacing_multiplier": 1.0,
    },
    "spawn": {
        # Restrict the world spawn search to inland climate, and nudge players
        # who still land in water onto the nearest land.
        "force_land_spawn": True,
    },
}

MODES = ("vanilla", "custom")
CENTER_TYPES = ("archipelago", "continent", "island", "ocean", "default")

# Continent size that reproduces vanilla's continent scale, measured with
# tools/calibrate.py. Used as the reference point for every "scale with
# continents" option.
VANILLA_CONTINENT_SIZE = 1400.0


def strip_comments(text: str) -> str:
    """Allow // and /* */ comments in the user-facing config file."""
    out = []
    in_string = False
    escaped = False
    i = 0
    while i < len(text):
        ch = text[i]
        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < len(text):
            if text[i + 1] == "/":
                while i < len(text) and text[i] != "\n":
                    i += 1
                continue
            if text[i + 1] == "*":
                end = text.find("*/", i + 2)
                i = len(text) if end < 0 else end + 2
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def load_config(path: str) -> dict:
    with open(path) as fh:
        return json.loads(strip_comments(fh.read()))


def merge_config(defaults: dict, override: dict) -> dict:
    result = {}
    for key, value in defaults.items():
        if isinstance(value, dict):
            result[key] = merge_config(value, (override or {}).get(key) or {})
        else:
            result[key] = (override or {}).get(key, value)
    for key, value in (override or {}).items():
        if key not in result:
            result[key] = value
    return result


def validate(cfg: dict) -> list[str]:
    """Human-readable problems; an empty list means the config is usable."""
    problems: list[str] = []

    if str(cfg.get("mode", "vanilla")).lower() not in MODES:
        problems.append(f"mode must be one of {', '.join(MODES)}")
    if str(cfg.get("mode", "vanilla")).lower() == "vanilla":
        return problems

    def number(section, key, lo, hi, allow_none=False):
        value = cfg[section][key]
        if value is None and allow_none:
            return
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            problems.append(f"{section}.{key} must be a number (got {value!r})")
            return
        if not (lo <= value <= hi):
            problems.append(f"{section}.{key} must be between {lo} and {hi} (got {value})")

    world = cfg["world"]
    number("world", "build_min_y", -2032, 0)
    number("world", "build_height", 16, 4064)
    number("world", "sea_level", -2032, 2032)
    number("world", "terrain_max_y", -2032, 4032)
    number("world", "terrain_min_y", -2032, 4032)
    number("world", "vertical_scale", 0.1, 4.0)
    if world["build_min_y"] % 16 or world["build_height"] % 16:
        problems.append("world.build_min_y and world.build_height must be multiples of 16")
    build_max = world["build_min_y"] + world["build_height"]
    if not (world["build_min_y"] < world["terrain_min_y"] < world["terrain_max_y"] < build_max):
        problems.append(
            "need build_min_y < terrain_min_y < terrain_max_y < build_min_y + build_height "
            f"(got {world['build_min_y']} / {world['terrain_min_y']} / "
            f"{world['terrain_max_y']} / {build_max})"
        )
    if not (world["terrain_min_y"] < world["sea_level"] < world["terrain_max_y"]):
        problems.append("world.sea_level must sit between terrain_min_y and terrain_max_y")

    if str(cfg["center"]["type"]).lower() not in CENTER_TYPES:
        problems.append(f"center.type must be one of {', '.join(CENTER_TYPES)}")
    number("center", "radius", 200, 200000)
    number("center", "strength", 0.0, 2.0)

    number("continents", "land_ratio", 0.02, 0.95)
    number("continents", "ocean_offset", -2.0, 1.0, allow_none=True)
    number("continents", "width", 300, 400000)
    number("continents", "height", 300, 400000)
    number("continents", "width_variation_percent", 0, 80)
    number("continents", "height_variation_percent", 0, 80)
    number("continents", "erosion_scale", 0.1, 8.0)
    number("continents", "ridge_scale", 0.1, 8.0)
    number("continents", "flat_terrain_skew", 0.0, 1.0)
    number("continents", "mountain_ranges", 0.0, 2.0)
    number("continents", "plateaus", 0.0, 2.0)
    number("continents", "tepui", 0.0, 2.0)

    number("rivers", "width", 0.1, 4.0)
    number("rivers", "depth_blocks", 0, 120)
    number("inland_seas", "frequency", 0.0, 1.0)
    number("inland_seas", "size", 500, 100000)
    number("inland_seas", "depth_blocks", 0, 200)
    number("fjords", "frequency", 0.0, 1.0)
    number("fjords", "width", 0.1, 4.0)
    number("fjords", "depth_blocks", 0, 200)

    number("islands", "size", 80, 20000)
    number("islands", "frequency", 0.0, 3.0)
    number("islands", "clustering", 0.0, 1.0)
    number("islands", "arc_strength", 0.0, 2.0)
    number("islands", "noise_offset", -0.6, 0.6)
    for key in ("atoll_chance", "volcanic_chance", "cliff_chance"):
        number("islands", key, 0.0, 1.0)

    number("oceans", "ocean_depth_blocks", 0, 1000)
    number("oceans", "deep_ocean_depth_blocks", 0, 1000)
    number("oceans", "seafloor_relief", 0.0, 4.0)
    number("oceans", "trench_depth_blocks", 0, 1000)

    for key in ("cliffs", "sea_stacks", "columnar_jointing"):
        number("coast", key, 0.0, 2.0)

    for key in (
        "temperature_scale",
        "temperature_multiplier",
        "vegetation_scale",
        "vegetation_multiplier",
    ):
        number("biomes", key, 0.05, 8.0)
    for key in ("temperature_offset", "vegetation_offset"):
        number("biomes", key, -1.0, 1.0)

    number("caves", "size_multiplier", 0.25, 4.0)
    number("structures", "spacing_multiplier", 0.25, 8.0)

    width = cfg["continents"]["width"]
    height = cfg["continents"]["height"]
    ratio = max(width / height, height / width)
    limit = _max_stretch()
    if ratio > limit + 0.02:
        problems.append(
            f"continents.width and continents.height must stay within a 1:{limit:.2f} ratio "
            f"(got 1:{ratio:.2f}). Minecraft density functions cannot read the world x/z "
            "coordinate, so elongation is produced by averaging the continent noise along "
            "one axis, and that saturates here - see README, 'Why the 1:1.8 limit'."
        )

    floor_y = cfg["world"]["sea_level"] - (
        cfg["oceans"]["deep_ocean_depth_blocks"] + cfg["oceans"]["trench_depth_blocks"]
    )
    if floor_y < cfg["world"]["terrain_min_y"]:
        problems.append(
            f"the deepest ocean floor (y={floor_y:.0f}) is below world.terrain_min_y "
            f"({cfg['world']['terrain_min_y']}); raise terrain_min_y or reduce the depths"
        )
    return problems
