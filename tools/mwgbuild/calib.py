"""Calibration: translating human units into noise-space numbers.

The tables live in ``calibration.json`` next to this file and are produced by
``tools/calibrate.py``, which runs the noise simulator in ``tools/mwgnoise``
over real generated packs. ``docs/CALIBRATION.md`` records the measurements.

Only the standard library is used here so ``apply_config.py`` stays dependency
free.
"""

from __future__ import annotations

import json
import os

_DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "calibration.json")

_FALLBACK = {
    "continent_base_wavelength": 1024.0,
    "island_base_wavelength": 256.0,
    "continent_lobe_ratio": [[0.32, 0.404]],
    "island_lobe_ratio": 0.392,
    "land_ratio_table": [[-1.30, 0.0], [0.0, 0.93]],
    "anisotropy_taps": 7,
    "blur_gain": [[0.0, 1.0]],
    "blur_stretch": [[0.0, 1.0]],
    "amp_per_percent": 0.004,
    "coast_gradient_per_unit_scale": 1.0,
    "island_type_quantiles": [[0.0, -1.0], [1.0, 1.0]],
    "inland_sea_quantiles": [[0.0, -1.0], [1.0, 1.0]],
    "cell_cut_2": [[0.02, 0.00441], [0.34, 0.09304]],
    "cell_width_2": [[0.02, 7.95], [0.34, 40.8]],
    "cell_cut_3": [[0.02, 0.0193], [0.34, 0.16787]],
    "cell_width_3": [[0.02, 10.35], [0.34, 35.55]],
    "center_ring_delta": 0.02,
    "center_slope_per_1000": 0.0575,
}


def _load() -> dict:
    if os.path.exists(_DATA_PATH):
        with open(_DATA_PATH) as fh:
            data = json.load(fh)
        merged = dict(_FALLBACK)
        merged.update(data)
        return merged
    return dict(_FALLBACK)


DATA = _load()


def reload() -> None:
    global DATA
    DATA = _load()


# --------------------------------------------------------------------- height
# depth = y_clamped_gradient(-64, 320, 1.5, -1.5) + offset, so the gradient
# loses exactly 3.0 / 384 = 1/128 per block: one unit of offset is 128 blocks.
BLOCKS_PER_OFFSET = 128.0


def offset_for_y(y: float) -> float:
    """Terrain offset that places the surface at world height ``y``."""
    return (float(y) + 64.0) / BLOCKS_PER_OFFSET - 1.5


def y_for_offset(offset: float) -> float:
    return (float(offset) + 1.5) * BLOCKS_PER_OFFSET - 64.0


# ------------------------------------------------------------------ utilities
def _interp(table, x, index_in=0, index_out=1):
    """Piecewise-linear lookup over a sorted list of pairs, clamped at the ends."""
    pairs = sorted(((row[index_in], row[index_out]) for row in table), key=lambda r: r[0])
    if x <= pairs[0][0]:
        return pairs[0][1]
    for (x0, y0), (x1, y1) in zip(pairs, pairs[1:]):
        if x0 <= x <= x1:
            if x1 == x0:
                return y1
            return y0 + (x - x0) * (y1 - y0) / (x1 - x0)
    return pairs[-1][1]


def _invert(table, y):
    """Same as _interp but solving for x given y; the table must be monotonic."""
    pairs = sorted(((row[0], row[1]) for row in table), key=lambda r: r[1])
    if y <= pairs[0][1]:
        return pairs[0][0]
    for (x0, y0), (x1, y1) in zip(pairs, pairs[1:]):
        if y0 <= y <= y1:
            if y1 == y0:
                return x1
            return x0 + (y - y0) * (x1 - x0) / (y1 - y0)
    return pairs[-1][0]


# ------------------------------------------------------------------ continents
def continent_lobe_ratio(land_ratio: float) -> float:
    """Landmass extent as a fraction of the continent noise wavelength.

    Depends on how much land there is: with more land the lobes above the sea
    threshold are wider and neighbouring ones start to merge.
    """
    return _interp(DATA["continent_lobe_ratio"], float(land_ratio))


def continent_scale_for_size(size_blocks: float, land_ratio: float) -> float:
    """xz_scale that yields landmasses ``size_blocks`` across on average."""
    wavelength = DATA["continent_base_wavelength"]
    return wavelength * continent_lobe_ratio(land_ratio) / float(size_blocks)


def island_scale_for_size(size_blocks: float) -> float:
    return DATA["island_base_wavelength"] * DATA["island_lobe_ratio"] / float(size_blocks)


# ------------------------------------------------------------------- land area
def ocean_offset_for_land_ratio(ratio: float) -> float:
    table = DATA["land_ratio_table"]
    lo = min(row[1] for row in table)
    hi = max(row[1] for row in table)
    return round(_invert(table, max(lo, min(hi, float(ratio)))), 4)


