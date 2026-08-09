# Producing the README screenshots

The images in the README are [uNmINeD](https://unmined.net/) map renders of
real generated worlds. To regenerate them after changing the terrain graph:

## 1. Generate a world per preset

```bash
python3 tools/apply_config.py --config presets/earthlike.json --out /tmp/mwg-earthlike
```

Copy `/tmp/mwg-earthlike` into a fresh world's `datapacks/` folder and create
the world with seed `1234`, then pre-generate the area you want to show. With
a server, [Chunky](https://modrinth.com/plugin/chunky) is the quickest way:

```
/chunky world minecraft:overworld
/chunky center 0 0
/chunky radius 8000
/chunky start
```

8 000 blocks of radius is enough to show several landmasses for the
medium-scale presets. `pangaea` needs roughly 40 000 to show a whole
continent.

## 2. Render with uNmINeD

```bash
unmined-cli image render \
  --world="<path to the world folder>" \
  --output="docs/img/earthlike.png" \
  --zoom=-5 \
  --area="c(-500,-500)-(500,500)" \
  --imagequality=90
```

`--zoom=-5` gives one pixel per 32 blocks, which keeps a 32 000-block square
under 1 000 px. Use `--zoom=-6` for `pangaea`.

For the isometric shots of individual landforms (sea stacks, columnar
jointing, tepuis) use the in-game F1 view or:

```bash
unmined-cli image render --world="..." --output="docs/img/coast.png" \
  --zoom=0 --area="b(-300,-300)-(300,300)"
```

## 3. File names the README expects

| file | preset | suggested area |
|---|---|---|
| `docs/img/earthlike.png` | `presets/earthlike.json` | 32 000 blocks square, centred on 0,0 |
| `docs/img/archipelago.png` | `presets/archipelago.json` | 24 000 blocks square |
| `docs/img/pangaea.png` | `presets/pangaea.json` | 96 000 blocks square |
| `docs/img/highlands.png` | `presets/highlands.json` | 32 000 blocks square |
| `docs/img/waterworld.png` | `presets/waterworld.json` | 24 000 blocks square |

Drop the files in with those names and the README picks them up with no
further changes.

## Quick preview without Minecraft

`tools/render.py` draws a heightmap straight from the pack's JSON using the
noise simulator. It is much faster than generating chunks and is useful while
tuning a config, though it shows terrain height rather than blocks and biomes:

```bash
python3 tools/render.py --config presets/earthlike.json --out /tmp/preview.png
```
