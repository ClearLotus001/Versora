import test from 'node:test';
import assert from 'node:assert/strict';

import type { HorizontalVirtualColumnEntry } from '../src/hooks/virtualization/useHorizontalVirtualColumns';
import type { SplitRow, WorkbookCellDelta } from '../src/types';
import { resolveWorkbookCanvasAnchor } from '../src/utils/workbook/workbookCanvasCompareCells';
import { buildWorkbookSelectedCell, type WorkbookRowEntry } from '../src/utils/workbook/workbookNavigation';
import { buildWorkbookCompareCellsMaps } from '../src/utils/workbook/workbookPanelHelpers';
import {
  findWorkbookCanvasRowSegmentAtY,
  getWorkbookCanvasHoverRowSegmentBounds,
  getWorkbookCanvasRowSegmentBounds,
  getWorkbookCanvasRowSegmentCenterY,
  getWorkbookCanvasRowSegmentLineCenters,
  getWorkbookCanvasRowSegments,
  getWorkbookCanvasLayerViewports,
  getWorkbookCanvasSpanSegmentsForLayer,
  getWorkbookCanvasCellViewportRect,
  getWorkbookMergedCompareCellFromRows,
  findWorkbookMergeRange,
  getWorkbookCanvasSpanGeometry,
  getWorkbookColumnSpanBounds,
  getWorkbookMergeDrawInfo,
  getWorkbookSelectionSpanForSelection,
} from '../src/utils/workbook/workbookMergeLayout';

const mergeRanges = [
  {
    startRow: 2,
    endRow: 4,
    startCol: 1,
    endCol: 2,
  },
];

function buildSingleColumnLayout(): Map<number, HorizontalVirtualColumnEntry> {
  return new Map([
    [0, { column: 0, position: 0, width: 120, displayWidth: 120, offset: 0, absoluteOffset: 0 }],
    [1, { column: 1, position: 1, width: 120, displayWidth: 120, offset: 120, absoluteOffset: 120 }],
    [2, { column: 2, position: 2, width: 120, displayWidth: 120, offset: 240, absoluteOffset: 240 }],
    [3, { column: 3, position: 3, width: 120, displayWidth: 120, offset: 360, absoluteOffset: 360 }],
  ]);
}

function buildPairedColumnLayout(): Map<number, HorizontalVirtualColumnEntry> {
  return new Map([
    [0, { column: 0, position: 0, width: 120, displayWidth: 240, offset: 0, absoluteOffset: 0 }],
    [1, { column: 1, position: 1, width: 120, displayWidth: 240, offset: 240, absoluteOffset: 240 }],
    [2, { column: 2, position: 2, width: 120, displayWidth: 240, offset: 480, absoluteOffset: 480 }],
  ]);
}

test('findWorkbookMergeRange resolves cells inside a merged area', () => {
  assert.deepEqual(findWorkbookMergeRange(mergeRanges, 2, 1), mergeRanges[0]);
  assert.deepEqual(findWorkbookMergeRange(mergeRanges, 4, 2), mergeRanges[0]);
  assert.equal(findWorkbookMergeRange(mergeRanges, 5, 2), null);
});

test('findWorkbookMergeRange resolves very tall sparse merges without expanding every row', () => {
  const ranges = [{ startRow: 1, endRow: 1_048_576, startCol: 0, endCol: 1 }];

  assert.equal(findWorkbookMergeRange(ranges, 1_048_576, 1), ranges[0]);
  assert.equal(findWorkbookMergeRange(ranges, 524_288, 2), null);
});

test('getWorkbookSelectionSpanForSelection expands a cell selection to the merged range', () => {
  const span = getWorkbookSelectionSpanForSelection({
    kind: 'cell',
    sheetName: 'Items',
    side: 'base',
    versionLabel: 'BASE',
    rowNumber: 3,
    colIndex: 2,
    colLabel: 'C',
    address: 'C3',
    value: 'Potion',
    formula: '',
  }, mergeRanges);

  assert.deepEqual(span, {
    startCol: 1,
    endCol: 2,
  });
});

test('getWorkbookColumnSpanBounds computes paired mine offsets across multiple columns', () => {
  const bounds = getWorkbookColumnSpanBounds(0, 2, buildPairedColumnLayout(), 'paired-mine', 0);
  assert.ok(bounds);
  assert.equal(bounds.leftOffset, 120);
  assert.equal(bounds.rightOffset, 720);
  assert.equal(bounds.width, 600);
});

