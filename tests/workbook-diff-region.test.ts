import test from 'node:test';
import assert from 'node:assert/strict';

import { computeWorkbookDiff } from '../src/engine/workbook/workbookDiff';
import { computeHunks } from '../src/engine/text/diff';
import {
  buildWorkbookDiffRegions,
  buildWorkbookNavigationRegions,
  findWorkbookDiffRegionNavigationIndex,
  findWorkbookDiffRegionIndexForSelection,
  formatWorkbookDiffRegionLabel,
  formatWorkbookDiffRegionSemanticSummary,
  formatWorkbookDiffRegionSummary,
  resolveWorkbookDiffRegionChangeKind,
  resolveWorkbookDiffRegionSemanticLabelsForLayout,
  shouldShowWorkbookDiffRegionLabelForSide,
} from '../src/utils/workbook/workbookDiffRegion';
import { createWorkbookRowLine, createWorkbookSheetLine } from '../src/utils/workbook/workbookDisplay';
import {
  buildWorkbookSectionRowIndex,
} from '../src/utils/workbook/workbookSheetIndex';
import { getWorkbookSections } from '../src/utils/workbook/workbookSections';

function buildWorkbook(rows: Array<Array<string>>, sheetName = 'Thing') {
  return [
    createWorkbookSheetLine(sheetName),
    ...rows.map((cells, index) => createWorkbookRowLine(index + 1, cells)),
  ].join('\n');
}

function buildRegion(overrides: Partial<Parameters<typeof buildWorkbookNavigationRegions>[0][number]> = {}) {
  return {
    id: 'Thing:0:0:0',
    sheetName: 'Thing',
    startRowIndex: 0,
    endRowIndex: 0,
    startCol: 0,
    endCol: 0,
    rowNumberStart: 1,
    rowNumberEnd: 1,
    lineStartIdx: 0,
    lineEndIdx: 0,
    anchorLineIdx: 0,
    hasBaseSide: true,
    hasMineSide: true,
    anchorSelection: null,
    patches: [],
    ...overrides,
  };
}

test('buildWorkbookDiffRegions splits disjoint workbook change islands into separate regions', () => {
  const base = buildWorkbook([
    ['ID', 'Name', 'Type', 'Slot', 'Buff', 'Tag', 'Desc'],
    ['10001', 'Sword', 'Weapon', 'L', 'A', 'Alpha', 'Keep'],
    ['10002', 'Potion', 'Consumable', 'L', 'B', 'Beta', 'Keep'],
  ]);
  const mine = buildWorkbook([
    ['ID', 'Name', 'Type', 'Slot', 'Buff', 'Tag', 'Desc'],
    ['10001', 'Long Sword', 'Rare Weapon', 'L', 'A', 'Alpha+', 'Keep+'],
    ['10002', 'Hi-Potion', 'Epic Consumable', 'L', 'B', 'Beta', 'Keep'],
  ]);

  const diffLines = computeWorkbookDiff(base, mine);
  const sections = getWorkbookSections(diffLines);
  const rowIndex = buildWorkbookSectionRowIndex(diffLines, sections);
  const regions = buildWorkbookDiffRegions(
    sections,
    rowIndex,
    'BASE',
    'MINE',
  );

  assert.equal(regions.length, 2);
  assert.equal(regions[0]?.sheetName, 'Thing');
  assert.equal(regions[0]?.startCol, 1);
  assert.equal(regions[0]?.endCol, 2);
  assert.equal(regions[0]?.rowNumberStart, 2);
  assert.equal(regions[0]?.rowNumberEnd, 3);
  assert.equal(regions[1]?.startCol, 5);
  assert.equal(regions[1]?.endCol, 6);
  assert.equal(regions[1]?.rowNumberStart, 2);
  assert.equal(regions[1]?.rowNumberEnd, 2);
});

test('workbook diff regions expose region-level labels and selection lookup', () => {
  const base = buildWorkbook([
    ['ID', 'Name', 'Type'],
    ['10001', 'Sword', 'Weapon'],
    ['10002', 'Potion', 'Consumable'],
  ]);
  const mine = buildWorkbook([
    ['ID', 'Name', 'Type'],
    ['10001', 'Sword', 'Weapon'],
    ['10002', 'Hi-Potion', 'Consumable'],
  ]);

  const diffLines = computeWorkbookDiff(base, mine);
  const sections = getWorkbookSections(diffLines);
  const rowIndex = buildWorkbookSectionRowIndex(diffLines, sections);
  const regions = buildWorkbookDiffRegions(
    sections,
    rowIndex,
    'BASE',
    'MINE',
  );
  const activeRegion = regions[0];

  assert.ok(activeRegion);
  assert.equal(formatWorkbookDiffRegionLabel(activeRegion), 'Thing!B3');
  assert.equal(formatWorkbookDiffRegionSummary(activeRegion), 'B3 · 1×1');
  assert.equal(
    findWorkbookDiffRegionIndexForSelection(regions, activeRegion?.anchorSelection ?? null),
    0,
  );
});

