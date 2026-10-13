import test from 'node:test';
import assert from 'node:assert/strict';

import type { SplitRow, WorkbookRowDelta } from '../src/types';
import { createWorkbookRowLine } from '../src/utils/workbook/workbookDisplay';
import {
  buildWorkbookMaskedRegionModel,
  getWorkbookMaskedRegionId,
} from '../src/utils/workbook/workbookMaskedRegionModel';

function row(rowNumber: number, changedColumn: number): SplitRow {
  const base = createWorkbookRowLine(rowNumber, ['same-a', 'before', 'same-c']);
  const mine = createWorkbookRowLine(rowNumber, [
    'same-a',
    changedColumn === 1 ? 'after' : 'before',
    'same-c',
  ]);
  return {
    lineIdx: rowNumber,
    lineIdxs: [rowNumber],
    left: { type: 'delete', base, mine: null, baseLineNo: rowNumber, mineLineNo: null, baseCharSpans: null, mineCharSpans: null },
    right: { type: 'add', base: null, mine, baseLineNo: null, mineLineNo: rowNumber, baseCharSpans: null, mineCharSpans: null },
  };
}

test('masked region model merges adjacent irrelevant cells and pairs both versions', () => {
  const model = buildWorkbookMaskedRegionModel({
    rows: [row(2, 1), row(3, 1)],
    visibleColumns: [0, 1, 2],
    compareMode: 'strict',
    renderPolicy: { mode: 'differences-only', maskIrrelevantCells: true, diffTypeFilter: 'all' },
    sheetName: 'Sheet1',
    headerRowNumber: 1,
  });

  const leftTop = getWorkbookMaskedRegionId(model, 'base', 2, 0);
  const leftBottom = getWorkbookMaskedRegionId(model, 'mine', 3, 0);
  const rightTop = getWorkbookMaskedRegionId(model, 'base', 2, 2);
  assert.ok(leftTop);
  assert.equal(leftBottom, leftTop);
  assert.ok(rightTop);
  assert.notEqual(rightTop, leftTop);
  assert.equal(getWorkbookMaskedRegionId(model, 'mine', 2, 1), null);
  assert.equal(model.regionCount, 2);
});

test('full render policy does not build masked regions', () => {
  const model = buildWorkbookMaskedRegionModel({
    rows: [row(2, 1)],
    visibleColumns: [0, 1, 2],
    compareMode: 'strict',
    renderPolicy: { mode: 'full', maskIrrelevantCells: false, diffTypeFilter: 'all' },
    sheetName: 'Sheet1',
    headerRowNumber: 1,
  });
  assert.equal(model.regionCount, 0);
});

interface RegionRowCase {
  baseRowNumber: number | null;
  mineRowNumber: number | null;
  changedColumns: number[];
  structuralChange?: 'add' | 'delete';
}

function precomputedRow(source: RegionRowCase, lineIdx: number): SplitRow {
  const makeLine = (side: 'base' | 'mine') => {
    const rowNumber = side === 'base' ? source.baseRowNumber : source.mineRowNumber;
    if (rowNumber == null) return null;
    const text = createWorkbookRowLine(rowNumber, ['cell']);
    return {
      type: side === 'base' ? 'delete' as const : 'add' as const,
      base: side === 'base' ? text : null,
      mine: side === 'mine' ? text : null,
      baseLineNo: side === 'base' ? rowNumber : null,
      mineLineNo: side === 'mine' ? rowNumber : null,
      baseCharSpans: null,
      mineCharSpans: null,
    };
  };
  const delta: WorkbookRowDelta = {
    get cellDeltas(): WorkbookRowDelta['cellDeltas'] {
      throw new Error('Masked region construction must use the precomputed summary.');
    },
    changedColumns: source.changedColumns,
    strictOnlyColumns: [],
    changedCount: source.changedColumns.length,
    hasChanges: source.changedColumns.length > 0,
    tone: 'mixed',
    ...(source.structuralChange ? { structuralChange: source.structuralChange } : {}),
  };
  return {
    lineIdx,
    lineIdxs: [lineIdx],
    left: makeLine('base'),
    right: makeLine('mine'),
    workbookRowDelta: delta,
  };
}