test('getWorkbookCanvasSpanGeometry splits a merged region across the frozen boundary', () => {
  const bounds = getWorkbookColumnSpanBounds(1, 2, buildSingleColumnLayout(), 'single', 2);
  assert.ok(bounds);
  const geometry = getWorkbookCanvasSpanGeometry(bounds, 12, 48, 240);
  assert.ok(geometry);
  assert.equal(geometry.segments.length, 2);
  assert.deepEqual(geometry.segments, [
    { left: 132, width: 120 },
    { left: 252, width: 72 },
  ]);
  assert.equal(geometry.left, 132);
  assert.equal(geometry.right, 324);
  assert.equal(geometry.width, 192);
});

test('getWorkbookCanvasSpanGeometry keeps paired-base merge segments non-contiguous across interleaved mine columns', () => {
  const bounds = getWorkbookColumnSpanBounds(1, 2, buildPairedColumnLayout(), 'paired-base', 0);
  assert.ok(bounds);
  const geometry = getWorkbookCanvasSpanGeometry(bounds, 12, 0, 0);
  assert.ok(geometry);
  assert.deepEqual(geometry.segments, [
    { left: 252, width: 120 },
    { left: 492, width: 120 },
  ]);
});

test('getWorkbookCanvasSpanGeometry clips floating merged regions before the frozen pane boundary', () => {
  const bounds = getWorkbookColumnSpanBounds(1, 2, buildSingleColumnLayout(), 'single', 1);
  assert.ok(bounds);
  const geometry = getWorkbookCanvasSpanGeometry(bounds, 12, 48, 120);
  assert.ok(geometry);
  assert.deepEqual(geometry.segments, [
    { left: 132, width: 192 },
  ]);
  assert.equal(geometry.left, 132);
  assert.equal(geometry.right, 324);
  assert.equal(geometry.width, 192);
});

test('getWorkbookCanvasSpanGeometry preserves unclipped scroll-layer segments so merges can slide under frozen columns', () => {
  const bounds = getWorkbookColumnSpanBounds(1, 2, buildSingleColumnLayout(), 'single', 2);
  assert.ok(bounds);
  const geometry = getWorkbookCanvasSpanGeometry(bounds, 12, 48, 240);
  assert.ok(geometry);
  assert.deepEqual(getWorkbookCanvasSpanSegmentsForLayer(geometry, 'frozen'), [
    { left: 132, width: 120 },
  ]);
  assert.deepEqual(getWorkbookCanvasSpanSegmentsForLayer(geometry, 'scroll'), [
    { left: 204, width: 120 },
  ]);
});

test('getWorkbookCanvasSpanGeometry merges contiguous single-pane column spans into one segment', () => {
  const bounds = getWorkbookColumnSpanBounds(1, 2, buildSingleColumnLayout(), 'single', 0);
  assert.ok(bounds);
  const geometry = getWorkbookCanvasSpanGeometry(bounds, 12, 0, 0);
  assert.ok(geometry);
  assert.deepEqual(geometry.segments, [
    { left: 132, width: 240 },
  ]);
  assert.equal(geometry.width, 240);
});

test('getWorkbookCanvasCellViewportRect clips floating cells away from the frozen pane boundary', () => {
  assert.deepEqual(getWorkbookCanvasCellViewportRect({
    drawLeft: 100,
    drawWidth: 120,
    contentLeft: 12,
    frozenWidth: 120,
    frozen: false,
  }), {
    left: 132,
    width: 88,
  });
});

test('getWorkbookCanvasLayerViewports exposes separate content, frozen, and scroll clips', () => {
  assert.deepEqual(getWorkbookCanvasLayerViewports({
    contentLeft: 12,
    contentRight: 420,
    frozenWidth: 120,
  }), {
    content: {
      left: 12,
      width: 408,
    },
    frozen: {
      left: 12,
      width: 120,
    },
    scroll: {
      left: 132,
      width: 288,
    },
    frozenBoundaryX: 132,
  });
});

test('getWorkbookMergeDrawInfo clips merged regions to the first visible row in the strip', () => {
  const info = getWorkbookMergeDrawInfo({
    rowNumber: 3,
    column: 1,
    rowTop: 40,
    rowHeight: 20,
    renderedRowNumbers: [3, 4, 5],
    mergedRanges: mergeRanges,
    columnLayoutByColumn: buildSingleColumnLayout(),
    contentLeft: 12,
    currentScrollLeft: 0,
    freezeColumnCount: 0,
    frozenWidth: 0,
    mode: 'single',
  });

  assert.equal(info.covered, true);
  assert.ok(info.region);
  assert.equal(info.region?.left, 132);
  assert.equal(info.region?.top, 40);
  assert.equal(info.region?.width, 240);
  assert.equal(info.region?.height, 40);
  assert.equal(info.region?.visibleStartRow, 3);
});