test('workbook diff region semantic labels describe change direction and owning pane', () => {
  const labels = {
    add: 'Added on right',
    delete: 'Deleted on right',
    modify: 'Modified',
  };
  const added = buildRegion({
    rowNumberStart: 164,
    rowNumberEnd: 168,
    hasBaseSide: false,
    hasMineSide: true,
  });
  const deleted = buildRegion({
    rowNumberStart: 20,
    rowNumberEnd: 21,
    hasBaseSide: true,
    hasMineSide: false,
  });
  const modified = buildRegion({
    rowNumberStart: 8,
    rowNumberEnd: 8,
    hasBaseSide: true,
    hasMineSide: true,
  });

  assert.equal(resolveWorkbookDiffRegionChangeKind(added), 'add');
  assert.equal(formatWorkbookDiffRegionSemanticSummary(added, labels), 'Added on right A164:A168 · 5×1');
  assert.equal(shouldShowWorkbookDiffRegionLabelForSide(added, 'base'), false);
  assert.equal(shouldShowWorkbookDiffRegionLabelForSide(added, 'mine'), true);

  assert.equal(resolveWorkbookDiffRegionChangeKind(deleted), 'delete');
  assert.equal(formatWorkbookDiffRegionSemanticSummary(deleted, labels), 'Deleted on right A20:A21 · 2×1');
  assert.equal(shouldShowWorkbookDiffRegionLabelForSide(deleted, 'base'), true);
  assert.equal(shouldShowWorkbookDiffRegionLabelForSide(deleted, 'mine'), false);

  assert.equal(resolveWorkbookDiffRegionChangeKind(modified), 'modify');
  assert.equal(formatWorkbookDiffRegionSemanticSummary(modified, labels), 'Modified A8 · 1×1');
  assert.equal(shouldShowWorkbookDiffRegionLabelForSide(modified, 'base'), true);
  assert.equal(shouldShowWorkbookDiffRegionLabelForSide(modified, 'mine'), true);
});

test('stacked workbook region labels avoid side directions that are not visible', () => {
  const variants = {
    add: 'Added content',
    delete: 'Deleted content',
    addOnMine: 'Added on right',
    deleteFromMine: 'Deleted on right',
    modify: 'Modified',
  };

  assert.deepEqual(resolveWorkbookDiffRegionSemanticLabelsForLayout('stacked', variants), {
    add: 'Added content',
    delete: 'Deleted content',
    modify: 'Modified',
  });
  assert.deepEqual(resolveWorkbookDiffRegionSemanticLabelsForLayout('columns', variants), {
    add: 'Added on right',
    delete: 'Deleted on right',
    modify: 'Modified',
  });
  assert.deepEqual(resolveWorkbookDiffRegionSemanticLabelsForLayout('horizontal', variants), {
    add: 'Added on right',
    delete: 'Deleted on right',
    modify: 'Modified',
  });
});

test('buildWorkbookDiffRegions merges corner-touching workbook cells into one visual region', () => {
  const base = buildWorkbook([
    ['ID', 'Name', 'Type'],
    ['10001', 'Sword', 'Weapon'],
    ['10002', 'Potion', 'Consumable'],
  ]);
  const mine = buildWorkbook([
    ['ID', 'Name', 'Type'],
    ['10001', 'Long Sword', 'Weapon'],
    ['10002', 'Potion', 'Epic Consumable'],
  ]);

  const diffLines = computeWorkbookDiff(base, mine);
  const sections = getWorkbookSections(diffLines);
  const rowIndex = buildWorkbookSectionRowIndex(diffLines, sections);
  const regions = buildWorkbookDiffRegions(
    sections,
    rowIndex,
    'BASE',
    'MINE',
  );

  assert.equal(regions.length, 1);
  assert.equal(regions[0]?.startCol, 1);
  assert.equal(regions[0]?.endCol, 2);
  assert.equal(regions[0]?.rowNumberStart, 2);
  assert.equal(regions[0]?.rowNumberEnd, 3);
  assert.equal(regions[0]?.patches.length, 2);
});

