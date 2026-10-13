import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWorkbookSplitRowCompareState } from '../src/utils/workbook/workbookCompare';
import { computeWorkbookDiff } from '../src/engine/workbook/workbookDiff';
import { createWorkbookRowLine, createWorkbookSheetLine } from '../src/utils/workbook/workbookDisplay';
import { getWorkbookSections } from '../src/utils/workbook/workbookSections';
import {
  buildWorkbookSectionRowIndex,
} from '../src/utils/workbook/workbookSheetIndex';
import { buildWorkbookSheetPresentation } from '../src/utils/workbook/workbookMeta';
import {
  buildWorkbookCompareCellsMaps,
  buildWorkbookRowEntryMaps,
} from '../src/utils/workbook/workbookPanelHelpers';
import { getWorkbookCollapsibleSheetView } from '../src/utils/workbook/workbookSheetViewCache';
import {
  buildWorkbookCacheSignature,
  getWorkbookSharedCacheEntry,
  setWorkbookSharedCacheEntry,
} from '../src/utils/workbook/workbookSharedCache';
import type { SplitRow } from '../src/types/view';
import type { WorkbookRowDelta } from '../src/types/workbook';

function buildPrecomputedRowDelta(columnCount = 8): WorkbookRowDelta {
  const cellDeltas = new Map<number, WorkbookRowDelta['cellDeltas'] extends Map<number, infer T> ? T : never>();

  for (let column = 0; column < columnCount; column += 1) {
    cellDeltas.set(column, {
      column,
      baseCell: { value: `base-${column}`, formula: '' },
      mineCell: { value: column % 2 === 0 ? `base-${column}` : `mine-${column}`, formula: '' },
      changed: column % 2 === 1,
      masked: column % 2 === 0,
      strictOnly: false,
      kind: column % 2 === 1 ? 'modify' : 'equal',
      hasBaseContent: true,
      hasMineContent: true,
      hasContent: true,
    });
  }

  const deltas = [...cellDeltas.values()];
  return {
    cellDeltas,
    changedColumns: deltas.filter(delta => delta.changed).map(delta => delta.column),
    strictOnlyColumns: [],
    changedCount: deltas.filter(delta => delta.changed).length,
    hasChanges: deltas.some(delta => delta.changed),
    tone: 'mixed',
  };
}

test('buildWorkbookSplitRowCompareState reuses cached subset deltas for repeated visible-column requests', () => {
  const row: SplitRow = {
    left: null,
    right: null,
    lineIdx: 10,
    lineIdxs: [10],
    workbookRowDelta: buildPrecomputedRowDelta(),
  };
  const visibleColumns = [1, 3, 5, 7];

  const first = buildWorkbookSplitRowCompareState(row, visibleColumns, 'strict');
  const second = buildWorkbookSplitRowCompareState(row, visibleColumns, 'strict');

  assert.equal(first, second);
  assert.deepEqual(first.changedColumns, visibleColumns);
  assert.equal(first.changedCount, visibleColumns.length);
  assert.equal(first.miniMapTone, 'modify');
  assert.deepEqual(first.miniMapPaintTones, ['modify']);
});

test('buildWorkbookSplitRowCompareState keeps different visible-column subsets isolated', () => {
  const row: SplitRow = {
    left: null,
    right: null,
    lineIdx: 11,
    lineIdxs: [11],
    workbookRowDelta: buildPrecomputedRowDelta(),
  };

  const oddColumns = buildWorkbookSplitRowCompareState(row, [1, 3, 5, 7], 'strict');
  const mixedColumns = buildWorkbookSplitRowCompareState(row, [0, 1, 2], 'strict');

  assert.notEqual(oddColumns, mixedColumns);
  assert.deepEqual(oddColumns.changedColumns, [1, 3, 5, 7]);
  assert.deepEqual(mixedColumns.changedColumns, [1]);
  assert.equal(mixedColumns.changedCount, 1);
});

test('buildWorkbookSectionRowIndex reuses cached result for identical inputs', () => {
  const base = [
    createWorkbookSheetLine('Thing'),
    createWorkbookRowLine(1, ['ID', 'Name']),
    createWorkbookRowLine(2, ['1001', 'Alice']),
  ].join('\n');
  const mine = [
    createWorkbookSheetLine('Thing'),
    createWorkbookRowLine(1, ['ID', 'Name']),
    createWorkbookRowLine(2, ['1001', 'Alicia']),
  ].join('\n');
  const diffLines = computeWorkbookDiff(base, mine, 'strict');
  const sections = getWorkbookSections(diffLines, 'strict');

  const first = buildWorkbookSectionRowIndex(diffLines, sections, 'strict');
  const second = buildWorkbookSectionRowIndex(diffLines, sections, 'strict');

  assert.equal(first, second);
});

