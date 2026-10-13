import type { WorkbookRowDeltaTone } from '@/types';
import type { ThemeTokens } from '@/theme/tokens';
import { resolveThemeAppearance } from '@/theme';
import type { LineNumberTone } from '@/utils/diff/lineNumberTone';
import { resolveDiffIndicatorThemeVisual } from '@/utils/diff/diffIndicatorVisuals';
import {
  resolveDiffMiniMapPaint,
} from '@/utils/diff/minimapColors';

type WorkbookRowSideAccent = 'base' | 'mine' | null;
export type WorkbookRowSemanticTone = WorkbookRowDeltaTone | 'neutral';
export type WorkbookMiniMapSemanticTone = WorkbookRowSemanticTone | 'modify' | 'strict-only';

export interface WorkbookMiniMapPaint {
  kind: 'solid' | 'gradient';
  color?: string;
  stops?: Array<{ offset: number; color: string }>;
}

function normalizeWorkbookRowTone(tone: WorkbookRowSemanticTone): WorkbookRowDeltaTone {
  return tone === 'neutral' ? 'equal' : tone;
}

function resolveWorkbookSemanticDiffVisual(
  theme: ThemeTokens,
  tone: WorkbookRowSemanticTone,
) {
  const semanticTone = normalizeWorkbookRowTone(tone);
  if (semanticTone === 'equal') return null;
  return resolveDiffIndicatorThemeVisual(
    theme,
    semanticTone === 'mixed' ? 'modify' : semanticTone,
    'strong',
  );
}

export function resolveWorkbookVersionAccent(
  theme: ThemeTokens,
  side: 'base' | 'mine',
): string {
  return side === 'base' ? theme.versionBase : theme.versionMine;
}

export interface WorkbookVersionIdentityVisual {
  overlay: string | null;
  rail: string | null;
  railWidth: number;
}

export function resolveWorkbookVersionIdentityVisual(
  theme: ThemeTokens,
  side: 'base' | 'mine',
  hasSemanticDiff: boolean,
  surface: 'body' | 'header' = 'body',
): WorkbookVersionIdentityVisual {
  const isHighContrast = resolveThemeAppearance(theme) === 'high-contrast';
  if (hasSemanticDiff || isHighContrast || surface === 'body') {
    return {
      overlay: null,
      rail: null,
      railWidth: 0,
    };
  }

  const overlayAlpha = isLightWorkbookTheme(theme) ? '24' : '1a';
  return {
    overlay: `${resolveWorkbookVersionAccent(theme, side)}${overlayAlpha}`,
    rail: null,
    railWidth: 0,
  };
}

function getWorkbookSideAccent(theme: ThemeTokens, sideAccent: Exclude<WorkbookRowSideAccent, null>): string {
  return resolveWorkbookVersionAccent(theme, sideAccent);
}

function withHexAlpha(color: string, hexAlpha: string): string {
  return color.startsWith('#') && color.length === 7 ? `${color}${hexAlpha}` : color;
}

function isLightWorkbookTheme(theme: ThemeTokens): boolean {
  return resolveThemeAppearance(theme) === 'light';
}

export function mergeWorkbookSemanticTone(
  left: WorkbookRowSemanticTone | undefined,
  right: WorkbookRowSemanticTone | undefined,
): WorkbookRowSemanticTone | undefined {
  if (!left) return right;
  if (!right) return left;
  const normalizedLeft = normalizeWorkbookRowTone(left);
  const normalizedRight = normalizeWorkbookRowTone(right);
  if (normalizedLeft === normalizedRight) return normalizedLeft;
  if (normalizedLeft === 'equal') return normalizedRight;
  if (normalizedRight === 'equal') return normalizedLeft;
  return 'mixed';
}

export function resolveWorkbookRegionTone(
  hasBaseSide: boolean,
  hasMineSide: boolean,
): WorkbookRowDeltaTone {
  if (hasBaseSide && hasMineSide) return 'mixed';
  if (hasMineSide) return 'add';
  if (hasBaseSide) return 'delete';
  return 'equal';
}

