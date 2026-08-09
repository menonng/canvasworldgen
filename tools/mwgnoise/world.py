"""Sampling a generated MineWorldGen pack the way Minecraft would."""

from __future__ import annotations

import json
import os

import numpy as np

from .density import Evaluator, PackData

BLOCKS_PER_OFFSET = 128.0


def surface_height(offset, build_min_y: float = -64.0, build_height: float = 384.0):
    """Surface height implied by the terrain offset.

    ``depth = y_clamped_gradient(min_y, max_y, +H/256, -H/256) + offset`` loses
    1/128 per block, so it crosses zero at
    ``min_y + H/2 + 128 * offset`` — which is where the generator puts the
    surface, up to the few-block wobble the 3-D base noise adds on top.
    """
    return build_min_y + build_height / 2.0 + BLOCKS_PER_OFFSET * np.asarray(offset)


def y_for_offset(offset):
    """Vanilla-geometry shorthand for :func:`surface_height`."""
    return surface_height(offset, -64.0, 384.0)


class World:
    def __init__(self, pack_dir: str, seed: int = 0):
        data_dir = os.path.join(pack_dir, "data")
        self.pack = PackData([data_dir])
        self.seed = seed
        self.ev = Evaluator(self.pack, seed=seed)

        self.build_min_y = -64.0
        self.build_height = 384.0
        self.sea_level = 63.0
        settings = os.path.join(
            data_dir, "minecraft", "worldgen", "noise_settings", "overworld.json"
        )
        if os.path.exists(settings):
            with open(settings) as fh:
                data = json.load(fh)
            self.build_min_y = float(data["noise"]["min_y"])
            self.build_height = float(data["noise"]["height"])
            self.sea_level = float(data["sea_level"])

    def surface(self, offset):
        return surface_height(offset, self.build_min_y, self.build_height)

    def sample(self, x0: int, z0: int, size: int, step: int, functions=None) -> dict:
        """Evaluate a square of the world; arrays are indexed [ix, iz]."""
        xs = (x0 + np.arange(size) * step).astype(np.float64)
        zs = (z0 + np.arange(size) * step).astype(np.float64)
        X, Z = np.meshgrid(xs, zs, indexing="ij")
        Y = np.float64(0.0)

        wanted = functions or {
            "offset": "minecraft:overworld/offset",
            "continents": "minecraft:overworld/continents",
            "erosion": "minecraft:overworld/erosion",
            "ridges": "minecraft:overworld/ridges",
        }
        self.ev.reset_cache()
        out = {"x": xs, "z": zs}
        for key, ident in wanted.items():
            value = self.ev.evaluate(self.pack.density_function(ident), X, Y, Z)
            out[key] = np.broadcast_to(np.asarray(value, dtype=np.float64), X.shape).copy()
        if "offset" in out:
            out["surface"] = self.surface(out["offset"])
        return out

    def field(self, ident: str, x0: int, z0: int, size: int, step: int) -> np.ndarray:
        return self.sample(x0, z0, size, step, {"value": ident})["value"]
