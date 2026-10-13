import type { ThemeTokens } from '@/theme/tokens';
import { THEME_VAR_MAP } from '@/theme/tokens';

type Color = readonly [number, number, number, number];
type Rgb = readonly [number, number, number];
const CACHE_LIMIT = 512;
const MINIMUM_CONTRAST = 4.5;
const caches = new WeakMap<ThemeTokens, {
  surfaces: Map<string, Rgb[]>;
  foregrounds: Map<string, string>;
}>();

function cacheValue<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

function getCaches(theme: ThemeTokens) {
  let cache = caches.get(theme);
  if (!cache) {
    cache = { surfaces: new Map(), foregrounds: new Map() };
    caches.set(theme, cache);
  }
  return cache;
}

// Only the color expressions emitted by the text-diff surfaces are supported.
// Splitting at top-level commas keeps var(), rgba() and color-mix() intact.
function splitLayers(value: string): string[] {
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function resolveColor(value: string, variables: Map<string, string>): Color | null {
  const trimmed = value.trim();
  if (trimmed === 'transparent') return [0, 0, 0, 0];
  const variable = trimmed.match(/^var\((--[\w-]+)\)$/)?.[1];
  if (variable) return resolveColor(variables.get(variable) ?? '', variables);
  const hex = trimmed.match(/^#([\da-f]{3,8})$/i)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const expanded = hex.length < 5 ? [...hex].map(channel => channel + channel).join('') : hex;
    return [0, 2, 4, 6].map((offset) => (
      offset === 6 ? Number.parseInt(expanded.slice(offset) || 'ff', 16) / 255
        : Number.parseInt(expanded.slice(offset, offset + 2), 16)
    )) as unknown as Color;
  }
  const rgba = trimmed.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4] ?? 1)];
  if (!trimmed.startsWith('color-mix(')) return null;
  const parts = splitLayers(trimmed.slice(10, -1));
  if (parts[0] !== 'in srgb' || parts.length !== 3) return null;
  const left = parts[1]?.match(/^(.*?)\s+([\d.]+)%$/);
  const right = parts[2]?.match(/^(.*?)(?:\s+([\d.]+)%)?$/);
  const leftColor = resolveColor(left?.[1] ?? '', variables);
  const rightColor = resolveColor(right?.[1] ?? '', variables);
  if (!leftColor || !rightColor) return null;
  const leftWeight = Number(left?.[2]) / 100;
  const rightWeight = right?.[2] === undefined ? 1 - leftWeight : Number(right[2]) / 100;
  const alpha = leftColor[3] * leftWeight + rightColor[3] * rightWeight;
  if (alpha === 0) return [0, 0, 0, 0];
  return [0, 1, 2].map(index => (
    (leftColor[index]! * leftColor[3] * leftWeight + rightColor[index]! * rightColor[3] * rightWeight) / alpha
  )).concat(alpha) as unknown as Color;
}

function surfaceColors(value: string, variables: Map<string, string>): Color[] {
  if (!value.startsWith('linear-gradient(')) {
    const color = resolveColor(value, variables);
    return color ? [color] : [];
  }
  const stops = splitLayers(value.slice(16, -1)).slice(1);
  return stops.flatMap((stop) => {
    const color = resolveColor(stop.replace(/\s+[\d.]+%$/, ''), variables);
    return color ? [color] : [];
  });
}

function blend(color: Color, background: Rgb): Rgb {
  return [0, 1, 2].map(index => Math.round(
    color[index]! * color[3] + background[index]! * (1 - color[3]),
  )) as unknown as Rgb;
}

function luminance(color: Rgb): number {
  return color.reduce((sum, channel, index) => {
    const value = channel / 255;
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
  }, 0);
}

