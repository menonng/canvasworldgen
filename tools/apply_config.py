#!/usr/bin/env python3
"""Regenerate the MineWorldGen data pack from config.json.

Usage:
    python3 tools/apply_config.py [--config PATH] [--out PATH] [--quiet]

Run this after editing ``config.json`` inside the data pack, then reload the
world (``/reload`` is not enough - world generation is read when the world
loads, so a fresh world or a restart is required for terrain changes).

Only the Python standard library is required.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mwgbuild.builder import Builder  # noqa: E402
from mwgbuild.config import load_config  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PACK = os.path.join(REPO_ROOT, "pack")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=None, help="path to config.json")
    parser.add_argument("--out", default=None, help="data pack directory to write")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    out_dir = os.path.abspath(args.out or DEFAULT_PACK)
    config_path = os.path.abspath(args.config or os.path.join(out_dir, "config.json"))

    if not os.path.exists(config_path):
        print(f"error: no config file at {config_path}", file=sys.stderr)
        return 2

    try:
        user_config = load_config(config_path)
    except ValueError as exc:
        print(f"error: {config_path} is not valid JSON ({exc})", file=sys.stderr)
        return 1

    builder = Builder(user_config)
    notes = builder.build(out_dir)

    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "generated.json"), "w") as fh:
        json.dump(notes, fh, indent=2)
        fh.write("\n")

    if builder.adjustments:
        print("adjusted out-of-range settings:")
        for adjustment in builder.adjustments:
            print(f"  - {adjustment}")
    if not args.quiet:
        print(f"wrote data pack to {out_dir}")
        print("derived values:")
        for key, value in notes.items():
            if key != "adjustments":
                print(f"  {key}: {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