test('getWorkbookMergeDrawInfo preserves visible row segments for non-contiguous rows', () => {
  const info = getWorkbookMergeDrawInfo({
    rowNumber: 3,
    column: 1,
    rowTop: 40,
    rowHeight: 20,
    renderedRowNumbers: [3, 5],
    rowLayoutByRowNumber: new Map([
      [3, { top: 40, height: 20 }],
      [5, { top: 100, height: 20 }],
    ]),
    mergedRanges: [{
      startRow: 3,
      endRow: 5,
      startCol: 1,
      endCol: 1,
    }],
    columnLayoutByColumn: buildSingleColumnLayout(),
    contentLeft: 12,
    currentScrollLeft: 0,
    freezeColumnCount: 0,
    frozenWidth: 0,
    mode: 'single',
  });

  assert.ok(info.region);
  assert.deepEqual(info.region?.rowSegments, [
    { top: 40, height: 20 },
    { top: 100, height: 20 },
  ]);
});

test('getWorkbookMergeDrawInfo skips covered cells once the merged region is already drawn', () => {
  const info = getWorkbookMergeDrawInfo({
    rowNumber: 4,
    column: 1,
    rowTop: 60,
    rowHeight: 20,
    renderedRowNumbers: [3, 4, 5],
    mergedRanges: mergeRanges,
    columnLayoutByColumn: buildSingleColumnLayout(),
    contentLeft: 12,
    currentScrollLeft: 0,
    freezeColumnCount: 0,
    frozenWidth: 0,
    mode: 'single',
  });

  assert.equal(info.covered, true);
  assert.equal(info.region, null);
});

test('getWorkbookMergeDrawInfo skips a fully hidden overscanned merge anchor column and lets the first actually visible column draw', () => {
  const hiddenAnchorInfo = getWorkbookMergeDrawInfo({
    rowNumber: 3,
    column: 1,
    rowTop: 40,
    rowHeight: 20,
    renderedRowNumbers: [3, 4, 5],
    renderedColumns: [1, 2, 3],
    mergedRanges: mergeRanges,
    columnLayoutByColumn: buildSingleColumnLayout(),
    contentLeft: 12,
    currentScrollLeft: 200,
    freezeColumnCount: 1,
    frozenWidth: 120,
    mode: 'single',
  });

  const firstVisibleColumnInfo = getWorkbookMergeDrawInfo({
    rowNumber: 3,
    column: 2,
    rowTop: 40,
    rowHeight: 20,
    renderedRowNumbers: [3, 4, 5],
    renderedColumns: [1, 2, 3],
    mergedRanges: mergeRanges,
    columnLayoutByColumn: buildSingleColumnLayout(),
    contentLeft: 12,
    currentScrollLeft: 200,
    freezeColumnCount: 1,
    frozenWidth: 120,
    mode: 'single',
  });

  assert.equal(hiddenAnchorInfo.covered, true);
  assert.equal(hiddenAnchorInfo.region, null);
  assert.equal(firstVisibleColumnInfo.covered, true);
  assert.ok(firstVisibleColumnInfo.region);
});

test('getWorkbookMergeDrawInfo can resolve separate frozen and scroll merge anchors across the freeze boundary', () => {
  const frozenLayerInfo = getWorkbookMergeDrawInfo({
    rowNumber: 3,
    column: 1,
    rowTop: 40,
    rowHeight: 20,
    renderedRowNumbers: [3, 4, 5],
    mergedRanges: mergeRanges,
    columnLayoutByColumn: buildSingleColumnLayout(),
    contentLeft: 12,
    currentScrollLeft: 48,
    freezeColumnCount: 2,
    frozenWidth: 240,
    mode: 'single',
    layer: 'frozen',
  });
  const scrollCoveredInfo = getWorkbookMergeDrawInfo({
    rowNumber: 3,
    column: 1,
    rowTop: 40,
    rowHeight: 20,
    renderedRowNumbers: [3, 4, 5],
    mergedRanges: mergeRanges,
    columnLayoutByColumn: buildSingleColumnLayout(),
    contentLeft: 12,
    currentScrollLeft: 48,
    freezeColumnCount: 2,
    frozenWidth: 240,
    mode: 'single',
    layer: 'scroll',
  });
  const scrollLayerInfo = getWorkbookMergeDrawInfo({
    rowNumber: 3,
    column: 2,
    rowTop: 40,
    rowHeight: 20,
    renderedRowNumbers: [3, 4, 5],
    mergedRanges: mergeRanges,
    columnLayoutByColumn: buildSingleColumnLayout(),
    contentLeft: 12,
    currentScrollLeft: 48,
    freezeColumnCount: 2,
    frozenWidth: 240,
    mode: 'single',
    layer: 'scroll',
  });

  assert.ok(frozenLayerInfo.region);
  assert.deepEqual(frozenLayerInfo.region.segments, [
    { left: 132, width: 120 },
  ]);
  assert.equal(frozenLayerInfo.region.left, 132);
  assert.equal(frozenLayerInfo.region.width, 120);

  assert.equal(scrollCoveredInfo.covered, true);
  assert.equal(scrollCoveredInfo.region, null);

  assert.ok(scrollLayerInfo.region);
  assert.deepEqual(scrollLayerInfo.region.segments, [
    { left: 204, width: 120 },
  ]);
  assert.equal(scrollLayerInfo.region.left, 204);
  assert.equal(scrollLayerInfo.region.width, 120);
});