test('buildWorkbookSectionRowIndex memoizes requested section rows independently per sheet', () => {
  const base = [
    createWorkbookSheetLine('Thing'),
    createWorkbookRowLine(1, ['ID', 'Name']),
    createWorkbookRowLine(2, ['1001', 'Alice']),
    createWorkbookSheetLine('Other'),
    createWorkbookRowLine(1, ['ID', 'Status']),
    createWorkbookRowLine(2, ['2001', 'Open']),
  ].join('\n');
  const mine = [
    createWorkbookSheetLine('Thing'),
    createWorkbookRowLine(1, ['ID', 'Name']),
    createWorkbookRowLine(2, ['1001', 'Alicia']),
    createWorkbookSheetLine('Other'),
    createWorkbookRowLine(1, ['ID', 'Status']),
    createWorkbookRowLine(2, ['2001', 'Closed']),
  ].join('\n');
  const diffLines = computeWorkbookDiff(base, mine, 'strict');
  const sections = getWorkbookSections(diffLines, 'strict');

  const rowIndex = buildWorkbookSectionRowIndex(diffLines, sections, 'strict');
  const firstThing = rowIndex.get('Thing');
  const secondThing = rowIndex.get('Thing');
  const firstOther = rowIndex.get('Other');
  const secondOther = rowIndex.get('Other');

  assert.equal(firstThing, secondThing);
  assert.equal(firstOther, secondOther);
  assert.notEqual(firstThing, firstOther);
  assert.equal(firstThing?.rows.length, 2);
  assert.equal(firstOther?.rows.length, 2);
});

test('buildWorkbookSheetPresentation reuses cached result for identical inputs', () => {
  const base = [
    createWorkbookSheetLine('Thing'),
    createWorkbookRowLine(1, ['ID', 'Name']),
    createWorkbookRowLine(2, ['1001', 'Alice']),
  ].join('\n');
  const mine = [
    createWorkbookSheetLine('Thing'),
    createWorkbookRowLine(1, ['ID', 'Name']),
    createWorkbookRowLine(2, ['1001', 'Alicia']),
  ].join('\n');
  const diffLines = computeWorkbookDiff(base, mine, 'strict');
  const sections = getWorkbookSections(diffLines, 'strict');
  const rows = buildWorkbookSectionRowIndex(diffLines, sections, 'strict').get('Thing')?.rows ?? [];

  const first = buildWorkbookSheetPresentation(rows, 'Thing', null, null, 2, false, 'strict', []);
  const second = buildWorkbookSheetPresentation(rows, 'Thing', null, null, 2, false, 'strict', []);

  assert.equal(first, second);
});

test('buildWorkbookRowEntryMaps reuses cached result for identical inputs', () => {
  const base = [
    createWorkbookSheetLine('Thing'),
    createWorkbookRowLine(1, ['ID', 'Name']),
    createWorkbookRowLine(2, ['1001', 'Alice']),
  ].join('\n');
  const mine = [
    createWorkbookSheetLine('Thing'),
    createWorkbookRowLine(1, ['ID', 'Name']),
    createWorkbookRowLine(2, ['1001', 'Alicia']),
  ].join('\n');
  const diffLines = computeWorkbookDiff(base, mine, 'strict');
  const sections = getWorkbookSections(diffLines, 'strict');
  const rows = buildWorkbookSectionRowIndex(diffLines, sections, 'strict').get('Thing')?.rows ?? [];
  const presentation = buildWorkbookSheetPresentation(rows, 'Thing', null, null, 2, false, 'strict', []);

  const first = buildWorkbookRowEntryMaps(rows, 'Thing', 'base', 'mine', presentation.visibleColumns);
  const second = buildWorkbookRowEntryMaps(rows, 'Thing', 'base', 'mine', presentation.visibleColumns);

  assert.equal(first, second);
});

