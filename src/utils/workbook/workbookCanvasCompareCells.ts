import type { WorkbookCellDelta } from '@/types';
import type { WorkbookRowEntry } from '@/utils/workbook/workbookNavigation';
import {
  getWorkbookMergedCompareCell,
  getWorkbookMergedCompareCellFromRows,
} from '@/utils/workbook/workbookMergeLayout';

export interface WorkbookCanvasCompareCellRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export interface ResolveWorkbookCanvasCompareCellParams {
  compareCellsByRowNumber: Map<number, Map<number, WorkbookCellDelta>>;
  rowCompareCells: Map<number, WorkbookCellDelta>;
  anchorRowNumber: number;
  column: number;
  mergeRange?: WorkbookCanvasCompareCellRange | null;
}

export function resolveWorkbookCanvasAnchor({
  entry,
  rowEntryByRowNumber,
  column,
  mergeRange = null,
}: {
  entry: WorkbookRowEntry;
  rowEntryByRowNumber: ReadonlyMap<number, WorkbookRowEntry>;
  column: number;
  mergeRange?: WorkbookCanvasCompareCellRange | null;
}): { entry: WorkbookRowEntry; rowNumber: number; column: number } {
  const rowNumber = mergeRange?.startRow ?? entry.rowNumber;
  return {
    entry: rowEntryByRowNumber.get(rowNumber) ?? entry,
    rowNumber,
    column: mergeRange?.startCol ?? column,
  };
}

export function resolveWorkbookCanvasCompareCell({
  compareCellsByRowNumber,
  rowCompareCells,
  anchorRowNumber,
  column,
  mergeRange = null,
}: ResolveWorkbookCanvasCompareCellParams): WorkbookCellDelta | undefined {
  if (mergeRange) {
    return getWorkbookMergedCompareCellFromRows(compareCellsByRowNumber, mergeRange)
      ?? getWorkbookMergedCompareCell(rowCompareCells, mergeRange);
  }

  return compareCellsByRowNumber.get(anchorRowNumber)?.get(column)
    ?? rowCompareCells.get(column);
}