export function resolveWorkbookRowSurfaceBackground(params: {
  theme: ThemeTokens;
  isGuided: boolean;
  isActiveSearch: boolean;
  isSearchMatch: boolean;
  isHeaderRow?: boolean;
}): string {
  const {
    theme,
    isGuided,
    isActiveSearch,
    isSearchMatch,
    isHeaderRow = false,
  } = params;

  if (isGuided) return `${theme.acc2}08`;
  if (isActiveSearch) return theme.searchActiveBg;
  if (isSearchMatch) return `${theme.searchHl}24`;
  if (isHeaderRow) return theme.workbookHeaderBg;
  return theme.workbookCanvasBg;
}

export function resolveWorkbookHeaderRowDividerColor(theme: ThemeTokens): string {
  return theme.workbookHeaderBorder;
}

export function formatWorkbookVisibleRowNumber(
  rowNumber: number,
  previousVisibleRowNumber: number | null,
): string {
  if (rowNumber <= 0) return '';
  if (
    previousVisibleRowNumber != null
    && previousVisibleRowNumber > 0
    && rowNumber > previousVisibleRowNumber + 1
  ) {
    return `⋯ ${rowNumber}`;
  }
  return String(rowNumber);
}

export function resolveWorkbookRowSelectionAccent(
  theme: ThemeTokens,
  side: 'base' | 'mine',
): string {
  return resolveWorkbookVersionAccent(theme, side);
}

export interface WorkbookAccentSurfaceVisual {
  background: string;
  border: string;
  textColor: string;
}

export function resolveWorkbookAccentSurfaceVisual(
  accent: string,
  variant: 'badge' | 'button' = 'badge',
): WorkbookAccentSurfaceVisual {
  if (variant === 'button') {
    return {
      background: `${accent}16`,
      border: `${accent}55`,
      textColor: accent,
    };
  }

  return {
    background: `${accent}18`,
    border: 'transparent',
    textColor: accent,
  };
}

export function resolveWorkbookAuxBarPalette(
  theme: ThemeTokens,
  tone: WorkbookRowSemanticTone = 'mixed',
): {
  background: string;
  border: string;
  accent: string;
  buttonBorder: string;
  buttonText: string;
  labelText: string;
  subduedText: string;
} {
  const semanticVisual = resolveWorkbookSemanticDiffVisual(theme, tone);
  if (semanticVisual) {
    return {
      background: `linear-gradient(180deg, ${theme.bg2} 0%, ${theme.bg1} 100%)`,
      border: `${semanticVisual.border}66`,
      accent: semanticVisual.border,
      buttonBorder: `${semanticVisual.border}55`,
      buttonText: semanticVisual.textColor,
      labelText: semanticVisual.textColor,
      subduedText: theme.t2,
    };
  }
  return {
    background: `linear-gradient(180deg, ${theme.bg2} 0%, ${theme.bg1} 100%)`,
    border: `${theme.border}66`,
    accent: theme.acc2,
    buttonBorder: `${theme.border}88`,
    buttonText: theme.t1,
    labelText: theme.t1,
    subduedText: theme.t2,
  };
}

export function resolveWorkbookRowGutterBackground(params: {
  theme: ThemeTokens;
  selectionAccent: string;
  isSelected: boolean;
  isHeaderRow?: boolean;
  versionSide?: 'base' | 'mine' | null;
}): string {
  const {
    theme,
    selectionAccent,
    isSelected,
    isHeaderRow = false,
    versionSide = null,
  } = params;
  if (isSelected) return `${selectionAccent}${isLightWorkbookTheme(theme) ? '40' : '26'}`;
  if (isHeaderRow) return theme.workbookHeaderBg;
  if (versionSide) {
    return `${resolveWorkbookVersionAccent(theme, versionSide)}${isLightWorkbookTheme(theme) ? '32' : '20'}`;
  }
  return theme.lnBg;
}

export function resolveWorkbookRowBorderColor(
  theme: ThemeTokens,
  tone: WorkbookRowSemanticTone,
  sideAccent: WorkbookRowSideAccent = null,
): string {
  if (sideAccent) return getWorkbookSideAccent(theme, sideAccent);
  return resolveWorkbookSemanticDiffVisual(theme, tone)?.border
    ?? theme.workbookGridBorderStrong;
}