test('buildWorkbookCompareCellsMaps reuses cached result for identical inputs', () => {
  const base = [
    createWorkbookSheetLine('Thing'),
    createWorkbookRowLine(1, ['ID', 'Name']),
    createWorkbookRowLine(2, ['1001', 'Alice']),
  ].join('\n');
  const mine = [
    createWorkbookSheetLine('Thing'),
    createWorkbookRowLine(1, ['ID', 'Name']),
    createWorkbookRowLine(2, ['1001', 'Alicia']),
  ].join('\n');
  const diffLines = computeWorkbookDiff(base, mine, 'strict');
  const sections = getWorkbookSections(diffLines, 'strict');
  const rows = buildWorkbookSectionRowIndex(diffLines, sections, 'strict').get('Thing')?.rows ?? [];
  const presentation = buildWorkbookSheetPresentation(rows, 'Thing', null, null, 2, false, 'strict', []);

  const first = buildWorkbookCompareCellsMaps(rows, presentation.visibleColumns, 'strict');
  const second = buildWorkbookCompareCellsMaps(rows, presentation.visibleColumns, 'strict');

  assert.equal(first, second);
});

test('buildWorkbookCacheSignature keeps boolean cache keys distinct for UI state toggles', () => {
  const collapsedKey = buildWorkbookCacheSignature(['Thing', 120, true, 'expanded']);
  const expandedKey = buildWorkbookCacheSignature(['Thing', 120, false, 'expanded']);

  assert.notEqual(collapsedKey, expandedKey);
});

test('setWorkbookSharedCacheEntry evicts the least recently used entry', () => {
  const bucket = new Map<string, number>();

  setWorkbookSharedCacheEntry(bucket, 'a', 1, 2);
  setWorkbookSharedCacheEntry(bucket, 'b', 2, 2);
  assert.equal(getWorkbookSharedCacheEntry(bucket, 'a'), 1);

  setWorkbookSharedCacheEntry(bucket, 'c', 3, 2);

  assert.equal(bucket.has('a'), true);
  assert.equal(bucket.has('b'), false);
  assert.equal(bucket.has('c'), true);
});

test('getWorkbookCollapsibleSheetView keeps equality strategies isolated in cache', () => {
  const rows: SplitRow[] = [
    { left: null, right: null, lineIdx: 1, lineIdxs: [1] },
    { left: null, right: null, lineIdx: 2, lineIdxs: [2] },
    { left: null, right: null, lineIdx: 3, lineIdxs: [3] },
    { left: null, right: null, lineIdx: 4, lineIdxs: [4] },
  ];
  const hiddenLineIdxSet = new Set<number>();

  const equalView = getWorkbookCollapsibleSheetView({
    sectionRows: rows,
    sheetName: 'Thing',
    hiddenLineIdxSet,
    contextLines: 1,
    blockPrefix: 'thing',
    equalityStrategyKey: 'always-equal',
    isEqualRow: () => true,
  });
  const equalViewAgain = getWorkbookCollapsibleSheetView({
    sectionRows: rows,
    sheetName: 'Thing',
    hiddenLineIdxSet,
    contextLines: 1,
    blockPrefix: 'thing',
    equalityStrategyKey: 'always-equal',
    isEqualRow: () => true,
  });
  const changeView = getWorkbookCollapsibleSheetView({
    sectionRows: rows,
    sheetName: 'Thing',
    hiddenLineIdxSet,
    contextLines: 1,
    blockPrefix: 'thing',
    equalityStrategyKey: 'never-equal',
    isEqualRow: () => false,
  });

  assert.equal(equalView, equalViewAgain);
  assert.notEqual(equalView, changeView);
  assert.equal(equalView.collapsedRowDescriptors.length, 1);
  assert.equal(changeView.collapsedRowDescriptors.length, 0);
});

test('getWorkbookCollapsibleSheetView keeps protected workbook header rows visible while excluding them from collapse blocks', () => {
  const rows: SplitRow[] = [
    { left: null, right: null, lineIdx: 1, lineIdxs: [1] },
    { left: null, right: null, lineIdx: 2, lineIdxs: [2] },
    { left: null, right: null, lineIdx: 3, lineIdxs: [3] },
    { left: null, right: null, lineIdx: 4, lineIdxs: [4] },
  ];

  const view = getWorkbookCollapsibleSheetView({
    sectionRows: rows,
    sheetName: 'Thing',
    protectedLineIdxSet: new Set([1]),
    contextLines: 1,
    blockPrefix: 'thing',
    equalityStrategyKey: 'always-equal',
    isEqualRow: () => true,
  });

  assert.equal(view.visibleRows.length, 4);
  assert.deepEqual(view.visibleRows.map((row) => row.lineIdx), [1, 2, 3, 4]);
  assert.equal(view.rowBlocks[0]?.kind, 'change');
  assert.deepEqual(view.rowBlocks[0]?.rows.map((row) => row.lineIdx), [1]);
  assert.equal(view.collapsedRowDescriptors.length, 1);
});
