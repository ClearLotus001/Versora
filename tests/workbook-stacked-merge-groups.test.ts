import test from 'node:test';
import assert from 'node:assert/strict';

import type { SplitRow, WorkbookMergeRange } from '../src/types';
import type { WorkbookStackedLayoutRow } from '../src/utils/workbook/workbookStackedMergeGroups';
import { buildWorkbookCanvasRuns } from '../src/utils/workbook/workbookCanvasRuns';
import { syncWorkbookCanvasSurface } from '../src/utils/workbook/workbookCanvasSurface';
import {
  buildWorkbookStackedLayoutRows,
  buildWorkbookStackedMergeCoverageWindows,
  buildWorkbookStackedVisualGroups,
  mergeWorkbookStackedCoverageWindows,
} from '../src/utils/workbook/workbookStackedMergeGroups';

function buildSplitRow(params: {
  lineIdx: number;
  baseRowNumber?: number;
  mineRowNumber?: number;
}): SplitRow {
  const { lineIdx, baseRowNumber, mineRowNumber } = params;

  return {
    left: baseRowNumber == null ? null : {
      type: 'delete',
      base: `@@row\t${baseRowNumber}\tB${baseRowNumber}`,
      mine: null,
      baseLineNo: baseRowNumber,
      mineLineNo: null,
      baseCharSpans: null,
      mineCharSpans: null,
    },
    right: mineRowNumber == null ? null : {
      type: 'add',
      base: null,
      mine: `@@row\t${mineRowNumber}\tM${mineRowNumber}`,
      baseLineNo: null,
      mineLineNo: mineRowNumber,
      baseCharSpans: null,
      mineCharSpans: null,
    },
    lineIdx,
    lineIdxs: [lineIdx],
  };
}

test('buildWorkbookStackedMergeCoverageWindows expands a base-side vertical merge across intervening split rows', () => {
  const layoutRows = buildWorkbookStackedLayoutRows({
    rows: [
      { row: buildSplitRow({ lineIdx: 1, baseRowNumber: 28 }), renderMode: 'single-base', height: 24 },
      { row: buildSplitRow({ lineIdx: 2, mineRowNumber: 99 }), renderMode: 'single-mine', height: 24 },
      { row: buildSplitRow({ lineIdx: 3, baseRowNumber: 29 }), renderMode: 'single-base', height: 24 },
    ],
  });

  const windows = buildWorkbookStackedMergeCoverageWindows({
    rows: layoutRows,
    baseMergeRanges: [{ startRow: 28, endRow: 29, startCol: 0, endCol: 0 }],
    mineMergeRanges: [],
  });

  assert.deepEqual(windows, [{
    key: 'base:28:29:0:0',
    side: 'base',
    range: { startRow: 28, endRow: 29, startCol: 0, endCol: 0 },
    startIndex: 0,
    endIndex: 2,
  }]);
});

test('mergeWorkbookStackedCoverageWindows merges overlapping side coverage windows into one visual window', () => {
  const merged = mergeWorkbookStackedCoverageWindows([
    {
      key: 'base:28:29:0:0',
      side: 'base',
      range: { startRow: 28, endRow: 29, startCol: 0, endCol: 0 },
      startIndex: 1,
      endIndex: 3,
    },
    {
      key: 'mine:28:29:0:0',
      side: 'mine',
      range: { startRow: 28, endRow: 29, startCol: 0, endCol: 0 },
      startIndex: 2,
      endIndex: 4,
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.startIndex, 1);
  assert.equal(merged[0]?.endIndex, 4);
  assert.equal(merged[0]?.windows.length, 2);
});

test('buildWorkbookStackedVisualGroups splits plain rows around merge coverage windows', () => {
  const layoutRows = buildWorkbookStackedLayoutRows({
    rows: [
      { row: buildSplitRow({ lineIdx: 1, baseRowNumber: 27 }), renderMode: 'single-base', height: 24 },
      { row: buildSplitRow({ lineIdx: 2, baseRowNumber: 28 }), renderMode: 'single-base', height: 24 },
      { row: buildSplitRow({ lineIdx: 3, mineRowNumber: 99 }), renderMode: 'single-mine', height: 24 },
      { row: buildSplitRow({ lineIdx: 4, baseRowNumber: 29 }), renderMode: 'single-base', height: 24 },
      { row: buildSplitRow({ lineIdx: 5, baseRowNumber: 30 }), renderMode: 'single-base', height: 24 },
    ],
  });

  const groups = buildWorkbookStackedVisualGroups({
    rows: layoutRows,
    baseMergeRanges: [{ startRow: 28, endRow: 29, startCol: 0, endCol: 0 }],
    mineMergeRanges: [],
  });

  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group) => ({
    reason: group.reason,
    startIndex: group.startIndex,
    endIndex: group.endIndex,
  })), [
    { reason: 'plain', startIndex: 0, endIndex: 0 },
    { reason: 'merge', startIndex: 1, endIndex: 3 },
    { reason: 'plain', startIndex: 4, endIndex: 4 },
  ]);
  assert.equal(groups[1]?.baseTrack.length, 2);
  assert.equal(groups[1]?.mineTrack.length, 1);
});