function contrast(foreground: Rgb, background: Rgb): number {
  const left = luminance(foreground);
  const right = luminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

/** Layers are back-to-front; each CSS background list itself is front-to-back. */
export function resolveTextBackgroundSamples(
  theme: ThemeTokens,
  layers: readonly (string | undefined)[],
): readonly Rgb[] {
  const cache = getCaches(theme).surfaces;
  const key = JSON.stringify(layers);
  const cached = cache.get(key);
  if (cached) return cached;
  const variables = new Map(Object.entries(THEME_VAR_MAP).map(([name, variable]) => [
    variable, theme[name as keyof ThemeTokens],
  ]));
  // The editor surface is a bg1-to-bg0 gradient; cover both ends for equal rows.
  let samples = [theme.bg0, theme.bg1].flatMap((background) => {
    const color = resolveColor(background, variables);
    return color ? [blend(color, [0, 0, 0])] : [];
  });
  for (const layer of layers) {
    if (!layer) continue;
    for (const background of splitLayers(layer).reverse()) {
      const colors = surfaceColors(background, variables);
      if (colors.length === 0) continue;
      samples = [...new Map(samples.flatMap(sample => colors.map(color => {
        const result = blend(color, sample);
        return [result.join(','), result] as const;
      }))).values()];
    }
  }
  return cacheValue(cache, key, samples);
}

function toHsl(color: Rgb): readonly [number, number, number] {
  const [r, g, b] = color.map(value => value / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) return [0, 0, lightness];
  const hue = max === r ? ((g - b) / delta + (g < b ? 6 : 0))
    : max === g ? ((b - r) / delta + 2) : ((r - g) / delta + 4);
  return [hue / 6, delta / (1 - Math.abs(2 * lightness - 1)), lightness];
}

function fromHsl(hue: number, saturation: number, lightness: number): Rgb {
  const amplitude = saturation * Math.min(lightness, 1 - lightness);
  return [0, 8, 4].map((offset) => {
    const phase = (offset + hue * 12) % 12;
    return Math.round(255 * (lightness - amplitude * Math.max(-1, Math.min(phase - 3, 9 - phase, 1))));
  }) as unknown as Rgb;
}

/** Keep accessible syntax colors; otherwise change only HSL lightness as little as needed. */
export function resolveTextForegroundColor(
  color: string,
  theme: ThemeTokens,
  backgrounds: readonly Rgb[],
): string {
  const cache = getCaches(theme).foregrounds;
  const key = `${color}:${backgrounds.map(background => background.join(',')).join(';')}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const parsed = resolveColor(color, new Map());
  if (!parsed || backgrounds.length === 0) return color;
  const rgb: Rgb = [parsed[0], parsed[1], parsed[2]];
  const score = (candidate: Rgb) => Math.min(...backgrounds.map(background => contrast(candidate, background)));
  if (score(rgb) >= MINIMUM_CONTRAST) return cacheValue(cache, key, color);
  const [hue, saturation, lightness] = toHsl(rgb);
  const candidates = [0, 1].flatMap((endpoint) => {
    if (score(fromHsl(hue, saturation, endpoint)) < MINIMUM_CONTRAST) return [];
    let fail = lightness;
    let pass = endpoint;
    // Twelve bounded steps are finer than an 8-bit color channel. Test rounded
    // RGB values, so the resulting CSS hex also reaches the contrast threshold.
    for (let step = 0; step < 12; step += 1) {
      const middle = (fail + pass) / 2;
      if (score(fromHsl(hue, saturation, middle)) >= MINIMUM_CONTRAST) pass = middle;
      else fail = middle;
    }
    return [{ lightness: pass, rgb: fromHsl(hue, saturation, pass) }];
  });
  const closest = candidates.sort((a, b) => Math.abs(a.lightness - lightness) - Math.abs(b.lightness - lightness))[0];
  // Existing text surfaces have a consistent brightness. For unsupported
  // mixed-brightness gradients, retain the original syntax color.
  if (!closest) return cacheValue(cache, key, color);
  const adjusted = `#${closest.rgb.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
  return cacheValue(cache, key, adjusted);
}
