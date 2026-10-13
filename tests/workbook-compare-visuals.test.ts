import test from 'node:test';
import assert from 'node:assert/strict';

import { getThemeTokensSnapshot } from '../src/theme';
import { getWorkbookCompareCellsTone } from '../src/utils/workbook/workbookCompareTone';
const lightTheme = getThemeTokensSnapshot('light');
const darkTheme = getThemeTokensSnapshot('dark');

import {
  getWorkbookCompareHintVisual,
  getWorkbookMergeContinuationVisual,
  resolveWorkbookCompareCellKind,
  resolveWorkbookCompareCellVisual,
} from '../src/utils/workbook/workbookCompareVisuals';

const changedCell = {
  column: 2,
  baseCell: { value: 'before', formula: '' },
  mineCell: { value: 'after', formula: '' },
  changed: true,
  masked: false,
};

test('unchanged workbook cells bind directly to the selected light and dark theme surfaces', () => {
  const resolveEqual = (theme: typeof lightTheme) => resolveWorkbookCompareCellVisual({
    theme,
    compareCell: undefined,
    side: 'base',
    hasEntry: true,
    hasContent: true,
    hasBaseRow: true,
    hasMineRow: true,
    defaultTextColor: theme.t0,
  });

  assert.equal(resolveEqual(lightTheme).background, lightTheme.workbookCellBg);
  assert.equal(resolveEqual(lightTheme).border, lightTheme.workbookGridBorderStrong);
  assert.equal(resolveEqual(lightTheme).textColor, lightTheme.t0);
  assert.equal(resolveEqual(darkTheme).background, darkTheme.workbookCellBg);
  assert.equal(resolveEqual(darkTheme).border, darkTheme.workbookGridBorderStrong);
  assert.equal(resolveEqual(darkTheme).textColor, darkTheme.t0);
  assert.notEqual(resolveEqual(lightTheme).background, resolveEqual(darkTheme).background);
});

test('high contrast workbook cells keep a graphite surface without version tinting', () => {
  const highContrastTheme = getThemeTokensSnapshot('hc');
  const visual = resolveWorkbookCompareCellVisual({
    theme: highContrastTheme,
    compareCell: undefined,
    side: 'base',
    hasEntry: true,
    hasContent: true,
    hasBaseRow: true,
    hasMineRow: true,
    defaultTextColor: highContrastTheme.t0,
  });

  assert.equal(visual.background, highContrastTheme.workbookCellBg);
  assert.equal(visual.border, highContrastTheme.workbookGridBorderStrong);
});

test('unchanged workbook header cells share one neutral slate surface regardless of content', () => {
  const contentVisual = resolveWorkbookCompareCellVisual({
    theme: lightTheme,
    compareCell: undefined,
    side: 'base',
    isHeaderRow: true,
    hasEntry: true,
    hasContent: true,
    hasBaseRow: true,
    hasMineRow: true,
    defaultTextColor: lightTheme.t1,
  });
  const emptyVisual = resolveWorkbookCompareCellVisual({
    theme: lightTheme,
    compareCell: undefined,
    side: 'base',
    isHeaderRow: true,
    hasEntry: true,
    hasContent: false,
    hasBaseRow: true,
    hasMineRow: true,
    defaultTextColor: lightTheme.t1,
  });

  assert.equal(contentVisual.background, lightTheme.workbookHeaderBg);
  assert.equal(emptyVisual.background, lightTheme.workbookHeaderBg);
  assert.equal(contentVisual.textColor, lightTheme.t0);
});