test('buildWorkbookStackedVisualGroups chunks large plain row runs to keep stacked virtualization granular', () => {
  const layoutRows = buildWorkbookStackedLayoutRows({
    rows: Array.from({ length: 600 }, (_, index) => ({
      row: buildSplitRow({ lineIdx: index + 1, baseRowNumber: index + 1 }),
      renderMode: 'single-base' as const,
      height: 24,
    })),
  });

  const groups = buildWorkbookStackedVisualGroups({
    rows: layoutRows,
    baseMergeRanges: [],
    mineMergeRanges: [],
  });

  assert.deepEqual(groups.map((group) => ({
    reason: group.reason,
    startIndex: group.startIndex,
    endIndex: group.endIndex,
  })), [
    { reason: 'plain', startIndex: 0, endIndex: 63 },
    { reason: 'plain', startIndex: 64, endIndex: 127 },
    { reason: 'plain', startIndex: 128, endIndex: 191 },
    { reason: 'plain', startIndex: 192, endIndex: 255 },
    { reason: 'plain', startIndex: 256, endIndex: 319 },
    { reason: 'plain', startIndex: 320, endIndex: 383 },
    { reason: 'plain', startIndex: 384, endIndex: 447 },
    { reason: 'plain', startIndex: 448, endIndex: 511 },
    { reason: 'plain', startIndex: 512, endIndex: 575 },
    { reason: 'plain', startIndex: 576, endIndex: 599 },
  ]);
});

test('buildWorkbookStackedVisualGroups uses rendered row height when chunking double stacked rows', () => {
  const layoutRows = buildWorkbookStackedLayoutRows({
    rows: Array.from({ length: 70 }, (_, index) => ({
      row: buildSplitRow({ lineIdx: index + 1, baseRowNumber: index + 1, mineRowNumber: index + 1 }),
      renderMode: 'double' as const,
      height: 48,
    })),
  });

  const groups = buildWorkbookStackedVisualGroups({
    rows: layoutRows,
    baseMergeRanges: [],
    mineMergeRanges: [],
  });

  assert.deepEqual(groups.map((group) => ({
    reason: group.reason,
    startIndex: group.startIndex,
    endIndex: group.endIndex,
    height: group.rows.reduce((sum, row) => sum + row.height, 0),
  })), [
    { reason: 'plain', startIndex: 0, endIndex: 31, height: 1536 },
    { reason: 'plain', startIndex: 32, endIndex: 63, height: 1536 },
    { reason: 'plain', startIndex: 64, endIndex: 69, height: 288 },
  ]);
});

test('adjacent independent vertical merges remain separate virtual groups', () => {
  const rows = buildWorkbookStackedLayoutRows({
    rows: Array.from({ length: 6 }, (_, index) => ({
      row: buildSplitRow({ lineIdx: index, baseRowNumber: index + 1, mineRowNumber: index + 1 }),
      renderMode: 'double' as const,
      height: 48,
    })),
  });
  const ranges = [1, 3, 5].map((startRow) => ({ startRow, endRow: startRow + 1, startCol: 0, endCol: 0 }));
  const groups = buildWorkbookStackedVisualGroups({ rows, baseMergeRanges: ranges, mineMergeRanges: ranges });

  assert.deepEqual(groups.map((group) => [group.startIndex, group.endIndex]), [[0, 1], [2, 3], [4, 5]]);
  assert.ok(groups.every((group) => group.reason === 'merge'));
});

