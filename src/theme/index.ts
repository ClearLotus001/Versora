// ─────────────────────────────────────────────────────────────────────────────
// src/theme/index.ts — 主题模块入口
//
// 主题契约统一为：
//   1. UI 层只传递 ThemeKey
//   2. DOM 组件使用 CSS Variables
//   3. Canvas / 纯函数场景显式读取 ThemeTokens 快照
// ─────────────────────────────────────────────────────────────────────────────

import type { TokenType } from '@/types/diff';
import { type ThemeTokens, THEME_VAR_MAP } from '@/theme/tokens';

export type { ThemeTokens };

export type ThemeKey = 'dark' | 'light' | 'hc';
export type ThemeAppearance = 'dark' | 'light' | 'high-contrast';

export const THEME_KEYS: readonly ThemeKey[] = ['light', 'dark', 'hc'] as const;

export const THEME_CLASS_MAP: Record<ThemeKey, string> = {
  dark: 'theme-dark',
  light: 'theme-light',
  hc: 'theme-hc',
};

/**
 * 纯 ThemeTokens 快照。
 *
 * 仅供 tests / SSR / Canvas / 纯函数视觉计算使用；
 * UI 层不再暴露 `THEMES` 兼容入口。
 */
const STATIC_THEME_TOKENS: Record<ThemeKey, ThemeTokens> = {
  dark: {
    bg0: '#08090d',
    bg1: '#13141a',
    bg2: '#1b1b1f',
    bg3: '#242529',
    bg4: '#222326',
    border: '#222326',
    border2: '#343539',
    t0: '#fafafa',
    t1: '#f4f4f5',
    t2: '#a1a1aa',
    addBg: '#132b1f',
    addHl: '#1d402c',
    addTx: '#83d39b',
    addBrd: '#45b36b',
    delBg: '#351c1b',
    delHl: '#512826',
    delTx: '#f0aaa4',
    delBrd: '#e06a61',
    chgBg: '#312817',
    chgHl: '#4b3c1d',
    chgTx: '#e9c96a',
    chgBrd: '#d09a29',
    whitespaceBg: '#182440',
    whitespaceHl: '#283f6a',
    whitespaceTx: '#a9c5ff',
    whitespaceBrd: '#7599ed',
    acc: '#8ab8e3',
    acc2: '#76c7d2',
    versionBase: '#8ab8e3',
    versionMine: '#e6c95a',
    kw: '#e879f9',
    str: '#93c5fd',
    num: '#6ee7b7',
    cmt: '#85858f',
    punc: '#d4d4d8',
    lnBg: '#18181b',
    lnTx: '#85858f',
    workbookHeaderBg: '#1b2b38',
    workbookHeaderBorder: '#557085',
    workbookCanvasBg: '#0d1015',
    workbookCellBg: '#171b22',
    workbookEmptyBg: '#14181f',
    workbookMissingBg: '#202630',
    workbookGridBorder: '#26313d',
    workbookGridBorderStrong: '#3a4856',
    scrollThumb: '#2e2f34',
    scrollThumbHover: '#45464c',
    scrollTrack: 'transparent',
    miniAdd: '#45b36b',
    miniDel: '#e06a61',
    miniVp: '#202126',
    searchHl: '#38bdf8',
    searchActiveBg: 'rgba(56, 189, 248, 0.30)',
    textSelectionBg: 'rgba(38, 79, 120, 0.60)',
    textSelectionEdge: 'rgba(38, 79, 120, 0.42)',
    glassBlur: 'blur(24px) saturate(1.42)',
  },
  light: {
    bg0: '#f5f7fb',
    bg1: '#fdfefe',
    bg2: '#fcfcfe',
    bg3: '#fcfdfe',
    bg4: '#dddfe4',
    border: '#dddfe4',
    border2: '#cdcfd3',
    t0: '#09090b',
    t1: '#09090b',
    t2: '#71717a',
    addBg: '#dff6e7',
    addHl: '#bfeacb',
    addTx: '#126b35',
    addBrd: '#238f4b',
    delBg: '#fde7e4',
    delHl: '#f7c9c3',
    delTx: '#a1322c',
    delBrd: '#d94b43',
    chgBg: '#fff0c8',
    chgHl: '#f3d482',
    chgTx: '#765300',
    chgBrd: '#b47700',
    whitespaceBg: '#e9efff',
    whitespaceHl: '#d0ddfa',
    whitespaceTx: '#254782',
    whitespaceBrd: '#4b6bb5',
    acc: '#246fae',
    acc2: '#007a86',
    versionBase: '#246fae',
    versionMine: '#8d6200',
    kw: '#7c3aed',
    str: '#2563eb',
    num: '#059669',
    cmt: '#71717a',
    punc: '#52525b',
    lnBg: '#ffffff',
    lnTx: '#71717a',
    workbookHeaderBg: '#edf4fa',
    workbookHeaderBorder: '#9fb3c4',
    workbookCanvasBg: '#f1f4f8',
    workbookCellBg: '#ffffff',
    workbookEmptyBg: '#f8fafc',
    workbookMissingBg: '#eef2f6',
    workbookGridBorder: '#e2e8f0',
    workbookGridBorderStrong: '#cbd5e1',
    scrollThumb: '#d3d5db',
    scrollThumbHover: '#c7c8ce',
    scrollTrack: 'transparent',
    miniAdd: '#238f4b',
    miniDel: '#d94b43',
    miniVp: '#e2e4e8',
    searchHl: '#2563eb',
    searchActiveBg: 'rgba(37, 99, 235, 0.24)',
    textSelectionBg: 'rgba(173, 214, 255, 0.74)',
    textSelectionEdge: 'rgba(173, 214, 255, 0.50)',
    glassBlur: 'blur(28px) saturate(1.55)',
  },
  hc: {
    bg0: '#000000',
    bg1: '#000000',
    bg2: '#1a1a1a',
    bg3: '#1a1a1a',
    bg4: '#ffffff',
    border: '#ffffff',
    border2: '#ffffff',
    t0: '#ffffff',
    t1: '#ffffff',
    t2: '#00ffff',
    addBg: 'transparent',
    addHl: '#003300',
    addTx: '#00ff00',
    addBrd: '#00ff00',
    delBg: 'transparent',
    delHl: '#330000',
    delTx: '#ff00ff',
    delBrd: '#ff00ff',
    chgBg: 'transparent',
    chgHl: '#333300',
    chgTx: '#ffff00',
    chgBrd: '#ffff00',
    whitespaceBg: '#09162b',
    whitespaceHl: '#18385e',
    whitespaceTx: '#9cc4ff',
    whitespaceBrd: '#82b4ff',
    acc: '#ffff00',
    acc2: '#00ffff',
    versionBase: '#00ffff',
    versionMine: '#ffff00',
    kw: '#ffffff',
    str: '#ffffff',
    num: '#ffffff',
    cmt: '#ffffff',
    punc: '#ffffff',
    lnBg: '#000000',
    lnTx: '#00ffff',
    workbookHeaderBg: '#1a1a1a',
    workbookHeaderBorder: '#7a8791',
    workbookCanvasBg: '#000000',
    workbookCellBg: '#1a1a1a',
    workbookEmptyBg: '#111111',
    workbookMissingBg: '#000000',
    workbookGridBorder: '#3f4952',
    workbookGridBorderStrong: '#56616b',
    scrollThumb: '#ffffff',
    scrollThumbHover: '#ffffff',
    scrollTrack: 'transparent',
    miniAdd: '#00ff00',
    miniDel: '#ff00ff',
    miniVp: '#404040',
    searchHl: '#00ffff',
    searchActiveBg: 'rgba(0, 255, 255, 0.38)',
    textSelectionBg: 'rgba(0, 255, 255, 0.76)',
    textSelectionEdge: 'rgba(0, 255, 255, 0.56)',
    glassBlur: 'blur(0px)',
  },
};