test('changed workbook header cells keep semantic diff colors ahead of the header tint', () => {
  const modifiedHeader = resolveWorkbookCompareCellVisual({
    theme: lightTheme,
    compareCell: changedCell,
    side: 'base',
    isHeaderRow: true,
    hasEntry: true,
    hasContent: true,
    hasBaseRow: true,
    hasMineRow: true,
    defaultTextColor: lightTheme.t1,
  });
  const deletedHeader = resolveWorkbookCompareCellVisual({
    theme: lightTheme,
    compareCell: {
      ...changedCell,
      baseCell: { value: 'Removed title', formula: '' },
      mineCell: { value: '', formula: '' },
    },
    compareMode: 'strict',
    side: 'base',
    isHeaderRow: true,
    hasEntry: true,
    hasContent: true,
    hasBaseRow: true,
    hasMineRow: true,
    defaultTextColor: lightTheme.t1,
  });

  assert.equal(modifiedHeader.background, lightTheme.chgBg);
  assert.equal(modifiedHeader.border, lightTheme.chgBrd);
  assert.equal(deletedHeader.background, lightTheme.delBg);
  assert.equal(deletedHeader.border, lightTheme.delBrd);
});

test('paired workbook changes use the yellow modify palette', () => {
  const visual = resolveWorkbookCompareCellVisual({
    theme: lightTheme,
    compareCell: changedCell,
    side: 'base',
    hasEntry: true,
    hasContent: true,
    hasBaseRow: true,
    hasMineRow: true,
    defaultTextColor: lightTheme.t1,
  });

  assert.deepEqual(visual, {
    background: lightTheme.chgBg,
    border: lightTheme.chgBrd,
    textColor: lightTheme.chgTx,
    maskOverlay: null,
  });
});

test('stacked paired workbook changes can use the base side accent palette', () => {
  const visual = resolveWorkbookCompareCellVisual({
    theme: lightTheme,
    compareCell: changedCell,
    side: 'base',
    modifyColorMode: 'side-accent',
    hasEntry: true,
    hasContent: true,
    hasBaseRow: true,
    hasMineRow: true,
    defaultTextColor: lightTheme.t1,
  });

  assert.deepEqual(visual, {
    background: `${lightTheme.versionBase}1f`,
    border: `${lightTheme.versionBase}8c`,
    textColor: lightTheme.versionBase,
    maskOverlay: null,
  });
});

test('stacked paired workbook changes can use the mine side accent palette', () => {
  const visual = resolveWorkbookCompareCellVisual({
    theme: lightTheme,
    compareCell: changedCell,
    side: 'mine',
    modifyColorMode: 'side-accent',
    hasEntry: true,
    hasContent: true,
    hasBaseRow: true,
    hasMineRow: true,
    defaultTextColor: lightTheme.t0,
  });

  assert.deepEqual(visual, {
    background: `${lightTheme.versionMine}1f`,
    border: `${lightTheme.versionMine}8c`,
    textColor: lightTheme.versionMine,
    maskOverlay: null,
  });
});

test('strict-only workbook changes use the blue whitespace palette', () => {
  const visual = resolveWorkbookCompareCellVisual({
    theme: lightTheme,
    compareCell: {
      ...changedCell,
      baseCell: { value: ' ', formula: '' },
      mineCell: { value: '', formula: '' },
      strictOnly: true,
      kind: 'delete',
    },
    side: 'base',
    hasEntry: true,
    hasContent: true,
    hasBaseRow: true,
    hasMineRow: true,
    defaultTextColor: lightTheme.t1,
  });

  assert.deepEqual(visual, {
    background: lightTheme.whitespaceBg,
    border: lightTheme.whitespaceBrd,
    textColor: lightTheme.whitespaceTx,
    maskOverlay: null,
  });
});

test('single-sided workbook additions keep add semantics', () => {
  const visual = resolveWorkbookCompareCellVisual({
    theme: lightTheme,
    compareCell: changedCell,
    side: 'mine',
    hasEntry: true,
    hasContent: true,
    hasBaseRow: false,
    hasMineRow: true,
    defaultTextColor: lightTheme.t0,
  });

  assert.deepEqual(visual, {
    background: lightTheme.addBg,
    border: lightTheme.addBrd,
    textColor: lightTheme.addTx,
    maskOverlay: null,
  });
});

