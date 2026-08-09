"""Evaluator for Minecraft worldgen density functions, over numpy grids.

Loads density-function and noise JSON straight out of a datapack (plus a small
built-in table of the vanilla noise parameters the pack relies on) and computes
values for whole 2-D grids at once.

Only the density-function types the pack actually uses are implemented; an
unsupported type raises instead of silently returning a wrong number.
"""

from __future__ import annotations

import json
import math
import os

import numpy as np

from .mcrandom import Xoroshiro
from .perlin import NormalNoise

# Vanilla minecraft:worldgen/noise entries used by the pack. Kept here so the
# simulator does not need a copy of the vanilla data pack.
VANILLA_NOISE = {
    "minecraft:continentalness": (-9, [1.0, 1.0, 2.0, 2.0, 2.0, 1.0, 1.0, 1.0, 1.0]),
    "minecraft:continentalness_large": (-11, [1.0, 1.0, 2.0, 2.0, 2.0, 1.0, 1.0, 1.0, 1.0]),
    "minecraft:erosion": (-9, [1.0, 1.0, 0.0, 1.0, 1.0]),
    "minecraft:erosion_large": (-11, [1.0, 1.0, 0.0, 1.0, 1.0]),
    "minecraft:ridge": (-7, [1.0, 2.0, 1.0, 0.0, 0.0, 0.0]),
    "minecraft:temperature": (-10, [1.5, 0.0, 1.0, 0.0, 0.0, 0.0]),
    "minecraft:temperature_large": (-12, [1.5, 0.0, 1.0, 0.0, 0.0, 0.0]),
    "minecraft:vegetation": (-8, [1.0, 1.0, 0.0, 0.0, 0.0, 0.0]),
    "minecraft:vegetation_large": (-10, [1.0, 1.0, 0.0, 0.0, 0.0, 0.0]),
    "minecraft:offset": (-3, [1.0, 1.0, 1.0, 0.0]),
    "minecraft:jagged": (-16, [1.0] * 16),
    "minecraft:aquifer_barrier": (-3, [1.0]),
    "minecraft:aquifer_fluid_level_floodedness": (-7, [1.0]),
    "minecraft:aquifer_fluid_level_spread": (-5, [1.0]),
    "minecraft:aquifer_lava": (-1, [1.0]),
    "minecraft:cave_layer": (-8, [1.0]),
    "minecraft:cave_cheese": (-8, [0.5, 1.0, 2.0, 1.0, 2.0, 1.0, 0.0, 2.0, 0.0]),
    "minecraft:cave_entrance": (-7, [0.4, 0.5, 1.0]),
    "minecraft:noodle": (-8, [1.0]),
    "minecraft:noodle_thickness": (-8, [1.0]),
    "minecraft:noodle_ridge_a": (-7, [1.0]),
    "minecraft:noodle_ridge_b": (-7, [1.0]),
    "minecraft:spaghetti_2d": (-7, [1.0]),
    "minecraft:spaghetti_2d_elevation": (-8, [1.0]),
    "minecraft:spaghetti_2d_modulator": (-11, [1.0]),
    "minecraft:spaghetti_2d_thickness": (-11, [1.0]),
    "minecraft:spaghetti_3d_1": (-7, [1.0]),
    "minecraft:spaghetti_3d_2": (-7, [1.0]),
    "minecraft:spaghetti_3d_rarity": (-11, [1.0]),
    "minecraft:spaghetti_3d_thickness": (-8, [1.0]),
    "minecraft:spaghetti_roughness": (-5, [1.0]),
    "minecraft:spaghetti_roughness_modulator": (-8, [1.0]),
    "minecraft:pillar": (-7, [1.0, 1.0]),
    "minecraft:pillar_rareness": (-8, [1.0]),
    "minecraft:pillar_thickness": (-8, [1.0]),
    "minecraft:ore_veininess": (-8, [1.0]),
    "minecraft:ore_vein_a": (-7, [1.0]),
    "minecraft:ore_vein_b": (-7, [1.0]),
    "minecraft:ore_gap": (-5, [1.0]),
}


# Vanilla density functions the pack refers to but does not ship.
VANILLA_DF = {
    "minecraft:y": {
        "type": "minecraft:y_clamped_gradient",
        "from_y": -4064,
        "to_y": 4062,
        "from_value": -4064,
        "to_value": 4062,
    },
    "minecraft:zero": 0.0,
    "minecraft:shift_x": {
        "type": "minecraft:flat_cache",
        "argument": {
            "type": "minecraft:cache_2d",
            "argument": {"type": "minecraft:shift_a", "argument": "minecraft:offset"},
        },
    },
    "minecraft:shift_z": {
        "type": "minecraft:flat_cache",
        "argument": {
            "type": "minecraft:cache_2d",
            "argument": {"type": "minecraft:shift_b", "argument": "minecraft:offset"},
        },
    },
}