test('getWorkbookMergedCompareCellFromRows resolves merged cell tone from any row in the merged range', () => {
  const compareCell = getWorkbookMergedCompareCellFromRows(
    new Map([
      [2, new Map()],
      [3, new Map([
        [1, {
          column: 1,
          baseCell: { value: '', formula: '' },
          mineCell: { value: 'sdfsf', formula: '' },
          changed: true,
          masked: false,
          strictOnly: false,
          kind: 'add',
          hasBaseContent: false,
          hasMineContent: true,
          hasContent: true,
        }],
      ])],
    ]),
    {
      startRow: 2,
      endRow: 3,
      startCol: 1,
      endCol: 1,
    },
  );

  assert.equal(compareCell?.changed, true);
  assert.equal(compareCell?.kind, 'add');
  assert.equal(compareCell?.mineCell.value, 'sdfsf');
});

test('tall merge comparison visits sparse present rows once and shares the summary between fragments', () => {
  const changed: WorkbookCellDelta = {
    column: 1, baseCell: { value: 'old', formula: '' }, mineCell: { value: 'new', formula: '' },
    changed: true, masked: false, strictOnly: false, kind: 'modify',
    hasBaseContent: true, hasMineContent: true, hasContent: true,
  };
  let rowReads = 0;
  class CountingRows extends Map<number, Map<number, WorkbookCellDelta>> {
    override get(rowNumber: number) { rowReads += 1; return super.get(rowNumber); }
  }
  const rows = new CountingRows([
    [1, new Map()],
    [1_048_576, new Map([[1, changed]])],
  ]);
  const range = { startRow: 1, endRow: 1_048_576, startCol: 1, endCol: 1 };

  assert.equal(getWorkbookMergedCompareCellFromRows(rows, range), changed);
  assert.equal(rowReads, 2);
  assert.equal(getWorkbookMergedCompareCellFromRows(rows, { ...range }), changed);
  assert.equal(rowReads, 2);
});

test('a virtual fragment inside a tall merge keeps its original anchor and clips to local row bands', () => {
  const range = { startRow: 1, endRow: 10_000, startCol: 1, endCol: 1 };
  const renderedRowNumbers = [65, 66, 67];
  const info = getWorkbookMergeDrawInfo({
    rowNumber: 65, column: 1, rowTop: 0, rowHeight: 24,
    renderedRowNumbers,
    rowLayoutByRowNumber: new Map([[65, { top: 0, height: 24 }], [66, { top: 48, height: 24 }], [67, { top: 96, height: 24 }]]),
    mergedRanges: [range], columnLayoutByColumn: buildSingleColumnLayout(),
    contentLeft: 12, currentScrollLeft: 0, freezeColumnCount: 0, frozenWidth: 0, mode: 'single',
  });
  assert.equal(info.region?.range.startRow, 1);
  assert.equal(info.region?.visibleStartRow, 65);
  assert.equal(info.region?.height, 120);
  assert.deepEqual(info.region?.rowSegments, [{ top: 0, height: 24 }, { top: 48, height: 24 }, { top: 96, height: 24 }]);
});

