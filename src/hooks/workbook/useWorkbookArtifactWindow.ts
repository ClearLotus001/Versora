import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { SplitRow, WorkbookMergeRange } from '@/types';
import type { WorkbookRowEntryMaps, WorkbookCompareCellsMaps, WorkbookCompareStateByRow } from '@/utils/workbook/workbookPanelHelpers';

const noSubscribe = () => () => {};
const zeroSnapshot = () => 0;

/** Explicit viewport hydration shared by all three Canvas layouts. */
export function useWorkbookArtifactWindow({ rows, columns, baseVersion, mineVersion, baseMerges = [], mineMerges = [], fallback }: {
  rows: readonly SplitRow[];
  columns: readonly number[];
  baseVersion: string;
  mineVersion: string;
  baseMerges?: readonly WorkbookMergeRange[];
  mineMerges?: readonly WorkbookMergeRange[];
  fallback: { entries: WorkbookRowEntryMaps; cells: WorkbookCompareCellsMaps; states: WorkbookCompareStateByRow };
}) {
  const fallbackBaseEntries = fallback.entries.base;
  const fallbackMineEntries = fallback.entries.mine;
  const fallbackBaseCells = fallback.cells.base;
  const fallbackMineCells = fallback.cells.mine;
  const fallbackStates = fallback.states;
  const provider = rows[0]?.workbookArtifactRow?.provider;
  const revision = useSyncExternalStore(provider?.subscribe ?? noSubscribe, provider?.getSnapshot ?? zeroSnapshot);
  const columnKey = columns.join(',');
  const rowKey = rows.map((row) => row.lineIdx).join(',');
  const requests = useMemo(() => {
    if (!provider) return null;
    const selectedColumns = [...new Set(columns)];
    const sheetId = rows[0]!.workbookArtifactRow!.sheetId;
    const anchorRows = new Set<SplitRow>();
    const anchors = { base: [] as Array<{ rowNumber: number; column: number }>, mine: [] as Array<{ rowNumber: number; column: number }> };
    for (const side of ['base', 'mine'] as const) {
      const numbers = rows.map((row) => side === 'base' ? row.workbookArtifactRow!.baseRowNumber : row.workbookArtifactRow!.mineRowNumber).filter((number): number is number => number != null);
      if (!numbers.length) continue;
      const firstRow = Math.min(...numbers); const lastRow = Math.max(...numbers);
      for (const range of side === 'base' ? baseMerges : mineMerges) {
        if (range.endRow < firstRow || range.startRow > lastRow || !columns.some((column) => column >= range.startCol && column <= range.endCol)) continue;
        anchors[side].push({ rowNumber: range.startRow, column: range.startCol });
        const index = provider.findPhysicalRowIndex(sheetId, side, range.startRow);
        const ref = index == null ? null : provider.getRowReference(index);
        if (ref) anchorRows.add(provider.getRows(provider.descriptor.sheets.find((sheet) => sheet.id === sheetId)!.name)![ref.localRowIndex]!);
        if (!selectedColumns.includes(range.startCol)) selectedColumns.push(range.startCol);
      }
    }
    return { sheetId, selectedColumns, anchors, rows: [...new Set([...rows, ...anchorRows])] };
    // Keys describe the requested coordinates; no cache read is hidden here.
  }, [provider, rowKey, columnKey, baseMerges, mineMerges]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!provider || !requests) return;
    void provider.ensureRows(requests.rows, requests.selectedColumns);
    for (const side of ['base', 'mine'] as const) void provider.ensureCells(requests.sheetId, side, requests.anchors[side]);
  }, [provider, requests]);
  return useMemo(() => {
    if (!provider || !requests) return { entries: { base: fallbackBaseEntries, mine: fallbackMineEntries },
      cells: { base: fallbackBaseCells, mine: fallbackMineCells }, states: fallbackStates };
    const entries: WorkbookRowEntryMaps = { base: new Map(), mine: new Map() };
    const cells: WorkbookCompareCellsMaps = { base: new Map(), mine: new Map() };
    const states: WorkbookCompareStateByRow = new Map();
    for (const row of requests.rows) {
      const ref = row.workbookArtifactRow!;
      const delta = provider.buildWindowDelta(ref, requests.selectedColumns, row.workbookRowDelta!);
      states.set(row, delta);
      for (const side of ['base', 'mine'] as const) {
        const entry = provider.buildEntry(ref, side, side === 'base' ? baseVersion : mineVersion, requests.selectedColumns, true);
        if (entry) { entries[side].set(entry.rowNumber, entry); cells[side].set(entry.rowNumber, delta.cellDeltas); }
      }
    }
    return { entries, cells, states, revision };
  }, [provider, requests, revision, baseVersion, mineVersion,
    fallbackBaseEntries, fallbackMineEntries, fallbackBaseCells, fallbackMineCells, fallbackStates]);
}
