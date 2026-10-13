import type { WorkbookCompareMode } from '@/types';
import { buildWorkbookSplitRowCompareState } from '@/utils/workbook/workbookCompare';
import { resolveWorkbookCompareCellKind } from '@/utils/workbook/workbookCompareVisuals';
import { getWorkbookRowDeltaEntries } from '@/utils/workbook/workbookDelta';
import type { WorkbookSectionRowIndex } from '@/utils/workbook/workbookSheetIndex';

export interface WorkbookCellChangeSummary {
  added: number;
  removed: number;
  modified: number;
  strictOnly: number;
}

const EMPTY_WORKBOOK_CELL_CHANGE_SUMMARY: WorkbookCellChangeSummary = {
  added: 0,
  removed: 0,
  modified: 0,
  strictOnly: 0,
};

export function summarizeWorkbookCellChanges(
  sheetName: string | null,
  sectionRowIndex: WorkbookSectionRowIndex,
  compareMode: WorkbookCompareMode,
): WorkbookCellChangeSummary {
  if (!sheetName) return EMPTY_WORKBOOK_CELL_CHANGE_SUMMARY;

  const rows = sectionRowIndex.get(sheetName)?.rows;
  if (!rows?.length) return EMPTY_WORKBOOK_CELL_CHANGE_SUMMARY;

  const summary: WorkbookCellChangeSummary = {
    added: 0,
    removed: 0,
    modified: 0,
    strictOnly: 0,
  };
  const artifact = rows[0]?.workbookArtifactRow;
  if (artifact) {
    const { descriptor } = artifact.provider;
    const sheet = descriptor.sheets.find((item) => item.id === artifact.sheetId)!;
    const start = descriptor.rows.runOffsets[sheet.pairStart]!;
    const end = descriptor.rows.runOffsets[sheet.pairStart + sheet.pairCount]!;
    for (let run = start; run < end; run += 1) {
      const count = descriptor.runs.ends[run]! - descriptor.runs.starts[run]!;
      const flags = descriptor.runs.flags[run]!;
      const kind = flags & 3;
      if (kind === 1) summary.added += count;
      else if (kind === 2) summary.removed += count;
      else if (flags & 4) summary.strictOnly += count;
      else summary.modified += count;
    }
    return summary;
  }

  rows.forEach((row) => {
    const rowDelta = buildWorkbookSplitRowCompareState(row, undefined, compareMode);
    getWorkbookRowDeltaEntries(rowDelta).forEach((cellDelta) => {
      if (!cellDelta.changed) return;
      const kind = resolveWorkbookCompareCellKind(cellDelta, compareMode);
      if (kind === 'add') summary.added += 1;
      else if (kind === 'delete') summary.removed += 1;
      else if (kind === 'strict-only') summary.strictOnly += 1;
      else if (kind === 'modify') summary.modified += 1;
    });
  });

  return summary;
}