def _norm_id(ident: str, kind: str) -> str:
    if ":" not in ident:
        ident = "minecraft:" + ident
    return ident


class PackData:
    """Reads density_function / noise JSON out of one or more data roots."""

    def __init__(self, roots: list[str]):
        self.roots = roots
        self._df_cache: dict[str, object] = {}
        self._noise_cache: dict[str, tuple[int, list[float]]] = {}

    def _find(self, ident: str, folder: str) -> str | None:
        ns, _, path = ident.partition(":")
        for root in self.roots:
            candidate = os.path.join(root, ns, "worldgen", folder, path + ".json")
            if os.path.exists(candidate):
                return candidate
        return None

    def density_function(self, ident: str):
        ident = _norm_id(ident, "density_function")
        if ident in self._df_cache:
            return self._df_cache[ident]
        path = self._find(ident, "density_function")
        if path is None:
            if ident in VANILLA_DF:
                value = VANILLA_DF[ident]
                self._df_cache[ident] = value
                return value
            raise KeyError(f"density function not found: {ident}")
        with open(path) as fh:
            value = json.load(fh)
        self._df_cache[ident] = value
        return value

    def noise_parameters(self, ident: str) -> tuple[int, list[float]]:
        ident = _norm_id(ident, "noise")
        if ident in self._noise_cache:
            return self._noise_cache[ident]
        path = self._find(ident, "noise")
        if path is not None:
            with open(path) as fh:
                data = json.load(fh)
            result = (int(data["firstOctave"]), [float(a) for a in data["amplitudes"]])
        elif ident in VANILLA_NOISE:
            result = VANILLA_NOISE[ident]
        else:
            raise KeyError(f"noise parameters not found: {ident}")
        self._noise_cache[ident] = result
        return result