test('buildWorkbookDiffRegions keeps workbook cells with a true gap as separate regions', () => {
  const base = buildWorkbook([
    ['ID', 'Name', 'Type', 'Slot'],
    ['10001', 'Sword', 'Weapon', 'L'],
    ['10002', 'Potion', 'Consumable', 'R'],
    ['10003', 'Shield', 'Armor', 'M'],
  ]);
  const mine = buildWorkbook([
    ['ID', 'Name', 'Type', 'Slot'],
    ['10001', 'Long Sword', 'Weapon', 'L'],
    ['10002', 'Potion', 'Consumable', 'R'],
    ['10003', 'Shield', 'Armor', 'Heavy'],
  ]);

  const diffLines = computeWorkbookDiff(base, mine);
  const sections = getWorkbookSections(diffLines);
  const rowIndex = buildWorkbookSectionRowIndex(diffLines, sections);
  const regions = buildWorkbookDiffRegions(
    sections,
    rowIndex,
    'BASE',
    'MINE',
  );

  assert.equal(regions.length, 2);
  assert.equal(regions[0]?.startCol, 1);
  assert.equal(regions[0]?.endCol, 1);
  assert.equal(regions[0]?.rowNumberStart, 2);
  assert.equal(regions[0]?.rowNumberEnd, 2);
  assert.equal(regions[1]?.startCol, 3);
  assert.equal(regions[1]?.endCol, 3);
  assert.equal(regions[1]?.rowNumberStart, 4);
  assert.equal(regions[1]?.rowNumberEnd, 4);
});

test('buildWorkbookDiffRegions merges edge-connected workbook cells into one visual region', () => {
  const base = buildWorkbook([
    ['ID', 'Name', 'Type'],
    ['10001', 'Sword', 'Weapon'],
    ['10002', 'Potion', 'Consumable'],
  ]);
  const mine = buildWorkbook([
    ['ID', 'Name', 'Type'],
    ['10001', 'Long Sword', 'Rare Weapon'],
    ['10002', 'Hi-Potion', 'Consumable'],
  ]);

  const diffLines = computeWorkbookDiff(base, mine);
  const sections = getWorkbookSections(diffLines);
  const rowIndex = buildWorkbookSectionRowIndex(diffLines, sections);
  const regions = buildWorkbookDiffRegions(
    sections,
    rowIndex,
    'BASE',
    'MINE',
  );

  assert.equal(regions.length, 1);
  assert.equal(regions[0]?.startCol, 1);
  assert.equal(regions[0]?.endCol, 2);
  assert.equal(regions[0]?.rowNumberStart, 2);
  assert.equal(regions[0]?.rowNumberEnd, 3);
  assert.equal(regions[0]?.patches.length, 3);
});

test('buildWorkbookNavigationRegions keeps disjoint cell islands within the same workbook hunk separate', () => {
  const base = buildWorkbook([
    ['ID', 'Name', 'Type', 'Slot', 'Buff', 'Tag', 'Desc'],
    ['10001', 'Sword', 'Weapon', 'L', 'A', 'Alpha', 'Keep'],
    ['10002', 'Potion', 'Consumable', 'L', 'B', 'Beta', 'Keep'],
  ]);
  const mine = buildWorkbook([
    ['ID', 'Name', 'Type', 'Slot', 'Buff', 'Tag', 'Desc'],
    ['10001', 'Long Sword', 'Rare Weapon', 'L', 'A', 'Alpha+', 'Keep+'],
    ['10002', 'Hi-Potion', 'Epic Consumable', 'L', 'B', 'Beta', 'Keep'],
  ]);

  const diffLines = computeWorkbookDiff(base, mine);
  const hunks = computeHunks(diffLines);
  const sections = getWorkbookSections(diffLines);
  const rowIndex = buildWorkbookSectionRowIndex(diffLines, sections);
  const cellRegions = buildWorkbookDiffRegions(
    sections,
    rowIndex,
    'BASE',
    'MINE',
  );
  const navigationRegions = buildWorkbookNavigationRegions(cellRegions, hunks);

  assert.equal(cellRegions.length, 2);
  assert.equal(navigationRegions.length, 2);
  assert.deepEqual(
    navigationRegions.map((region) => ({
      id: region.id,
      startCol: region.startCol,
      endCol: region.endCol,
      rowNumberStart: region.rowNumberStart,
      rowNumberEnd: region.rowNumberEnd,
    })),
    cellRegions.map((region) => ({
      id: region.id,
      startCol: region.startCol,
      endCol: region.endCol,
      rowNumberStart: region.rowNumberStart,
      rowNumberEnd: region.rowNumberEnd,
    })),
  );
  assert.equal(
    findWorkbookDiffRegionIndexForSelection(
      navigationRegions,
      cellRegions[1]?.anchorSelection ?? null,
    ),
    1,
  );
});