function expectedRegions(cases: RegionRowCase[], columns: number[], headerRowNumber: number) {
  const retained = cases.filter((source) => {
    const rowNumber = source.baseRowNumber ?? source.mineRowNumber;
    return rowNumber != null && rowNumber !== headerRowNumber
      && (source.structuralChange || source.changedColumns.some((column) => columns.includes(column)));
  });
  const irrelevant = retained.map((source) => columns.map((column) => (
    !(source.structuralChange && source.changedColumns.length === 0)
      && !source.changedColumns.includes(column)
  )));
  const visited = retained.map(() => columns.map(() => false));
  const cells = new Map<string, string>();
  let regionCount = 0;
  for (let rowIndex = 0; rowIndex < retained.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      if (visited[rowIndex]![columnIndex] || !irrelevant[rowIndex]![columnIndex]) continue;
      const regionId = `Sheet1:masked:${regionCount++}`;
      const queue = [[rowIndex, columnIndex]];
      visited[rowIndex]![columnIndex] = true;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const [ri, ci] = queue[cursor]!;
        const source = retained[ri!]!;
        for (const side of ['base', 'mine'] as const) {
          const rowNumber = side === 'base' ? source.baseRowNumber : source.mineRowNumber;
          if (rowNumber != null) cells.set(`${side}\u0000${rowNumber}\u0000${columns[ci!]}`, regionId);
        }
        for (const [nr, nc] of [[ri! - 1, ci!], [ri! + 1, ci!], [ri!, ci! - 1], [ri!, ci! + 1]]) {
          if (nr! < 0 || nr! >= retained.length || nc! < 0 || nc! >= columns.length
            || visited[nr!]![nc!] || !irrelevant[nr!]![nc!]) continue;
          visited[nr!]![nc!] = true;
          queue.push([nr!, nc!]);
        }
      }
    }
  }
  return { cells, regionCount };
}

function buildPrecomputedModel(cases: RegionRowCase[], visibleColumns: number[], headerRowNumber = 1) {
  return buildWorkbookMaskedRegionModel({
    rows: cases.map(precomputedRow),
    visibleColumns,
    compareMode: 'strict',
    renderPolicy: { mode: 'differences-only', maskIrrelevantCells: true, diffTypeFilter: 'all' },
    sheetName: 'Sheet1',
    headerRowNumber,
  });
}

test('compressed regions preserve BFS connectivity, IDs and Map lookups across sparse and shifted rows', () => {
  const columns = [0, 2, 5, 9, 15, 30];
  let seed = 71237;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let sample = 0; sample < 80; sample += 1) {
    const cases: RegionRowCase[] = Array.from({ length: 8 }, (_, index) => ({
      baseRowNumber: index === 6 ? 3 : index + 1,
      mineRowNumber: index % 3 === 0 ? null : index + 10,
      changedColumns: columns.filter(() => random() % 3 === 0),
      ...(index === 4 && sample % 2 === 0 ? { structuralChange: 'delete' as const } : {}),
    }));
    const expected = expectedRegions(cases, columns, 1);
    const model = buildPrecomputedModel(cases, columns);
    assert.equal(model.regionCount, expected.regionCount);
    assert.equal(model.regionByCellKey.size, expected.cells.size);
    assert.deepEqual(new Map(model.regionByCellKey), expected.cells);
    for (const [key, regionId] of expected.cells) {
      assert.equal(model.regionByCellKey.has(key), true);
      assert.equal(model.regionByCellKey.get(key), regionId);
      const [side, rowNumber, column] = key.split('\u0000');
      assert.equal(getWorkbookMaskedRegionId(model, side as 'base' | 'mine', Number(rowNumber), Number(column)), regionId);
    }
    assert.equal(model.regionByCellKey.get('base\u000003\u00000'), undefined);
    assert.equal(model.regionByCellKey.has('base\u0000999\u00000'), false);
  }
});

