import test from 'node:test';
import assert from 'node:assert/strict';

import { getThemeTokensSnapshot } from '../src/theme';
const lightTheme = getThemeTokensSnapshot('light');
const darkTheme = getThemeTokensSnapshot('dark');

function relativeLuminance(color: string): number {
  const channels = color.slice(1).match(/../g)?.map((part) => Number.parseInt(part, 16) / 255) ?? [];
  const linear = channels.map((value) => (
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * (linear[0] ?? 0)) + (0.7152 * (linear[1] ?? 0)) + (0.0722 * (linear[2] ?? 0));
}

function contrastRatio(foreground: string, background: string): number {
  const left = relativeLuminance(foreground);
  const right = relativeLuminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

import {
  formatWorkbookVisibleRowNumber,
  resolveWorkbookAccentSurfaceVisual,
  resolveWorkbookAuxBarPalette,
  resolveWorkbookHeaderRowDividerColor,
  resolveWorkbookMiniMapColor,
  resolveWorkbookMiniMapPaint,
  resolveWorkbookOverlayPalette,
  resolveWorkbookRowBorderColor,
  resolveWorkbookRowGutterBackground,
  resolveWorkbookRowLineNumberColor,
  resolveWorkbookRowSelectionAccent,
  resolveWorkbookRowSurfaceBackground,
  resolveWorkbookRowRuleColor,
  resolveWorkbookRegionTone,
  resolveWorkbookVersionIdentityVisual,
} from '../src/utils/workbook/workbookRowVisuals';

test('workbook row visuals use semantic add/delete/mixed colors', () => {
  assert.equal(resolveWorkbookRowBorderColor(lightTheme, 'add'), lightTheme.addBrd);
  assert.equal(resolveWorkbookRowBorderColor(lightTheme, 'delete'), lightTheme.delBrd);
  assert.equal(resolveWorkbookRowBorderColor(lightTheme, 'mixed'), lightTheme.chgBrd);

  assert.equal(resolveWorkbookRowLineNumberColor({
    theme: lightTheme,
    tone: 'add',
    fallbackTone: 'base',
  }), lightTheme.addTx);
  assert.equal(resolveWorkbookRowLineNumberColor({
    theme: lightTheme,
    tone: 'delete',
    fallbackTone: 'mine',
  }), lightTheme.delTx);
  assert.equal(resolveWorkbookRowLineNumberColor({
    theme: lightTheme,
    tone: 'mixed',
    fallbackTone: 'neutral',
  }), lightTheme.chgTx);
});

test('workbook row visuals fall back to side colors for equal rows and support stacked side accents', () => {
  assert.equal(resolveWorkbookRowLineNumberColor({
    theme: lightTheme,
    tone: 'equal',
    fallbackTone: 'base',
  }), `${lightTheme.versionBase}e6`);
  assert.equal(resolveWorkbookRowBorderColor(lightTheme, 'delete', 'mine'), lightTheme.versionMine);
  assert.equal(resolveWorkbookRowRuleColor(lightTheme, 'delete', 'mine'), `${lightTheme.versionMine}88`);
});

test('workbook row visuals resolve region and minimap tones consistently', () => {
  assert.equal(resolveWorkbookRegionTone(true, false), 'delete');
  assert.equal(resolveWorkbookRegionTone(false, true), 'add');
  assert.equal(resolveWorkbookRegionTone(true, true), 'mixed');
  const mixedMiniMapColor = resolveWorkbookMiniMapColor(lightTheme, 'mixed');
  const strictOnlyMiniMapColor = resolveWorkbookMiniMapColor(lightTheme, 'strict-only');
  const mixedMiniMapPaint = resolveWorkbookMiniMapPaint(lightTheme, 'mixed');
  assert.notEqual(mixedMiniMapColor, lightTheme.bg2);
  assert.match(mixedMiniMapColor, /^(#|rgba?\()/i);
  assert.equal(strictOnlyMiniMapColor, lightTheme.whitespaceBrd);
  assert.equal(mixedMiniMapPaint.kind, 'solid');
  assert.equal(mixedMiniMapPaint.color, lightTheme.chgBrd);
});

test('workbook row visuals resolve row surface, selection accent and gutter background consistently', () => {
  assert.equal(resolveWorkbookRowSurfaceBackground({
    theme: lightTheme,
    isGuided: true,
    isActiveSearch: false,
    isSearchMatch: false,
  }), `${lightTheme.acc2}08`);
  assert.equal(resolveWorkbookRowSurfaceBackground({
    theme: lightTheme,
    isGuided: false,
    isActiveSearch: true,
    isSearchMatch: false,
  }), lightTheme.searchActiveBg);
  assert.equal(resolveWorkbookRowSurfaceBackground({
    theme: lightTheme,
    isGuided: false,
    isActiveSearch: false,
    isSearchMatch: false,
    isHeaderRow: true,
  }), lightTheme.workbookHeaderBg);
  assert.equal(resolveWorkbookRowSelectionAccent(lightTheme, 'mine'), lightTheme.versionMine);
  assert.equal(resolveWorkbookRowGutterBackground({
    theme: lightTheme,
    selectionAccent: lightTheme.acc,
    isSelected: true,
  }), `${lightTheme.acc}40`);
  assert.equal(resolveWorkbookRowGutterBackground({
    theme: lightTheme,
    selectionAccent: lightTheme.acc,
    isSelected: false,
    isHeaderRow: true,
  }), lightTheme.workbookHeaderBg);
  assert.equal(resolveWorkbookRowGutterBackground({
    theme: lightTheme,
    selectionAccent: lightTheme.versionBase,
    isSelected: false,
    versionSide: 'base',
  }), `${lightTheme.versionBase}32`);
  assert.equal(resolveWorkbookHeaderRowDividerColor(lightTheme), lightTheme.workbookHeaderBorder);
});

test('workbook header surfaces use a restrained cool slate hierarchy in every theme', () => {
  const highContrastTheme = getThemeTokensSnapshot('hc');

  assert.equal(lightTheme.workbookHeaderBg, '#edf4fa');
  assert.equal(lightTheme.workbookHeaderBorder, '#9fb3c4');
  assert.equal(darkTheme.workbookHeaderBg, '#1b2b38');
  assert.equal(darkTheme.workbookHeaderBorder, '#557085');
  assert.equal(highContrastTheme.workbookHeaderBg, '#1a1a1a');
  assert.equal(highContrastTheme.workbookHeaderBorder, '#7a8791');
  assert.equal(highContrastTheme.workbookGridBorder, '#3f4952');
  assert.equal(highContrastTheme.workbookGridBorderStrong, '#56616b');
  assert.ok(contrastRatio(lightTheme.t0, lightTheme.workbookHeaderBg) >= 4.5);
  assert.ok(contrastRatio(darkTheme.t0, darkTheme.workbookHeaderBg) >= 4.5);
  assert.ok(contrastRatio(highContrastTheme.workbookGridBorder, highContrastTheme.bg0) >= 2);
  assert.ok(contrastRatio(highContrastTheme.workbookGridBorderStrong, highContrastTheme.bg0) >= 3);
  assert.ok(contrastRatio(highContrastTheme.workbookHeaderBorder, highContrastTheme.bg0) >= 4.5);
  assert.ok(
    contrastRatio(highContrastTheme.workbookGridBorderStrong, highContrastTheme.bg0)
    < contrastRatio(highContrastTheme.t0, highContrastTheme.bg0),
  );
  assert.equal(
    resolveWorkbookRowBorderColor(highContrastTheme, 'equal'),
    highContrastTheme.workbookGridBorderStrong,
  );
});

test('version accents use distinct blue and gold colors with accessible theme contrast', () => {
  assert.equal(lightTheme.acc, '#246fae');
  assert.equal(lightTheme.acc2, '#007a86');
  assert.equal(darkTheme.acc, '#8ab8e3');
  assert.equal(darkTheme.acc2, '#76c7d2');
  assert.equal(lightTheme.versionBase, '#246fae');
  assert.equal(lightTheme.versionMine, '#8d6200');
  assert.equal(darkTheme.versionBase, '#8ab8e3');
  assert.equal(darkTheme.versionMine, '#e6c95a');
  assert.ok(contrastRatio(lightTheme.versionBase, '#ffffff') >= 4.5);
  assert.ok(contrastRatio(lightTheme.versionMine, '#ffffff') >= 4.5);
  assert.ok(contrastRatio(darkTheme.versionBase, '#09090b') >= 4.5);
  assert.ok(contrastRatio(darkTheme.versionMine, '#09090b') >= 4.5);
  assert.ok(contrastRatio(lightTheme.versionBase, lightTheme.addBg) >= 4.5);
  assert.ok(contrastRatio(lightTheme.versionMine, lightTheme.delBg) >= 4.5);
  assert.ok(contrastRatio(darkTheme.versionBase, darkTheme.bg0) >= 4.5);
  assert.ok(contrastRatio(darkTheme.versionMine, darkTheme.bg0) >= 4.5);
});

test('semantic diff palette stays green red and yellow with accessible text contrast', () => {
  assert.equal(lightTheme.addBrd, '#238f4b');
  assert.equal(lightTheme.delBrd, '#d94b43');
  assert.equal(lightTheme.chgBrd, '#b47700');
  assert.ok(contrastRatio(lightTheme.addTx, lightTheme.addBg) >= 4.5);
  assert.ok(contrastRatio(lightTheme.delTx, lightTheme.delBg) >= 4.5);
  assert.ok(contrastRatio(lightTheme.chgTx, lightTheme.chgBg) >= 4.5);
  assert.ok(contrastRatio(darkTheme.addTx, darkTheme.addBg) >= 4.5);
  assert.ok(contrastRatio(darkTheme.delTx, darkTheme.delBg) >= 4.5);
  assert.ok(contrastRatio(darkTheme.chgTx, darkTheme.chgBg) >= 4.5);
});

test('workbook aux bar palette follows semantic tones', () => {
  const palette = resolveWorkbookAuxBarPalette(lightTheme, 'mixed');
  assert.equal(palette.border, `${lightTheme.chgBrd}66`);
  assert.equal(palette.accent, lightTheme.chgBrd);
  assert.equal(palette.buttonBorder, `${lightTheme.chgBrd}55`);
  assert.equal(palette.buttonText, lightTheme.chgTx);
});

test('workbook overlay outlines use semantic border colors', () => {
  const added = resolveWorkbookOverlayPalette(lightTheme, 'add');
  const deleted = resolveWorkbookOverlayPalette(lightTheme, 'delete');
  const modified = resolveWorkbookOverlayPalette(lightTheme, 'mixed');

  assert.equal(added.mid, lightTheme.addBrd);
  assert.equal(deleted.mid, lightTheme.delBrd);
  assert.equal(modified.mid, lightTheme.chgBrd);
  assert.equal(modified.continuation, `${lightTheme.chgBrd}38`);
  assert.equal(modified.shine, `${lightTheme.chgBrd}44`);
});

test('workbook visible row labels expose sparse row gaps without materializing blank rows', () => {
  assert.equal(formatWorkbookVisibleRowNumber(2, 1), '2');
  assert.equal(formatWorkbookVisibleRowNumber(682, 1), '⋯ 682');
  assert.equal(formatWorkbookVisibleRowNumber(1, null), '1');
});

test('workbook accent surface visuals expose shared badge and button tokens', () => {
  assert.deepEqual(resolveWorkbookAccentSurfaceVisual(lightTheme.acc2), {
    background: `${lightTheme.acc2}18`,
    border: 'transparent',
    textColor: lightTheme.acc2,
  });
  assert.deepEqual(resolveWorkbookAccentSurfaceVisual(lightTheme.acc, 'button'), {
    background: `${lightTheme.acc}16`,
    border: `${lightTheme.acc}55`,
    textColor: lightTheme.acc,
  });
});

test('workbook version identity keeps body cells neutral and tints only headers', () => {
  assert.deepEqual(resolveWorkbookVersionIdentityVisual(lightTheme, 'base', false), {
    overlay: null,
    rail: null,
    railWidth: 0,
  });
  assert.deepEqual(resolveWorkbookVersionIdentityVisual(lightTheme, 'mine', true), {
    overlay: null,
    rail: null,
    railWidth: 0,
  });
  assert.deepEqual(resolveWorkbookVersionIdentityVisual(lightTheme, 'base', false, 'header'), {
    overlay: `${lightTheme.versionBase}24`,
    rail: null,
    railWidth: 0,
  });
  assert.deepEqual(resolveWorkbookVersionIdentityVisual(darkTheme, 'mine', false), {
    overlay: null,
    rail: null,
    railWidth: 0,
  });
});