test('buildWorkbookNavigationRegions sorts workbook regions by sheet order, then row, then column', () => {
  const navigationRegions = buildWorkbookNavigationRegions([
    buildRegion({
      id: 'SheetB-r3-c1',
      sheetName: 'SheetB',
      rowNumberStart: 3,
      rowNumberEnd: 3,
      startRowIndex: 2,
      endRowIndex: 2,
      startCol: 1,
      endCol: 1,
      lineStartIdx: 10,
    }),
    buildRegion({
      id: 'SheetA-r2-c4',
      sheetName: 'SheetA',
      rowNumberStart: 2,
      rowNumberEnd: 2,
      startRowIndex: 1,
      endRowIndex: 1,
      startCol: 4,
      endCol: 4,
      lineStartIdx: 50,
    }),
    buildRegion({
      id: 'SheetB-r1-c2',
      sheetName: 'SheetB',
      rowNumberStart: 1,
      rowNumberEnd: 1,
      startRowIndex: 0,
      endRowIndex: 0,
      startCol: 2,
      endCol: 2,
      lineStartIdx: 5,
    }),
    buildRegion({
      id: 'SheetA-r2-c1',
      sheetName: 'SheetA',
      rowNumberStart: 2,
      rowNumberEnd: 2,
      startRowIndex: 1,
      endRowIndex: 1,
      startCol: 1,
      endCol: 1,
      lineStartIdx: 100,
    }),
  ], [], ['SheetA', 'SheetB']);

  assert.deepEqual(
    navigationRegions.map((region) => region.id),
    ['SheetA-r2-c1', 'SheetA-r2-c4', 'SheetB-r1-c2', 'SheetB-r3-c1'],
  );
});

test('buildWorkbookNavigationRegions preserves first-seen sheet order when no sheet order is provided', () => {
  const navigationRegions = buildWorkbookNavigationRegions([
    buildRegion({
      id: 'SheetB-r3-c1',
      sheetName: 'SheetB',
      rowNumberStart: 3,
      rowNumberEnd: 3,
      startRowIndex: 2,
      endRowIndex: 2,
      startCol: 1,
      endCol: 1,
    }),
    buildRegion({
      id: 'SheetA-r2-c4',
      sheetName: 'SheetA',
      rowNumberStart: 2,
      rowNumberEnd: 2,
      startRowIndex: 1,
      endRowIndex: 1,
      startCol: 4,
      endCol: 4,
    }),
    buildRegion({
      id: 'SheetB-r1-c2',
      sheetName: 'SheetB',
      rowNumberStart: 1,
      rowNumberEnd: 1,
      startRowIndex: 0,
      endRowIndex: 0,
      startCol: 2,
      endCol: 2,
    }),
    buildRegion({
      id: 'SheetA-r2-c1',
      sheetName: 'SheetA',
      rowNumberStart: 2,
      rowNumberEnd: 2,
      startRowIndex: 1,
      endRowIndex: 1,
      startCol: 1,
      endCol: 1,
    }),
  ], []);

  assert.deepEqual(
    navigationRegions.map((region) => region.id),
    ['SheetB-r1-c2', 'SheetB-r3-c1', 'SheetA-r2-c1', 'SheetA-r2-c4'],
  );
});

test('findWorkbookDiffRegionNavigationIndex starts from the current sheet when the visible sheet differs from the active diff region', () => {
  const navigationRegions = buildWorkbookNavigationRegions([
    buildRegion({ id: 'SheetA-r2-c1', sheetName: 'SheetA', rowNumberStart: 2, rowNumberEnd: 2, startRowIndex: 1, endRowIndex: 1, startCol: 1, endCol: 1 }),
    buildRegion({ id: 'SheetA-r4-c1', sheetName: 'SheetA', rowNumberStart: 4, rowNumberEnd: 4, startRowIndex: 3, endRowIndex: 3, startCol: 1, endCol: 1 }),
    buildRegion({ id: 'SheetB-r3-c2', sheetName: 'SheetB', rowNumberStart: 3, rowNumberEnd: 3, startRowIndex: 2, endRowIndex: 2, startCol: 2, endCol: 2 }),
    buildRegion({ id: 'SheetB-r5-c1', sheetName: 'SheetB', rowNumberStart: 5, rowNumberEnd: 5, startRowIndex: 4, endRowIndex: 4, startCol: 1, endCol: 1 }),
    buildRegion({ id: 'SheetC-r1-c1', sheetName: 'SheetC', rowNumberStart: 1, rowNumberEnd: 1, startRowIndex: 0, endRowIndex: 0, startCol: 1, endCol: 1 }),
  ], [], ['SheetA', 'SheetB', 'SheetC']);

  assert.equal(findWorkbookDiffRegionNavigationIndex({
    regions: navigationRegions,
    currentIndex: 0,
    direction: 1,
    activeSheetName: 'SheetB',
    sheetOrder: ['SheetA', 'SheetB', 'SheetC'],
  }), 2);
  assert.equal(findWorkbookDiffRegionNavigationIndex({
    regions: navigationRegions,
    currentIndex: 0,
    direction: -1,
    activeSheetName: 'SheetB',
    sheetOrder: ['SheetA', 'SheetB', 'SheetC'],
  }), 3);
});

