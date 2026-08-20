/**
 * Calibration: human units into noise-space numbers.
 *
 * The tables come from tools/mwgbuild/calibration.json, produced by
 * tools/calibrate.py running the noise simulator over real generated packs.
 * Imported directly so the browser and the Python generator can never drift.
 */

import table from "../../../tools/mwgbuild/calibration.json";

type Pair = [number, number];

const DATA = table as unknown as {
  continent_base_wavelength: number;
  island_base_wavelength: number;
  island_lobe_ratio: number;
  continent_lobe_ratio: Pair[];
  land_ratio_table: Pair[];
  anisotropy_taps: number;
  blur_gain: Pair[];
  blur_stretch: Pair[];
  amp_per_percent: number;
  island_type_quantiles: Pair[];
  inland_sea_quantiles: Pair[];
  center_ring_delta: number;
  center_slope_per_1000: number;
};

export const BLOCKS_PER_OFFSET = 128;

function interp(pairs: Pair[], x: number): number {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  if (x <= sorted[0][0]) return sorted[0][1];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [x0, y0] = sorted[i];
    const [x1, y1] = sorted[i + 1];
    if (x >= x0 && x <= x1) return x1 === x0 ? y1 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
  }
  return sorted[sorted.length - 1][1];
}

function invert(pairs: Pair[], y: number): number {
  const sorted = [...pairs].sort((a, b) => a[1] - b[1]);
  if (y <= sorted[0][1]) return sorted[0][0];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [x0, y0] = sorted[i];
    const [x1, y1] = sorted[i + 1];
    if (y >= y0 && y <= y1) return y1 === y0 ? x1 : x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
  }
  return sorted[sorted.length - 1][0];
}

export const continentBaseWavelength = DATA.continent_base_wavelength;
export const anisotropyTaps = DATA.anisotropy_taps;
export const centerRingDelta = DATA.center_ring_delta;

export const continentLobeRatio = (landRatio: number): number => interp(DATA.continent_lobe_ratio, landRatio);

export const continentScaleForSize = (sizeBlocks: number, landRatio: number): number =>
  (DATA.continent_base_wavelength * continentLobeRatio(landRatio)) / sizeBlocks;

export const islandScaleForSize = (sizeBlocks: number): number =>
  (DATA.island_base_wavelength * DATA.island_lobe_ratio) / sizeBlocks;

export function landRatioBounds(): [number, number] {
  const values = DATA.land_ratio_table.map((row) => row[1]);
  return [Math.min(...values), Math.max(...values)];
}

export function oceanOffsetForLandRatio(ratio: number): number {
  const [lo, hi] = landRatioBounds();
  return Number(invert(DATA.land_ratio_table, Math.max(lo, Math.min(hi, ratio))).toFixed(4));
}

export const landRatioForOceanOffset = (offset: number): number =>
  Number(interp(DATA.land_ratio_table, offset).toFixed(4));

export const blurGain = (r: number): number => interp(DATA.blur_gain, Math.max(0, r));
export const maxStretch = (): number => Math.max(...DATA.blur_stretch.map((row) => row[1]));

export function blurForStretch(stretch: number): number {
  const limit = maxStretch();
  return Number(invert(DATA.blur_stretch, Math.max(1, Math.min(limit, stretch))).toFixed(4));
}

export const ampForPercent = (percent: number): number =>
  Number((DATA.amp_per_percent * Math.max(0, percent)).toFixed(8));

export const islandTypeThreshold = (p: number): number =>
  Number(interp(DATA.island_type_quantiles, Math.max(0, Math.min(1, p))).toFixed(4));

/**
 * How far the deep continental interior is lifted above the inland-sea water
 * line, in units of the sea noise (whose standard deviation is 0.294). The
 * builder adds it to the field and inlandSeaBand subtracts it back out, so the
 * requested share is the share of the *deep interior* that floods.
 */
export const INLAND_SEA_INTERIOR_BIAS = 0.3;

/** Share of the deep continental interior an inland-sea frequency floods. */
export const inlandSeaShare = (frequency: number): number =>
  Math.max(0, Math.min(0.9, 0.45 * frequency));

/**
 * Noise values bounding the shore ramp for a given frequency.
 *
 * The threshold has to be a quantile rather than a fixed noise value. The
 * field is not symmetric (median -0.12) and its tails are sparse, so a fixed
 * cut lands on however much of the tail happens to fall inside this seed's
 * continental interior — measured across six seeds that swung the flooded
 * share from 0.1% to 19.6% for one unchanged config. Reading the cut off the
 * measured distribution instead fixes the area and leaves only the placement
 * to the seed.
 *
 * The inner 55% of the sea is at full depth and the rest is the ramp, so the
 * shore is a constant fraction of the water rather than a constant noise
 * delta — otherwise small seas would be all shore.
 */
export function inlandSeaBand(frequency: number): [number, number] {
  const share = inlandSeaShare(frequency);
  if (share <= 0) return [2, 2];
  const at = (p: number): number =>
    Number((interp(DATA.inland_sea_quantiles, p) + INLAND_SEA_INTERIOR_BIAS).toFixed(4));
  const low = at(1 - share);
  return [low, Math.max(at(1 - share * 0.55), low + 0.01)];
}

export const centerThreshold = (radiusBlocks: number): number =>
  Number(((DATA.center_slope_per_1000 * radiusBlocks) / 1000).toFixed(6));
