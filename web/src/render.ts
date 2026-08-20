/** Canvas rendering of the map layers, contours and grid. */

import { FEATURE_FLAGS, type LayerId, type MapModel } from "./field";
import {
  LAND_COLOUR,
  NEUTRAL_COLOUR,
  OCEAN_COLOUR,
  OUTSIDE_COLOUR,
  biomeColour,
  blendFeatureColours,
  elevationColour,
  temperatureColour,
  type RGB,
} from "./palette";

export { elevationColour } from "./palette";

export interface ViewState {
  /** Blocks per screen pixel. */
  scale: number;
  centreX: number;
  centreZ: number;
}

export interface RenderOptions {
  visible: Set<LayerId>;
  activeLayer: LayerId;
  grid: boolean;
  contours: boolean;
  contourInterval: number;
  seaLevel: number;
}

/** Blend `over` into `base` by `amount`, in place-free form. */
function mix(base: RGB, over: RGB, amount: number): RGB {
  const t = Math.max(0, Math.min(1, amount));
  return [
    base[0] + (over[0] - base[0]) * t,
    base[1] + (over[1] - base[1]) * t,
    base[2] + (over[2] - base[2]) * t,
  ];
}

export function renderMap(
  canvas: HTMLCanvasElement,
  map: MapModel,
  view: ViewState,
  options: RenderOptions,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const image = ctx.createImageData(w, h);
  const pixels = image.data;

  const land = map.layer("land");
  const elevation = map.layer("elevation");
  const temperature = map.layer("temperature");
  const biome = map.layer("biome");
  const feature = map.layer("feature");

  const showElevation = options.visible.has("elevation");
  const showTemperature = options.visible.has("temperature");
  const showBiome = options.visible.has("biome");
  const showLand = options.visible.has("land");
  const showFeature = options.visible.has("feature");

  // Painted layers cover what is under them, but not completely: the active
  // layer stays fully readable while the ones below still show through.
  const strength = (layer: LayerId): number => (options.activeLayer === layer ? 0.92 : 0.68);

  // A cell's fill depends only on which bits are set, and a map uses a handful
  // of combinations, so resolve each combination once instead of per pixel.
  const flagCache = new Map<number, RGB>();
  const featureFill = (bits: number): RGB => {
    const hit = flagCache.get(bits);
    if (hit) return hit;
    const names = FEATURE_FLAGS.filter((_, bit) => bits & (1 << bit));
    const colour = blendFeatureColours(names);
    flagCache.set(bits, colour);
    return colour;
  };

  for (let py = 0; py < h; py++) {
    const worldZ = view.centreZ + (py - h / 2) * view.scale;
    for (let px = 0; px < w; px++) {
      const worldX = view.centreX + (px - w / 2) * view.scale;
      const { cx, cy } = map.worldToCell(worldX, worldZ);
      const offset = (py * w + px) * 4;

      const inside = cx >= 0 && cy >= 0 && cx < map.cols && cy < map.rows;
      let colour: RGB;

      if (!inside) {
        // outside the design surface the procedural world takes over; shown
        // as a muted field rather than as ocean, because it is neither
        colour = OUTSIDE_COLOUR;
      } else {
        const isLand = land.get(cx, cy) !== 0;
        colour = showLand ? (isLand ? LAND_COLOUR : OCEAN_COLOUR) : NEUTRAL_COLOUR;
        if (showElevation) colour = elevationColour(elevation.real(cx, cy), options.seaLevel, isLand);
        if (showTemperature) {
          colour = mix(colour, temperatureColour(temperature.real(cx, cy)), strength("temperature"));
        }
        if (showBiome) {
          const index = biome.get(cx, cy);
          if (index > 0) colour = mix(colour, biomeColour(map.biomePalette[index] ?? ""), strength("biome"));
        }
        if (showFeature) {
          const bits = feature.get(cx, cy);
          if (bits) colour = mix(colour, featureFill(bits), strength("feature"));
        }
      }

      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
      pixels[offset + 3] = 255;
    }
  }

  // Contours sit above every layer, so they stay readable whatever is shown.
  if (options.contours) {
    const interval = Math.max(1, options.contourInterval);
    for (let py = 1; py < h; py++) {
      const worldZ = view.centreZ + (py - h / 2) * view.scale;
      for (let px = 1; px < w; px++) {
        const worldX = view.centreX + (px - w / 2) * view.scale;
        const a = map.worldToCell(worldX, worldZ);
        const b = map.worldToCell(worldX - view.scale, worldZ);
        const c = map.worldToCell(worldX, worldZ - view.scale);
        if (a.cx < 0 || a.cy < 0 || a.cx >= map.cols || a.cy >= map.rows) continue;
        const here = elevation.real(a.cx, a.cy);
        const west = elevation.real(b.cx, b.cy);
        const north = elevation.real(c.cx, c.cy);
        const crossed =
          Math.floor(here / interval) !== Math.floor(west / interval) ||
          Math.floor(here / interval) !== Math.floor(north / interval);
        if (!crossed) continue;
        const offset = (py * w + px) * 4;
        // land and water get different contour colours
        const isLand = land.get(a.cx, a.cy) !== 0;
        const tint = isLand ? [70, 50, 30] : [190, 225, 255];
        pixels[offset] = (pixels[offset] + tint[0]) / 2;
        pixels[offset + 1] = (pixels[offset + 1] + tint[1]) / 2;
        pixels[offset + 2] = (pixels[offset + 2] + tint[2]) / 2;
      }
    }
  }

  ctx.putImageData(image, 0, 0);

  if (options.grid) drawGrid(ctx, w, h, view);
  drawMapBorder(ctx, w, h, view, map);
}

