import type { SplitRow, WorkbookMergeRange } from '@/types';
import { ROW_H } from '@/hooks/virtualization/useVirtual';
import {
  getWorkbookSideRowNumber,
} from '@/utils/workbook/workbookNavigation';
import type { WorkbookCompactRenderMode } from '@/utils/workbook/workbookRowBehavior';

export interface WorkbookStackedLayoutRowInput {
  row: SplitRow;
  renderMode: WorkbookCompactRenderMode;
  height: number;
}

export interface WorkbookStackedLayoutRow {
  key: string;
  row: SplitRow;
  renderMode: WorkbookCompactRenderMode;
  height: number;
  baseRowNumber: number | null;
  mineRowNumber: number | null;
}

export interface WorkbookStackedMergeCoverageWindow {
  key: string;
  side: 'base' | 'mine';
  range: WorkbookMergeRange;
  startIndex: number;
  endIndex: number;
}

export interface WorkbookStackedMergedCoverageWindow {
  key: string;
  startIndex: number;
  endIndex: number;
  windows: WorkbookStackedMergeCoverageWindow[];
}

export interface WorkbookStackedTrackItem {
  sourceRowIndex: number;
  renderMode: WorkbookCompactRenderMode;
  rowNumber: number;
}

export interface WorkbookStackedVisualGroup {
  key: string;
  startIndex: number;
  endIndex: number;
  reason: 'plain' | 'merge';
  rows: WorkbookStackedLayoutRow[];
  baseTrack: WorkbookStackedTrackItem[];
  mineTrack: WorkbookStackedTrackItem[];
  mergeWindows: WorkbookStackedMergeCoverageWindow[];
}

const WORKBOOK_STACKED_GROUP_MAX_HEIGHT = ROW_H * 64;

export function splitWorkbookStackedRowsByHeight<T>(params: {
  rows: readonly T[];
  getHeight: (row: T) => number;
  startIndex?: number;
  endIndex?: number;
  maxHeight?: number;
}): Array<{ startIndex: number; endIndex: number }> {
  const {
    rows,
    getHeight,
    startIndex: rawStartIndex = 0,
    endIndex: rawEndIndex = rows.length - 1,
    maxHeight = WORKBOOK_STACKED_GROUP_MAX_HEIGHT,
  } = params;
  if (rows.length === 0) return [];

  const startIndex = Math.max(0, rawStartIndex);
  const endIndex = Math.min(rows.length - 1, rawEndIndex);
  if (startIndex > endIndex) return [];

  const heightBudget = Math.max(1, maxHeight);
  const chunks: Array<{ startIndex: number; endIndex: number }> = [];
  let chunkStart = startIndex;
  let chunkHeight = 0;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const row = rows[index]!;
    const rowHeight = Math.max(0, getHeight(row));
    if (index > chunkStart && chunkHeight + rowHeight > heightBudget) {
      chunks.push({ startIndex: chunkStart, endIndex: index - 1 });
      chunkStart = index;
      chunkHeight = 0;
    }
    chunkHeight += rowHeight;
  }

  chunks.push({ startIndex: chunkStart, endIndex });
  return chunks;
}

function buildMergeWindowKey(
  side: 'base' | 'mine',
  range: WorkbookMergeRange,
): string {
  return `${side}:${range.startRow}:${range.endRow}:${range.startCol}:${range.endCol}`;
}

function isVerticalMerge(range: WorkbookMergeRange): boolean {
  return range.endRow > range.startRow;
}

interface StackedCoverageIndex {
  rowNumbers: number[];
  leafCount: number;
  minSourceIndexes: Uint32Array;
  maxSourceIndexes: Uint32Array;
}

