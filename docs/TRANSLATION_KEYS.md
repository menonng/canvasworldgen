# Translation keys

Every string the editor can display. English is the source of truth and the
fallback: a key missing from another table falls back to English, so a partial
translation is always safe to ship.

Minecraft's own names are **not** translated. Biome ids stay as registry ids
(`minecraft:plains`), and so do block ids and the terrain-feature flag names
(`volcano`, `atoll`, `island_arc`, …) that the feature layer paints — those are
identifiers the data pack writes, not prose.

To add a locale, fill the third column and put the result in the matching table
in `web/src/i18n.ts`.

Regenerate this list after adding a key:

```bash
cd web && npm run keys
```

| Key | English | Translation |
| --- | --- | --- |
| `action.analyse` | Analyse map |  |
| `action.exportPack` | Export world |  |
| `action.exportProject` | Export project |  |
| `action.importProject` | Import project |  |
| `action.redo` | Redo |  |
| `action.undo` | Undo |  |
| `analysis.apply` | Apply edits |  |
| `analysis.center` | Centre |  |
| `analysis.clustering` | Clustering |  |
| `analysis.config` | Generator config (editable) |  |
| `analysis.continentSize` | Continent size |  |
| `analysis.islands` | Islands |  |
| `analysis.landRatio` | Land ratio |  |
| `analysis.landmasses` | Landmasses |  |
| `analysis.oceanDepth` | Ocean depth mean/max |  |
| `analysis.reset` | Reset |  |
| `analysis.variation` | Size variation |  |
| `app.subtitle` | Design a world, compile it to a Minecraft 26.2 data pack |  |
| `app.title` | MineWorldGen — World Designer |  |
| `brush.amount` | Amount per stroke |  |
| `brush.circle` | Circle |  |
| `brush.flow` | Flow |  |
| `brush.lower` | Lower |  |
| `brush.lowerTo` | Lower to Y |  |
| `brush.mode` | Mode |  |
| `brush.raise` | Raise |  |
| `brush.raiseTo` | Raise to Y |  |
| `brush.set` | Set to Y |  |
| `brush.shape` | Shape |  |
| `brush.size` | Size |  |
| `brush.slope` | Slope strength |  |
| `brush.square` | Square |  |
| `brush.targetY` | Target Y |  |
| `brush.value` | Value |  |
| `export.exact` | Exact — data pack + companion mod |  |
| `export.mode` | Export mode |  |
| `export.packName` | Pack name |  |
| `export.procedural` | Procedural — vanilla data pack, no mod |  |
| `export.vanilla` | Vanilla — identical to vanilla terrain |  |
| `hover.outside` | outside the design surface — procedural generation |  |
| `layer.biome` | Biome |  |
| `layer.elevation` | Elevation |  |
| `layer.feature` | Terrain feature |  |
| `layer.land` | Land / Ocean |  |
| `layer.temperature` | Temperature |  |
| `layer.visible` | Visible |  |
| `map.contourInterval` | Contour interval (blocks) |  |
| `map.contours` | Contours |  |
| `map.grid` | Grid |  |
| `map.height` | Height (blocks) |  |
| `map.navHint` | Left-drag paints · right or middle-drag pans · wheel zooms · [ ] resize the brush |  |
| `map.new` | New map |  |
| `map.resetView` | Reset view |  |
| `map.resolution` | Resolution (blocks per cell) |  |
| `map.seaLevel` | Sea level |  |
| `map.seed` | Seed (0 = random) |  |
| `map.width` | Width (blocks) |  |
| `panel.analysis` | Analysis |  |
| `panel.brush` | Brush |  |
| `panel.export` | Export |  |
| `panel.layers` | Layers |  |
| `panel.map` | Map |  |
| `panel.presets` | Presets |  |
| `panel.preview` | Preview |  |
| `preset.hint` | A preset replaces the generator settings only. Your drawn map is left untouched, so you can start from a preset and refine it by hand. |  |
| `preset.load` | Load preset settings |  |
| `preset.pick` | Preset |  |
| `preview.caption` | Procedural Export reproduces the character and scale of your design, not its exact coastlines. Exact Export preserves position. |  |
| `preview.procedural` | Procedural result |  |
| `preview.scale` | Both previews show the same window: |  |
| `preview.user` | Your design |  |
| `status.buildFailed` | Could not build the data pack |  |
| `status.building` | Building the data pack... |  |
| `status.configApplied` | Generator settings applied |  |
| `status.configInvalid` | That is not valid JSON |  |
| `status.configReset` | Generator settings restored |  |
| `status.exactPending` | Exact Export needs the companion mod, which is not built yet |  |
| `status.filesWritten` | files written |  |
| `status.importFailed` | Could not import project |  |
| `status.imported` | Project imported |  |
| `status.newMap` | New map created |  |
| `status.presetFailed` | Could not load that preset |  |
| `status.presetLoaded` | Preset loaded |  |
| `status.presetNone` | Pick a preset first |  |
| `status.restored` | Restored the autosaved project |  |
| `value.clear` | Clear |  |
| `value.land` | Land |  |
| `value.ocean` | Ocean |  |
