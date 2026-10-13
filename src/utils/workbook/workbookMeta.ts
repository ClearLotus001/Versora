import type {
  SplitRow,
  WorkbookCompareMode,
  WorkbookHiddenColumnSegment,
  WorkbookMergeRange,
  WorkbookMetadataMap,
  WorkbookSheetMetadata,
  WorkbookSheetPresentation,
} from '@/types';
import { parseWorkbookDiffLine } from '@/utils/workbook/workbookDisplay';
import { hasWorkbookCellContent } from '@/utils/workbook/workbookCellContract';
import { buildWorkbookHiddenColumnSegments } from '@/utils/workbook/workbookManualVisibility';
import { buildWorkbookSplitRowCompareState } from '@/utils/workbook/workbookCompare';
import { buildWorkbookAutoCollapsedColumns } from '@/utils/workbook/workbookAutoCollapse';
export type {
  WorkbookHiddenColumnSegment,
  WorkbookMergeRange,
  WorkbookMetadataMap,
  WorkbookSheetMetadata,
  WorkbookSheetPresentation,
};

const sheetPresentationCache = new WeakMap<SplitRow[], Map<string, WorkbookSheetPresentation>>();
const usedColumnsBySideCache = new WeakMap<
  SplitRow[],
  Map<WorkbookCompareMode, { base: Set<number>; mine: Set<number> }>
>();
const cacheObjectIds = new WeakMap<object, number>();
let nextCacheObjectId = 1;

function getCacheObjectId(value: object | null | undefined): number {
  if (!value) return 0;
  const existing = cacheObjectIds.get(value);
  if (existing) return existing;
  const nextId = nextCacheObjectId;
  nextCacheObjectId += 1;
  cacheObjectIds.set(value, nextId);
  return nextId;
}

function collectUsedColumnsBySide(
  rows: SplitRow[],
  compareMode: WorkbookCompareMode = 'strict',
): { base: Set<number>; mine: Set<number> } {
  let cacheByMode = usedColumnsBySideCache.get(rows);
  if (!cacheByMode) {
    cacheByMode = new Map();
    usedColumnsBySideCache.set(rows, cacheByMode);
  }
  const cached = cacheByMode.get(compareMode);
  if (cached) return cached;
  const artifactRow = rows[0]?.workbookArtifactRow;
  if (artifactRow) {
    const sheet = artifactRow.provider.descriptor.sheets.find((item) => item.id === artifactRow.sheetId)!;
    const summary = { base: new Set(sheet.baseUsedColumns), mine: new Set(sheet.mineUsedColumns) };
    cacheByMode.set(compareMode, summary);
    return summary;
  }

  const base = new Set<number>();
  const mine = new Set<number>();

  rows.forEach(row => {
    const baseParsed = parseWorkbookDiffLine(row.left);
    if (baseParsed?.kind === 'row') {
      baseParsed.cells.forEach((cell, index) => {
        if (hasWorkbookCellContent(cell, compareMode)) {
          base.add(index);
        }
      });
    }

    const mineParsed = row.right?.mine != null
      ? parseWorkbookDiffLine(row.right, 'mine')
      : parseWorkbookDiffLine(row.right, 'base');
    if (mineParsed?.kind === 'row') {
      mineParsed.cells.forEach((cell, index) => {
        if (hasWorkbookCellContent(cell, compareMode)) {
          mine.add(index);
        }
      });
    }
  });

  const nextValue = { base, mine };
  cacheByMode.set(compareMode, nextValue);
  return nextValue;
}

function collectMergedColumns(ranges: WorkbookMergeRange[]): Set<number> {
  const cols = new Set<number>();

  ranges.forEach(range => {
    for (let col = range.startCol; col <= range.endCol; col += 1) {
      cols.add(col);
    }
  });

  return cols;
}

function addIntersectingMergedColumns(
  ranges: WorkbookMergeRange[],
  anchorColumns: ReadonlySet<number>,
  targetColumns: Set<number>,
) {
  ranges.forEach((range) => {
    let intersects = false;
    for (let column = range.startCol; column <= range.endCol; column += 1) {
      if (anchorColumns.has(column)) {
        intersects = true;
        break;
      }
    }
    if (!intersects) return;
    for (let column = range.startCol; column <= range.endCol; column += 1) {
      targetColumns.add(column);
    }
  });
}

