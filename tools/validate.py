#!/usr/bin/env python3
"""Check that a generated pack is well formed before it ever reaches the game.

    python3 tools/validate.py                 # validates every preset
    python3 tools/validate.py --config x.json # validates one config

Checks performed:
  * every JSON file parses
  * every density-function and noise reference resolves, either inside the pack
    or in vanilla 26.2
  * every spline has strictly increasing knot locations (Minecraft rejects the
    file otherwise, and duplicated knots make the interpolation blow up)
  * the whole density-function graph is acyclic
  * the graph actually evaluates, over a real grid, without producing NaN/inf
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mwgbuild import vanilla  # noqa: E402
from mwgbuild.builder import Builder  # noqa: E402
from mwgbuild.config import DEFAULTS, load_config, merge_config, validate as validate_config  # noqa: E402
from mwgnoise.density import VANILLA_DF, VANILLA_NOISE, Evaluator, PackData  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NOISE_KEYS = {"noise"}
DF_KEYS = {
    "argument",
    "argument1",
    "argument2",
    "input",
    "when_in_range",
    "when_out_of_range",
    "shift_x",
    "shift_y",
    "shift_z",
    "coordinate",
    "value",
    "density",
}


class Problems(list):
    def add(self, message: str) -> None:
        self.append(message)


def _iter_json(root: str):
    for base, _dirs, files in os.walk(root):
        for name in files:
            if name.endswith(".json"):
                yield os.path.join(base, name)


def collect_references(node, df_refs: set, noise_refs: set, problems: Problems, where: str):
    if isinstance(node, str):
        return
    if isinstance(node, list):
        for item in node:
            collect_references(item, df_refs, noise_refs, problems, where)
        return
    if not isinstance(node, dict):
        return

    if "points" in node and "coordinate" in node:
        locations = [p.get("location") for p in node["points"]]
        for a, b in zip(locations, locations[1:]):
            if a is None or b is None or b <= a:
                problems.add(f"{where}: spline knots must strictly increase, got {locations}")
                break

    for key, value in node.items():
        if key in NOISE_KEYS and isinstance(value, str):
            noise_refs.add(value)
        elif key in DF_KEYS and isinstance(value, str):
            df_refs.add(value)
        collect_references(value, df_refs, noise_refs, problems, where)


def has_cycle(pack: PackData, roots) -> list:
    seen_ok = set()
    stack = []

    def visit(ident):
        if ident in seen_ok:
            return None
        if ident in stack:
            return " -> ".join(stack + [ident])
        stack.append(ident)
        try:
            node = pack.density_function(ident)
        except KeyError:
            stack.pop()
            return None
        found = None
        refs, noises, problems = set(), set(), Problems()
        collect_references(node, refs, noises, problems, ident)
        for ref in refs:
            found = visit(ref)
            if found:
                break
        stack.pop()
        if not found:
            seen_ok.add(ident)
        return found

    cycles = []
    for root in roots:
        found = visit(root)
        if found:
            cycles.append(found)
    return cycles


def validate_pack(pack_dir: str, label: str) -> Problems:
    problems = Problems()
    data_dir = os.path.join(pack_dir, "data")
    df_refs: set[str] = set()
    noise_refs: set[str] = set()

    for path in _iter_json(pack_dir):
        try:
            with open(path) as fh:
                content = json.load(fh)
        except Exception as exc:  # noqa: BLE001
            problems.add(f"{path}: not valid JSON ({exc})")
            continue
        rel = os.path.relpath(path, pack_dir)
        collect_references(content, df_refs, noise_refs, problems, rel)

    pack = PackData([data_dir, os.path.join(vanilla.ROOT)])
    for ref in sorted(df_refs):
        if ref in VANILLA_DF:
            continue
        try:
            pack.density_function(ref)
        except KeyError:
            problems.add(f"{label}: density function reference does not resolve: {ref}")
    for ref in sorted(noise_refs):
        if ref in VANILLA_NOISE:
            continue
        try:
            pack.noise_parameters(ref)
        except KeyError:
            problems.add(f"{label}: noise reference does not resolve: {ref}")

    settings_path = os.path.join(data_dir, "minecraft", "worldgen", "noise_settings", "overworld.json")
    roots = []
    if os.path.exists(settings_path):
        with open(settings_path) as fh:
            router = json.load(fh)["noise_router"]
        roots = [value for value in router.values() if isinstance(value, str)]
    for cycle in has_cycle(pack, roots):
        problems.add(f"{label}: density function cycle: {cycle}")

    # the graph has to actually run
    if os.path.exists(settings_path):
        evaluator = Evaluator(pack, seed=17)
        xs = np.arange(-2048, 2048, 128.0)
        X, Z = np.meshgrid(xs, xs, indexing="ij")
        for name in (
            "minecraft:overworld/continents",
            "minecraft:overworld/erosion",
            "minecraft:overworld/ridges",
            "minecraft:overworld/offset",
            "minecraft:overworld/factor",
            "minecraft:overworld/jaggedness",
        ):
            evaluator.reset_cache()
            try:
                value = np.asarray(
                    evaluator.evaluate(pack.density_function(name), X, np.float64(0.0), Z),
                    dtype=np.float64,
                )
            except Exception as exc:  # noqa: BLE001
                problems.add(f"{label}: {name} failed to evaluate: {exc}")
                continue
            if not np.isfinite(value).all():
                problems.add(f"{label}: {name} produced non-finite values")
            if name.endswith(("continents", "erosion", "ridges")) and (
                value.min() < -2.5 or value.max() > 2.5
            ):
                problems.add(
                    f"{label}: {name} leaves the climate range "
                    f"[{value.min():.2f}, {value.max():.2f}]"
                )
            if name.endswith("factor") and value.min() <= 0:
                problems.add(f"{label}: factor must stay positive, got {value.min():.3f}")
    return problems


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)

    targets = []
    if args.config:
        targets.append((os.path.basename(args.config), load_config(args.config)))
    else:
        targets.append(("vanilla-default", load_config(os.path.join(REPO_ROOT, "pack", "config.json"))))
        preset_dir = os.path.join(REPO_ROOT, "presets")
        for name in sorted(os.listdir(preset_dir)):
            if name.endswith(".json"):
                targets.append((name, load_config(os.path.join(preset_dir, name))))

    failures = 0
    for label, config in targets:
        merged = merge_config(DEFAULTS, config)
        config_problems = validate_config(merged)
        temp = tempfile.mkdtemp(prefix="mwgcheck-")
        try:
            Builder(config).build(temp)
            problems = validate_pack(temp, label)
        finally:
            shutil.rmtree(temp, ignore_errors=True)
        problems = Problems(config_problems + problems)
        if problems:
            failures += 1
            print(f"FAIL  {label}")
            for problem in problems:
                print(f"        {problem}")
        else:
            print(f"ok    {label}")
    print()
    print("all packs valid" if not failures else f"{failures} pack(s) failed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