function niceStep(scale: number): number {
  const target = scale * 90; // aim for a line roughly every 90 pixels
  const steps = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
  return steps.find((s) => s >= target) ?? steps[steps.length - 1];
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, view: ViewState): void {
  const step = niceStep(view.scale);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.font = "11px ui-monospace, monospace";
  const left = view.centreX - (w / 2) * view.scale;
  const top = view.centreZ - (h / 2) * view.scale;

  for (let x = Math.ceil(left / step) * step; x < left + w * view.scale; x += step) {
    const px = Math.round((x - left) / view.scale) + 0.5;
    ctx.strokeStyle = x === 0 ? "rgba(255,220,120,0.55)" : "rgba(255,255,255,0.10)";
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillText(String(x), px + 3, 12);
  }
  for (let z = Math.ceil(top / step) * step; z < top + h * view.scale; z += step) {
    const py = Math.round((z - top) / view.scale) + 0.5;
    ctx.strokeStyle = z === 0 ? "rgba(255,220,120,0.55)" : "rgba(255,255,255,0.10)";
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillText(String(z), 3, py - 3);
  }
  ctx.restore();
}

function drawMapBorder(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  view: ViewState,
  map: MapModel,
): void {
  const left = map.origin.x - map.widthBlocks / 2;
  const top = map.origin.z - map.heightBlocks / 2;
  const toPx = (x: number, z: number) => ({
    px: (x - view.centreX) / view.scale + w / 2,
    py: (z - view.centreZ) / view.scale + h / 2,
  });
  const a = toPx(left, top);
  const b = toPx(left + map.widthBlocks, top + map.heightBlocks);
  ctx.save();
  ctx.strokeStyle = "rgba(120,200,255,0.7)";
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(a.px, a.py, b.px - a.px, b.py - a.py);
  ctx.restore();
}

/**
 * Draws a preview height grid into its own canvas, for the comparison panel.
 *
 * `landMask` is what makes the left panel honest: the drawn map keeps land and
 * elevation independent, so a coastline drawn at sea level has to come from the
 * land layer. Without a mask — the procedural side, where land really is
 * height-derived — sea level decides.
 */
export function renderHeightGrid(
  canvas: HTMLCanvasElement,
  heights: Float32Array,
  size: number,
  seaLevel: number,
  landMask?: Uint8Array,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  canvas.width = size;
  canvas.height = size;
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < heights.length; i++) {
    const y = heights[i];
    const colour = elevationColour(y, seaLevel, landMask ? landMask[i] !== 0 : y > seaLevel);
    image.data[i * 4] = colour[0];
    image.data[i * 4 + 1] = colour[1];
    image.data[i * 4 + 2] = colour[2];
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}