export function getThemeTokensSnapshot(themeKey: ThemeKey): ThemeTokens {
  return STATIC_THEME_TOKENS[themeKey];
}

export function resolveThemeAppearance(tokens: ThemeTokens): ThemeAppearance {
  if (tokens === STATIC_THEME_TOKENS.light) return 'light';
  if (tokens === STATIC_THEME_TOKENS.hc) return 'high-contrast';
  if (tokens === STATIC_THEME_TOKENS.dark) return 'dark';
  if (tokens.bg0.toLowerCase() === '#000000') return 'high-contrast';
  return tokens.t0.toLowerCase() === '#09090b' ? 'light' : 'dark';
}

// ─── 运行时色值读取（Canvas 渲染层专用） ─────────────────────────────────

let cachedKey: ThemeKey | null = null;
let cachedTokens: ThemeTokens | null = null;

function parseHexRGB(hex: string): [number, number, number] | null {
  const raw = hex.slice(1);
  if (raw.length === 3) {
    const r = raw.charAt(0);
    const g = raw.charAt(1);
    const b = raw.charAt(2);
    return [
      parseInt(r + r, 16),
      parseInt(g + g, 16),
      parseInt(b + b, 16),
    ];
  }
  if (raw.length >= 6) {
    return [
      parseInt(raw.slice(0, 2), 16),
      parseInt(raw.slice(2, 4), 16),
      parseInt(raw.slice(4, 6), 16),
    ];
  }
  return null;
}