test('wide precomputed rows keep millions of masked cells compressed without hydrating cell maps', { timeout: 5000 }, () => {
  const columnCount = 16_384;
  const rowCount = 2000;
  const columns = Array.from({ length: columnCount }, (_, index) => index);
  const cases: RegionRowCase[] = Array.from({ length: rowCount }, (_, index) => ({
    baseRowNumber: index + 2,
    mineRowNumber: index + 4,
    changedColumns: [8192],
  }));
  const model = buildPrecomputedModel(cases, columns);
  assert.equal(model.regionCount, 2);
  assert.equal(model.regionByCellKey.size, rowCount * (columnCount - 1) * 2);
  assert.equal(getWorkbookMaskedRegionId(model, 'base', 2, 0), 'Sheet1:masked:0');
  assert.equal(getWorkbookMaskedRegionId(model, 'mine', rowCount + 3, columnCount - 1), 'Sheet1:masked:1');
  assert.equal(getWorkbookMaskedRegionId(model, 'base', 2, 8192), null);
  assert.deepEqual(model.regionByCellKey.entries().next().value, ['base\u00002\u00000', 'Sheet1:masked:0']);
});

test('structural empty rows separate regions while filtered unchanged rows do not', () => {
  const cases: RegionRowCase[] = [
    { baseRowNumber: 2, mineRowNumber: 3, changedColumns: [1] },
    { baseRowNumber: 3, mineRowNumber: 4, changedColumns: [] },
    { baseRowNumber: 4, mineRowNumber: 5, changedColumns: [1] },
    { baseRowNumber: 5, mineRowNumber: null, changedColumns: [], structuralChange: 'delete' },
    { baseRowNumber: 6, mineRowNumber: 7, changedColumns: [1] },
  ];
  const model = buildPrecomputedModel(cases, [0, 1, 2]);
  assert.equal(getWorkbookMaskedRegionId(model, 'base', 2, 0), getWorkbookMaskedRegionId(model, 'base', 4, 0));
  assert.notEqual(getWorkbookMaskedRegionId(model, 'base', 4, 0), getWorkbookMaskedRegionId(model, 'base', 6, 0));
  assert.equal(getWorkbookMaskedRegionId(model, 'base', 3, 0), null);
  assert.equal(getWorkbookMaskedRegionId(model, 'base', 5, 0), null);
});

test('the compressed read-only Map exposes consistent keys, values and forEach', () => {
  const model = buildPrecomputedModel([
    { baseRowNumber: 2, mineRowNumber: 8, changedColumns: [9] },
  ], [5, 9, 2]);
  const cells = model.regionByCellKey;
  const entries = [...cells.entries()];
  assert.deepEqual([...cells.keys()], entries.map(([key]) => key));
  assert.deepEqual([...cells.values()], entries.map(([, value]) => value));
  const seen: Array<[string, string]> = [];
  const context = { called: 0 };
  cells.forEach(function (this: typeof context, value, key, map) {
    assert.equal(this, context);
    assert.equal(map, cells);
    this.called += 1;
    seen.push([key, value]);
  }, context);
  assert.equal(context.called, cells.size);
  assert.deepEqual(seen, entries);
  assert.equal(getWorkbookMaskedRegionId(model, 'base', 2, 5), 'Sheet1:masked:0');
  assert.equal(getWorkbookMaskedRegionId(model, 'base', 2, 2), 'Sheet1:masked:1');
});

test('changes outside visible columns do not introduce a masked row', () => {
  const model = buildWorkbookMaskedRegionModel({
    rows: [row(2, 1)],
    visibleColumns: [0, 2],
    compareMode: 'strict',
    renderPolicy: { mode: 'differences-only', maskIrrelevantCells: true, diffTypeFilter: 'all' },
    sheetName: 'Sheet1',
    headerRowNumber: 1,
  });
  assert.equal(model.regionCount, 0);
  assert.equal(model.regionByCellKey.size, 0);
});