export function buildWorkbookSheetPresentation(
  rows: SplitRow[],
  sheetName: string,
  baseMetadata: WorkbookMetadataMap | null,
  mineMetadata: WorkbookMetadataMap | null,
  fallbackColumnCount: number,
  includeHiddenColumns = false,
  compareMode: WorkbookCompareMode = 'strict',
  manualHiddenColumns: number[] = [],
  autoCollapseUnchangedColumns = false,
  revealedAutoColumns: number[] = [],
  protectedAutoCollapseColumns: number[] = [],
  protectedAutoCollapseColumnCount = 0,
  hideUnchangedColumns = false,
): WorkbookSheetPresentation {
  const baseSheet = baseMetadata?.sheets[sheetName] ?? null;
  const mineSheet = mineMetadata?.sheets[sheetName] ?? null;
  let rowsCache = sheetPresentationCache.get(rows);
  if (!rowsCache) {
    rowsCache = new Map<string, WorkbookSheetPresentation>();
    sheetPresentationCache.set(rows, rowsCache);
  }

  const cacheKey = [
    sheetName,
    fallbackColumnCount,
    includeHiddenColumns ? '1' : '0',
    compareMode,
    manualHiddenColumns.join(','),
    autoCollapseUnchangedColumns ? '1' : '0',
    revealedAutoColumns.join(','),
    protectedAutoCollapseColumns.join(','),
    protectedAutoCollapseColumnCount,
    hideUnchangedColumns ? 'diff-only' : 'all-columns',
    getCacheObjectId(baseSheet),
    getCacheObjectId(mineSheet),
  ].join('::');
  const cachedPresentation = rowsCache.get(cacheKey);
  if (cachedPresentation) return cachedPresentation;

  const baseHidden = new Set(baseSheet?.hiddenColumns ?? []);
  const mineHidden = new Set(mineSheet?.hiddenColumns ?? []);
  const manualHidden = new Set(manualHiddenColumns);
  const usedColumnsBySide = collectUsedColumnsBySide(rows, compareMode);

  const candidateColumns = new Set<number>();
  [
    usedColumnsBySide.base,
    usedColumnsBySide.mine,
    collectMergedColumns(baseSheet?.mergeRanges ?? []),
    collectMergedColumns(mineSheet?.mergeRanges ?? []),
  ].forEach(columnSet => {
    columnSet.forEach(column => candidateColumns.add(column));
  });

  if (includeHiddenColumns) {
    (baseSheet?.hiddenColumns ?? []).forEach(column => candidateColumns.add(column));
    (mineSheet?.hiddenColumns ?? []).forEach(column => candidateColumns.add(column));
  }

  if (candidateColumns.size === 0) {
    for (let column = 0; column < Math.max(1, fallbackColumnCount); column += 1) {
      candidateColumns.add(column);
    }
  }

  const allColumns = [...candidateColumns].sort((left, right) => left - right);

  const protectedColumns = new Set<number>(hideUnchangedColumns
    ? protectedAutoCollapseColumns
    : [
        ...revealedAutoColumns,
        ...protectedAutoCollapseColumns,
        ...allColumns.slice(0, Math.max(0, protectedAutoCollapseColumnCount)),
        ...collectMergedColumns(baseSheet?.mergeRanges ?? []),
        ...collectMergedColumns(mineSheet?.mergeRanges ?? []),
      ]);
  let hasStructuralColumnChange = false;
  if (autoCollapseUnchangedColumns || hideUnchangedColumns) {
    const artifactRow = rows[0]?.workbookArtifactRow;
    if (artifactRow) {
      const sheet = artifactRow.provider.descriptor.sheets.find((item) => item.id === artifactRow.sheetId)!;
      (sheet.changedColumns ?? []).forEach((column) => protectedColumns.add(column));
      hasStructuralColumnChange = sheet.addedRows > 0 || sheet.deletedRows > 0;
    } else rows.forEach((row) => {
      const rowDelta = buildWorkbookSplitRowCompareState(row, undefined, compareMode);
      if (rowDelta.structuralChange) hasStructuralColumnChange = true;
      rowDelta.changedColumns
        .forEach((column) => protectedColumns.add(column));
    });
  }
  if (hideUnchangedColumns) {
    if (hasStructuralColumnChange) {
      allColumns.forEach((column) => protectedColumns.add(column));
    }
    const mergeAnchors = new Set(protectedColumns);
    addIntersectingMergedColumns(baseSheet?.mergeRanges ?? [], mergeAnchors, protectedColumns);
    addIntersectingMergedColumns(mineSheet?.mergeRanges ?? [], mergeAnchors, protectedColumns);
  }
  const differenceOnlyHiddenColumnSet = new Set(hideUnchangedColumns
    ? allColumns.filter((column) => !protectedColumns.has(column))
    : []);
  const autoCollapsedColumns = autoCollapseUnchangedColumns && !hideUnchangedColumns
    ? buildWorkbookAutoCollapsedColumns(allColumns, protectedColumns)
    : [];
  const autoCollapsedColumnSet = new Set(autoCollapsedColumns);

  let visibleColumns = allColumns
    .filter(column => (
      (
        includeHiddenColumns
        || (
          !(baseHidden.has(column) && mineHidden.has(column))
          && !manualHidden.has(column)
        )
      )
      && !autoCollapsedColumnSet.has(column)
      && !differenceOnlyHiddenColumnSet.has(column)
    ));

  if (visibleColumns.length === 0) visibleColumns = [0];

  const presentation: WorkbookSheetPresentation = {
    allColumns,
    visibleColumns,
    hiddenColumnSegments: buildWorkbookHiddenColumnSegments(
      allColumns,
      [
        ...autoCollapsedColumns,
        ...(includeHiddenColumns ? [] : manualHiddenColumns),
      ],
    ),
    autoCollapsedColumns,
    autoCollapsedColumnSegments: buildWorkbookHiddenColumnSegments(allColumns, autoCollapsedColumns),
    baseMergeRanges: baseSheet?.mergeRanges ?? [],
    mineMergeRanges: mineSheet?.mergeRanges ?? [],
  };
  rowsCache.set(cacheKey, presentation);
  return presentation;
}
