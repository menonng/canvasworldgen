"""Tiny helpers for writing Minecraft density-function JSON from Python."""

from __future__ import annotations


def add(a, b):
    if a == 0:
        return b
    if b == 0:
        return a
    return {"type": "minecraft:add", "argument1": a, "argument2": b}


def add_all(*args):
    result = 0
    for arg in args:
        result = add(result, arg)
    return result


def mul(a, b):
    if a == 1:
        return b
    if b == 1:
        return a
    if a == 0 or b == 0:
        return 0
    return {"type": "minecraft:mul", "argument1": a, "argument2": b}


def sub(a, b):
    return add(a, mul(-1, b))


def mn(a, b):
    return {"type": "minecraft:min", "argument1": a, "argument2": b}


def mx(a, b):
    return {"type": "minecraft:max", "argument1": a, "argument2": b}


def clamp(value, lo, hi):
    return {"type": "minecraft:clamp", "input": value, "min": lo, "max": hi}


def abs_(value):
    return {"type": "minecraft:abs", "argument": value}


def square(value):
    return {"type": "minecraft:square", "argument": value}


def half_negative(value):
    return {"type": "minecraft:half_negative", "argument": value}


def quarter_negative(value):
    return {"type": "minecraft:quarter_negative", "argument": value}


def squeeze(value):
    return {"type": "minecraft:squeeze", "argument": value}


def flat(value):
    return {"type": "minecraft:flat_cache", "argument": value}


def cache2d(value):
    return {"type": "minecraft:cache_2d", "argument": value}


def cache_once(value):
    return {"type": "minecraft:cache_once", "argument": value}


def interpolated(value):
    return {"type": "minecraft:interpolated", "argument": value}


def blend_density(value):
    return {"type": "minecraft:blend_density", "argument": value}


def noise(name, xz_scale=1.0, y_scale=0.0):
    return {
        "type": "minecraft:noise",
        "noise": name,
        "xz_scale": xz_scale,
        "y_scale": y_scale,
    }


def shifted_noise(name, xz_scale=1.0, y_scale=0.0, shift_x=0.0, shift_y=0.0, shift_z=0.0):
    return {
        "type": "minecraft:shifted_noise",
        "noise": name,
        "xz_scale": xz_scale,
        "y_scale": y_scale,
        "shift_x": shift_x,
        "shift_y": shift_y,
        "shift_z": shift_z,
    }


def ygrad(from_y, to_y, from_value, to_value):
    return {
        "type": "minecraft:y_clamped_gradient",
        "from_y": from_y,
        "to_y": to_y,
        "from_value": from_value,
        "to_value": to_value,
    }


def range_choice(value, lo, hi, inside, outside):
    return {
        "type": "minecraft:range_choice",
        "input": value,
        "min_inclusive": lo,
        "max_exclusive": hi,
        "when_in_range": inside,
        "when_out_of_range": outside,
    }


def pt(location, value, derivative=0.0):
    return {"location": location, "value": value, "derivative": derivative}


def spline(coordinate, points):
    return {"type": "minecraft:spline", "spline": {"coordinate": coordinate, "points": points}}


def nested(coordinate, points):
    """A spline used as the ``value`` of another spline's point."""
    return {"coordinate": coordinate, "points": points}


def as_df(value):
    """A nested spline value promoted to a density function of its own.

    ``nested`` returns the bare ``{coordinate, points}`` object a spline point
    wants, which is not a density function and has no ``type``. Anywhere a
    branch might hand one of those straight to ``df`` - a selection with no
    branches left, for instance - it has to be wrapped first, or the pack
    fails to load with no clue as to which file is wrong.
    """
    if isinstance(value, dict) and "coordinate" in value and "type" not in value:
        return {"type": "minecraft:spline", "spline": value}
    return value


def lerp_map(coordinate, pairs, derivative=0.0):
    """Piecewise map with flat ends: ``[(loc, value), ...]``."""
    return spline(coordinate, [pt(loc, val, derivative) for loc, val in pairs])


def step(coordinate, threshold, low, high, width=1e-3):
    """A near-instant switch between two values at ``threshold``."""
    return spline(
        coordinate,
        [pt(threshold - width, low, 0.0), pt(threshold + width, high, 0.0)],
    )