test('stacked fragment drawing and selection resolve an anchor outside its visible and frozen row window', () => {
  const mergeRange = { startRow: 1, endRow: 10_000, startCol: 1, endCol: 1 };
  for (const side of ['base', 'mine'] as const) {
    const anchorEntry: WorkbookRowEntry = {
      sheetName: 'Items', side, versionLabel: side, rowNumber: 1, visibleColumns: [0, 1], lineIdxs: [0],
      cells: [{ value: 'ID', formula: '' }, { value: `${side}-anchor`, formula: '=A1' }],
    };
    const visibleEntry: WorkbookRowEntry = { ...anchorEntry, rowNumber: 65, lineIdxs: [64], cells: [{ value: '65', formula: '' }, { value: '', formula: '' }] };
    const anchor = resolveWorkbookCanvasAnchor({
      entry: visibleEntry, rowEntryByRowNumber: new Map([[1, anchorEntry], [65, visibleEntry]]), column: 1, mergeRange,
    });
    assert.equal(anchor.entry, anchorEntry);
    assert.equal(anchor.rowNumber, 1);
    const selection = buildWorkbookSelectedCell(anchor.entry, anchor.column, [mergeRange]);
    assert.equal(selection.address, 'B1');
    assert.equal(selection.value, `${side}-anchor`);
    assert.equal(selection.formula, '=A1');
    assert.equal(selection.side, side);
  }
});

test('merged comparison summaries stay isolated between strict and content render maps', () => {
  const row: SplitRow = {
    left: { type: 'delete', base: '@@row\t1\t ', mine: null, baseLineNo: 1, mineLineNo: null, baseCharSpans: null, mineCharSpans: null },
    right: { type: 'add', base: null, mine: '@@row\t1\t', baseLineNo: null, mineLineNo: 1, baseCharSpans: null, mineCharSpans: null },
    lineIdx: 0, lineIdxs: [0, 1],
  };
  const rows = [row];
  const strict = buildWorkbookCompareCellsMaps(rows, [0], 'strict');
  const content = buildWorkbookCompareCellsMaps(rows, [0], 'content');
  const range = { startRow: 1, endRow: 10_000, startCol: 0, endCol: 0 };

  assert.equal(getWorkbookMergedCompareCellFromRows(strict.base, range)?.changed, true);
  assert.equal(getWorkbookMergedCompareCellFromRows(content.base, range), undefined);
  assert.equal(getWorkbookMergedCompareCellFromRows(strict.base, range)?.changed, true);
});

test('getWorkbookCanvasRowSegments keeps stacked merged rows on their own visible bands', () => {
  const segments = getWorkbookCanvasRowSegments(
    {
      startRow: 28,
      endRow: 29,
      startCol: 0,
      endCol: 0,
    },
    [27, 28, 29, 30],
    new Map([
      [27, { top: 96, height: 24 }],
      [28, { top: 120, height: 24 }],
      [29, { top: 168, height: 24 }],
      [30, { top: 192, height: 24 }],
    ]),
  );

  assert.deepEqual(segments, [
    { top: 120, height: 24 },
    { top: 168, height: 24 },
  ]);
  assert.deepEqual(getWorkbookCanvasRowSegmentBounds(segments), {
    top: 120,
    height: 72,
  });
});

test('getWorkbookCanvasRowSegmentLineCenters centers merged text across visible row bands without landing in the interleaved gap', () => {
  const centers = getWorkbookCanvasRowSegmentLineCenters([
    { top: 120, height: 24 },
    { top: 168, height: 24 },
  ], 2, 18);

  assert.deepEqual(centers, [132, 180]);
});

test('getWorkbookCanvasRowSegmentCenterY prefers a real visible band center instead of the interleaved gap', () => {
  const centerY = getWorkbookCanvasRowSegmentCenterY([
    { top: 120, height: 24 },
    { top: 168, height: 24 },
  ]);

  assert.equal(centerY, 132);
});

test('findWorkbookCanvasRowSegmentAtY resolves the concrete hovered segment instead of the merged gap bounds', () => {
  const segments = [
    { top: 120, height: 24 },
    { top: 168, height: 24 },
  ];

  assert.deepEqual(findWorkbookCanvasRowSegmentAtY(segments, 130), { top: 120, height: 24 });
  assert.deepEqual(findWorkbookCanvasRowSegmentAtY(segments, 180), { top: 168, height: 24 });
  assert.equal(findWorkbookCanvasRowSegmentAtY(segments, 150), null);
});

test('getWorkbookCanvasHoverRowSegmentBounds uses the full region when continuous and the hit segment when discontinuous', () => {
  assert.deepEqual(
    getWorkbookCanvasHoverRowSegmentBounds([{ top: 120, height: 48 }], 130),
    { top: 120, height: 48 },
  );

  assert.deepEqual(
    getWorkbookCanvasHoverRowSegmentBounds([
      { top: 120, height: 24 },
      { top: 168, height: 24 },
    ], 180),
    { top: 168, height: 24 },
  );
});
