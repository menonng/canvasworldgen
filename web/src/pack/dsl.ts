/** Helpers for writing Minecraft density-function JSON. */

export type DF = unknown;

export function add(a: DF, b: DF): DF {
  if (a === 0) return b;
  if (b === 0) return a;
  return { type: "minecraft:add", argument1: a, argument2: b };
}

export function addAll(...args: DF[]): DF {
  let result: DF = 0;
  for (const arg of args) result = add(result, arg);
  return result;
}

export function mul(a: DF, b: DF): DF {
  if (a === 1) return b;
  if (b === 1) return a;
  if (a === 0 || b === 0) return 0;
  return { type: "minecraft:mul", argument1: a, argument2: b };
}

export const sub = (a: DF, b: DF): DF => add(a, mul(-1, b));
export const mn = (a: DF, b: DF): DF => ({ type: "minecraft:min", argument1: a, argument2: b });
export const mx = (a: DF, b: DF): DF => ({ type: "minecraft:max", argument1: a, argument2: b });
export const clamp = (v: DF, lo: number, hi: number): DF => ({ type: "minecraft:clamp", input: v, min: lo, max: hi });
export const abs_ = (v: DF): DF => ({ type: "minecraft:abs", argument: v });
export const square = (v: DF): DF => ({ type: "minecraft:square", argument: v });
export const flat = (v: DF): DF => ({ type: "minecraft:flat_cache", argument: v });
export const cache2d = (v: DF): DF => ({ type: "minecraft:cache_2d", argument: v });

export function noise(name: string, xzScale = 1, yScale = 0): DF {
  return { type: "minecraft:noise", noise: name, xz_scale: xzScale, y_scale: yScale };
}

export function shiftedNoise(
  name: string,
  xzScale: number,
  yScale: number,
  shiftX: DF,
  shiftY: DF,
  shiftZ: DF,
): DF {
  return {
    type: "minecraft:shifted_noise",
    noise: name,
    xz_scale: xzScale,
    y_scale: yScale,
    shift_x: shiftX,
    shift_y: shiftY,
    shift_z: shiftZ,
  };
}

export function rangeChoice(value: DF, lo: number, hi: number, inside: DF, outside: DF): DF {
  return {
    type: "minecraft:range_choice",
    input: value,
    min_inclusive: lo,
    max_exclusive: hi,
    when_in_range: inside,
    when_out_of_range: outside,
  };
}

export interface SplinePoint {
  location: number;
  value: DF;
  derivative: number;
}

export const pt = (location: number, value: DF, derivative = 0): SplinePoint => ({
  location,
  value,
  derivative,
});

export const spline = (coordinate: DF, points: SplinePoint[]): DF => ({
  type: "minecraft:spline",
  spline: { coordinate, points },
});

/** A spline used as the value of another spline's point. */
export const nested = (coordinate: DF, points: SplinePoint[]): DF => ({ coordinate, points });

/**
 * A nested spline value promoted to a density function of its own.
 *
 * `nested` returns the bare `{coordinate, points}` object a spline point wants,
 * which is not a density function and has no `type`. Anywhere a branch might
 * hand one of those straight to `df` — a selection with no branches left, for
 * instance — it has to be wrapped first, or the pack fails to load with no clue
 * as to which file is wrong.
 */
export const asDF = (value: DF): DF => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if ("coordinate" in obj && !("type" in obj)) {
      return { type: "minecraft:spline", spline: obj } as DF;
    }
  }
  return value;
};

export const round8 = (v: number): number => Number(v.toFixed(8));
export const round6 = (v: number): number => Number(v.toFixed(6));
