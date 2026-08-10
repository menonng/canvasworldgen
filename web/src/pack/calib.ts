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

export const centerThreshold = (radiusBlocks: number): number =>
  Number(((DATA.center_slope_per_1000 * radiusBlocks) / 1000).toFixed(6));