def land_ratio_bounds() -> tuple[float, float]:
    """Lowest and highest land ratio the ocean-offset table can reach."""
    values = [row[1] for row in DATA["land_ratio_table"]]
    return min(values), max(values)


def land_ratio_for_ocean_offset(offset: float) -> float:
    return round(_interp(DATA["land_ratio_table"], float(offset)), 4)


# ------------------------------------------------------------------ anisotropy
def anisotropy_taps() -> int:
    return int(DATA["anisotropy_taps"])


def blur_gain(r: float) -> float:
    """std(unblurred) / std(blurred) for an r-wavelength blur along one axis."""
    return _interp(DATA["blur_gain"], max(0.0, float(r)))


def stretch_for_blur(r: float) -> float:
    return _interp(DATA["blur_stretch"], max(0.0, float(r)))


def blur_for_stretch(stretch: float) -> float:
    table = DATA["blur_stretch"]
    max_stretch = max(row[1] for row in table)
    return round(_invert(table, max(1.0, min(max_stretch, float(stretch)))), 4)


def max_stretch() -> float:
    return max(row[1] for row in DATA["blur_stretch"])


# --------------------------------------------------------------------- spread
def amp_for_percent(percent: float) -> float:
    """Bias amplitude that makes each shoreline wander by ``percent`` of the
    configured landmass size.

    The amplitude works out independent of the configured size: a bigger
    continent uses a proportionally flatter noise, and the two cancel.
    """
    return round(DATA["amp_per_percent"] * max(0.0, float(percent)), 8)


def coastline_shift_blocks(percent: float, size_blocks: float) -> float:
    """The measurement above, expressed back in blocks, for reporting."""
    return round(float(percent) / 100.0 * float(size_blocks) / 2.0, 1)


# ------------------------------------------------------------------- quantiles
def island_type_threshold(cumulative_probability: float) -> float:
    p = max(0.0, min(1.0, float(cumulative_probability)))
    return round(_interp(DATA["island_type_quantiles"], p), 4)


#: How far the deep continental interior is lifted above the inland-sea water
#: line, in units of the sea noise (whose standard deviation is 0.294). The
#: builder adds it to the field and the thresholds below subtract it back out,
#: so the requested share is the share of the *deep interior* that floods.
INLAND_SEA_INTERIOR_BIAS = 0.30


#: Coverage past which neighbouring cells percolate into each other and stop
#: being separate landforms; the measured widths turn non-monotonic above it.
MAX_CELL_COVERAGE = 0.35


def cell_cut(crossings: int, coverage: float) -> float:
    """The r2 contour that covers this share of the ground."""
    coverage = max(0.005, min(MAX_CELL_COVERAGE, float(coverage)))
    return round(_interp(DATA[f"cell_cut_{crossings}"], coverage), 6)


def cell_scale(crossings: int, coverage: float, width_blocks: float) -> float:
    """xz_scale that makes a cell at that contour this many blocks wide.

    Cell width scales as 1/xz_scale, so the calibration stores the product and
    this divides it out.
    """
    coverage = max(0.005, min(MAX_CELL_COVERAGE, float(coverage)))
    unit = _interp(DATA[f"cell_width_{crossings}"], coverage)
    return round(unit / max(float(width_blocks), 1.0), 8)


def inland_sea_share(frequency: float) -> float:
    """Share of the deep continental interior an inland-sea frequency floods."""
    return max(0.0, min(0.9, 0.45 * float(frequency)))


def inland_sea_band(frequency: float) -> tuple[float, float]:
    """Noise values bounding the shore ramp for a given frequency.

    The threshold has to be a quantile rather than a fixed noise value. The
    field is not symmetric (median -0.12) and its tails are sparse, so a fixed
    cut lands on however much of the tail happens to fall inside this seed's
    continental interior - measured across six seeds that swung the flooded
    share from 0.1% to 19.6% for one unchanged config. Reading the cut off the
    measured distribution instead fixes the area and leaves only the placement
    to the seed.

    The inner 55% of the sea is at full depth and the rest is the ramp, so the
    shore is a constant fraction of the water rather than a constant noise
    delta - otherwise small seas would be all shore.
    """
    share = inland_sea_share(frequency)
    if share <= 0.0:
        return 2.0, 2.0
    table = DATA["inland_sea_quantiles"]
    bias = INLAND_SEA_INTERIOR_BIAS
    low = round(_interp(table, 1.0 - share) + bias, 4)
    high = round(_interp(table, 1.0 - share * 0.55) + bias, 4)
    return low, max(high, low + 0.01)


# ------------------------------------------------------------- centre of world
def center_ring_delta() -> float:
    return float(DATA["center_ring_delta"])


def center_threshold(radius_blocks: float) -> float:
    return round(DATA["center_slope_per_1000"] * float(radius_blocks) / 1000.0, 6)
