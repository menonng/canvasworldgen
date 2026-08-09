#!/usr/bin/env python3
"""Render a preview map of a config, straight out of the noise simulator.

    python3 tools/render.py --config presets/archipelago.json --out docs/img/archipelago.png

Colours follow the surface height: ocean depths in blues, land from beach sand
up through green, rock and snow, so the shape of the world is readable at a
glance.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mwgbuild.builder import Builder  # noqa: E402
from mwgbuild.config import load_config  # noqa: E402
from mwgnoise.world import World  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

RAMP = [
    (-140, (5, 15, 55)),
    (-40, (10, 32, 92)),
    (-12, (18, 58, 130)),
    (0, (30, 95, 165)),
    (0.5, (233, 220, 170)),
    (6, (150, 190, 110)),
    (30, (86, 150, 78)),
    (70, (108, 140, 72)),
    (110, (140, 128, 84)),
    (150, (132, 118, 110)),
    (190, (150, 148, 148)),
    (230, (198, 198, 200)),
    (270, (240, 244, 248)),
    (400, (255, 255, 255)),
]


def colourise(surface: np.ndarray, sea_level: float) -> np.ndarray:
    relative = surface - sea_level
    stops = np.array([row[0] for row in RAMP], dtype=np.float64)
    colours = np.array([row[1] for row in RAMP], dtype=np.float64)
    out = np.empty(relative.shape + (3,), dtype=np.float64)
    for channel in range(3):
        out[..., channel] = np.interp(relative, stops, colours[:, channel])

    # hill shading, so mountain ranges and cliffs are visible
    gy, gx = np.gradient(np.maximum(surface, sea_level))
    shade = np.clip(1.0 + 0.045 * (gx + gy), 0.55, 1.45)
    out *= shade[..., None]
    return np.clip(out, 0, 255).astype(np.uint8)


def render(pack_dir: str, seed: int, size: int, step: int, sea_level: float | None = None):
    world = World(pack_dir, seed=seed)
    span = size * step
    data = world.sample(-span // 2, -span // 2, size, step, {"offset": "minecraft:overworld/offset"})
    surface = data["surface"]
    pixels = colourise(surface, world.sea_level if sea_level is None else sea_level)
    # array is [ix, iz]; image rows should run north-south
    return Image.fromarray(np.transpose(pixels, (1, 0, 2)), "RGB")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=None, help="config json to render (built to a temp pack)")
    parser.add_argument("--pack", default=None, help="already generated pack directory")
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, default=1234)
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--step", type=int, default=96)
    args = parser.parse_args(argv)

    temp = None
    if args.pack:
        pack_dir = args.pack
        sea_level = None
    else:
        cfg = load_config(args.config or os.path.join(REPO_ROOT, "pack", "config.json"))
        cfg.setdefault("mode", "custom")
        temp = tempfile.mkdtemp(prefix="mwgrender-")
        Builder(cfg).build(temp)
        pack_dir = temp
        sea_level = None

    image = render(pack_dir, args.seed, args.size, args.step, sea_level)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    image.save(args.out)
    print(f"wrote {args.out} ({args.size * args.step} x {args.size * args.step} blocks)")
    if temp:
        import shutil

        shutil.rmtree(temp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
