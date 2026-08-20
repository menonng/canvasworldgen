"""Builds the MineWorldGen data pack from a config file.

Design in one paragraph: the pack is vanilla Minecraft 26.2 worldgen data plus
a patch. At ``mode: "vanilla"`` no world generation file is written at all, so
terrain is bit-for-bit vanilla. At ``mode: "custom"`` the generator loads the
vanilla files from ``tools/vanilla``, rewrites the six density functions that
shape the Overworld (continents, erosion, ridges, offset, factor, jaggedness)
plus the climate router, and writes the result into the pack. Biome placement
still runs through vanilla's multi-noise source, so only vanilla biomes and
vanilla blocks can ever appear.
"""

from __future__ import annotations

import json
import math
import os
import shutil

from . import calib, vanilla
from .config import VANILLA_CONTINENT_SIZE, normalise
from .dsl import (
    abs_,
    add,
    add_all,
    cache2d,
    clamp,
    flat,
    mn,
    mul,
    mx,
    nested,
    noise,
    pt,
    range_choice,
    shifted_noise,
    spline,
    square,
    sub,
)

NS = "mwg"
BLOCKS = calib.BLOCKS_PER_OFFSET


def cfg_ref(name: str) -> str:
    return f"{NS}:config/{name}"


def scaled(const_name: str, value: float):
    """``value * <config constant>``, expressed as a one-point spline."""
    return nested(cfg_ref(const_name), [pt(0.0, 0.0, value)])


def read_const(const_name: str):
    """The config constant itself, usable as a spline value."""
    return nested(cfg_ref(const_name), [pt(0.0, 0.0, 1.0)])