export function resolveWorkbookRowRuleColor(
  theme: ThemeTokens,
  tone: WorkbookRowSemanticTone,
  sideAccent: WorkbookRowSideAccent = null,
): string {
  if (!sideAccent) return resolveWorkbookRowBorderColor(theme, tone, sideAccent);
  return `${getWorkbookSideAccent(theme, sideAccent)}${isLightWorkbookTheme(theme) ? '88' : '66'}`;
}

export function resolveWorkbookRowLineNumberColor(params: {
  theme: ThemeTokens;
  tone: WorkbookRowSemanticTone;
  fallbackTone: LineNumberTone;
  active?: boolean;
}): string {
  const {
    theme,
    tone,
    fallbackTone,
    active = false,
  } = params;
  const semanticVisual = resolveWorkbookSemanticDiffVisual(theme, tone);
  if (semanticVisual) return semanticVisual.textColor;
  const inactiveVersionAlpha = isLightWorkbookTheme(theme) ? 'e6' : 'bf';
  if (fallbackTone === 'base') return active ? theme.versionBase : withHexAlpha(theme.versionBase, inactiveVersionAlpha);
  if (fallbackTone === 'mine') return active ? theme.versionMine : withHexAlpha(theme.versionMine, inactiveVersionAlpha);
  return active ? theme.acc2 : theme.lnTx;
}

export function resolveWorkbookMiniMapPaint(
  theme: ThemeTokens,
  tone: WorkbookMiniMapSemanticTone,
): WorkbookMiniMapPaint {
  if (tone === 'strict-only') {
    return {
      kind: 'solid',
      color: theme.whitespaceBrd,
    };
  }

  if (tone === 'modify') {
    return resolveDiffMiniMapPaint(theme, 'modify');
  }

  const semanticTone = normalizeWorkbookRowTone(tone);
  if (semanticTone === 'mixed') {
    return resolveDiffMiniMapPaint(theme, 'modify');
  }

  if (semanticTone !== 'equal') {
    return resolveDiffMiniMapPaint(theme, semanticTone);
  }

  return {
    kind: 'solid',
    color: theme.bg2,
  };
}

export function resolveWorkbookMiniMapColor(
  theme: ThemeTokens,
  tone: WorkbookMiniMapSemanticTone,
): string {
  const paint = resolveWorkbookMiniMapPaint(theme, tone);
  if (paint.kind === 'solid') return paint.color ?? theme.bg2;
  return paint.stops?.[1]?.color ?? resolveDiffMiniMapPaint(theme, 'modify').color ?? theme.chgBrd;
}

export function resolveWorkbookOverlayPalette(
  theme: ThemeTokens,
  tone: WorkbookRowSemanticTone,
): {
  left: string;
  right: string;
  mid: string;
  continuation: string;
  shine: string;
} {
  const semanticTone = normalizeWorkbookRowTone(tone);
  const semanticVisual = resolveWorkbookSemanticDiffVisual(theme, tone);
  if (semanticTone === 'add') {
    return {
      left: semanticVisual?.border ?? theme.addBrd,
      right: semanticVisual?.border ?? theme.addBrd,
      mid: semanticVisual?.border ?? theme.addBrd,
      continuation: `${semanticVisual?.border ?? theme.addBrd}38`,
      shine: `${semanticVisual?.border ?? theme.addBrd}44`,
    };
  }
  if (semanticTone === 'delete') {
    return {
      left: semanticVisual?.border ?? theme.delBrd,
      right: semanticVisual?.border ?? theme.delBrd,
      mid: semanticVisual?.border ?? theme.delBrd,
      continuation: `${semanticVisual?.border ?? theme.delBrd}38`,
      shine: `${semanticVisual?.border ?? theme.delBrd}44`,
    };
  }
  if (semanticTone === 'mixed') {
    return {
      left: theme.versionBase,
      right: theme.versionMine,
      mid: semanticVisual?.border ?? theme.chgBrd,
      continuation: `${semanticVisual?.border ?? theme.chgBrd}38`,
      shine: `${semanticVisual?.border ?? theme.chgBrd}44`,
    };
  }
  return {
    left: theme.workbookGridBorderStrong,
    right: theme.workbookGridBorderStrong,
    mid: theme.t1,
    continuation: `${theme.workbookGridBorderStrong}28`,
    shine: `${theme.t1}2e`,
  };
}
