# Calibration / 캘리브레이션

Every number in `tools/mwgbuild/calibration.json` was **measured**, not guessed.
`tools/calibrate.py` builds real data packs, runs them through the noise
simulator in `tools/mwgnoise` (a re-implementation of Minecraft's
Xoroshiro128++ random source, `ImprovedNoise` / `PerlinNoise` / `NormalNoise`
and the density-function evaluator), and fits the tables the generator uses to
turn human units into noise-space numbers.

`tools/mwgbuild/calibration.json`의 모든 수치는 추정이 아니라 **실측값**입니다.
`tools/calibrate.py`가 실제 데이터팩을 생성하고, 마인크래프트의 노이즈 알고리즘을
그대로 구현한 시뮬레이터로 지형을 계산해 표를 만듭니다.

Reproduce everything with:

```bash
python3 tools/calibrate.py --all
```

Raw logs of the runs behind the shipped table: `docs/calibration-run*.log`.

---

## 1. Height ↔ offset — exact, not measured

Vanilla's `minecraft:overworld/depth` is

```
y_clamped_gradient(min_y = -64, max_y = 320, from = 1.5, to = -1.5) + offset
```

The gradient loses `3.0 / 384 = 1/128` per block, so **one unit of terrain
offset is exactly 128 blocks of elevation**, and the surface sits at

```
y = min_y + height/2 + 128 · offset
```

Checks out against vanilla: `-64 + 192 + 128 · (-0.50375) = 63.5`, i.e. sea
level. The generator uses this identity to convert every block-valued setting
(`ocean_depth_blocks`, `terrain_max_y`, `river depth`, the 3-block treads of
columnar jointing) into offset units, and it keeps working when
`build_height` changes because `height/2` moves with it.

## 2. Continent size ↔ noise scale

`mwg:parameter/continentalness` has `firstOctave -10`, so its dominant octave
has a wavelength of **1024 blocks at `xz_scale` 1.0**. A landmass is one lobe
of `|noise|` above the sea threshold, which measures `lobe_ratio` of that
wavelength across.

`lobe_ratio` is not a constant — with more land the lobes are wider and start
merging:

| land ratio | measured lobe ratio |
|---|---|
| 0.12 | 0.274 |
| 0.20 | 0.399 |
| 0.32 | 0.428 |
| 0.45 | 0.463 |
| 0.60 | 0.753 |

`xz_scale = 1024 · lobe_ratio(land_ratio) / size_blocks`

Fixed-point iteration: build at the current estimate, measure the mean
bounding-box extent of every landmass that does not touch the sampled edge,
and update `lobe' = lobe · measured / requested`. Three iterations, 2–4 seeds,
a 50 000-block square each. Run-to-run spread is about ±10%.

Above land ratio ≈ 0.5 landmasses merge into one another and "continent size"
stops being a well-defined quantity; the table is extrapolated beyond 0.60.

## 3. Land ratio ↔ ocean offset

`ocean_offset` is swept in 0.1 steps and the fraction of the sampled square
above sea level recorded, 2 seeds each:

| ocean_offset | land | ocean_offset | land |
|---|---|---|---|
| −1.7 | 0.150 | −0.8 | 0.474 |
| −1.5 | 0.166 | −0.7 | 0.540 |
| −1.3 | 0.201 | −0.6 | 0.599 |
| −1.2 | 0.232 | −0.5 | 0.655 |
| −1.1 | 0.281 | −0.4 | 0.718 |
| −1.0 | 0.340 | −0.3 | 0.795 |
| −0.9 | 0.405 | −0.2 | 0.873 |
|  |  | −0.1 | 0.921 |

Two things this table encodes, both worth knowing:

* **It saturates near 0.15 at the bottom.** Below that, the whole map is deep
  ocean and the remaining land is *islands*, whose coverage is set by
  `islands.frequency`, not by `land_ratio`. To go below 15% land, lower
  `islands.frequency` as well.
* **It was measured at the default `width_variation_percent` of 30.** Setting
  variation to 0 lowers the achieved land ratio by roughly 0.04, because the
  bias field is added before a convex threshold.

## 4. Anisotropy — and why it stops at 1:1.81

