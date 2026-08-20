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


# Allowed range for every numeric setting. Values outside the range are pulled
# back to the nearest bound rather than rejected, so any config generates a
# world.
RANGES = {
    "world": {
        "sea_level": (-2032, 2032),
        "build_min_y": (-2032, 0),
        "build_height": (16, 4064),
        "terrain_max_y": (-2032, 4032),
        "terrain_min_y": (-2032, 4032),
        "vertical_scale": (0.1, 4.0),
    },
    "center": {"radius": (200, 200000), "strength": (0.0, 2.0)},
    "continents": {
        "land_ratio": (0.02, 0.95),
        "ocean_offset": (-2.0, 1.0),
        "width": (300, 400000),
        "height": (300, 400000),
        "width_variation_percent": (0, 80),
        "height_variation_percent": (0, 80),
        "erosion_scale": (0.1, 8.0),
        "ridge_scale": (0.1, 8.0),
        "flat_terrain_skew": (0.0, 1.0),
        "mountain_ranges": (0.0, 2.0),
        "plateaus": (0.0, 2.0),
        "tepui": (0.0, 2.0),
    },
    "rivers": {"width": (0.1, 4.0), "depth_blocks": (0, 120)},
    "inland_seas": {"frequency": (0.0, 1.0), "size": (500, 100000), "depth_blocks": (0, 200)},
    "fjords": {"frequency": (0.0, 1.0), "width": (0.1, 4.0), "depth_blocks": (0, 200)},
    "islands": {
        "size": (80, 20000),
        "frequency": (0.0, 3.0),
        "clustering": (0.0, 1.0),
        "arc_strength": (0.0, 2.0),
        "noise_offset": (-0.6, 0.6),
        "atoll_chance": (0.0, 1.0),
        "volcanic_chance": (0.0, 1.0),
        "cliff_chance": (0.0, 1.0),
    },
    "oceans": {
        "ocean_depth_blocks": (0, 1000),
        "deep_ocean_depth_blocks": (0, 1000),
        "seafloor_relief": (0.0, 4.0),
        "trench_depth_blocks": (0, 1000),
    },
    "coast": {"cliffs": (0.0, 2.0), "sea_stacks": (0.0, 2.0), "columnar_jointing": (0.0, 2.0)},
    "biomes": {
        "temperature_scale": (0.05, 8.0),
        "temperature_offset": (-1.0, 1.0),
        "temperature_multiplier": (0.05, 8.0),
        "vegetation_scale": (0.05, 8.0),
        "vegetation_offset": (-1.0, 1.0),
        "vegetation_multiplier": (0.05, 8.0),
    },
    "caves": {"size_multiplier": (0.25, 4.0)},
    "structures": {"spacing_multiplier": (0.25, 8.0)},
}

BOOLEAN_KEYS = {
    ("continents", "rolling_hills"),
    ("rivers", "enabled"),
    ("inland_seas", "enabled"),
    ("fjords", "enabled"),
    ("islands", "enabled"),
    ("oceans", "trenches"),
    ("biomes", "scale_with_continents"),
    ("caves", "scale_with_continents"),
    ("caves", "carvers_enabled"),
    ("structures", "scale_with_continents"),
    ("spawn", "force_land_spawn"),
}


def _round_to(value: float, step: int) -> int:
    return int(round(float(value) / step)) * step


