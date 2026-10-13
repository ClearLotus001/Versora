import type { SplitRow } from '@/types';
import { parseWorkbookDisplayLine } from '@/utils/workbook/workbookDisplay';
import { ROW_H } from '@/hooks/virtualization/useVirtual';

export type WorkbookCompactRenderMode = 'single-base' | 'single-mine' | 'single-equal' | 'double';
export interface WorkbookStackedVisibleBands {
  base: boolean;
  mine: boolean;
}
export function getWorkbookStackedBandDisplayRowNumber(
  side: 'base' | 'mine',
  baseRowNumber: number | null,
  mineRowNumber: number | null,
): number | null {
  return side === 'base'
    ? (baseRowNumber ?? mineRowNumber)
    : (mineRowNumber ?? baseRowNumber);
}

export function shouldRenderSingleMineStackedRow(row: SplitRow): boolean {
  if (row.workbookArtifactRow) return row.workbookArtifactRow.kind === 1;
  return row.left == null && row.right?.type === 'add';
}

export function shouldRenderSingleBaseStackedRow(row: SplitRow): boolean {
  if (row.workbookArtifactRow) return row.workbookArtifactRow.kind === 2;
  return row.right == null && row.left?.type === 'delete';
}

export function shouldRenderSingleEqualStackedRow(row: SplitRow): boolean {
  if (row.workbookArtifactRow) return row.workbookArtifactRow.kind === 0 && row.workbookArtifactRow.baseRowNumber === row.workbookArtifactRow.mineRowNumber;
  if (!row.left || !row.right) return false;
  if (row.left.type !== 'equal' || row.right.type !== 'equal') return false;
  if (row.left.base == null || row.right.mine == null) return false;
  if (row.left.base !== row.right.mine) return false;

  const leftParsed = parseWorkbookDisplayLine(row.left.base);
  const rightParsed = parseWorkbookDisplayLine(row.right.mine);
  return leftParsed?.kind === 'row'
    && rightParsed?.kind === 'row'
    && leftParsed.rowNumber === rightParsed.rowNumber;
}

export function getWorkbookCompactRenderMode(row: SplitRow): WorkbookCompactRenderMode {
  if (shouldRenderSingleMineStackedRow(row)) return 'single-mine';
  if (shouldRenderSingleBaseStackedRow(row)) return 'single-base';
  if (shouldRenderSingleEqualStackedRow(row)) return 'single-equal';
  return 'double';
}

export function getWorkbookColumnsRenderMode(_row: SplitRow): WorkbookCompactRenderMode {
  return 'double';
}

export function getWorkbookStackedRenderMode(row: SplitRow): WorkbookCompactRenderMode {
  return shouldRenderSingleEqualStackedRow(row) ? 'single-equal' : 'double';
}

export function getWorkbookStackedVisibleBands(
  hasBaseEntry: boolean,
  hasMineEntry: boolean,
  rowHeight: number,
): WorkbookStackedVisibleBands {
  if (rowHeight > ROW_H) {
    return { base: true, mine: true };
  }
  return {
    base: hasBaseEntry,
    mine: hasMineEntry && !hasBaseEntry,
  };
}

export function getStackedWorkbookRowRenderHeight(row: SplitRow, defaultHeight: number, compactHeight: number): number {
  return getWorkbookStackedRenderMode(row) === 'double' ? defaultHeight : compactHeight;
}