function buildCoverageIndex(
  rows: WorkbookStackedLayoutRow[],
  side: 'base' | 'mine',
): StackedCoverageIndex {
  const entries: Array<{ rowNumber: number; sourceIndex: number }> = [];
  rows.forEach((row, sourceIndex) => {
    const rowNumber = side === 'base' ? row.baseRowNumber : row.mineRowNumber;
    if (rowNumber != null) entries.push({ rowNumber, sourceIndex });
  });
  entries.sort((left, right) => left.rowNumber - right.rowNumber);

  let leafCount = 1;
  while (leafCount < entries.length) leafCount *= 2;
  const minSourceIndexes = new Uint32Array(leafCount * 2).fill(rows.length);
  const maxSourceIndexes = new Uint32Array(leafCount * 2);
  entries.forEach((entry, index) => {
    minSourceIndexes[leafCount + index] = entry.sourceIndex;
    maxSourceIndexes[leafCount + index] = entry.sourceIndex;
  });
  for (let index = leafCount - 1; index > 0; index -= 1) {
    minSourceIndexes[index] = Math.min(minSourceIndexes[index * 2]!, minSourceIndexes[index * 2 + 1]!);
    maxSourceIndexes[index] = Math.max(maxSourceIndexes[index * 2]!, maxSourceIndexes[index * 2 + 1]!);
  }
  return { rowNumbers: entries.map((entry) => entry.rowNumber), leafCount, minSourceIndexes, maxSourceIndexes };
}