def normalise(config: dict) -> tuple[dict, list[str]]:
    """Merge with the defaults and pull every value into its valid range.

    Nothing is ever rejected: out-of-range numbers are clamped to the nearest
    bound, unusable values fall back to the default, and impossible
    combinations are resolved in favour of the setting the player is most
    likely to care about. Returns the usable config plus a list of the
    adjustments that were made.
    """
    cfg = merge_config(DEFAULTS, config or {})
    notes: list[str] = []

    def note(message: str) -> None:
        notes.append(message)

    # --- mode and enums -----------------------------------------------------
    mode = str(cfg.get("mode", "vanilla")).strip().lower()
    if mode not in MODES:
        note(f'mode "{cfg.get("mode")}" is not recognised, falling back to "vanilla"')
        mode = "vanilla"
    cfg["mode"] = mode

    center_type = str(cfg["center"].get("type", "default")).strip().lower()
    if center_type not in CENTER_TYPES:
        note(f'center.type "{cfg["center"].get("type")}" is not recognised, using "default"')
        center_type = "default"
    cfg["center"]["type"] = center_type

    # --- booleans -----------------------------------------------------------
    for section, key in BOOLEAN_KEYS:
        cfg[section][key] = bool(cfg[section].get(key, DEFAULTS[section][key]))

    if mode != "custom":
        return cfg, notes

    # --- plain numeric clamping ---------------------------------------------
    for section, keys in RANGES.items():
        for key, (lo, hi) in keys.items():
            value = cfg[section].get(key)
            if key == "ocean_offset" and value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                default = DEFAULTS[section][key]
                note(f"{section}.{key} is not a number, using the default {default}")
                cfg[section][key] = default
                continue
            if value < lo:
                note(f"{section}.{key} raised from {value} to the minimum {lo}")
                cfg[section][key] = lo
            elif value > hi:
                note(f"{section}.{key} lowered from {value} to the maximum {hi}")
                cfg[section][key] = hi

    world = cfg["world"]

    # --- world geometry -----------------------------------------------------
    for key in ("build_min_y", "build_height"):
        rounded = _round_to(world[key], 16)
        lo, hi = RANGES["world"][key]
        rounded = max(int(lo), min(int(hi), rounded))
        if rounded != world[key]:
            note(f"world.{key} rounded from {world[key]} to {rounded} (must be a multiple of 16)")
        world[key] = rounded
    build_max = world["build_min_y"] + world["build_height"]

    # Terrain has to fit inside the build limits with a little headroom. The
    # ceiling needs 16 blocks of it, not 8: final_density fades terrain to air
    # over the 16 blocks above terrain_max_y, and a fade that runs past the
    # build ceiling never reaches air, so the cut would not be clean.
    top = build_max - 16
    bottom = world["build_min_y"] + 8
    for key, lo, hi in (("terrain_max_y", bottom + 2, top), ("terrain_min_y", bottom, top - 2)):
        value = world[key]
        clamped = max(lo, min(hi, value))
        if clamped != value:
            note(f"world.{key} moved from {value} to {clamped} to fit the build limits")
            world[key] = clamped
    if world["terrain_min_y"] >= world["terrain_max_y"]:
        world["terrain_min_y"] = max(bottom, world["terrain_max_y"] - 16)
        note(
            "world.terrain_min_y was at or above terrain_max_y, lowered to "
            f"{world['terrain_min_y']}"
        )
    sea = max(world["terrain_min_y"] + 1, min(world["terrain_max_y"] - 1, world["sea_level"]))
    if sea != world["sea_level"]:
        note(f"world.sea_level moved from {world['sea_level']} to {sea} to sit between the limits")
        world["sea_level"] = sea

    # --- continent aspect ratio ---------------------------------------------
    cont = cfg["continents"]
    limit = _max_stretch()
    width, height = float(cont["width"]), float(cont["height"])
    ratio = max(width / height, height / width)
    if ratio > limit:
        if width >= height:
            new = round(height * limit)
            note(f"continents.width lowered from {cont['width']} to {new} (max ratio 1:{limit:.2f})")
            cont["width"] = new
        else:
            new = round(width * limit)
            note(
                f"continents.height lowered from {cont['height']} to {new} "
                f"(max ratio 1:{limit:.2f})"
            )
            cont["height"] = new

    # --- land ratio inside the achievable band -------------------------------
    from .calib import land_ratio_bounds

    lo_land, hi_land = land_ratio_bounds()
    if cont.get("ocean_offset") is None:
        target = float(cont["land_ratio"])
        clamped = max(lo_land, min(hi_land, target))
        if abs(clamped - target) > 1e-6:
            note(
                f"continents.land_ratio moved from {target} to {clamped:.3f} "
                "(reachable range with the current island settings)"
            )
            cont["land_ratio"] = round(clamped, 4)

    # --- ocean floor has to fit above terrain_min_y --------------------------
    oceans = cfg["oceans"]
    trench = oceans["trench_depth_blocks"] if oceans["trenches"] else 0
    floor = world["sea_level"] - (oceans["deep_ocean_depth_blocks"] + trench)
    if floor < world["terrain_min_y"]:
        room = world["sea_level"] - max(bottom, world["build_min_y"] + 8)
        wanted = oceans["deep_ocean_depth_blocks"] + trench
        if wanted <= room:
            note(
                f"world.terrain_min_y lowered from {world['terrain_min_y']} to {floor} "
                "to make room for the configured ocean depth"
            )
            world["terrain_min_y"] = int(floor)
        else:
            scale = room / float(wanted) if wanted else 1.0
            oceans["deep_ocean_depth_blocks"] = int(oceans["deep_ocean_depth_blocks"] * scale)
            if oceans["trenches"]:
                oceans["trench_depth_blocks"] = int(oceans["trench_depth_blocks"] * scale)
            world["terrain_min_y"] = int(
                world["sea_level"]
                - oceans["deep_ocean_depth_blocks"]
                - (oceans["trench_depth_blocks"] if oceans["trenches"] else 0)
            )
            note(
                "the configured ocean depth does not fit in the world, depths scaled to "
                f"{oceans['deep_ocean_depth_blocks']} / {oceans['trench_depth_blocks']} blocks"
            )
    if oceans["ocean_depth_blocks"] > oceans["deep_ocean_depth_blocks"]:
        note(
            "oceans.ocean_depth_blocks was deeper than deep_ocean_depth_blocks, "
            f"lowered to {oceans['deep_ocean_depth_blocks']}"
        )
        oceans["ocean_depth_blocks"] = oceans["deep_ocean_depth_blocks"]

    # --- island archetype shares ---------------------------------------------
    isl = cfg["islands"]
    total = isl["atoll_chance"] + isl["volcanic_chance"] + isl["cliff_chance"]
    if total > 0.95:
        scale = 0.95 / total
        for key in ("atoll_chance", "volcanic_chance", "cliff_chance"):
            isl[key] = round(isl[key] * scale, 4)
        note(
            "island archetype chances summed above 0.95, scaled down to "
            f"{isl['atoll_chance']} / {isl['volcanic_chance']} / {isl['cliff_chance']}"
        )

    return cfg, notes