class Builder:
    def __init__(self, config: dict):
        self.cfg, self.adjustments = normalise(config)
        self.mode = self.cfg["mode"]
        self.density: dict[str, object] = {}
        self.noises: dict[str, dict] = {}
        self.mc_files: dict[str, object] = {}
        # configured/placed features, by registry; only the plateau stamping
        # uses these, and only when tepui is turned on
        self.features: dict[str, dict[str, object]] = {
            "configured_feature": {},
            "placed_feature": {},
        }
        self.functions: dict[str, str] = {}
        self.notes: dict[str, object] = {}
        if self.mode == "custom":
            self._derive()

    # ------------------------------------------------------------------ setup
    def _derive(self) -> None:
        cfg = self.cfg
        world = cfg["world"]
        cont = cfg["continents"]
        isl = cfg["islands"]

        self.sea_level = float(world["sea_level"])
        self.build_min_y = int(world["build_min_y"])
        self.build_height = int(world["build_height"])
        self.build_max_y = self.build_min_y + self.build_height

        # depth = y_clamped_gradient(build_min_y, build_max_y, +H/256, -H/256)
        # + offset, which loses exactly 1/128 per block whatever the world
        # height is, so one unit of offset is always 128 blocks.
        self.depth_top = self.build_height / 256.0
        self.base_offset = -(self.depth_top - (self.sea_level - self.build_min_y) / BLOCKS)
        self.max_offset = (float(world["terrain_max_y"]) - self.sea_level) / BLOCKS
        self.min_offset = (float(world["terrain_min_y"]) - self.sea_level) / BLOCKS

        # --- continent horizontal scale + anisotropy ------------------------
        width = float(cont["width"])
        height = float(cont["height"])
        short, long_ = min(width, height), max(width, height)
        if cont.get("ocean_offset") is None:
            probe_land = float(cont["land_ratio"])
        else:
            probe_land = calib.land_ratio_for_ocean_offset(float(cont["ocean_offset"]))
        self.continent_scale = calib.continent_scale_for_size(short, probe_land)
        self.stretch = long_ / short
        self.blur_r = calib.blur_for_stretch(self.stretch)
        self.blur_axis = "x" if width >= height else "z"
        self.blur_gain = calib.blur_gain(self.blur_r)
        self.blur_width = (
            self.blur_r * calib.DATA["continent_base_wavelength"] / self.continent_scale
        )
        self.mean_size = math.sqrt(width * height)
        self.size_factor = self.mean_size / VANILLA_CONTINENT_SIZE

        if cont.get("ocean_offset") is None:
            self.ocean_offset = calib.ocean_offset_for_land_ratio(cont["land_ratio"])
        else:
            self.ocean_offset = float(cont["ocean_offset"])

        self.width_amp = calib.amp_for_percent(cont["width_variation_percent"])
        self.height_amp = calib.amp_for_percent(cont["height_variation_percent"])

        # --- islands ----------------------------------------------------------
        self.island_scale = calib.island_scale_for_size(float(isl["size"]))
        self.island_cluster_scale = self.island_scale * 0.32
        self.island_arc_scale = self.island_scale * 0.22
        self.island_type_scale = self.island_scale * 0.45

        atoll = float(isl["atoll_chance"])
        volcanic = float(isl["volcanic_chance"])
        cliff = float(isl["cliff_chance"])
        total = atoll + volcanic + cliff
        if total > 0.95:
            k = 0.95 / total
            atoll, volcanic, cliff = atoll * k, volcanic * k, cliff * k
        self.island_bands = []
        cursor = 0.0
        for name, share in (("atoll", atoll), ("volcano", volcanic), ("cliff", cliff)):
            if share > 0.0:
                lo = calib.island_type_threshold(cursor)
                cursor += share
                self.island_bands.append((name, lo, calib.island_type_threshold(cursor)))

        # --- centre of the world ------------------------------------------------
        self.center_type = str(cfg["center"]["type"]).lower()
        self.center_radius = float(cfg["center"]["radius"])
        self.center_threshold = calib.center_threshold(self.center_radius)

        # --- proportional scaling -------------------------------------------------
        biomes = cfg["biomes"]
        self.climate_factor = float(biomes["temperature_scale"])
        self.veg_factor = float(biomes["vegetation_scale"])
        if biomes["scale_with_continents"]:
            self.climate_factor *= self.size_factor
            self.veg_factor *= self.size_factor

        self.cave_factor = float(cfg["caves"]["size_multiplier"])
        if cfg["caves"]["scale_with_continents"]:
            # caves grow with the world but far more gently than the coastline
            self.cave_factor *= min(2.5, max(0.5, self.size_factor**0.35))

        self.structure_factor = float(cfg["structures"]["spacing_multiplier"])
        if cfg["structures"]["scale_with_continents"]:
            self.structure_factor *= min(6.0, max(0.4, self.size_factor**0.5))

        self.notes = {
            "minecraft_version": vanilla.MINECRAFT_VERSION,
            "sea_level": self.sea_level,
            "build_range": [self.build_min_y, self.build_max_y],
            "base_offset": round(self.base_offset, 6),
            "max_offset": round(self.max_offset, 6),
            "min_offset": round(self.min_offset, 6),
            "continent_xz_scale": round(self.continent_scale, 6),
            "continent_stretch": round(self.stretch, 4),
            "anisotropy_blur_blocks": round(self.blur_width, 1),
            "anisotropy_gain": round(self.blur_gain, 5),
            "ocean_offset": round(self.ocean_offset, 4),
            "predicted_land_ratio": calib.land_ratio_for_ocean_offset(self.ocean_offset),
            "island_xz_scale": round(self.island_scale, 6),
            "island_bands": self.island_bands,
            "center_threshold": self.center_threshold,
            "climate_scale_factor": round(self.climate_factor, 4),
            "cave_scale_factor": round(self.cave_factor, 4),
            "structure_spacing_factor": round(self.structure_factor, 4),
        }

    # -------------------------------------------------------------- utilities
    def df(self, name: str, value) -> str:
        self.density[name] = value
        return f"{NS}:{name}"

    def noise_def(self, name: str, first_octave: int, amplitudes: list[float]) -> str:
        self.noises[name] = {"firstOctave": first_octave, "amplitudes": amplitudes}
        return f"{NS}:{name}"

    def constant(self, name: str, value) -> str:
        self.density[f"config/{name}"] = {
            "type": "minecraft:constant",
            "argument": round(float(value), 8),
        }
        return cfg_ref(name)

    def _blur(self, make_sample, axis: str, width_blocks: float, taps: int, scale: float):
        if taps <= 1 or width_blocks <= 0.0:
            return make_sample(0.0, 0.0)
        spacing = width_blocks / (taps - 1)
        total = 0
        for i in range(taps):
            shift = (i - (taps - 1) / 2.0) * spacing * scale
            total = add(total, make_sample(shift, 0.0) if axis == "x" else make_sample(0.0, shift))
        return mul(round(1.0 / taps, 8), total)

    # Measured on mwg cell noises at firstOctave -6 (see docs/CALIBRATION.md):
    # at xz_scale 0.15 the field puts 3.3 cell centres in a square kilometre,
    # so the mean spacing is 550 blocks, and a contour at r2 = c is
    # 82.7 * sqrt(c) / xz_scale blocks wide. Both follow from plain scaling, so
    # one measurement fixes the constants for every size.
    CELL_SPACING_AT_UNIT_SCALE = 82.5
    CELL_WIDTH_AT_UNIT_SCALE = 82.7

    def radial_cells(self, name: str, width_blocks: float, coverage: float) -> tuple[str, float]:
        """A squared-distance-from-cell-centre field, and the contour to cut it at.

        Three independent single-octave noises, squared and summed. Each one's
        zero set is a curve; the sum only approaches zero where all three do,
        which happens at isolated points, and it grows as a positive quadratic
        form around each - so its low contours are compact blobs. That is the
        difference between a landform and a noise wobble: a spline over this
        field gives every cone, tower and stack the same profile in the same
        place, where a spline over an ordinary fractal noise just follows that
        noise's ragged contour bands.

        Two noises would do the same but come out badly stretched (measured
        median roundness 0.36, a 3:1 ellipse); three brings it to 0.53 and a
        fourth adds almost nothing, so three it is.

        The contour is returned rather than chosen by the caller because it is
        fixed by the geometry: a cell of width W spaced S apart needs the cut
        at (W/S)^2, which is exactly the share of the ground the cells cover.
        """
        coverage = max(1.0e-4, min(0.9, float(coverage)))
        spacing = max(float(width_blocks), 1.0) / math.sqrt(coverage)
        scale = self.CELL_SPACING_AT_UNIT_SCALE / spacing
        parts = []
        for index in range(3):
            noise_name = f"cell/{name}_{index}"
            self.noise_def(noise_name, -6, [1.0])
            parts.append(
                square(noise(f"{NS}:{noise_name}", xz_scale=round(scale, 8), y_scale=0.0))
            )
        ident = self.df(f"cell/{name}", flat(cache2d(add_all(*parts))))
        return ident, coverage

    def _by_island_type(self, overrides: dict, default):
        """Spline over the island-type noise, one profile per archetype band."""
        if not self.island_bands:
            return default
        points = [pt(-1.4, overrides.get(self.island_bands[0][0], default), 0.0)]
        for name, lo, hi in self.island_bands:
            value = overrides.get(name, default)
            points.append(pt(lo, value, 0.0))
            points.append(pt(hi - 2.0e-3, value, 0.0))
            points.append(pt(hi, default, 0.0))
        points.append(pt(1.4, default, 0.0))
        cleaned = []
        for point in points:
            if cleaned and point["location"] <= cleaned[-1]["location"]:
                point = dict(point, location=round(cleaned[-1]["location"] + 1.0e-4, 6))
            cleaned.append(point)
        return spline(f"{NS}:noise/island_type", cleaned)

    # ---------------------------------------------------------------- constants
    def _build_constants(self) -> None:
        cfg = self.cfg
        cont, isl, oceans, coast = cfg["continents"], cfg["islands"], cfg["oceans"], cfg["coast"]
        rivers, seas, fjords = cfg["rivers"], cfg["inland_seas"], cfg["fjords"]
        biomes = cfg["biomes"]

        self.constant("ocean_offset", self.ocean_offset)
        self.constant("max_offset", self.max_offset)
        self.constant("min_offset", self.min_offset)
        self.constant("vertical_scale", cfg["world"]["vertical_scale"])

        self.constant("ocean_depth", -abs(oceans["ocean_depth_blocks"]) / BLOCKS)
        self.constant("deep_ocean_depth", -abs(oceans["deep_ocean_depth_blocks"]) / BLOCKS)
        self.constant("seafloor_relief", oceans["seafloor_relief"])
        self.constant(
            "trench_depth",
            abs(oceans["trench_depth_blocks"]) / BLOCKS if oceans["trenches"] else 0.0,
        )

        self.constant("mountain_strength", cont["mountain_ranges"])
        self.constant("plateau_strength", cont["plateaus"])
        self.constant("tepui_strength", cont["tepui"])
        self.constant("rolling_hills", 1.0 if cont["rolling_hills"] else 0.0)
        self.constant("flat_terrain_skew", cont["flat_terrain_skew"])

        self.constant("river_depth", abs(rivers["depth_blocks"]) / BLOCKS if rivers["enabled"] else 0.0)
        self.constant("fjord_depth", abs(fjords["depth_blocks"]) / BLOCKS if fjords["enabled"] else 0.0)
        self.constant(
            "inland_sea_depth", abs(seas["depth_blocks"]) / BLOCKS if seas["enabled"] else 0.0
        )

        self.constant("island_frequency", isl["frequency"] if isl["enabled"] else 0.0)
        self.constant("island_offset", isl["noise_offset"])
        self.constant("arc_strength", isl["arc_strength"])

        self.constant("coast_cliffs", coast["cliffs"])
        self.constant("sea_stacks", coast["sea_stacks"])
        self.constant("columnar_jointing", coast["columnar_jointing"])

        self.constant("width_variation", self.width_amp)
        self.constant("height_variation", self.height_amp)

        self.constant("temperature_multiplier", biomes["temperature_multiplier"])
        self.constant("temperature_offset", biomes["temperature_offset"])
        self.constant("vegetation_multiplier", biomes["vegetation_multiplier"])
        self.constant("vegetation_offset", biomes["vegetation_offset"])

        strength = {
            "continent": 0.95,
            "island": 0.80,
            "archipelago": -0.72,
            "ocean": -1.20,
            "default": 0.0,
        }.get(self.center_type, 0.0)
        self.constant("center_strength", strength * float(cfg["center"]["strength"]))

    # ------------------------------------------------------------------ noises
    def _build_noises(self) -> None:
        # Octave layouts follow Tectonic's tuning: smoother, more continuous
        # landmasses than vanilla's, while staying in the same value range.
        self.noise_def("parameter/continentalness", -10, [1.75, 1, 2, 3, 2, 2, 1, 1, 1])
        self.noise_def("parameter/erosion", -10, [2, 1.75, 1.5, 1.5, 1.3, 1, 1, 1, 1])
        self.noise_def("parameter/ridge", -8, [1, 2, 1])

        self.noise_def("size_bias/width", -10, [1, 0.6])
        self.noise_def("size_bias/height", -10, [1, 0.6])

        # Six octaves, not nine: the last three sat at 5-20 block wavelengths
        # and, once the island spline had multiplied them up, dithered the
        # shoreline into speckle instead of shaping an island.
        self.noise_def("island/a", -8, [2, 1, 2, 3, 2, 2])
        self.noise_def("island/b", -8, [2, 1, 2, 3, 2, 2])
        self.noise_def("island/cluster", -9, [1, 0.7, 0.4])
        self.noise_def("island/arc", -10, [1, 0.35])
        self.noise_def("island/type", -9, [1, 1])
        self.noise_def("island/erosion", -9, [1, 1, 0, 1, 1])
        self.noise_def("island/ridge", -7, [1, 2, 1, 0, 0, 0])

        self.noise_def("mountain/base", -9, [1, 0.4, 0.2])
        self.noise_def("mountain/detail", -7, [0.3, 1, 0.5])
        self.noise_def("mountain/warp", -8, [1, 0.5])

        self.noise_def("region/selector", -11, [1, 2.1, 1.5, 1.7, 1.4, 2, 2])
        self.noise_def("region/plateau", -9, [1, 1, 0.5])
        # three octaves so the plateau has a shape, none fine enough to break
        # up its top
        self.noise_def("region/tepui", -9, [1, 0.6, 0.25])

        self.noise_def("coast/stack_a", -5, [1, 0.5])
        self.noise_def("coast/stack_b", -5, [1, 0.5])
        self.noise_def("coast/column_a", -3, [1])
        self.noise_def("coast/column_b", -3, [1])
        self.noise_def("coast/fjord", -6, [1, 0.6])

        self.noise_def("ocean/floor_a", -7, [1, 1, 0.6])
        self.noise_def("ocean/floor_b", -5, [1, 0.7])
        self.noise_def("ocean/trench", -10, [1, 0.4])

        self.noise_def("inland_sea", -10, [1, 0.5, 0.25])

        if self.center_type != "default":
            for i in range(1, 5):
                self.noise_def(f"center/ring{i}", -10 - i, [1, 0.25])

    # --------------------------------------------------------- continent field
    def _build_continent_field(self) -> None:
        scale = round(self.continent_scale, 8)

        def sample(shift_x, shift_z):
            return shifted_noise(
                f"{NS}:parameter/continentalness",
                xz_scale=scale,
                y_scale=0.0,
                shift_x=add(round(shift_x, 6), "minecraft:shift_x"),
                shift_y=0.0,
                shift_z=add(round(shift_z, 6), "minecraft:shift_z"),
            )

        blurred = self._blur(
            sample, self.blur_axis, self.blur_width, calib.anisotropy_taps(), self.continent_scale
        )
        self.df("noise/continent_raw", flat(cache2d(mul(round(self.blur_gain, 6), blurred))))

        # --- per-axis size variation ------------------------------------------
        bias_terms = []
        for axis, const_name, noise_name, amp in (
            ("width", "width_variation", f"{NS}:size_bias/width", self.width_amp),
            ("height", "height_variation", f"{NS}:size_bias/height", self.height_amp),
        ):
            if amp <= 0.0:
                continue
            # A width bias has to be constant along z (and the other way round),
            # so it is blurred hard along the axis it must not vary on.
            blur_axis = "z" if axis == "width" else "x"
            bias_scale = self.continent_scale * 0.45
            bias_width = 1.6 * calib.DATA["continent_base_wavelength"] / bias_scale
            bias_gain = calib.blur_gain(1.6)

            def make(shift_x, shift_z, _name=noise_name, _scale=round(bias_scale, 8)):
                return shifted_noise(
                    _name,
                    xz_scale=_scale,
                    y_scale=0.0,
                    shift_x=round(shift_x, 6),
                    shift_y=0.0,
                    shift_z=round(shift_z, 6),
                )

            field = self._blur(make, blur_axis, bias_width, 9, bias_scale)
            bias_terms.append(mul(cfg_ref(const_name), mul(round(bias_gain, 6), field)))

        self.df(
            "noise/size_bias", flat(cache2d(add_all(*bias_terms))) if bias_terms else 0
        )

        # --- centre of the world -----------------------------------------------
        if self.center_type == "default":
            self.df("center/mask", 0)
            self.df("center/bias", 0)
        else:
            delta = calib.center_ring_delta()
            rings = 0
            for i in range(1, 5):
                base = 0.75 + 0.05 * i
                rings = add(
                    rings,
                    abs_(
                        sub(
                            noise(f"{NS}:center/ring{i}", xz_scale=round(base, 6), y_scale=0.0),
                            noise(
                                f"{NS}:center/ring{i}",
                                xz_scale=round(base * (1.0 - delta), 8),
                                y_scale=0.0,
                            ),
                        )
                    ),
                )
            thr = self.center_threshold
            self.df(
                "center/mask",
                flat(
                    cache2d(
                        spline(
                            mul(0.25, rings),
                            [
                                pt(0.0, 1.0, 0.0),
                                pt(round(thr * 0.55, 6), 1.0, 0.0),
                                pt(round(thr, 6), 0.0, 0.0),
                            ],
                        )
                    )
                ),
            )
            self.df("center/bias", mul(f"{NS}:center/mask", cfg_ref("center_strength")))

        land_shape = spline(
            abs_(f"{NS}:noise/continent_raw"),
            [pt(0.0, 0.0, 0.0), pt(0.40, 0.575, 1.0), pt(0.48, 0.68, 1.0)],
        )
        self.df(
            "noise/raw_continents",
            flat(
                cache2d(
                    clamp(
                        add_all(
                            cfg_ref("ocean_offset"),
                            f"{NS}:noise/size_bias",
                            f"{NS}:center/bias",
                            land_shape,
                        ),
                        -1.0,
                        2.0,
                    )
                )
            ),
        )
        self.df(
            "selector/island",
            flat(cache2d(range_choice(f"{NS}:noise/raw_continents", -1.0, -0.5, 1, 0))),
        )
        self.df("selector/continent", flat(cache2d(sub(1, f"{NS}:selector/island"))))

        # --- inland seas ----------------------------------------------------------
        seas = self.cfg["inland_seas"]
        if seas["enabled"] and seas["frequency"] > 0.0 and seas["depth_blocks"] > 0:
            sea_scale = calib.continent_scale_for_size(
                float(seas["size"]), self.cfg["continents"]["land_ratio"]
            )
            # The water line is a measured quantile of the sea noise, not a
            # fixed value: see calib.inland_sea_band for why a fixed cut made
            # the seas appear or not appear depending on the seed.
            shore, deep = calib.inland_sea_band(float(seas["frequency"]))
            # Continentalness is added to the sea noise rather than gating it.
            # A gate can only ever mask, so whether a seed produced any sea at
            # all came down to whether a blob of the sea noise happened to land
            # on that seed's interior. Adding a bias makes the deep interior
            # start above the water line by construction, which is also where
            # inland seas are on Earth, and leaves the noise to shape them.
            bias = spline(
                f"{NS}:noise/raw_continents",
                [
                    pt(0.02, -1.2, 0.0),
                    pt(0.18, 0.0, 0.0),
                    # full bias by 0.34: a seed whose continents are small
                    # never reaches the high continentalness of a big landmass,
                    # and it is exactly those seeds that used to come out with
                    # no seas at all
                    pt(0.34, calib.INLAND_SEA_INTERIOR_BIAS, 0.0),
                ],
            )
            field = add(
                noise(f"{NS}:inland_sea", xz_scale=round(sea_scale, 8), y_scale=0.0), bias
            )
            self.df(
                "water/inland_sea",
                flat(cache2d(spline(field, [pt(shore, 0.0, 0.0), pt(deep, 1.0, 0.0)]))),
            )
            self.notes["inland_sea_share"] = round(
                calib.inland_sea_share(float(seas["frequency"])), 4
            )
        else:
            self.df("water/inland_sea", 0)

    # ---------------------------------------------------------------- islands
    def _build_islands(self) -> None:
        isl = self.cfg["islands"]
        scale = round(self.island_scale, 8)

        self.df(
            "noise/island_core",
            flat(
                cache2d(
                    add(
                        mx(
                            noise(f"{NS}:island/a", xz_scale=scale, y_scale=0.0),
                            noise(f"{NS}:island/b", xz_scale=scale, y_scale=0.0),
                        ),
                        cfg_ref("island_offset"),
                    )
                )
            ),
        )

        clustering = float(isl["clustering"])
        lo = -1.0 + 1.35 * clustering
        hi = lo + max(0.12, 0.55 * (1.0 - clustering))
        cluster = spline(
            noise(f"{NS}:island/cluster", xz_scale=round(self.island_cluster_scale, 8), y_scale=0.0),
            [pt(round(lo, 4), 0.0, 0.0), pt(round(hi, 4), 1.0, 0.0)],
        )
        arc = spline(
            abs_(noise(f"{NS}:island/arc", xz_scale=round(self.island_arc_scale, 8), y_scale=0.0)),
            [pt(0.0, 1.0, 0.0), pt(0.09, 0.0, 0.0)],
        )
        self.df(
            "noise/island_gate",
            flat(
                cache2d(
                    clamp(
                        mul(
                            cfg_ref("island_frequency"),
                            mul(cluster, add(1.0, mul(cfg_ref("arc_strength"), arc))),
                        ),
                        0.0,
                        1.7,
                    )
                )
            ),
        )

        # Islands fade in over the deep-ocean band. Knot locations have to be
        # strictly increasing, so the flat shoulders use a 0.002 epsilon rather
        # than repeating a location.
        falloff = spline(
            f"{NS}:noise/raw_continents",
            [
                pt(-0.802, 0.70, 0.0),
                pt(-0.800, 0.70, -1.0),
                pt(-0.500, 0.0, -2.5),
                pt(-0.498, 0.0, 0.0),
            ],
        )
        self.df(
            "noise/raw_islands",
            flat(
                cache2d(
                    add(mul(mul(f"{NS}:noise/island_core", f"{NS}:noise/island_gate"), falloff), -0.70)
                )
            ),
        )
        self.df(
            "noise/island_type",
            flat(
                cache2d(
                    noise(f"{NS}:island/type", xz_scale=round(self.island_type_scale, 8), y_scale=0.0)
                )
            ),
        )

        # Atolls reshape continentalness itself so the lagoon really is water.
        atoll_shape = nested(
            f"{NS}:noise/raw_islands",
            [
                pt(-1.0, -1.0, 1.0),
                pt(-0.30, -0.30, 0.6),
                pt(-0.16, 0.04, 0.0),
                pt(-0.04, 0.06, 0.0),
                pt(0.06, -0.22, 0.0),
                pt(0.45, -0.30, 0.0),
            ],
        )
        plain_shape = nested(f"{NS}:noise/raw_islands", [pt(0.0, 0.0, 1.0)])
        self.df(
            "noise/islands_shaped",
            flat(cache2d(self._by_island_type({"atoll": atoll_shape}, plain_shape))),
        )

        continent_part = spline(
            f"{NS}:noise/raw_continents", [pt(0.05, 0.05, 1.0), pt(0.175, 0.30, 1.0)]
        )
        # Inland seas pull continentalness back to coastal values so vanilla
        # picks beach/ocean biomes around them.
        sea_pull = mul(-0.55, f"{NS}:water/inland_sea")
        self.df(
            "noise/full_continents",
            flat(
                cache2d(
                    add(
                        mul(f"{NS}:selector/island", f"{NS}:noise/islands_shaped"),
                        mul(f"{NS}:selector/continent", add(continent_part, sea_pull)),
                    )
                )
            ),
        )

    # ------------------------------------------------------- biome parameters
    def _build_biome_parameters(self) -> None:
        cont = self.cfg["continents"]
        erosion_scale = self.continent_scale * 2.4 / float(cont["erosion_scale"])
        ridge_scale = self.continent_scale * 3.2 / float(cont["ridge_scale"])

        warp = mul(
            2.4,
            noise(f"{NS}:mountain/warp", xz_scale=round(self.continent_scale * 1.1, 8), y_scale=0.0),
        )
        ridge_line = spline(
            abs_(
                shifted_noise(
                    f"{NS}:mountain/base",
                    xz_scale=round(self.continent_scale * 1.8, 8),
                    y_scale=0.0,
                    shift_x=warp,
                    shift_y=0.0,
                    shift_z=mul(-1.0, warp),
                )
            ),
            # Vanilla keeps 9% of land in its mountainous erosion band; a
            # 0.30 cut-off put 54% of land inside a "range", which is what made
            # highlands read as one saturated plateau.
            [pt(0.0, 1.0, 0.0), pt(0.16, 0.0, 0.0)],
        )
        detail = spline(
            abs_(
                noise(
                    f"{NS}:mountain/detail",
                    # was continent_scale * 5.0, i.e. 50-100 block wavelengths:
                    # the mask flickered inside a single range and left isolated
                    # peaks standing on flat ground
                    xz_scale=round(self.continent_scale * 1.5, 8),
                    y_scale=0.0,
                )
            ),
            [pt(0.0, 1.0, 0.0), pt(0.55, 0.62, 0.0)],
        )
        self.df("mountain/ridges", flat(cache2d(mul(ridge_line, detail))))

        self.df(
            "erosion/continents",
            flat(
                cache2d(
                    clamp(
                        add_all(
                            mul(
                                0.78,
                                noise(
                                    f"{NS}:parameter/erosion",
                                    xz_scale=round(erosion_scale, 8),
                                    y_scale=0.0,
                                ),
                            ),
                            0.12,
                            # -1.35 pushed erosion past its clamp over most
                            # land, flattening it into one terrain type with
                            # abrupt edges. Measured against vanilla, whose
                            # erosion on land averages -0.055.
                            mul(-0.75, mul(cfg_ref("mountain_strength"), f"{NS}:mountain/ridges")),
                        ),
                        -1.0,
                        1.0,
                    )
                )
            ),
        )

        island_erosion = self._by_island_type(
            {
                "cliff": nested(
                    f"{NS}:noise/raw_islands", [pt(-0.30, -0.35, 0.0), pt(0.05, -0.95, 0.0)]
                ),
                "volcano": nested(
                    f"{NS}:noise/raw_islands", [pt(-0.30, -0.25, 0.0), pt(0.05, -0.80, 0.0)]
                ),
                "atoll": 0.62,
            },
            nested(
                abs_(
                    noise(
                        f"{NS}:island/erosion",
                        xz_scale=round(self.island_scale * 1.6, 8),
                        y_scale=0.0,
                    )
                ),
                [pt(0.0, -0.15, 0.0), pt(0.60, 0.55, 0.0)],
            ),
        )
        self.df("erosion/islands", flat(cache2d(clamp(island_erosion, -1.0, 1.0))))

        self.df(
            "biome/erosion",
            flat(
                cache2d(
                    add(
                        mul(f"{NS}:selector/island", f"{NS}:erosion/islands"),
                        mul(f"{NS}:selector/continent", f"{NS}:erosion/continents"),
                    )
                )
            ),
        )

        self.df(
            "biome/ridges",
            flat(
                cache2d(
                    clamp(
                        add(
                            mul(
                                f"{NS}:selector/island",
                                noise(
                                    f"{NS}:island/ridge",
                                    xz_scale=round(self.island_scale * 2.2, 8),
                                    y_scale=0.0,
                                ),
                            ),
                            mul(
                                f"{NS}:selector/continent",
                                noise(
                                    f"{NS}:parameter/ridge",
                                    xz_scale=round(ridge_scale, 8),
                                    y_scale=0.0,
                                ),
                            ),
                        ),
                        -1.0,
                        1.0,
                    )
                )
            ),
        )
        # vanilla's peaks-and-valleys fold: 1 - 3 * ||ridges| - 2/3|
        self.df(
            "biome/ridges_folded",
            flat(
                cache2d(
                    mul(
                        -3.0,
                        add(
                            -0.3333333333333333,
                            abs_(add(-0.6666666666666666, abs_(f"{NS}:biome/ridges"))),
                        ),
                    )
                )
            ),
        )

    # ------------------------------------------------------------ water carving
    def _build_water(self) -> None:
        rivers, fjords = self.cfg["rivers"], self.cfg["fjords"]
        folded = f"{NS}:biome/ridges_folded"

        if rivers["enabled"] and rivers["depth_blocks"] > 0:
            band = min(0.55, 0.15 * float(rivers["width"]))
            channel = spline(
                folded, [pt(-1.0, 1.0, 0.0), pt(round(-1.0 + band, 4), 0.0, 0.0)]
            )
            inland = spline(
                f"{NS}:noise/raw_continents", [pt(-0.06, 0.0, 0.0), pt(0.04, 1.0, 0.0)]
            )
            self.df("water/river", flat(cache2d(mul(channel, inland))))
        else:
            self.df("water/river", 0)

        if fjords["enabled"] and fjords["depth_blocks"] > 0 and fjords["frequency"] > 0:
            # Four multiplied gates used to leave fjords on 0.2% of the world —
            # measured, they simply never appeared. Each is widened so their
            # product lands in the same range as rivers, and the picker now
            # opens up as frequency rises instead of closing down.
            band = min(0.55, 0.18 * float(fjords["width"]))
            channel = spline(
                folded, [pt(-1.0, 1.0, 0.0), pt(round(-1.0 + band, 4), 0.0, 0.0)]
            )
            # only where the coast is steep rock, and only on a fraction of it
            steep = spline(f"{NS}:biome/erosion", [pt(-0.85, 1.0, 0.0), pt(-0.30, 0.0, 0.0)])
            coastal = spline(
                f"{NS}:noise/raw_continents",
                [pt(-0.44, 0.0, 0.0), pt(-0.30, 1.0, 0.0), pt(0.16, 1.0, 0.0), pt(0.32, 0.0, 0.0)],
            )
            picker = spline(
                abs_(noise(f"{NS}:coast/fjord", xz_scale=round(self.continent_scale * 2.5, 8), y_scale=0.0)),
                [
                    pt(0.0, 1.0, 0.0),
                    pt(round(0.12 + 0.62 * float(fjords["frequency"]), 4), 0.0, 0.0),
                ],
            )
            self.df("water/fjord", flat(cache2d(mul(mul(channel, steep), mul(coastal, picker)))))
        else:
            self.df("water/fjord", 0)

        self.df(
            "water/carve",
            flat(
                cache2d(
                    mul(
                        -1.0,
                        add(
                            mul(cfg_ref("river_depth"), f"{NS}:water/river"),
                            mul(cfg_ref("fjord_depth"), f"{NS}:water/fjord"),
                        ),
                    )
                )
            ),
        )

    # ----------------------------------------------------------------- offsets
    def _build_offsets(self) -> None:
        folded = f"{NS}:biome/ridges_folded"
        scale = self.continent_scale

        # Gains here are blocks-per-unit of a field that swings its whole range
        # every ~150 blocks, so they set the terrain's slope. Vanilla's
        # ridges-driven splines have a median local gain of 0.378 across 43
        # leaves; these used to run 0.75-1.02, which is what turned ridges into
        # spikes.
        mountains = nested(
            folded,
            [
                pt(-1.00, scaled("mountain_strength", 0.30), 0.0),
                pt(-0.20, scaled("mountain_strength", 0.52), 0.0),
                pt(0.45, scaled("mountain_strength", 0.86), 0.0),
                pt(1.00, scaled("mountain_strength", 1.16), 0.0),
            ],
        )
        high_hills = nested(
            folded,
            [
                pt(-1.00, 0.18, 0.0),
                pt(0.20, 0.38, 0.0),
                pt(1.00, scaled("mountain_strength", 0.62), 0.0),
            ],
        )
        plateau = nested(
            noise(f"{NS}:region/plateau", xz_scale=round(scale * 3.6, 8), y_scale=0.0),
            [
                pt(-0.60, 0.11, 0.0),
                pt(-0.16, 0.12, 0.0),
                pt(-0.10, scaled("plateau_strength", 0.34), 0.0),
                pt(0.18, scaled("plateau_strength", 0.36), 0.0),
                pt(0.24, scaled("plateau_strength", 0.62), 0.0),
                pt(0.60, scaled("plateau_strength", 0.65), 0.0),
            ],
        )
        # A plateau on the Tibetan scale, not a mesa. The field runs an order of
        # magnitude coarser than it did, so one plateau spans thousands of
        # blocks instead of a few hundred, and it is emitted as its own density
        # function because both the profile and the selector below read it.
        plateau_field = self.df(
            "terrain/plateau_field",
            flat(
                cache2d(
                    noise(f"{NS}:region/tepui", xz_scale=round(scale * 0.85, 8), y_scale=0.0)
                )
            ),
        )
        # The flank rises across a wide band of the field rather than a 0.04
        # sliver, which had put a vertical wall around every one, and the cap is
        # deliberately almost level: 0.06 of offset across it is 8 blocks of
        # relief over the whole plateau.
        tepui = nested(
            plateau_field,
            [
                pt(0.10, 0.16, 0.0),
                pt(0.30, 0.30, 0.0),
                pt(0.46, scaled("tepui_strength", 0.78), 0.0),
                pt(0.62, scaled("tepui_strength", 0.86), 0.0),
                pt(1.00, scaled("tepui_strength", 0.92), 0.0),
            ],
        )
        # Which of the two a place gets is decided by the plateau field, not by
        # humidity: vegetation only reaches 0.61 with a p90 of 0.31, so the old
        # "vegetation > 0.42" gate fired on 4.5% of land and, multiplied by the
        # erosion band, left tepuis on 0.9% of it — measured, they never
        # appeared. A plateau is flat high ground, so the erosion band decides
        # that it is flat and this field decides that it is a plateau.
        plateau_or_tepui = nested(
            plateau_field, [pt(0.18, plateau, 0.0), pt(0.30, tepui, 0.0)]
        )
        rolling = nested(
            noise(f"{NS}:region/plateau", xz_scale=round(scale * 7.0, 8), y_scale=0.0),
            [
                pt(-0.60, 0.055, 0.0),
                pt(0.00, scaled("rolling_hills", 0.135), 0.0),
                pt(0.60, 0.060, 0.0),
            ],
        )
        # flat_terrain_skew slides the boundary between plateau and flat ground
        skew = float(self.cfg["continents"]["flat_terrain_skew"])
        plateau_edge = round(0.05 + (skew - 0.10) * 1.5, 4)

        inland = nested(
            f"{NS}:biome/erosion",
            [
                pt(-1.00, mountains, 0.0),
                pt(-0.58, mountains, 0.0),
                pt(-0.45, high_hills, 0.0),
                pt(-0.22, plateau_or_tepui, 0.0),
                pt(plateau_edge, plateau_or_tepui, 0.0),
                pt(round(plateau_edge + 0.11, 4), rolling, 0.0),
                pt(0.55, 0.055, 0.0),
                pt(1.00, 0.035, 0.0),
            ],
        )
        near_inland = nested(
            f"{NS}:biome/erosion",
            [
                pt(
                    -1.00,
                    nested(
                        folded,
                        [pt(-0.40, 0.20, 0.0), pt(1.00, scaled("mountain_strength", 0.70), 0.0)],
                    ),
                    0.0,
                ),
                pt(-0.45, 0.22, 0.0),
                pt(-0.10, 0.14, 0.0),
                pt(0.40, 0.055, 0.0),
                pt(1.00, 0.030, 0.0),
            ],
        )
        coast = nested(
            f"{NS}:biome/erosion",
            [
                pt(-1.00, scaled("coast_cliffs", 0.52), 0.0),
                pt(-0.35, scaled("coast_cliffs", 0.30), 0.0),
                pt(-0.05, 0.045, 0.0),
                pt(1.00, 0.010, 0.0),
            ],
        )
        deep = nested(cfg_ref("deep_ocean_depth"), [pt(0.0, 0.0, 1.0)])
        shelf = nested(cfg_ref("ocean_depth"), [pt(0.0, 0.0, 1.0)])

        self.df(
            "terrain/offset_continents",
            flat(
                cache2d(
                    spline(
                        f"{NS}:noise/raw_continents",
                        [
                            pt(-0.60, deep, 0.0),
                            pt(-0.42, deep, 0.0),
                            pt(-0.30, shelf, 0.0),
                            pt(-0.20, nested(cfg_ref("ocean_depth"), [pt(0.0, 0.0, 0.35)]), 0.0),
                            pt(-0.13, coast, 0.0),
                            pt(-0.02, near_inland, 0.0),
                            pt(0.14, inland, 0.0),
                            pt(0.70, inland, 0.0),
                        ],
                    )
                )
            ),
        )

        normal_island = nested(
            f"{NS}:noise/raw_islands",
            [
                pt(-0.72, shelf, 0.0),
                pt(-0.30, -0.10, 0.0),
                pt(-0.08, 0.02, 0.0),
                pt(0.06, 0.14, 0.0),
                pt(0.40, 0.34, 0.0),
            ],
        )
        atoll_island = nested(
            f"{NS}:noise/raw_islands",
            [
                pt(-0.72, shelf, 0.0),
                pt(-0.34, -0.090, 0.0),
                pt(-0.12, -0.015, 0.0),
                pt(-0.02, 0.032, 0.0),
                pt(0.05, -0.035, 0.0),
                pt(0.40, -0.055, 0.0),
            ],
        )
        volcano_island = nested(
            f"{NS}:noise/raw_islands",
            [
                pt(-0.72, shelf, 0.0),
                pt(-0.30, -0.07, 0.0),
                pt(-0.05, 0.22, 0.0),
                pt(0.12, scaled("mountain_strength", 0.95), 0.0),
                pt(0.22, scaled("mountain_strength", 1.42), 0.0),
                pt(0.27, scaled("mountain_strength", 1.50), 0.0),
                pt(0.32, scaled("mountain_strength", 1.28), 0.0),
            ],
        )
        cliff_island = nested(
            f"{NS}:noise/raw_islands",
            [
                pt(-0.72, shelf, 0.0),
                pt(-0.28, -0.08, 0.0),
                pt(-0.22, scaled("coast_cliffs", 0.55), 0.0),
                pt(0.02, scaled("mountain_strength", 0.95), 0.0),
                pt(0.36, scaled("mountain_strength", 1.40), 0.0),
            ],
        )
        self.df(
            "terrain/offset_islands",
            flat(
                cache2d(
                    self._by_island_type(
                        {"atoll": atoll_island, "volcano": volcano_island, "cliff": cliff_island},
                        normal_island,
                    )
                )
            ),
        )

        # --- ocean floor -----------------------------------------------------
        relief = mul(
            cfg_ref("seafloor_relief"),
            add(
                mul(0.055, noise(f"{NS}:ocean/floor_a", xz_scale=0.55, y_scale=0.0)),
                mul(0.022, noise(f"{NS}:ocean/floor_b", xz_scale=1.4, y_scale=0.0)),
            ),
        )
        trench = mul(
            mul(-1.0, cfg_ref("trench_depth")),
            spline(
                abs_(noise(f"{NS}:ocean/trench", xz_scale=round(scale * 2.0, 8), y_scale=0.0)),
                [pt(0.0, 1.0, 0.0), pt(0.05, 0.0, 0.0)],
            ),
        )
        ocean_mask = spline(
            f"{NS}:noise/raw_continents",
            [pt(-1.0, 1.0, 0.0), pt(-0.26, 1.0, 0.0), pt(-0.16, 0.0, 0.0)],
        )
        self.df("terrain/ocean_relief", flat(cache2d(mul(ocean_mask, add(relief, trench)))))

        # --- coastal micro-relief ----------------------------------------------
        self.df(
            "terrain/coast_mask",
            flat(
                cache2d(
                    spline(
                        f"{NS}:noise/raw_continents",
                        [
                            pt(-0.34, 0.0, 0.0),
                            pt(-0.26, 1.0, 0.0),
                            pt(-0.11, 1.0, 0.0),
                            pt(-0.04, 0.0, 0.0),
                        ],
                    )
                )
            ),
        )
        # Sea stacks and columns are cliff features: they belong on a steep,
        # rocky coast, not sprayed across every shoreline. Without this gate they
        # reached 8 blocks or more on 4-8% of all land, at 16-32 block
        # wavelengths, which reads as isolated spikes standing on open ground.
        coast_steep = spline(
            f"{NS}:biome/erosion", [pt(-1.00, 1.0, 0.0), pt(-0.62, 0.0, 0.0)]
        )
        # and stacks specifically belong on the seaward side of the band
        stack_band = spline(
            f"{NS}:noise/raw_continents",
            [
                pt(-0.32, 0.0, 0.0),
                pt(-0.26, 1.0, 0.0),
                pt(-0.17, 1.0, 0.0),
                pt(-0.12, 0.0, 0.0),
            ],
        )
        stack_field = mn(
            spline(
                abs_(noise(f"{NS}:coast/stack_a", xz_scale=1.0, y_scale=0.0)),
                [pt(0.0, 1.0, 0.0), pt(0.34, 0.0, 0.0)],
            ),
            spline(
                abs_(noise(f"{NS}:coast/stack_b", xz_scale=1.0, y_scale=0.0)),
                [pt(0.0, 1.0, 0.0), pt(0.34, 0.0, 0.0)],
            ),
        )
        # 0.42 let roughly one point in twenty qualify; a stack field is meant to
        # be a handful of pillars, so the threshold is far higher now
        sea_stacks = mul(
            mul(cfg_ref("sea_stacks"), mul(coast_steep, stack_band)),
            spline(stack_field, [pt(0.0, 0.0, 0.0), pt(0.70, 0.0, 0.0), pt(1.0, 0.30, 0.0)]),
        )
        column_field = mn(
            spline(
                abs_(noise(f"{NS}:coast/column_a", xz_scale=1.0, y_scale=0.0)),
                [pt(0.0, 1.0, 0.0), pt(0.40, 0.0, 0.0)],
            ),
            spline(
                abs_(noise(f"{NS}:coast/column_b", xz_scale=1.0, y_scale=0.0)),
                [pt(0.0, 1.0, 0.0), pt(0.40, 0.0, 0.0)],
            ),
        )
        # Flat treads of 3 blocks each give the stepped, flat-topped look of
        # columnar jointing. 3 / 128 = 0.0234 offset units.
        columnar = mul(
            mul(cfg_ref("columnar_jointing"), coast_steep),
            spline(
                column_field,
                [
                    pt(0.00, 0.0000, 0.0),
                    pt(0.24, 0.0000, 0.0),
                    pt(0.26, 0.0234, 0.0),
                    pt(0.48, 0.0234, 0.0),
                    pt(0.50, 0.0469, 0.0),
                    pt(0.72, 0.0469, 0.0),
                    pt(0.74, 0.0703, 0.0),
                    pt(1.00, 0.0703, 0.0),
                ],
            ),
        )
        self.df(
            "terrain/coast_features",
            flat(cache2d(mul(f"{NS}:terrain/coast_mask", add(sea_stacks, columnar)))),
        )

        # --- discrete landforms -----------------------------------------------
        self._build_landform_offsets()

        # --- final offset -----------------------------------------------------
        vscale = range_choice(
            f"{NS}:terrain/offset_continents", 0.0, 64.0, cfg_ref("vertical_scale"), 1
        )
        island_vscale = range_choice(
            f"{NS}:terrain/offset_islands", 0.0, 64.0, cfg_ref("vertical_scale"), 1
        )
        raw_offset = add_all(
            mul(f"{NS}:selector/continent", mul(vscale, f"{NS}:terrain/offset_continents")),
            mul(f"{NS}:selector/island", mul(island_vscale, f"{NS}:terrain/offset_islands")),
            f"{NS}:terrain/ocean_relief",
            f"{NS}:terrain/coast_features",
            f"{NS}:terrain/landforms",
            f"{NS}:water/carve",
        )
        # An inland sea is a basin, not a cut. Rivers and fjords subtract a
        # depth from whatever they cross, which is right for them, but doing
        # the same to a sea means it only reaches water on terrain that was
        # already low: on the highlands preset a 30-block subtraction leaves an
        # interior sitting at y=150 still 90 blocks dry, which is why the seas
        # came and went. Pulling the offset *to* the basin floor instead puts
        # the water surface at sea level whatever the surrounding land does.
        sea_field = f"{NS}:water/inland_sea"
        raw_offset = add(
            mul(raw_offset, sub(1.0, sea_field)),
            mul(mul(-1.0, cfg_ref("inland_sea_depth")), sea_field),
        )
        body = add(
            round(self.base_offset, 8),
            mx(mn(raw_offset, cfg_ref("max_offset")), cfg_ref("min_offset")),
        )
        self.mc_files["worldgen/density_function/overworld/offset"] = flat(
            cache2d(
                add(
                    mul(
                        {"type": "minecraft:blend_offset"},
                        sub(1, {"type": "minecraft:blend_alpha"}),
                    ),
                    mul(body, {"type": "minecraft:blend_alpha"}),
                )
            )
        )

    # ------------------------------------------------------------- landforms
    def _build_landform_offsets(self) -> None:
        """Volcanoes and karst towers, as discrete cells rather than noise.

        Both are shapes, not textures: a volcano is a cone with a crater in the
        top and a karst tower is a flat-topped pillar with near-vertical sides.
        Neither can be got by splining an ordinary terrain noise, because such
        a spline can only follow that noise's contours - which is why these
        used to read as a wobble in the ground rather than as a landform. Each
        one here is a profile applied to radial_cells, so every instance has
        the same section wherever it lands.
        """
        parts = []
        notes: dict[str, object] = {}

        volcano = self.cfg["volcanoes"]
        if volcano["enabled"] and volcano["frequency"] > 0 and volcano["height_blocks"] > 0:
            cells, cut = self.radial_cells(
                "volcano", float(volcano["size"]), float(volcano["frequency"])
            )
            height = float(volcano["height_blocks"]) / BLOCKS
            crater = min(float(volcano["crater_blocks"]) / BLOCKS, height * 0.6)
            # u is the squared radius as a fraction of the cone's base, so the
            # rim sits just off centre and the flanks fall away with distance
            profile = [
                (0.00, height - crater),
                (0.06, height),
                (0.30, height * 0.62),
                (0.65, height * 0.24),
                (1.00, 0.0),
            ]
            cone = spline(
                cells, [pt(round(u * cut, 8), round(v, 6), 0.0) for u, v in profile]
            )
            # a cone belongs on land; at sea it would be an island the island
            # system did not put there
            on_land = spline(
                f"{NS}:noise/raw_continents", [pt(-0.10, 0.0, 0.0), pt(0.06, 1.0, 0.0)]
            )
            parts.append(mul(on_land, cone))
            notes["volcanoes"] = {
                "coverage": round(cut, 4),
                "spacing_blocks": round(float(volcano["size"]) / math.sqrt(cut)),
                "height_blocks": float(volcano["height_blocks"]),
                "crater_blocks": round(crater * BLOCKS, 1),
            }

        karst = self.cfg["karst"]
        if karst["enabled"] and karst["frequency"] > 0 and karst["height_blocks"] > 0:
            cells, cut = self.radial_cells(
                "karst", float(karst["size"]), float(karst["frequency"])
            )
            height = float(karst["height_blocks"]) / BLOCKS
            # a karst tower is a pillar: flat on top for most of its width,
            # then over in a fifth of its radius
            profile = [
                (0.00, height),
                (0.55, height * 0.96),
                (0.82, height * 0.42),
                (1.00, 0.0),
            ]
            tower = spline(
                cells, [pt(round(u * cut, 8), round(v, 6), 0.0) for u, v in profile]
            )
            setting = str(karst["setting"]).lower()
            if setting == "land":
                gate = spline(
                    f"{NS}:noise/raw_continents", [pt(-0.05, 0.0, 0.0), pt(0.10, 1.0, 0.0)]
                )
            elif setting == "sea":
                # the drowned bay: shallow water just off the coast, so the
                # towers stand out of the sea rather than out of a plain
                gate = spline(
                    f"{NS}:noise/raw_continents",
                    [
                        pt(-0.62, 0.0, 0.0),
                        pt(-0.44, 1.0, 0.0),
                        pt(-0.16, 1.0, 0.0),
                        pt(-0.04, 0.0, 0.0),
                    ],
                )
            else:
                gate = spline(
                    f"{NS}:noise/raw_continents",
                    [pt(-0.62, 0.0, 0.0), pt(-0.44, 1.0, 0.0), pt(1.0, 1.0, 0.0)],
                )
            parts.append(mul(gate, tower))
            notes["karst"] = {
                "coverage": round(cut, 4),
                "spacing_blocks": round(float(karst["size"]) / math.sqrt(cut)),
                "height_blocks": float(karst["height_blocks"]),
                "setting": setting,
            }

        self.df("terrain/landforms", flat(cache2d(add_all(*parts))) if parts else 0)
        if notes:
            self.notes["landforms"] = notes

    # ------------------------------------------------------- factor/jaggedness
    def _build_factor_and_jaggedness(self) -> None:
        folded = f"{NS}:biome/ridges_folded"
        inland_factor = nested(
            f"{NS}:biome/erosion",
            [
                pt(-1.00, 1.05, 0.0),
                pt(-0.55, 1.90, 0.0),
                pt(-0.30, 4.40, 0.0),
                pt(-0.05, 6.00, 0.0),
                pt(0.35, 6.40, 0.0),
                pt(1.00, 6.60, 0.0),
            ],
        )
        # Steep coastal transitions are what make cliffs, sea stacks and
        # columns read as vertical rock instead of gentle mounds.
        coast_factor = nested(cfg_ref("coast_cliffs"), [pt(0.0, 5.6, 0.0), pt(1.0, 9.5, 0.0)])
        self.mc_files["worldgen/density_function/overworld/factor"] = flat(
            cache2d(
                spline(
                    f"{NS}:noise/raw_continents",
                    [
                        pt(-0.60, 5.40, 0.0),
                        pt(-0.24, coast_factor, 0.0),
                        pt(-0.10, coast_factor, 0.0),
                        pt(0.02, inland_factor, 0.0),
                        pt(0.70, inland_factor, 0.0),
                    ],
                )
            )
        )

        jag_inland = nested(
            f"{NS}:biome/erosion",
            [
                pt(
                    -1.00,
                    nested(
                        folded,
                        [pt(0.0, 0.0, 0.0), pt(1.0, scaled("mountain_strength", 0.62), 0.0)],
                    ),
                    0.0,
                ),
                pt(
                    -0.50,
                    nested(
                        folded,
                        [pt(0.2, 0.0, 0.0), pt(1.0, scaled("mountain_strength", 0.28), 0.0)],
                    ),
                    0.0,
                ),
                pt(-0.25, 0.0, 0.0),
                pt(1.00, 0.0, 0.0),
            ],
        )
        self.mc_files["worldgen/density_function/overworld/jaggedness"] = flat(
            cache2d(
                spline(
                    f"{NS}:noise/raw_continents",
                    [pt(0.0, 0.0, 0.0), pt(0.16, jag_inland, 0.0), pt(0.70, jag_inland, 0.0)],
                )
            )
        )

    # ------------------------------------------------------------------ climate
    def _build_climate(self) -> None:
        biomes = self.cfg["biomes"]
        temp_scale = 0.25 / max(0.05, self.climate_factor)
        veg_scale = 0.25 / max(0.05, self.veg_factor)

        temperature = clamp(
            add_all(
                cfg_ref("temperature_offset"),
                mul(
                    cfg_ref("temperature_multiplier"),
                    shifted_noise(
                        "minecraft:temperature",
                        xz_scale=round(temp_scale, 8),
                        y_scale=0.0,
                        shift_x="minecraft:shift_x",
                        shift_y=0.0,
                        shift_z="minecraft:shift_z",
                    ),
                ),
                # atolls and volcanic islands belong in warm water
                mul(
                    f"{NS}:selector/island",
                    self._by_island_type({"atoll": 0.35, "volcano": 0.15}, 0.0),
                ),
            ),
            -2.0,
            2.0,
        )
        vegetation = clamp(
            add(
                cfg_ref("vegetation_offset"),
                mul(
                    cfg_ref("vegetation_multiplier"),
                    shifted_noise(
                        "minecraft:vegetation",
                        xz_scale=round(veg_scale, 8),
                        y_scale=0.0,
                        shift_x="minecraft:shift_x",
                        shift_y=0.0,
                        shift_z="minecraft:shift_z",
                    ),
                ),
            ),
            -2.0,
            2.0,
        )
        self.df("climate/temperature", flat(cache2d(temperature)))
        self.df("climate/vegetation", flat(cache2d(vegetation)))
        del biomes

    # ------------------------------------------------------------------ routers
    def _build_routers(self) -> None:
        self.mc_files["worldgen/density_function/overworld/continents"] = flat(
            cache2d(add(f"{NS}:noise/full_continents", 0))
        )
        self.mc_files["worldgen/density_function/overworld/erosion"] = flat(
            cache2d(add(f"{NS}:biome/erosion", 0))
        )
        self.mc_files["worldgen/density_function/overworld/ridges"] = flat(
            cache2d(add(f"{NS}:biome/ridges", 0))
        )
        self.mc_files["worldgen/density_function/overworld/depth"] = add(
            {
                "type": "minecraft:y_clamped_gradient",
                "from_y": self.build_min_y,
                "to_y": self.build_max_y,
                "from_value": round(self.depth_top, 8),
                "to_value": round(-self.depth_top, 8),
            },
            "minecraft:overworld/offset",
        )

        settings = vanilla.noise_settings("overworld")
        settings["sea_level"] = int(self.sea_level)
        settings["noise"]["min_y"] = self.build_min_y
        settings["noise"]["height"] = self.build_height
        self._move_density_guards(settings["noise_router"])
        settings["noise_router"]["temperature"] = f"{NS}:climate/temperature"
        settings["noise_router"]["vegetation"] = f"{NS}:climate/vegetation"
        if self.cfg["spawn"]["force_land_spawn"]:
            # Vanilla looks for continentalness >= -0.11, which includes coast
            # and shallow ocean; mid-inland guarantees dry land.
            for target in settings["spawn_target"]:
                target["continentalness"] = [0.03, 1.0]
        self.mc_files["worldgen/noise_settings/overworld"] = settings

        if (self.build_min_y, self.build_height) != (-64, 384):
            dimension = vanilla.dimension_type("overworld")
            dimension["min_y"] = self.build_min_y
            dimension["height"] = self.build_height
            dimension["logical_height"] = self.build_height
            self.mc_files["dimension_type/overworld"] = dimension

    # ------------------------------------------------- world height guards
    #: The two y_clamped_gradients vanilla's final_density hard-codes, keyed by
    #: their exact vanilla constants so a changed vanilla file fails loudly
    #: rather than being silently left alone.
    FLOOR_GUARD = {"from_y": -64, "to_y": -40, "from_value": 0.0, "to_value": 1.0}
    CEILING_FADE = {"from_y": 240, "to_y": 256, "from_value": 1.0, "to_value": 0.0}

    def _move_density_guards(self, router: dict) -> None:
        """Re-anchor vanilla's two hard-coded height guards to this world.

        final_density is written for a -64..320 world and says so in numbers:
        below y=-64 the density is forced solid so the world has a floor, and
        between y=240 and 256 it is faded to air so terrain cannot reach the
        build ceiling. Setting noise.min_y and noise.height moves the world but
        leaves those numbers where they were, which breaks a custom world at
        both ends -- a floor above -40 has no solid bottom at all, so the
        lowest layers open into caverns, and terrain above 256 is thinned and
        then cut off flat, which is exactly the look of the Amplified world
        type.

        The floor keeps vanilla's 24-block ramp off the bottom of the build
        range. The ceiling fade is placed on terrain_max_y rather than the
        build ceiling, because terrain_max_y is what the configuration means by
        "this high and no higher"; config.normalise keeps 16 blocks of build
        range above it for the fade to finish in.
        """
        floor_from = self.build_min_y
        floor_to = self.build_min_y + 24
        fade_from = int(self.cfg["world"]["terrain_max_y"])
        fade_to = min(self.build_max_y, fade_from + 16)
        moved = 0

        def walk(node):
            nonlocal moved
            if isinstance(node, list):
                for item in node:
                    walk(item)
                return
            if not isinstance(node, dict):
                return
            if node.get("type") == "minecraft:y_clamped_gradient":
                probe = {k: node.get(k) for k in ("from_y", "to_y", "from_value", "to_value")}
                if probe == self.FLOOR_GUARD:
                    node["from_y"], node["to_y"] = floor_from, floor_to
                    moved += 1
                elif probe == self.CEILING_FADE:
                    node["from_y"], node["to_y"] = fade_from, fade_to
                    moved += 1
            for value in node.values():
                walk(value)

        walk(router["final_density"])
        if moved != 2:
            raise AssertionError(
                f"expected vanilla's two height guards in final_density, found {moved}"
            )
        self.notes["height_guards"] = {
            "solid_floor": [floor_from, floor_to],
            "terrain_fade": [fade_from, fade_to],
        }

    # -------------------------------------------------------- caves/structures
    def _build_caves_and_structures(self) -> None:
        if abs(self.cave_factor - 1.0) > 1e-3:
            for name in vanilla.CAVE_NOISES:
                self.mc_files[f"worldgen/noise/{name}"] = vanilla.scale_noise(
                    vanilla.noise(name), self.cave_factor
                )
        if not self.cfg["caves"]["carvers_enabled"]:
            for name in ("cave", "cave_extra_underground", "canyon"):
                carver = {
                    "type": "minecraft:cave",
                    "config": {
                        "probability": 0.0,
                        "y": {"type": "minecraft:uniform", "min_inclusive": {"absolute": 0},
                              "max_inclusive": {"absolute": 0}},
                        "yScale": 0.5,
                        "lava_level": {"above_bottom": 8},
                        "debug_settings": {"debug_mode": False},
                        "horizontal_radius_multiplier": {"type": "minecraft:uniform",
                                                          "value": {"min_inclusive": 0.7,
                                                                    "max_inclusive": 1.4}},
                        "vertical_radius_multiplier": {"type": "minecraft:uniform",
                                                        "value": {"min_inclusive": 0.8,
                                                                  "max_inclusive": 1.3}},
                        "floor_level": {"type": "minecraft:uniform",
                                        "value": {"min_inclusive": -1.0, "max_inclusive": -0.4}},
                    },
                }
                self.mc_files[f"worldgen/configured_carver/{name}"] = carver

        if abs(self.structure_factor - 1.0) > 1e-3:
            for name, data in vanilla.structure_sets().items():
                if name not in vanilla.OVERWORLD_STRUCTURE_SETS:
                    continue
                placement = data.get("placement", {})
                kind = placement.get("type", "")
                changed = False
                if kind == "minecraft:random_spread":
                    spacing = int(placement.get("spacing", 1))
                    separation = int(placement.get("separation", 0))
                    if spacing > 1:
                        new_spacing = max(2, int(round(spacing * self.structure_factor)))
                        new_separation = min(
                            new_spacing - 1, max(0, int(round(separation * self.structure_factor)))
                        )
                        placement["spacing"] = new_spacing
                        placement["separation"] = new_separation
                        changed = True
                elif kind == "minecraft:concentric_rings":
                    placement["distance"] = max(
                        1, int(round(int(placement.get("distance", 32)) * self.structure_factor))
                    )
                    placement["spread"] = max(
                        1, int(round(int(placement.get("spread", 3)) * self.structure_factor))
                    )
                    changed = True
                if changed:
                    self.mc_files[f"worldgen/structure_set/{name}"] = data

    # ---------------------------------------------------------------- functions
    def _build_spawn_functions(self) -> None:
        if not self.cfg["spawn"]["force_land_spawn"]:
            return
        sea = int(self.sea_level)
        radii = [400, 900, 1800, 3200, 6000, 11000, 20000, 36000]

        self.functions["spawn/load"] = "\n".join(
            [
                "# MineWorldGen - keeps players off the open ocean at spawn",
                "scoreboard objectives add mwg.try dummy",
                "",
            ]
        )

        tick = [
            "# runs only for players who have not been checked yet",
            "execute as @a[tag=!mwg.spawn_ok] at @s run function mwg:spawn/check",
            "",
        ]
        self.functions["spawn/tick"] = "\n".join(tick)

        check = [
            "# already on solid ground above sea level? then we are done",
            f"execute if entity @s[y={sea},dy=2048] unless block ~ ~ ~ water"
            " unless block ~ ~-1 ~ water run function mwg:spawn/settle",
            "execute if entity @s[tag=mwg.spawn_ok] run return 0",
            "scoreboard players add @s mwg.try 1",
        ]
        for index, radius in enumerate(radii):
            check.append(
                f"execute if score @s mwg.try matches {index + 1} run "
                f"spreadplayers 0 0 1 {radius} false @s"
            )
        check += [
            f"execute if score @s mwg.try matches {len(radii) + 1}.. run tag @s add mwg.spawn_ok",
            "",
        ]
        self.functions["spawn/check"] = "\n".join(check)

        self.functions["spawn/settle"] = "\n".join(
            [
                "tag @s add mwg.spawn_ok",
                "scoreboard players reset @s mwg.try",
                "# the first player to find land also fixes the world spawn",
                "execute unless score #mwg.world mwg.try matches 1.. run setworldspawn ~ ~ ~",
                "scoreboard players set #mwg.world mwg.try 1",
                "",
            ]
        )

        self.mc_files["tags/function/load"] = {"values": ["mwg:spawn/load"]}
        self.mc_files["tags/function/tick"] = {"values": ["mwg:spawn/tick"]}

    # ------------------------------------------------------------------ output
    # ------------------------------------------------- plateau block stamping
    def _build_plateau_features(self) -> None:
        """Stamp rock strata onto the plateau, the way Overhauled Overworld does.

        The density functions decide the plateau's *shape*; nothing in them can
        change which blocks it is made of. Wythers' tepuis get their character
        from features stamped after the noise has run — disks of deepslate and
        tuff filtered to the height band the plateau occupies — so the same
        technique is used here.

        The band is not a constant. It is computed from this pack's own tepui
        spline, whose cap sits at ``sea_level + 128 * 0.86 * tepui_strength``,
        so the strata land on the plateau this config actually generates rather
        than on a height that happened to suit vanilla.
        """
        cont = self.cfg["continents"]
        strength = float(cont["tepui"])
        if strength <= 0:
            return

        sea = float(self.cfg["world"]["sea_level"])
        cap_y = int(round(sea + BLOCKS * 0.86 * strength))
        top = min(int(self.cfg["world"]["terrain_max_y"]), cap_y + 24)
        floor = max(int(self.cfg["world"]["terrain_min_y"]) + 8, cap_y - 96)

        def surface_band(low: int, high: int, heightmap: str = "WORLD_SURFACE_WG") -> dict:
            """Keep only positions whose surface sits between low and high.

            surface_relative_threshold_filter compares position.y minus the
            heightmap, and the position is pinned to y=0 just above, so the
            window is expressed as the negated surface range.
            """
            return {
                "type": "minecraft:surface_relative_threshold_filter",
                "heightmap": heightmap,
                "min_inclusive": -high,
                "max_inclusive": -low,
            }

        def stamped(name: str, block: str, radius: tuple[int, int], half_height: int,
                    count: int, low: int, high: int) -> None:
            self.features["configured_feature"][name] = {
                "type": "minecraft:disk",
                "config": {
                    "state_provider": {
                        "fallback": {
                            "type": "minecraft:simple_state_provider",
                            "state": {"Name": block},
                        },
                        "rules": [],
                    },
                    "target": {
                        "type": "minecraft:matching_block_tag",
                        "tag": "minecraft:base_stone_overworld",
                    },
                    "radius": {
                        "type": "minecraft:uniform",
                        "value": {"min_inclusive": radius[0], "max_inclusive": radius[1]},
                    },
                    "half_height": half_height,
                },
            }
            self.features["placed_feature"][name] = {
                "feature": f"{NS}:{name}",
                "placement": [
                    {"type": "minecraft:count", "count": count},
                    {"type": "minecraft:in_square"},
                    {"type": "minecraft:height_range",
                     "height": {"type": "minecraft:constant", "value": {"absolute": 0}}},
                    surface_band(low, high),
                    {"type": "minecraft:heightmap", "heightmap": "WORLD_SURFACE_WG"},
                    {"type": "minecraft:biome"},
                ],
            }

        # the cap: a hard lid over the top of the plateau
        stamped("plateau/cap", "minecraft:tuff", (5, 9), 3, 24, cap_y - 16, top)
        # the flank strata, lower and thicker
        stamped("plateau/strata", "minecraft:deepslate", (4, 8), 4, 20, floor, cap_y - 12)
        self.notes["plateau_stamping"] = {
            "cap_y": cap_y,
            "cap_band": [cap_y - 16, top],
            "strata_band": [floor, cap_y - 12],
            "placed_features": [f"{NS}:plateau/cap", f"{NS}:plateau/strata"],
            "note": (
                "these need a biome to reference them; 26.2 has no feature "
                "injection, so run tools/port_pack.py --inject on the decoration "
                "pack, or add the ids to your own biome files"
            ),
        }

    def build(self, out_dir: str) -> dict:
        data_dir = os.path.join(out_dir, "data")
        if os.path.isdir(data_dir):
            shutil.rmtree(data_dir)
        os.makedirs(out_dir, exist_ok=True)

        if self.mode != "custom":
            self._write_pack_meta(out_dir)
            self._write(
                os.path.join(data_dir, NS, "worldgen", "density_function", "unused.json"),
                {"type": "minecraft:constant", "argument": 0.0},
            )
            self.notes = {
                "mode": "vanilla",
                "minecraft_version": vanilla.MINECRAFT_VERSION,
                "note": "no world generation files are written; terrain is 100% vanilla",
                "adjustments": self.adjustments,
            }
            return self.notes

        self._build_constants()
        self._build_noises()
        self._build_continent_field()
        self._build_islands()
        self._build_biome_parameters()
        self._build_climate()
        self._build_water()
        self._build_offsets()
        self._build_factor_and_jaggedness()
        self._build_routers()
        self._build_caves_and_structures()
        self._build_spawn_functions()
        self._build_plateau_features()

        for name, value in self.density.items():
            self._write(
                os.path.join(data_dir, NS, "worldgen", "density_function", name + ".json"), value
            )
        for name, value in self.noises.items():
            self._write(os.path.join(data_dir, NS, "worldgen", "noise", name + ".json"), value)
        for registry, entries in self.features.items():
            for name, value in entries.items():
                self._write(
                    os.path.join(data_dir, NS, "worldgen", registry, name + ".json"), value
                )
        for name, value in self.mc_files.items():
            self._write(os.path.join(data_dir, "minecraft", name + ".json"), value)
        for name, text in self.functions.items():
            path = os.path.join(data_dir, NS, "function", name + ".mcfunction")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as fh:
                fh.write(text)

        self.notes["mode"] = "custom"
        self.notes["adjustments"] = self.adjustments
        self._write_pack_meta(out_dir)
        return self.notes

    @staticmethod
    def _write(path: str, value) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            json.dump(value, fh, indent=2)
            fh.write("\n")

    def _write_pack_meta(self, out_dir: str) -> None:
        label = "vanilla fallback" if self.mode != "custom" else "custom terrain"
        meta = {
            "pack": {
                "description": [
                    {"text": "MineWorldGen", "color": "#4fc3f7"},
                    {"text": f"\n{label} - Minecraft {vanilla.MINECRAFT_VERSION}", "color": "gray"},
                ],
                "pack_format": vanilla.PACK_FORMAT,
                "min_format": vanilla.PACK_FORMAT,
                "max_format": vanilla.PACK_FORMAT,
                "supported_formats": {
                    "min_inclusive": vanilla.PACK_FORMAT,
                    "max_inclusive": vanilla.PACK_FORMAT,
                },
            }
        }
        with open(os.path.join(out_dir, "pack.mcmeta"), "w") as fh:
            json.dump(meta, fh, indent=2)
            fh.write("\n")