class Evaluator:
    """Evaluates density functions for a given world seed."""

    def __init__(self, pack: PackData, seed: int = 0):
        self.pack = pack
        self.seed = seed
        root = Xoroshiro.from_seed(seed).fork_positional()
        self._root_factory = root
        self._noises: dict[str, NormalNoise] = {}
        # per-evaluation caches
        self._cache2d: dict[int, np.ndarray] = {}
        self._node_ids: dict[int, int] = {}

    # ------------------------------------------------------------------ noise
    def noise(self, ident: str) -> NormalNoise:
        ident = _norm_id(ident, "noise")
        if ident not in self._noises:
            first_octave, amplitudes = self.pack.noise_parameters(ident)
            random = self._root_factory.from_hash_of(ident)
            self._noises[ident] = NormalNoise(random, first_octave, amplitudes)
        return self._noises[ident]

    # ------------------------------------------------------------------- eval
    def reset_cache(self) -> None:
        self._cache2d.clear()

    def evaluate(self, node, x, y, z):
        """Evaluate ``node`` at broadcastable coordinate arrays."""
        return self._eval(node, x, y, z)

    def _eval(self, node, x, y, z):
        if isinstance(node, (int, float)):
            return np.float64(node)
        if isinstance(node, str):
            return self._eval(self.pack.density_function(node), x, y, z)
        if not isinstance(node, dict):
            raise TypeError(f"unexpected density function node: {node!r}")

        kind = node["type"]
        if ":" not in kind:
            kind = "minecraft:" + kind
        kind = kind.split(":", 1)[1]

        method = getattr(self, "_df_" + kind, None)
        if method is None:
            raise NotImplementedError(f"density function type not supported: {kind}")
        return method(node, x, y, z)

    def _cached_2d(self, node, x, y, z):
        key = id(node)
        hit = self._cache2d.get(key)
        if hit is not None:
            return hit
        value = self._eval(node["argument"], x, np.float64(0.0), z)
        value = np.broadcast_to(np.asarray(value, dtype=np.float64), np.broadcast(x, z).shape)
        self._cache2d[key] = value
        return value

    # -- structural ---------------------------------------------------------
    def _df_constant(self, node, x, y, z):
        return np.float64(node["argument"])

    def _df_flat_cache(self, node, x, y, z):
        # FlatCache samples one value per quart (4x4 block) column.
        qx = (np.asarray(x, dtype=np.int64) >> 2) << 2
        qz = (np.asarray(z, dtype=np.int64) >> 2) << 2
        return self._cached_2d(node, qx.astype(np.float64), y, qz.astype(np.float64))

    def _df_cache_2d(self, node, x, y, z):
        return self._cached_2d(node, x, y, z)

    def _df_cache_once(self, node, x, y, z):
        return self._eval(node["argument"], x, y, z)

    def _df_cache_all_in_cell(self, node, x, y, z):
        return self._eval(node["argument"], x, y, z)

    def _df_interpolated(self, node, x, y, z):
        return self._eval(node["argument"], x, y, z)

    def _df_blend_density(self, node, x, y, z):
        return self._eval(node["argument"], x, y, z)

    def _df_blend_alpha(self, node, x, y, z):
        return np.float64(1.0)

    def _df_blend_offset(self, node, x, y, z):
        return np.float64(0.0)

    def _df_beardifier(self, node, x, y, z):
        return np.float64(0.0)

    def _df_old_blended_noise(self, node, x, y, z):
        raise NotImplementedError("old_blended_noise is not used by this pack")

    def _df_end_islands(self, node, x, y, z):
        raise NotImplementedError("end_islands is not used by this pack")

    # -- arithmetic ---------------------------------------------------------
    def _df_add(self, node, x, y, z):
        return self._eval(node["argument1"], x, y, z) + self._eval(node["argument2"], x, y, z)

    def _df_mul(self, node, x, y, z):
        return self._eval(node["argument1"], x, y, z) * self._eval(node["argument2"], x, y, z)

    def _df_min(self, node, x, y, z):
        return np.minimum(
            self._eval(node["argument1"], x, y, z), self._eval(node["argument2"], x, y, z)
        )

    def _df_max(self, node, x, y, z):
        return np.maximum(
            self._eval(node["argument1"], x, y, z), self._eval(node["argument2"], x, y, z)
        )

    def _df_abs(self, node, x, y, z):
        return np.abs(self._eval(node["argument"], x, y, z))

    def _df_square(self, node, x, y, z):
        v = self._eval(node["argument"], x, y, z)
        return v * v

    def _df_cube(self, node, x, y, z):
        v = self._eval(node["argument"], x, y, z)
        return v * v * v

    def _df_half_negative(self, node, x, y, z):
        v = self._eval(node["argument"], x, y, z)
        return np.where(v > 0.0, v, v * 0.5)

    def _df_quarter_negative(self, node, x, y, z):
        v = self._eval(node["argument"], x, y, z)
        return np.where(v > 0.0, v, v * 0.25)

    def _df_squeeze(self, node, x, y, z):
        v = np.clip(self._eval(node["argument"], x, y, z), -1.0, 1.0)
        return v / 2.0 - v * v * v / 24.0

    def _df_clamp(self, node, x, y, z):
        v = self._eval(node["input"], x, y, z)
        return np.clip(v, float(node["min"]), float(node["max"]))

    # -- noise --------------------------------------------------------------
    def _df_noise(self, node, x, y, z):
        noise = self.noise(node["noise"])
        xz = float(node.get("xz_scale", 1.0))
        ys = float(node.get("y_scale", 1.0))
        return noise.value(np.asarray(x) * xz, np.asarray(y) * ys, np.asarray(z) * xz)

    def _df_shifted_noise(self, node, x, y, z):
        noise = self.noise(node["noise"])
        xz = float(node.get("xz_scale", 1.0))
        ys = float(node.get("y_scale", 1.0))
        sx = self._eval(node.get("shift_x", 0.0), x, y, z)
        sy = self._eval(node.get("shift_y", 0.0), x, y, z)
        sz = self._eval(node.get("shift_z", 0.0), x, y, z)
        return noise.value(
            np.asarray(x) * xz + sx,
            np.asarray(y) * ys + sy,
            np.asarray(z) * xz + sz,
        )

    def _shift_noise(self, ident, a, b, c):
        return self.noise(ident).value(
            np.asarray(a) * 0.25, np.asarray(b) * 0.25, np.asarray(c) * 0.25
        ) * 4.0

    def _df_shift(self, node, x, y, z):
        return self._shift_noise(node["argument"], x, y, z)

    def _df_shift_a(self, node, x, y, z):
        return self._shift_noise(node["argument"], x, np.float64(0.0), z)

    def _df_shift_b(self, node, x, y, z):
        return self._shift_noise(node["argument"], z, x, np.float64(0.0))

    def _df_weird_scaled_sampler(self, node, x, y, z):
        noise = self.noise(node["noise"])
        rarity = self._eval(node["input"], x, y, z)
        mapper = node["rarity_value_mapper"]
        if mapper == "type_1":
            scale = _rarity_type1(rarity)
        else:
            scale = _rarity_type2(rarity)
        inv = 1.0 / scale
        return np.abs(scale) * noise.value(
            np.asarray(x) * inv, np.asarray(y) * inv, np.asarray(z) * inv
        )

    # -- coordinates --------------------------------------------------------
    def _df_y_clamped_gradient(self, node, x, y, z):
        from_y = float(node["from_y"])
        to_y = float(node["to_y"])
        from_v = float(node["from_value"])
        to_v = float(node["to_value"])
        t = (np.asarray(y, dtype=np.float64) - from_y) / (to_y - from_y)
        return from_v + np.clip(t, 0.0, 1.0) * (to_v - from_v)

    def _df_range_choice(self, node, x, y, z):
        value = self._eval(node["input"], x, y, z)
        lo = float(node["min_inclusive"])
        hi = float(node["max_exclusive"])
        inside = (value >= lo) & (value < hi)
        a = self._eval(node["when_in_range"], x, y, z)
        b = self._eval(node["when_out_of_range"], x, y, z)
        return np.where(inside, a, b)

    def _df_slide(self, node, x, y, z):
        raise NotImplementedError("slide is not used by this pack")

    # -- spline -------------------------------------------------------------
    def _df_spline(self, node, x, y, z):
        return self._spline(node["spline"], x, y, z)

    def _spline(self, spline, x, y, z):
        if isinstance(spline, (int, float)):
            return np.float64(spline)
        coord = self._eval(spline["coordinate"], x, y, z)
        points = spline["points"]
        locations = np.array([float(p["location"]) for p in points], dtype=np.float64)
        derivatives = np.array([float(p.get("derivative", 0.0)) for p in points], dtype=np.float64)
        values = [self._spline(p["value"], x, y, z) for p in points]

        coord_arr = np.asarray(coord, dtype=np.float64)
        shape = np.broadcast(coord_arr, *[np.asarray(v) for v in values]).shape
        scalar = shape == ()
        if scalar:
            shape = (1,)
        coord_arr = np.broadcast_to(coord_arr, shape)
        values = [np.broadcast_to(np.asarray(v, dtype=np.float64), shape) for v in values]

        n = len(points)
        # index of the last location <= coord, or -1
        idx = np.searchsorted(locations, coord_arr, side="right") - 1
        result = np.empty(shape, dtype=np.float64)

        # below the first knot -> linear extension from knot 0
        below = idx < 0
        if below.any():
            d0 = derivatives[0]
            result[below] = values[0][below] + (
                d0 * (coord_arr[below] - locations[0]) if d0 != 0.0 else 0.0
            )
        # at or past the last knot -> linear extension from the last knot
        above = idx >= n - 1
        if above.any():
            dn = derivatives[n - 1]
            result[above] = values[n - 1][above] + (
                dn * (coord_arr[above] - locations[n - 1]) if dn != 0.0 else 0.0
            )

        middle = ~below & ~above
        if middle.any():
            i = idx[middle]
            g = locations[i]
            h = locations[i + 1]
            span = h - g
            safe_span = np.where(span == 0.0, 1.0, span)
            k = np.where(span != 0.0, (coord_arr[middle] - g) / safe_span, 0.0)
            # gather per-point values for the selected indices
            stacked = np.stack(values, axis=0)
            sel = np.nonzero(middle)
            lo_v = stacked[(i,) + sel]
            hi_v = stacked[(i + 1,) + sel]
            n_term = derivatives[i] * span - (hi_v - lo_v)
            o_term = -derivatives[i + 1] * span + (hi_v - lo_v)
            lerp = lo_v + k * (hi_v - lo_v)
            result[middle] = lerp + k * (1.0 - k) * (n_term + k * (o_term - n_term))
        return result.reshape(()) if scalar else result


def _rarity_type1(value):
    return np.where(
        value < -0.5,
        0.75,
        np.where(value < 0.0, 1.0, np.where(value < 0.5, 1.5, 2.0)),
    )


def _rarity_type2(value):
    return np.where(
        value < -0.75,
        0.5,
        np.where(value < -0.5, 0.75, np.where(value < 0.5, 1.0, np.where(value < 0.75, 2.0, 3.0))),
    )