function blendOnBackground(
  r: number,
  g: number,
  b: number,
  a: number,
  bgRGB: [number, number, number],
): string {
  const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  const rr = r * a + bgRGB[0] * (1 - a);
  const gg = g * a + bgRGB[1] * (1 - a);
  const bb = b * a + bgRGB[2] * (1 - a);
  return `#${toHex(rr)}${toHex(gg)}${toHex(bb)}`;
}

function normalizeColorToHex(value: string, bgRGB: [number, number, number]): string {
  const v = value.trim();

  if (v.startsWith('#')) {
    const raw = v.slice(1);
    if (raw.length === 4) {
      const rc = raw.charAt(0);
      const gc = raw.charAt(1);
      const bc = raw.charAt(2);
      const ac = raw.charAt(3);
      const r = parseInt(rc + rc, 16);
      const g = parseInt(gc + gc, 16);
      const b = parseInt(bc + bc, 16);
      const a = parseInt(ac + ac, 16) / 255;
      if (a < 1) return blendOnBackground(r, g, b, a, bgRGB);
      const toHex = (n: number) => n.toString(16).padStart(2, '0');
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }
    if (raw.length === 3) {
      const expanded = raw.split('').map((ch) => `${ch}${ch}`).join('');
      return `#${expanded.toLowerCase()}`;
    }
    if (raw.length === 8) {
      const r = parseInt(raw.slice(0, 2), 16);
      const g = parseInt(raw.slice(2, 4), 16);
      const b = parseInt(raw.slice(4, 6), 16);
      const a = parseInt(raw.slice(6, 8), 16) / 255;
      if (a < 1) return blendOnBackground(r, g, b, a, bgRGB);
    }
    if (raw.length >= 6) return `#${raw.slice(0, 6).toLowerCase()}`;
    return v;
  }

  const rgbMatch = v.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i,
  );
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    const a = rgbMatch[4] !== undefined ? Number(rgbMatch[4]) : 1;
    if (a < 1) return blendOnBackground(r, g, b, a, bgRGB);
    const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  return v;
}

export function resolveThemeTokensFromCssVariables(
  themeKey: ThemeKey,
  readVariable: (variableName: string) => string,
): ThemeTokens {
  const fallback = getThemeTokensSnapshot(themeKey);
  const bgBaseRaw = readVariable('--bg-base').trim() || fallback.bg0;
  const bgRGB: [number, number, number] = parseHexRGB(bgBaseRaw)
    ?? parseHexRGB(fallback.bg0)
    ?? [0, 0, 0];
  const tokens = {} as ThemeTokens;

  for (const [field, varName] of Object.entries(THEME_VAR_MAP) as [keyof ThemeTokens, string][]) {
    const rawValue = readVariable(varName).trim();
    if (!rawValue) {
      tokens[field] = fallback[field];
      continue;
    }
    tokens[field] = field === 'searchActiveBg' || field === 'textSelectionBg' || field === 'textSelectionEdge'
      ? rawValue
      : normalizeColorToHex(rawValue, bgRGB);
  }

  return tokens;
}

/**
 * 从 DOM 的 `getComputedStyle` 读取当前主题的 CSS Variables。
 *
 * 当当前环境没有 DOM，或 DOM 尚未切换到目标主题类时，
 * 回退到显式 ThemeTokens 快照。
 */
export function getComputedThemeTokens(themeKey: ThemeKey): ThemeTokens {
  if (cachedKey === themeKey && cachedTokens) {
    return cachedTokens;
  }

  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    cachedKey = themeKey;
    cachedTokens = getThemeTokensSnapshot(themeKey);
    return cachedTokens;
  }

  const root = document.documentElement;
  const expectedClass = THEME_CLASS_MAP[themeKey];
  const hasExpectedClass = root.classList.contains(expectedClass) || root.className === expectedClass;
  if (!hasExpectedClass) {
    cachedKey = themeKey;
    cachedTokens = getThemeTokensSnapshot(themeKey);
    return cachedTokens;
  }

  const style = getComputedStyle(root);
  const tokens = resolveThemeTokensFromCssVariables(
    themeKey,
    (variableName) => style.getPropertyValue(variableName),
  );

  cachedKey = themeKey;
  cachedTokens = tokens;
  return cachedTokens;
}

export function invalidateThemeTokensCache(): void {
  cachedKey = null;
  cachedTokens = null;
}

export function makeTokenColors(themeKey: ThemeKey): Record<TokenType, string> {
  const T = getComputedThemeTokens(themeKey);
  return {
    keyword: T.kw,
    string: T.str,
    number: T.num,
    comment: T.cmt,
    punctuation: T.punc,
    plain: T.t0,
  };
}