test('coverage index preserves source extrema with reordered, duplicate and missing side rows', () => {
  const rows: WorkbookStackedLayoutRow[] = [4, 2, null, 3, 5, 2].map((baseRowNumber, index) => ({
    key: String(index),
    row: buildSplitRow({ lineIdx: index }),
    renderMode: 'single-base',
    height: 24,
    baseRowNumber,
    mineRowNumber: null,
  }));
  const windows = buildWorkbookStackedMergeCoverageWindows({
    rows,
    baseMergeRanges: [
      { startRow: 2, endRow: 4, startCol: 0, endCol: 0 },
      { startRow: 7, endRow: 9, startCol: 0, endCol: 0 },
    ],
    mineMergeRanges: [],
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.startIndex, 0);
  assert.equal(windows[0]?.endIndex, 5);
});

test('many merge ranges read source row numbers once instead of scanning every range', () => {
  let sourceReads = 0;
  const rowCount = 20_000;
  const rows: WorkbookStackedLayoutRow[] = Array.from({ length: rowCount }, (_, index) => ({
    key: String(index),
    row: buildSplitRow({ lineIdx: index }),
    renderMode: 'single-base',
    height: 24,
    get baseRowNumber() { sourceReads += 1; return index + 1; },
    mineRowNumber: null,
  }));
  const ranges = Array.from({ length: rowCount / 2 }, (_, index) => ({
    startRow: index * 2 + 1, endRow: index * 2 + 2, startCol: 0, endCol: 0,
  }));
  const windows = buildWorkbookStackedMergeCoverageWindows({ rows, baseMergeRanges: ranges, mineMergeRanges: [] });

  assert.equal(windows.length, ranges.length);
  assert.equal(sourceReads, rowCount);
  assert.equal(windows.at(-1)?.startIndex, rowCount - 2);
  assert.equal(windows.at(-1)?.endIndex, rowCount - 1);
});

test('a real tall merge stays within canvas budgets and preserves every row navigation offset', () => {
  const rowCount = 10_000;
  const rows = buildWorkbookStackedLayoutRows({
    rows: Array.from({ length: rowCount }, (_, index) => ({
      row: buildSplitRow({ lineIdx: index, baseRowNumber: index + 1, mineRowNumber: index + 1 }),
      renderMode: 'double' as const,
      height: 48,
    })),
  });
  const range: WorkbookMergeRange = { startRow: 1, endRow: rowCount, startCol: 0, endCol: 0 };
  const groups = buildWorkbookStackedVisualGroups({ rows, baseMergeRanges: [range], mineMergeRanges: [range] });
  assert.ok(groups.length > 1);
  assert.equal(groups.flatMap((group) => group.rows).length, rowCount);
  let groupTop = 0;
  for (const group of groups) {
    const height = group.rows.reduce((sum, row) => sum + row.height, 0);
    assert.ok(height <= 1536);
    assert.equal(group.reason, 'merge');
    for (const side of ['baseTrack', 'mineTrack'] as const) {
      for (const track of group[side]) {
        assert.equal(groupTop + track.sourceRowIndex * 48, (track.rowNumber - 1) * 48);
      }
    }
    groupTop += height;
  }
  assert.equal(groupTop, rowCount * 48);

  for (const maxRunHeight of [2304, 3072]) {
    const runs = buildWorkbookCanvasRuns(groups.map((group) => ({
      key: group.key, height: group.rows.reduce((sum, row) => sum + row.height, 0),
    })), { keyPrefix: 'tall-merge', maxRunHeight });
    for (const run of runs) {
      assert.ok(run.height <= maxRunHeight);
      const canvas = { width: 0, height: 0, style: { width: '', height: '' } } as HTMLCanvasElement;
      syncWorkbookCanvasSurface(canvas, 1200, run.height, 2);
      assert.ok(canvas.height <= maxRunHeight * 2);
    }
  }
});

test('a merge crossing the frozen pane boundary remains bounded when hidden rows are absent', () => {
  const rows = buildWorkbookStackedLayoutRows({
    rows: Array.from({ length: 400 }, (_, index) => ({
      row: buildSplitRow({ lineIdx: index, baseRowNumber: index * 2 + 1, mineRowNumber: index * 2 + 1 }),
      renderMode: 'double' as const,
      height: 48,
    })),
  });
  const range = { startRow: 1, endRow: 800, startCol: 0, endCol: 0 };
  for (const paneRows of [rows.slice(0, 75), rows.slice(75)]) {
    const groups = buildWorkbookStackedVisualGroups({ rows: paneRows, baseMergeRanges: [range], mineMergeRanges: [range] });
    assert.equal(groups.flatMap((group) => group.rows).length, paneRows.length);
    assert.ok(groups.every((group) => group.reason === 'merge' && group.rows.reduce((sum, row) => sum + row.height, 0) <= 1536));
    assert.equal(groups[0]?.mergeWindows[0]?.range, range);
    assert.equal(groups[0]?.baseTrack[0]?.rowNumber, paneRows[0]?.baseRowNumber);
    assert.equal(groups.at(-1)?.mineTrack.at(-1)?.rowNumber, paneRows.at(-1)?.mineRowNumber);
  }
});
