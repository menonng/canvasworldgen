#!/usr/bin/env python3
"""Measure generated worlds by simulating Minecraft's world generation.

    python3 tools/measure.py --config presets/earthlike.json
    python3 tools/measure.py --all-presets --markdown

The numbers come from ``tools/mwgnoise``, a re-implementation of Minecraft's
Xoroshiro128++ random source, ImprovedNoise/PerlinNoise/NormalNoise stack and
density-function evaluator, run over the JSON the generator actually writes.

Heights are the surface implied by the terrain offset. The 3-D base noise adds
a zero-mean wobble of a few blocks on top of that, so individual columns vary,
but every statistic below is unaffected by it.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile

import numpy as np
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mwgbuild.builder import Builder  # noqa: E402
from mwgbuild.config import DEFAULTS, load_config, merge_config  # noqa: E402
from mwgnoise.world import World  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def blobs(mask: np.ndarray, step: int, min_cells: int):
    labels, count = ndimage.label(mask)
    if count == 0:
        return []
    sizes = ndimage.sum(mask, labels, index=np.arange(1, count + 1))
    out = []
    for idx, slices in enumerate(ndimage.find_objects(labels)):
        if slices is None or sizes[idx] < min_cells:
            continue
        if (
            slices[0].start == 0
            or slices[1].start == 0
            or slices[0].stop == mask.shape[0]
            or slices[1].stop == mask.shape[1]
        ):
            continue
        out.append(
            {
                "width": (slices[0].stop - slices[0].start) * step,
                "height": (slices[1].stop - slices[1].start) * step,
                "area": float(sizes[idx]) * step * step,
            }
        )
    return out


def summarise(values):
    if not values:
        return {"n": 0}
    array = np.asarray(values, dtype=np.float64)
    mean = float(array.mean())
    std = float(array.std(ddof=1)) if len(array) > 1 else 0.0
    return {
        "n": len(array),
        "mean": round(mean, 1),
        "std": round(std, 1),
        "cv_percent": round(100.0 * std / mean, 1) if mean else 0.0,
    }


def measure(config: dict, seeds, size: int, step: int) -> dict:
    merged = merge_config(DEFAULTS, config)
    target_size = min(merged["continents"]["width"], merged["continents"]["height"])
    biggest = max(merged["continents"]["width"], merged["continents"]["height"])

    # The sampled square has to hold a decent number of whole landmasses,
    # otherwise every blob touches the edge and gets discarded.
    step = max(step, int(round(target_size / 34.0 / 8.0)) * 8)
    while size * step < biggest * 7:
        step *= 2

    pack = tempfile.mkdtemp(prefix="mwgmeasure-")
    notes = Builder(config).build(pack)
    try:
        land_fracs, widths, heights, island_sizes = [], [], [], []
        depths, mins, maxs, islands_per_seed = [], [], [], []
        span = size * step
        sea_level = float(merged["world"]["sea_level"])
        for seed in seeds:
            world = World(pack, seed=seed)
            sea_level = world.sea_level
            data = world.sample(
                -span // 2, -span // 2, size, step, {"offset": "minecraft:overworld/offset"}
            )
            surface = data["surface"]
            land = surface > sea_level
            land_fracs.append(float(land.mean()))
            mins.append(float(surface.min()))
            maxs.append(float(surface.max()))
            depths.append(sea_level - surface[~land])

            # a landmass has to be at least half the configured size before it
            # counts as a continent rather than an island cluster
            big_cells = int(((target_size / 2.0) / step) ** 2 * 0.6)
            big = [
                b
                for b in blobs(land, step, big_cells)
                if b["width"] >= target_size * 0.4 and b["height"] >= target_size * 0.4
            ]
            small = blobs(land, step, 4)
            for blob in big:
                widths.append(blob["width"])
                heights.append(blob["height"])
            big_keys = {(b["width"], b["height"], b["area"]) for b in big}
            count = 0
            for blob in small:
                if (blob["width"], blob["height"], blob["area"]) in big_keys:
                    continue
                count += 1
                island_sizes.append(max(blob["width"], blob["height"]))
            islands_per_seed.append(count)
    finally:
        shutil.rmtree(pack, ignore_errors=True)

    all_depths = np.concatenate(depths) if depths else np.array([0.0])
    return {
        "sampled_area_blocks": f"{span} x {span}",
        "sample_step": step,
        "seeds": list(seeds),
        "requested": {
            "land_ratio": merged["continents"]["land_ratio"],
            "continent_width": merged["continents"]["width"],
            "continent_height": merged["continents"]["height"],
            "island_size": merged["islands"]["size"],
            "ocean_depth_blocks": merged["oceans"]["ocean_depth_blocks"],
            "deep_ocean_depth_blocks": merged["oceans"]["deep_ocean_depth_blocks"],
            "terrain_max_y": merged["world"]["terrain_max_y"],
            "terrain_min_y": merged["world"]["terrain_min_y"],
        },
        "measured": {
            "land_ratio": round(float(np.mean(land_fracs)), 4),
            "landmass_width": summarise(widths),
            "landmass_height": summarise(heights),
            "island_diameter": summarise(island_sizes),
            "islands_per_65k_blocks": round(
                float(np.mean(islands_per_seed)) * (65536.0 / span) ** 2, 1
            ),
            "ocean_depth_median": round(float(np.percentile(all_depths, 50)), 1),
            "ocean_depth_p95": round(float(np.percentile(all_depths, 95)), 1),
            "surface_y_min": round(min(mins), 1),
            "surface_y_max": round(max(maxs), 1),
        },
        "derived": notes,
    }


def markdown_row(name: str, report: dict) -> str:
    m, r = report["measured"], report["requested"]
    return (
        f"| `{name}` | {r['land_ratio']:.2f} / **{m['land_ratio']:.2f}** "
        f"| {r['continent_width']} x {r['continent_height']} "
        f"| **{m['landmass_width'].get('mean', 0):.0f} x "
        f"{m['landmass_height'].get('mean', 0):.0f}** (n={m['landmass_width'].get('n', 0)}) "
        f"| {r['island_size']} / **{m['island_diameter'].get('mean', 0):.0f}** "
        f"| **{m['ocean_depth_median']:.0f}** / {m['ocean_depth_p95']:.0f} "
        f"| **{m['surface_y_min']:.0f} .. {m['surface_y_max']:.0f}** |"
    )


MARKDOWN_HEADER = (
    "| preset | land ratio req/meas | continent req | continent measured "
    "| island req/meas | ocean depth med/p95 | surface y range |\n"
    "|---|---|---|---|---|---|---|"
)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=None)
    parser.add_argument("--all-presets", action="store_true")
    parser.add_argument("--seeds", type=int, default=3)
    parser.add_argument("--size", type=int, default=320)
    parser.add_argument("--step", type=int, default=160)
    parser.add_argument("--markdown", action="store_true")
    parser.add_argument("--json-out", default=None)
    args = parser.parse_args(argv)

    seeds = [1234 + 7919 * i for i in range(args.seeds)]
    targets = []
    if args.all_presets:
        folder = os.path.join(REPO_ROOT, "presets")
        for name in sorted(os.listdir(folder)):
            if name.endswith(".json"):
                targets.append((name[:-5], load_config(os.path.join(folder, name))))
    else:
        path = args.config or os.path.join(REPO_ROOT, "pack", "config.json")
        config = load_config(path)
        config.setdefault("mode", "custom")
        targets.append((os.path.basename(path), config))

    reports = {}
    rows = []
    for name, config in targets:
        report = measure(config, seeds, args.size, args.step)
        reports[name] = report
        rows.append(markdown_row(name, report))
        if not args.markdown:
            print(f"=== {name}")
            print(json.dumps(report, indent=2))

    if args.markdown:
        print(MARKDOWN_HEADER)
        for row in rows:
            print(row)
    if args.json_out:
        os.makedirs(os.path.dirname(os.path.abspath(args.json_out)), exist_ok=True)
        with open(args.json_out, "w") as fh:
            json.dump(reports, fh, indent=2)
            fh.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