function findCoverageBoundary(rowNumbers: number[], rowNumber: number, inclusive: boolean): number {
  let low = 0;
  let high = rowNumbers.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rowNumbers[middle]! < rowNumber || (inclusive && rowNumbers[middle] === rowNumber)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function resolveCoverageWindow(index: StackedCoverageIndex, range: WorkbookMergeRange) {
  let start = findCoverageBoundary(index.rowNumbers, range.startRow, false);
  let end = findCoverageBoundary(index.rowNumbers, range.endRow, true);
  if (start >= end) return null;

  // Source order can differ from worksheet row order after alignment. Query the
  // interval extrema instead of assuming its first and last entries are enough.
  let startIndex = Number.POSITIVE_INFINITY;
  let endIndex = 0;
  start += index.leafCount;
  end += index.leafCount;
  while (start < end) {
    if (start % 2 === 1) {
      startIndex = Math.min(startIndex, index.minSourceIndexes[start]!);
      endIndex = Math.max(endIndex, index.maxSourceIndexes[start]!);
      start += 1;
    }
    if (end % 2 === 1) {
      end -= 1;
      startIndex = Math.min(startIndex, index.minSourceIndexes[end]!);
      endIndex = Math.max(endIndex, index.maxSourceIndexes[end]!);
    }
    start = Math.floor(start / 2);
    end = Math.floor(end / 2);
  }
  return { startIndex, endIndex };
}

function buildTrack(
  rows: WorkbookStackedLayoutRow[],
  side: 'base' | 'mine',
): WorkbookStackedTrackItem[] {
  return rows.flatMap((row, sourceRowIndex) => {
    const rowNumber = side === 'base' ? row.baseRowNumber : row.mineRowNumber;
    return rowNumber != null
      ? [{
        sourceRowIndex,
        renderMode: row.renderMode,
        rowNumber,
      }]
      : [];
  });
}

export function buildWorkbookStackedLayoutRows(params: {
  rows: WorkbookStackedLayoutRowInput[];
}): WorkbookStackedLayoutRow[] {
  const { rows } = params;

  return rows.map((item, index) => {
    return {
      key: `stacked-layout-row:${index}:${item.row.lineIdx}`,
      row: item.row,
      renderMode: item.renderMode,
      height: item.height,
      baseRowNumber: getWorkbookSideRowNumber(item.row, 'base'),
      mineRowNumber: getWorkbookSideRowNumber(item.row, 'mine'),
    };
  });
}

export function buildWorkbookStackedMergeCoverageWindows(params: {
  rows: WorkbookStackedLayoutRow[];
  baseMergeRanges: ReadonlyArray<WorkbookMergeRange>;
  mineMergeRanges: ReadonlyArray<WorkbookMergeRange>;
}): WorkbookStackedMergeCoverageWindow[] {
  const {
    rows,
    baseMergeRanges,
    mineMergeRanges,
  } = params;

  const windows: WorkbookStackedMergeCoverageWindow[] = [];
  const appendWindows = (side: 'base' | 'mine', ranges: ReadonlyArray<WorkbookMergeRange>) => {
    if (!ranges.some(isVerticalMerge)) return;
    const coverageIndex = buildCoverageIndex(rows, side);
    ranges
      .filter(isVerticalMerge)
      .forEach((range) => {
        const coverage = resolveCoverageWindow(coverageIndex, range);
        if (!coverage) return;

        windows.push({
          key: buildMergeWindowKey(side, range),
          side,
          range,
          ...coverage,
        });
      });
  };

  appendWindows('base', baseMergeRanges);
  appendWindows('mine', mineMergeRanges);

  return windows.sort((left, right) => (
    left.startIndex - right.startIndex
    || left.endIndex - right.endIndex
    || left.key.localeCompare(right.key)
  ));
}

export function mergeWorkbookStackedCoverageWindows(
  windows: WorkbookStackedMergeCoverageWindow[],
): WorkbookStackedMergedCoverageWindow[] {
  if (windows.length === 0) return [];

  const merged: WorkbookStackedMergedCoverageWindow[] = [];
  windows.forEach((window) => {
    const previous = merged[merged.length - 1];
    if (!previous || window.startIndex > previous.endIndex) {
      merged.push({
        key: `coverage:${window.startIndex}:${window.endIndex}:${window.key}`,
        startIndex: window.startIndex,
        endIndex: window.endIndex,
        windows: [window],
      });
      return;
    }

    previous.endIndex = Math.max(previous.endIndex, window.endIndex);
    previous.windows.push(window);
  });

  return merged;
}

export function buildWorkbookStackedVisualGroups(params: {
  rows: WorkbookStackedLayoutRow[];
  baseMergeRanges: ReadonlyArray<WorkbookMergeRange>;
  mineMergeRanges: ReadonlyArray<WorkbookMergeRange>;
}): WorkbookStackedVisualGroup[] {
  const {
    rows,
    baseMergeRanges,
    mineMergeRanges,
  } = params;

  if (rows.length === 0) return [];

  const coverageWindows = buildWorkbookStackedMergeCoverageWindows({
    rows,
    baseMergeRanges,
    mineMergeRanges,
  });
  const mergedWindows = mergeWorkbookStackedCoverageWindows(coverageWindows);
  const groups: WorkbookStackedVisualGroup[] = [];

  const pushGroup = (
    startIndex: number,
    endIndex: number,
    reason: 'plain' | 'merge',
    mergeWindows: WorkbookStackedMergeCoverageWindow[],
  ) => {
    const groupRows = rows.slice(startIndex, endIndex + 1);
    groups.push({
      key: `stacked-group:${reason}:${startIndex}:${endIndex}`,
      startIndex,
      endIndex,
      reason,
      rows: groupRows,
      baseTrack: buildTrack(groupRows, 'base'),
      mineTrack: buildTrack(groupRows, 'mine'),
      mergeWindows,
    });
  };

  const pushPlainGroups = (startIndex: number, endIndex: number) => {
    if (startIndex > endIndex) return;
    splitWorkbookStackedRowsByHeight({
      rows,
      startIndex,
      endIndex,
      getHeight: (row) => row.height,
    }).forEach((chunk) => {
      pushGroup(chunk.startIndex, chunk.endIndex, 'plain', []);
    });
  };

  let cursor = 0;
  mergedWindows.forEach((window) => {
    if (cursor < window.startIndex) {
      pushPlainGroups(cursor, window.startIndex - 1);
    }
    // A real tall merge must remain granular too: drawing uses the sheet-wide
    // anchor and clips its geometry to the rows of each virtual group.
    splitWorkbookStackedRowsByHeight({
      rows,
      startIndex: window.startIndex,
      endIndex: window.endIndex,
      getHeight: (row) => row.height,
    }).forEach((chunk) => {
      pushGroup(chunk.startIndex, chunk.endIndex, 'merge', window.windows);
    });
    cursor = window.endIndex + 1;
  });

  if (cursor < rows.length) {
    pushPlainGroups(cursor, rows.length - 1);
  }

  return groups;
}
