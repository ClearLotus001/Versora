import test from 'node:test';
import assert from 'node:assert/strict';

import type { DiffLine } from '../src/types';
import { createWorkbookRowLine, createWorkbookSheetLine } from '../src/utils/workbook/workbookDisplay';
import {
  buildWorkbookLineSheetContextLookup,
  buildWorkbookLineSheetContexts,
  getWorkbookSections,
  resolveWorkbookSheetNameForLineContext,
} from '../src/utils/workbook/workbookSections';
import {
  buildWorkbookSectionRowIndex,
} from '../src/utils/workbook/workbookSheetIndex';
import { parseWorkbookRowLine } from '../src/utils/workbook/workbookCompare';

function buildDiffLine(overrides: Partial<DiffLine>): DiffLine {
  return {
    type: 'equal',
    base: null,
    mine: null,
    baseLineNo: null,
    mineLineNo: null,
    baseCharSpans: null,
    mineCharSpans: null,
    ...overrides,
  };
}

test('section row index keeps cross-sheet aligned rows scoped to their owning sheet', () => {
  const diffLines: DiffLine[] = [
    buildDiffLine({
      type: 'equal',
      base: createWorkbookSheetLine('ThingType'),
      mine: createWorkbookSheetLine('ThingType'),
      baseLineNo: 1,
      mineLineNo: 1,
    }),
    buildDiffLine({
      type: 'equal',
      base: createWorkbookRowLine(1, ['类型', '后台类型', '逻辑类型', '背包ID', '有效期类型过期删除时']),
      mine: createWorkbookRowLine(1, ['类型', '后台类型', '逻辑类型', '背包ID', '有效期类型过期删除时']),
      baseLineNo: 2,
      mineLineNo: 2,
    }),
    buildDiffLine({
      type: 'add',
      mine: createWorkbookSheetLine('类型描述'),
      mineLineNo: 3,
    }),
    buildDiffLine({
      type: 'equal',
      base: createWorkbookRowLine(4, ['3虚拟物品', '2', '数量型', '0', '']),
      mine: createWorkbookRowLine(1, ['ID', '类型', '子类型', '类型描述']),
      baseLineNo: 4,
      mineLineNo: 4,
    }),
  ];

  const sections = getWorkbookSections(diffLines);
  const rowIndex = buildWorkbookSectionRowIndex(diffLines, sections);

  const thingTypeRows = rowIndex.get('ThingType')?.rows ?? [];
  const typeDescriptionRows = rowIndex.get('类型描述')?.rows ?? [];

  assert.deepEqual(
    thingTypeRows.map((row) => ({
      leftRow: parseWorkbookRowLine(row.left)?.rowNumber ?? null,
      rightRow: parseWorkbookRowLine(row.right)?.rowNumber ?? null,
      leftColumnCount: parseWorkbookRowLine(row.left)?.cells.length ?? 0,
      rightColumnCount: parseWorkbookRowLine(row.right)?.cells.length ?? 0,
    })),
    [
      { leftRow: 1, rightRow: 1, leftColumnCount: 5, rightColumnCount: 5 },
      { leftRow: 4, rightRow: null, leftColumnCount: 5, rightColumnCount: 0 },
    ],
  );

  assert.deepEqual(
    typeDescriptionRows.map((row) => ({
      leftRow: parseWorkbookRowLine(row.left)?.rowNumber ?? null,
      rightRow: parseWorkbookRowLine(row.right)?.rowNumber ?? null,
      leftColumnCount: parseWorkbookRowLine(row.left)?.cells.length ?? 0,
      rightColumnCount: parseWorkbookRowLine(row.right)?.cells.length ?? 0,
    })),
    [
      { leftRow: null, rightRow: 1, leftColumnCount: 0, rightColumnCount: 4 },
    ],
  );
});

test('resolveWorkbookSheetNameForLineContext chooses the correct sheet at cross-sheet boundaries', () => {
  const diffLines: DiffLine[] = [
    buildDiffLine({
      type: 'equal',
      base: createWorkbookSheetLine('ThingType'),
      mine: createWorkbookSheetLine('ThingType'),
    }),
    buildDiffLine({
      type: 'add',
      mine: createWorkbookSheetLine('类型描述'),
    }),
    buildDiffLine({
      type: 'equal',
      base: createWorkbookRowLine(4, ['3虚拟物品', '2', '数量型', '0', '']),
      mine: createWorkbookRowLine(1, ['ID', '类型', '子类型', '类型描述']),
    }),
  ];

  const contexts = buildWorkbookLineSheetContexts(diffLines);

  assert.equal(
    resolveWorkbookSheetNameForLineContext({
      line: diffLines[1],
      context: contexts[1],
    }),
    '类型描述',
  );

  assert.equal(
    resolveWorkbookSheetNameForLineContext({
      line: diffLines[2],
      context: contexts[2],
      preferredSheetName: '类型描述',
    }),
    '类型描述',
  );

  assert.equal(
    resolveWorkbookSheetNameForLineContext({
      line: diffLines[2],
      context: contexts[2],
      preferredSheetName: 'ThingType',
    }),
    'ThingType',
  );
});

test('buildWorkbookLineSheetContextLookup lazily resolves the same boundary contexts as the materialized array', () => {
  const diffLines: DiffLine[] = [
    buildDiffLine({
      type: 'equal',
      base: createWorkbookSheetLine('ThingType'),
      mine: createWorkbookSheetLine('ThingType'),
    }),
    buildDiffLine({
      type: 'add',
      mine: createWorkbookSheetLine('类型描述'),
    }),
    buildDiffLine({
      type: 'equal',
      base: createWorkbookRowLine(4, ['3虚拟物品', '2', '数量型', '0', '']),
      mine: createWorkbookRowLine(1, ['ID', '类型', '子类型', '类型描述']),
    }),
  ];

  const contexts = buildWorkbookLineSheetContexts(diffLines);
  const lookup = buildWorkbookLineSheetContextLookup(diffLines);

  assert.deepEqual(lookup.get(1), contexts[1]);
  assert.deepEqual(lookup.get(2), contexts[2]);
  assert.equal(
    resolveWorkbookSheetNameForLineContext({
      line: diffLines[2],
      context: lookup.get(2),
      preferredSheetName: 'ThingType',
    }),
    'ThingType',
  );
});