Minecraft density functions cannot read the world x/z coordinate, so a data
pack cannot sample the continent noise at `(x/r, z)`. What it *can* do is
average several samples displaced along one axis, using a constant `shift_x`
inside `shifted_noise` — a constant shift translates the sample point, and 7
taps spread over `r` wavelengths low-pass filter the field along that axis,
which lengthens features along it.

Measured over two seeds, 512 × 512 samples, `xz_scale` 0.12:

| blur width r (wavelengths) | std gain | x/z extent ratio |
|---|---|---|
| 0.00 | 1.000 | 1.000 (control) |
| 0.25 | 1.057 | 1.273 |
| 0.50 | 1.148 | 1.480 |
| 0.75 | 1.270 | 1.668 |
| **1.00** | **1.414** | **1.807** |
| 1.50 | 1.722 | 1.462 |
| 2.00 | 1.993 | 1.343 |
| 3.00 | 2.439 | 1.230 |

Past roughly one wavelength the average starts cancelling opposite-phase lobes
instead of lengthening them, and the ratio falls again. **1.807 is therefore a
hard ceiling for `width : height`**, and the config validator rejects anything
beyond it rather than silently producing a round world.

`std gain` is applied as a multiplier so the blurred field keeps the same
standard deviation as the unblurred one; without it the land ratio would drift
whenever the ratio changed.

## 5. Coastline variation ↔ bias amplitude

`width_variation_percent` adds a slowly varying bias to the continent field
before the sea threshold. A bias of `A` moves the shoreline by `A / |∇C|`
blocks, so the amplitude needed for a given percentage follows from the
gradient of the continent field at the shore.

Measured over three seeds at 32-block resolution, taking the median gradient
magnitude of `mwg:noise/raw_continents` on cells with the field between −0.24
and −0.10:

```
|∇C| = 3.23e-4 per block at xz_scale 0.0739
     = 4.370e-3 per block per unit of xz_scale
```

Because `xz_scale = 1024 · lobe / size`, the size cancels out and the amplitude
per percent is a single constant:

```
amp_per_percent = 4.370e-3 · 1024 · 0.4285 / 200 = 9.686e-3
```

So `width_variation_percent: 30` shifts each shore by 15% of the configured
width, in both directions.

## 6. Centre of the world

A data pack cannot ask how far a column is from (0, 0) either. The trick,
borrowed from Stardust Labs' *Continents*, is to sample the same noise at two
almost identical scales: `n(s·p) − n(s(1−δ)·p)`. At the origin both samples
land on the same point and the difference is zero; the further out, the more
the two samples decorrelate. Four rings at different octaves are averaged to
smooth the result.

Measured over four seeds, 64 angles per radius, δ = 0.02:

| radius | mean &#124;Δ&#124; | per 1000 blocks |
|---|---|---|
| 250 | 0.00072 | 0.00288 |
| 500 | 0.00134 | 0.00268 |
| 1000 | 0.00241 | 0.00241 |
| 2000 | 0.00543 | 0.00272 |
| 4000 | 0.00884 | 0.00221 |
| 8000 | 0.01801 | 0.00225 |
| 16000 | 0.03739 | 0.00234 |

Linear to within ±15% over the whole range, giving
`threshold = 0.002578 · radius / 1000`. Because the response is a mean over a
random field rather than a true distance, the forced region has a soft, ragged
edge — the radius is accurate to roughly ±30% on any given bearing.

## 7. Island archetype quantiles

`mwg:island/type` (`firstOctave -9`, amplitudes `[1, 1]`) is sampled a million
times and its empirical CDF stored at 2.5% steps, so `atoll_chance: 0.18`
really does hand 18% of the noise's range to atolls. Measured σ = 0.324,
median 0.012.

## 8. What is *not* calibrated

* The 3-D base noise (`minecraft:overworld/base_3d_noise`) is left vanilla and
  is not simulated. It adds a zero-mean wobble of a few blocks to every column.
  Statistics over an area are unaffected; a single column is not.
* Cave scaling shifts noise octaves; the resulting cave volume is not measured.
* Structure spacing is a direct multiplier on vanilla's numbers, nothing to
  measure.