test('single-sided workbook deletions keep delete semantics', () => {
  const visual = resolveWorkbookCompareCellVisual({
    theme: lightTheme,
    compareCell: changedCell,
    side: 'base',
    hasEntry: true,
    hasContent: true,
    hasBaseRow: true,
    hasMineRow: false,
    defaultTextColor: lightTheme.t1,
  });

  assert.deepEqual(visual, {
    background: lightTheme.delBg,
    border: lightTheme.delBrd,
    textColor: lightTheme.delTx,
    maskOverlay: null,
  });
});

test('paired workbook deletions use the delete palette when one side becomes empty', () => {
  const visual = resolveWorkbookCompareCellVisual({
    theme: lightTheme,
    compareCell: {
      ...changedCell,
      baseCell: { value: 'before', formula: '' },
      mineCell: { value: '', formula: '' },
    },
    compareMode: 'strict',
    side: 'mine',
    hasEntry: true,
    hasContent: false,
    hasBaseRow: true,
    hasMineRow: true,
    defaultTextColor: lightTheme.t0,
  });

  assert.deepEqual(visual, {
    background: lightTheme.delBg,
    border: lightTheme.delBrd,
    textColor: lightTheme.delTx,
    maskOverlay: null,
  });
});

test('paired workbook additions use the add palette when one side becomes populated', () => {
  const visual = resolveWorkbookCompareCellVisual({
    theme: lightTheme,
    compareCell: {
      ...changedCell,
      baseCell: { value: '', formula: '' },
      mineCell: { value: 'after', formula: '' },
    },
    compareMode: 'strict',
    side: 'mine',
    hasEntry: true,
    hasContent: true,
    hasBaseRow: true,
    hasMineRow: true,
    defaultTextColor: lightTheme.t0,
  });

  assert.deepEqual(visual, {
    background: lightTheme.addBg,
    border: lightTheme.addBrd,
    textColor: lightTheme.addTx,
    maskOverlay: null,
  });
});

test('compare tone marks paired delete-like changes as delete', () => {
  const tone = getWorkbookCompareCellsTone([
    {
      ...changedCell,
      baseCell: { value: 'before', formula: '' },
      mineCell: { value: '', formula: '' },
    },
  ]);

  assert.equal(tone, 'delete');
});

test('compare tone marks paired add-like changes as add', () => {
  const tone = getWorkbookCompareCellsTone([
    {
      ...changedCell,
      baseCell: { value: '', formula: '' },
      mineCell: { value: 'after', formula: '' },
    },
  ]);

  assert.equal(tone, 'add');
});

test('compare tone marks content-preserving value edits as mixed', () => {
  const tone = getWorkbookCompareCellsTone([changedCell]);

  assert.equal(tone, 'mixed');
});

test('masked workbook cells preserve the normal palette and overlay', () => {
  const visual = resolveWorkbookCompareCellVisual({
    theme: lightTheme,
    compareCell: {
      ...changedCell,
      changed: false,
      masked: true,
    },
    side: 'mine',
    hasEntry: true,
    hasContent: true,
    hasBaseRow: true,
    hasMineRow: true,
    defaultTextColor: lightTheme.t0,
  });

  assert.deepEqual(visual, {
    background: lightTheme.workbookCellBg,
    border: lightTheme.workbookGridBorderStrong,
    textColor: lightTheme.t0,
    maskOverlay: `${lightTheme.workbookCellBg}22`,
  });
});

test('compare visuals expose shared semantic hint palettes and merge continuation visuals', () => {
  assert.equal(resolveWorkbookCompareCellKind({
    ...changedCell,
    strictOnly: true,
    kind: 'delete',
  }), 'strict-only');

  assert.deepEqual(getWorkbookCompareHintVisual(lightTheme, 'strict-only'), {
    background: `${lightTheme.whitespaceBrd}14`,
    border: `${lightTheme.whitespaceBrd}66`,
    textColor: lightTheme.whitespaceTx,
  });

  assert.deepEqual(getWorkbookMergeContinuationVisual(lightTheme, lightTheme.delBrd), {
    background: `${lightTheme.workbookCanvasBg}1c`,
    guideStroke: `${lightTheme.delBrd}66`,
  });
});