test('findWorkbookDiffRegionNavigationIndex falls through to later sheets when the current sheet has no diffs', () => {
  const navigationRegions = buildWorkbookNavigationRegions([
    buildRegion({ id: 'SheetA-r2-c1', sheetName: 'SheetA', rowNumberStart: 2, rowNumberEnd: 2, startRowIndex: 1, endRowIndex: 1, startCol: 1, endCol: 1 }),
    buildRegion({ id: 'SheetC-r1-c1', sheetName: 'SheetC', rowNumberStart: 1, rowNumberEnd: 1, startRowIndex: 0, endRowIndex: 0, startCol: 1, endCol: 1 }),
  ], [], ['SheetA', 'SheetB', 'SheetC']);

  assert.equal(findWorkbookDiffRegionNavigationIndex({
    regions: navigationRegions,
    currentIndex: 0,
    direction: 1,
    activeSheetName: 'SheetB',
    sheetOrder: ['SheetA', 'SheetB', 'SheetC'],
  }), 1);
  assert.equal(findWorkbookDiffRegionNavigationIndex({
    regions: navigationRegions,
    currentIndex: 1,
    direction: -1,
    activeSheetName: 'SheetB',
    sheetOrder: ['SheetA', 'SheetB', 'SheetC'],
  }), 0);
});

test('buildWorkbookDiffRegions honors authoritative merge-aware deltas in content mode', () => {
  const diffLines = [
    {
      type: 'equal' as const,
      base: createWorkbookSheetLine('Thing'),
      mine: createWorkbookSheetLine('Thing'),
      baseLineNo: null,
      mineLineNo: null,
      baseCharSpans: null,
      mineCharSpans: null,
    },
    {
      type: 'equal' as const,
      base: createWorkbookRowLine(1, ['Group']),
      mine: createWorkbookRowLine(1, ['Group']),
      baseLineNo: 1,
      mineLineNo: 1,
      baseCharSpans: null,
      mineCharSpans: null,
    },
  ];
  const sections = getWorkbookSections(diffLines);
  const rowIndex = buildWorkbookSectionRowIndex(diffLines, sections, 'content');
  rowIndex.get('Thing')!.rows[0]!.workbookRowDelta = {
    cellDeltas: new Map([[0, {
      column: 0, baseCell: { value: 'Group', formula: '' }, mineCell: { value: 'Group', formula: '' },
      changed: true, masked: false, strictOnly: false, kind: 'modify',
      hasBaseContent: true, hasMineContent: true, hasContent: true,
    }]]),
    changedColumns: [0], strictOnlyColumns: [], changedCount: 1, hasChanges: true, tone: 'mixed',
  };
  const regions = buildWorkbookDiffRegions(
    sections,
    rowIndex,
    'BASE',
    'MINE',
    'content',
    {
      sheets: {
        Thing: {
          name: 'Thing',
          hiddenColumns: [],
          mergeRanges: [{ startRow: 1, endRow: 2, startCol: 0, endCol: 1 }],
        },
      },
    },
    {
      sheets: {
        Thing: {
          name: 'Thing',
          hiddenColumns: [],
          mergeRanges: [{ startRow: 1, endRow: 2, startCol: 0, endCol: 2 }],
        },
      },
    },
  );

  assert.equal(regions.length, 1);
  assert.equal(regions[0]?.startCol, 0);
  assert.equal(regions[0]?.endCol, 2);
  assert.equal(regions[0]?.rowNumberStart, 1);
  assert.equal(regions[0]?.rowNumberEnd, 2);
});
