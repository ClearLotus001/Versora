import test from 'node:test';
import assert from 'node:assert/strict';

import type { DiffLine, SplitRenderItem } from '../src/types';
import { buildSplitRows } from '../src/engine/text/diff';
import { buildReplacementPairIndex } from '../src/engine/text/textChangeAlignment';
import { ROW_H } from '../src/hooks/virtualization/useVirtual';
import {
  buildMiniMapDiffMarkers,
  buildSplitMiniMapSegments,
  resolveMiniMapLineTone,
} from '../src/components/diff/MiniMap';
import {
  buildCollapsedItems,
  buildCollapsibleRowBlocks,
} from '../src/utils/collapse/collapsibleRows';
import { EMPTY_COLLAPSE_EXPANSION_STATE } from '../src/utils/collapse/collapseState';

function makeDeleteLine(base: string, baseLineNo: number): DiffLine {
  return {
    type: 'delete',
    base,
    mine: null,
    baseLineNo,
    mineLineNo: null,
    baseCharSpans: null,
    mineCharSpans: null,
  };
}

function makeAddLine(mine: string, mineLineNo: number): DiffLine {
  return {
    type: 'add',
    base: null,
    mine,
    baseLineNo: null,
    mineLineNo,
    baseCharSpans: null,
    mineCharSpans: null,
  };
}

function makeEqualLine(text: string, lineNo: number): DiffLine {
  return {
    type: 'equal',
    base: text,
    mine: text,
    baseLineNo: lineNo,
    mineLineNo: lineNo,
    baseCharSpans: null,
    mineCharSpans: null,
  };
}

test('minimap paints replacement pairs as modify instead of add/delete', () => {
  const diffLines: DiffLine[] = [
    makeDeleteLine('output = run_convert_tool(addr, "libil2cpp.sym.so")', 83),
    makeAddLine('output = run_convert_tool(addr, "libil2cpp.dbg.so")', 83),
  ];

  const replacementPairIndex = buildReplacementPairIndex(diffLines);

  assert.equal(resolveMiniMapLineTone(diffLines[0]!, 0, replacementPairIndex), 'modify');
  assert.equal(resolveMiniMapLineTone(diffLines[1]!, 1, replacementPairIndex), 'modify');
});

test('minimap keeps unrelated add/delete lines as their original tones', () => {
  const diffLines: DiffLine[] = [
    makeDeleteLine('remove legacy bootstrap block', 10),
    makeAddLine('add brand new telemetry section', 10),
  ];

  const replacementPairIndex = buildReplacementPairIndex(diffLines);

  assert.equal(resolveMiniMapLineTone(diffLines[0]!, 0, replacementPairIndex), 'delete');
  assert.equal(resolveMiniMapLineTone(diffLines[1]!, 1, replacementPairIndex), 'add');
});

test('horizontal split minimap retains its geometry and search hits without a height array', () => {
  const diffLines: DiffLine[] = [
    makeEqualLine('same', 1),
    makeDeleteLine('before', 2),
    makeAddLine('after', 2),
  ];
  const items: SplitRenderItem[] = [
    ...buildSplitRows(diffLines).map((row) => ({ kind: 'split-line' as const, row, lineIdx: row.lineIdx })),
    {
      kind: 'split-collapse',
      count: 100,
      blockId: 'hidden',
      fromIdx: 3,
      toIdx: 102,
      hiddenStart: 0,
      hiddenEnd: 99,
      expandStep: 10,
    },
  ];
  const searchHits = new Set([2, 50]);

  assert.deepEqual(
    buildSplitMiniMapSegments(items, [], searchHits),
    buildSplitMiniMapSegments(items, items.map(() => ROW_H), searchHits),
  );
});

test('split minimap uses rendered rows so trailing additions stay inside collapsed viewport space', () => {
  const diffLines: DiffLine[] = [
    ...Array.from({ length: 100 }, (_, index) => makeEqualLine(`stable line ${index + 1}`, index + 1)),
    makeAddLine('tail addition should remain visible in minimap', 101),
  ];

  const splitRows = buildSplitRows(diffLines);
  const rowBlocks = buildCollapsibleRowBlocks(
    splitRows,
    (row) => row.left?.type === 'equal' && row.right?.type === 'equal',
  );
  const items = buildCollapsedItems(rowBlocks, true, EMPTY_COLLAPSE_EXPANSION_STATE, {
    contextLines: 3,
    blockPrefix: 'text',
    buildRowItem: (row): SplitRenderItem => ({ kind: 'split-line', row, lineIdx: row.lineIdx }),
    buildCollapseItem: (params): SplitRenderItem => ({
      kind: 'split-collapse',
      count: params.count,
      blockId: params.blockId,
      fromIdx: params.fromIdx,
      toIdx: params.toIdx,
      hiddenStart: params.hiddenStart,
      hiddenEnd: params.hiddenEnd,
      expandStep: params.expandStep,
    }),
  });
  const itemHeights = items.map(() => ROW_H);
  const segments = buildSplitMiniMapSegments(items, itemHeights, new Set<number>());

  const totalHeight = segments.reduce((sum, segment) => sum + segment.height, 0);
  const offsetBeforeLast = segments
    .slice(0, -1)
    .reduce((sum, segment) => sum + segment.height, 0);

  assert.equal(items.length, 8);
  assert.equal(totalHeight, items.length * ROW_H);
  assert.equal(segments.at(-1)?.tone, 'add');
  assert.equal(offsetBeforeLast, totalHeight - ROW_H);
});

test('text minimap expands tiny trailing diff markers so ultra-long files remain visible', () => {
  const canvasHeight = 850;
  const contentHeight = 58046 * ROW_H;
  const markers = buildMiniMapDiffMarkers(
    [
      { tone: 'equal', height: 58045 * ROW_H },
      { tone: 'add', height: ROW_H },
    ],
    contentHeight,
    canvasHeight,
  );

  assert.equal(markers.length, 1);
  assert.equal(markers[0]?.tone, 'add');
  assert.equal(markers[0]?.height, 3);
  assert.equal(markers[0]?.top, 847);
  assert.ok((markers[0]?.top ?? 0) + (markers[0]?.height ?? 0) <= canvasHeight);
});

test('text minimap markers preserve concrete constituent tones after compression merges', () => {
  const markers = buildMiniMapDiffMarkers(
    [
      { tone: 'delete', tones: ['delete'], height: 24 },
      { tone: 'modify', tones: ['delete', 'modify'], height: 24 },
    ],
    48,
    3,
  );

  assert.equal(markers.length, 1);
  assert.equal(markers[0]?.tone, 'modify');
  assert.deepEqual(markers[0]?.tones, ['delete', 'modify']);
});
