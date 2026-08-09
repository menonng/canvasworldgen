#!/usr/bin/env python3
"""Measure the generator and write tools/mwgbuild/calibration.json.

Every table the builder uses to turn human units (blocks, ratios, coefficients
of variation) into noise-space numbers is produced here by simulating real
generated packs. Run it after changing the density-function graph:

    python3 tools/calibrate.py --all

Individual stages can be re-run with --steps quantiles,land,lobe,aniso,cv,center
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time

import numpy as np
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mwgbuild import calib  # noqa: E402
from mwgbuild.builder import Builder  # noqa: E402
from mwgnoise.density import Evaluator, PackData  # noqa: E402
from mwgnoise.world import World  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CALIB_PATH = os.path.join(REPO_ROOT, "tools", "mwgbuild", "calibration.json")

GRID = 288
STEP = 176
SEEDS = (1234, 90210)
SEA_LEVEL = 63.0


# --------------------------------------------------------------------- helpers
def load_table() -> dict:
    if os.path.exists(CALIB_PATH):
        with open(CALIB_PATH) as fh:
            return json.load(fh)
    return dict(calib._FALLBACK)


def save_table(table: dict) -> None:
    with open(CALIB_PATH, "w") as fh:
        json.dump(table, fh, indent=2, sort_keys=True)
        fh.write("\n")
    calib.reload()


def build_temp_pack(config: dict) -> str:
    out = tempfile.mkdtemp(prefix="mwgcal-")
    config = dict(config)
    config["mode"] = "custom"
    Builder(config).build(out)
    return out


def surface_of(pack_dir: str, seed: int, grid=GRID, step=STEP) -> np.ndarray:
    world = World(pack_dir, seed=seed)
    span = grid * step
    data = world.sample(-span // 2, -span // 2, grid, step, {"offset": "minecraft:overworld/offset"})
    return data["surface"]


def blob_extents(mask: np.ndarray, step: int, min_cells: int):
    """(width, height) of every blob that does not touch the sampled edge."""
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
            ((slices[0].stop - slices[0].start) * step, (slices[1].stop - slices[1].start) * step)
        )
    return out


REFERENCE_PACK = None


def reference_pack() -> str:
    """A pack built with mode=custom, used for sampling the mwg noises."""
    global REFERENCE_PACK
    if REFERENCE_PACK is None:
        REFERENCE_PACK = build_temp_pack({"center": {"type": "continent"}})
    return REFERENCE_PACK


def continent_noise_grid(seed: int, xz_scale: float, grid: int, step: int, offsets=(0.0,)):
    """Raw mwg:parameter/continentalness samples, optionally shifted along x."""
    pack = PackData([os.path.join(reference_pack(), "data")])
    ev = Evaluator(pack, seed=seed)
    noise = ev.noise("mwg:parameter/continentalness")
    xs = (np.arange(grid) - grid / 2) * step
    X, Z = np.meshgrid(xs, xs, indexing="ij")
    return [noise.value(X * xz_scale + off, 0.0, Z * xz_scale) for off in offsets]


# ------------------------------------------------------------------- stage 1/6
def step_quantiles(table: dict) -> None:
    print("[quantiles] sampling mwg:island/type ...")
    pack = PackData([os.path.join(reference_pack(), "data")])
    values = []
    for seed in (11, 22, 33, 44):
        ev = Evaluator(pack, seed=seed)
        noise = ev.noise("mwg:island/type")
        xs = np.arange(512) * 37.0
        X, Z = np.meshgrid(xs, xs, indexing="ij")
        values.append(noise.value(X * 0.1, 0.0, Z * 0.1).ravel())
    data = np.concatenate(values)
    probs = [i / 40.0 for i in range(41)]
    quantiles = [[round(p, 4), round(float(np.quantile(data, p)), 5)] for p in probs]
    quantiles[0][1] = -2.0
    quantiles[-1][1] = 2.0
    table["island_type_quantiles"] = quantiles
    print(f"  n={data.size} std={data.std():.4f} median={np.median(data):.4f}")


# ------------------------------------------------------------------- stage 2/6
def step_land(table: dict) -> None:
    print("[land] sweeping continents.ocean_offset ...")
    results = []
    for offset in [round(-1.7 + 0.1 * i, 2) for i in range(19)]:
        config = {"continents": {"ocean_offset": offset}}
        pack = build_temp_pack(config)
        try:
            fracs = []
            for seed in SEEDS:
                surface = surface_of(pack, seed)
                fracs.append(float((surface > SEA_LEVEL).mean()))
            ratio = float(np.mean(fracs))
        finally:
            shutil.rmtree(pack, ignore_errors=True)
        if results and ratio <= results[-1][1] + 1e-4:
            print(f"  ocean_offset {offset:6.2f} -> land {ratio:.4f} (saturated, stopping)")
            break
        results.append([offset, round(ratio, 5)])
        print(f"  ocean_offset {offset:6.2f} -> land {ratio:.4f}")
        if ratio > 0.95:
            break
    table["land_ratio_table"] = results


# ------------------------------------------------------------------- stage 3/6
def step_lobe(table: dict) -> None:
    print("[lobe] measuring landmass extent per land ratio ...")
    reference = 6000.0
    rows = []
    lobe_seeds = SEEDS + (4242, 31337)
    for land_ratio in (0.12, 0.20, 0.32, 0.45, 0.60):
        used = calib.continent_lobe_ratio(land_ratio)
        config = {
            "continents": {
                "land_ratio": land_ratio,
                "width": reference,
                "height": reference,
                "width_variation_percent": 0,
                "height_variation_percent": 0,
            },
            "islands": {"enabled": False},
        }
        pack = build_temp_pack(config)
        try:
            extents = []
            for seed in lobe_seeds:
                surface = surface_of(pack, seed)
                mask = surface > SEA_LEVEL
                # only blobs at least a third of the target size count as land masses
                min_cells = int(((reference / 3.0) / STEP) ** 2 * 0.6)
                extents += blob_extents(mask, STEP, min_cells)
        finally:
            shutil.rmtree(pack, ignore_errors=True)
        if not extents:
            print(f"  land_ratio {land_ratio}: no isolated landmasses, skipped")
            continue
        sizes = np.array([(w + h) / 2.0 for w, h in extents], dtype=np.float64)
        measured = float(sizes.mean())
        true_lobe = used * measured / reference
        rows.append([land_ratio, round(true_lobe, 5)])
        print(
            f"  land_ratio {land_ratio:.2f}: n={len(sizes)} measured={measured:7.0f} "
            f"lobe {used:.4f} -> {true_lobe:.4f}"
        )
    if rows:
        table["continent_lobe_ratio"] = rows


# ------------------------------------------------------------------- stage 4/6
def step_aniso(table: dict) -> None:
    print("[aniso] measuring directional blur ...")
    wavelength = table.get("continent_base_wavelength", 1024.0)
    taps = int(table.get("anisotropy_taps", 7))
    xz_scale = 0.12  # base wavelength / 0.12 = 8533 blocks, dozens of lobes in view
    grid, step = 512, 96
    r_values = [0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0]
    seeds = (5150, 8675309)

    baseline = {}
    for seed in seeds:
        base = continent_noise_grid(seed, xz_scale, grid, step, (0.0,))[0]
        baseline[seed] = base

    base_std = float(np.mean([baseline[s].std() for s in seeds]))
    # keep the land threshold fixed across every r so the extents are comparable
    threshold = float(np.mean([np.quantile(np.abs(baseline[s]), 0.62) for s in seeds]))

    gains, stretches = [], []
    for r in r_values:
        if r == 0.0:
            offsets = (0.0,)
        else:
            # the pack shifts by world_offset * xz_scale, and the total blur is
            # r wavelengths wide
            offsets = tuple(
                (i - (taps - 1) / 2.0) * (r * wavelength / (taps - 1)) for i in range(taps)
            )
        stds, ratios = [], []
        for seed in seeds:
            field = np.mean(continent_noise_grid(seed, xz_scale, grid, step, offsets), axis=0)
            stds.append(float(field.std()))
            gain = base_std / float(field.std())
            mask = np.abs(field * gain) > threshold
            extents = blob_extents(mask, step, min_cells=20)
            if extents:
                ratios.append(
                    float(np.mean([w for w, _ in extents]) / np.mean([h for _, h in extents]))
                )
        gain = base_std / float(np.mean(stds))
        stretch = float(np.mean(ratios)) if ratios else 1.0
        gains.append([round(r, 3), round(gain, 5)])
        stretches.append([round(r, 3), round(stretch, 5)])
        print(f"  r={r:4.2f}  gain={gain:6.4f}  x/z extent ratio={stretch:6.4f}")

    # r=0 is the isotropic control; anything it measures other than 1.0 is
    # sampling bias, so every ratio is expressed relative to it.
    control = stretches[0][1] or 1.0
    normalised = [[r, round(value / control, 5)] for r, value in stretches]
    # Past roughly one wavelength the average starts cancelling opposite-phase
    # lobes instead of lengthening them, so the usable table stops at the peak.
    peak = max(range(len(normalised)), key=lambda i: normalised[i][1])
    table["blur_gain"] = gains[: peak + 1]
    table["blur_stretch"] = normalised[: peak + 1]
    print(f"  max usable stretch {normalised[peak][1]:.3f} at r={normalised[peak][0]}")


# ------------------------------------------------------------------- stage 5/6
def step_cv(table: dict) -> None:
    """Coastline sensitivity: how far the shore moves per unit of added bias."""
    print("[coast] measuring coastline gradient ...")
    pack = build_temp_pack(
        {
            "continents": {
                "land_ratio": 0.32,
                "width": 6000,
                "height": 6000,
                "width_variation_percent": 0,
                "height_variation_percent": 0,
            },
            "islands": {"enabled": False},
        }
    )
    scale = Builder(
        dict(
            {
                "mode": "custom",
                "continents": {"land_ratio": 0.32, "width": 6000, "height": 6000},
            }
        )
    ).continent_scale
    try:
        gradients = []
        step = 32  # fine enough to differentiate the field cleanly
        grid = 512
        for seed in SEEDS + (4242,):
            world = World(pack, seed=seed)
            span = grid * step
            field = world.field("mwg:noise/raw_continents", -span // 2, -span // 2, grid, step)
            gx, gz = np.gradient(field, step)
            magnitude = np.hypot(gx, gz)
            # only the cells actually on the shoreline matter
            shore = (field > -0.24) & (field < -0.10)
            if shore.any():
                gradients.append(float(np.median(magnitude[shore])))
        gradient = float(np.mean(gradients))
    finally:
        shutil.rmtree(pack, ignore_errors=True)

    # |grad| scales linearly with the horizontal noise scale, so normalise it
    per_unit_scale = gradient / scale
    lobe = calib.continent_lobe_ratio(0.32)
    wavelength = table.get("continent_base_wavelength", 1024.0)
    # amp needed so each shore moves (percent/100 * size / 2) blocks:
    #   displacement = amp / |grad| ,  |grad| = per_unit_scale * scale
    #   scale = wavelength * lobe / size   =>  the size cancels out
    amp_per_percent = per_unit_scale * wavelength * lobe / 200.0
    table["coast_gradient_per_unit_scale"] = round(per_unit_scale, 8)
    table["amp_per_percent"] = round(amp_per_percent, 8)
    print(
        f"  |grad raw_continents| = {gradient:.6f} /block at xz_scale {scale:.5f}\n"
        f"  -> {per_unit_scale:.5f} per block per unit scale\n"
        f"  -> bias amplitude {amp_per_percent:.5f} per 1% of coastline variation"
    )


# ------------------------------------------------------------------- stage 6/6
def step_center(table: dict) -> None:
    print("[center] measuring the origin locator ...")
    pack = PackData([os.path.join(reference_pack(), "data")])
    delta = float(table.get("center_ring_delta", 0.02))
    radii = np.array([250, 500, 1000, 2000, 4000, 8000, 16000], dtype=np.float64)
    per_radius = {r: [] for r in radii}
    for seed in (7, 77, 777, 7777):
        ev = Evaluator(pack, seed=seed)
        noises = []
        for i in range(1, 5):
            try:
                noises.append((0.75 + 0.05 * i, ev.noise(f"mwg:center/ring{i}")))
            except KeyError:
                print("  centre rings are not in the current pack; build with a non-default"
                      " center.type first")
                return
        angles = np.linspace(0.0, 2.0 * np.pi, 64, endpoint=False)
        for radius in radii:
            x = radius * np.cos(angles)
            z = radius * np.sin(angles)
            total = np.zeros_like(x)
            for base, noise in noises:
                a = noise.value(x * base, 0.0, z * base)
                b = noise.value(x * base * (1.0 - delta), 0.0, z * base * (1.0 - delta))
                total += np.abs(a - b)
            per_radius[radius].append(float(np.mean(total * 0.25)))
    slopes = []
    for radius in radii:
        mean = float(np.mean(per_radius[radius]))
        slopes.append(mean / radius * 1000.0)
        print(f"  r={radius:6.0f} mean|delta|={mean:.5f}  per 1000 blocks {slopes[-1]:.5f}")
    # use the small-to-mid radii where the response is still linear
    table["center_slope_per_1000"] = round(float(np.mean(slopes[:5])), 6)


STEPS = {
    "quantiles": step_quantiles,
    "land": step_land,
    "lobe": step_lobe,
    "aniso": step_aniso,
    "cv": step_cv,
    "center": step_center,
}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--steps", default="")
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args(argv)

    names = list(STEPS) if args.all or not args.steps else args.steps.split(",")
    table = load_table()
    for name in names:
        if name not in STEPS:
            print(f"unknown step: {name}", file=sys.stderr)
            return 2
        started = time.time()
        STEPS[name](table)
        save_table(table)
        print(f"  ({name} took {time.time() - started:.0f}s)\n")
    print(f"wrote {CALIB_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
