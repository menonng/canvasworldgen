/**
 * UI strings. English is the source of truth and the fallback; Korean sits on
 * top as display text only. Minecraft biome and block names are never
 * translated — they stay as registry ids such as minecraft:plains.
 */

export type Locale = "en" | "ko";

const EN: Record<string, string> = {
  "app.title": "MineWorldGen — World Designer",
  "app.subtitle": "Design a world, compile it to a Minecraft 26.2 data pack",
  "panel.map": "Map",
  "panel.layers": "Layers",
  "panel.brush": "Brush",
  "panel.analysis": "Analysis",
  "panel.preview": "Preview",
  "panel.export": "Export",
  "map.width": "Width (blocks)",
  "map.height": "Height (blocks)",
  "map.resolution": "Resolution (blocks per cell)",
  "map.seaLevel": "Sea level",
  "map.seed": "Seed (0 = random)",
  "map.new": "New map",
  "map.grid": "Grid",
  "map.contours": "Contours",
  "layer.land": "Land / Ocean",
  "layer.elevation": "Elevation",
  "layer.temperature": "Temperature",
  "layer.biome": "Biome",
  "layer.feature": "Terrain feature",
  "layer.visible": "Visible",
  "brush.shape": "Shape",
  "brush.circle": "Circle",
  "brush.square": "Square",
  "brush.size": "Size",
  "brush.mode": "Mode",
  "brush.value": "Value",
  "brush.amount": "Amount per stroke",
  "brush.targetY": "Target Y",
  "brush.slope": "Slope strength",
  "brush.flow": "Flow",
  "brush.raise": "Raise",
  "brush.lower": "Lower",
  "brush.raiseTo": "Raise to Y",
  "brush.lowerTo": "Lower to Y",
  "brush.set": "Set to Y",
  "value.land": "Land",
  "value.ocean": "Ocean",
  "value.clear": "Clear",
  "hover.outside": "outside the design surface — procedural generation",
  "action.undo": "Undo",
  "action.redo": "Redo",
  "action.importProject": "Import project",
  "action.exportProject": "Export project",
  "action.analyse": "Analyse map",
  "action.exportPack": "Export world",
  "analysis.landRatio": "Land ratio",
  "analysis.landmasses": "Landmasses",
  "analysis.continentSize": "Continent size",
  "analysis.variation": "Size variation",
  "analysis.islands": "Islands",
  "analysis.clustering": "Clustering",
  "analysis.oceanDepth": "Ocean depth mean/max",
  "analysis.center": "Centre",
  "preview.user": "Your design",
  "preview.procedural": "Procedural result",
  "preview.caption":
    "Procedural Export reproduces the character and scale of your design, not its exact coastlines. Exact Export preserves position.",
  "export.mode": "Export mode",
  "export.procedural": "Procedural — vanilla data pack, no mod",
  "export.exact": "Exact — data pack + companion mod",
  "status.newMap": "New map created",
  "status.imported": "Project imported",
  "status.importFailed": "Could not import project",
  "status.restored": "Restored the autosaved project",
  "status.building": "Building the data pack...",
  "status.filesWritten": "files written",
  "status.buildFailed": "Could not build the data pack",
  "status.exactPending": "Exact Export needs the companion mod, which is not built yet",
};

const KO: Record<string, string> = {
  // Korean strings arrive from the project owner; anything missing falls back
  // to English automatically.
};

const TABLES: Record<Locale, Record<string, string>> = { en: EN, ko: KO };

let locale: Locale = (localStorage.getItem("mwg.locale") as Locale) ?? "en";

export function currentLocale(): Locale {
  return locale;
}

export function setLocale(next: Locale): void {
  locale = next;
  localStorage.setItem("mwg.locale", next);
}

export function t(key: string): string {
  return TABLES[locale][key] ?? EN[key] ?? key;
}

/** Every key the UI can show, for handing off to a translator. */
export function translationKeys(): string[] {
  return Object.keys(EN).sort();
}
