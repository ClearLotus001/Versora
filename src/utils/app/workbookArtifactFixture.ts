/** Test-only canonical workbook adapter. The product Canvas consumes the same provider contract. */
import type { WorkbookArtifactDescriptor, WorkbookArtifactWindow, WorkbookArtifactWindowRequest, WorkbookArtifactCell, WorkbookArtifactSearchMatch } from '../../../shared/workbookArtifactProtocol';
import { computeWorkbookDiff } from '@/engine/workbook/workbookDiff';
import { compileSearchPattern, scanMatchesInSearchableLines } from '@/engine/text/search';
import { getWorkbookSections } from '@/utils/workbook/workbookSections';
import { buildWorkbookSectionRowIndex } from '@/utils/workbook/workbookSheetIndex';
import { buildWorkbookDiffRegions } from '@/utils/workbook/workbookDiffRegion';
import { buildWorkbookRowEntry, resolveWorkbookSearchMatchColumnIndex } from '@/utils/workbook/workbookNavigation';
import { createWorkbookRowLine, getWorkbookSearchableContentStart } from '@/utils/workbook/workbookDisplay';
import { buildWorkbookSplitRowDelta, getWorkbookRowDeltaEntries } from '@/utils/workbook/workbookDelta';
import { hasWorkbookCellContent } from '@/utils/workbook/workbookCellContract';
import { registerWorkbookArtifactFixture } from '@/utils/workbook/workbookArtifactProvider';
import type { WorkbookCompareMode, DiffLine } from '@/types';

interface FixtureRow { baseRowNumber: number; mineRowNumber: number; baseCells: WorkbookArtifactCell[]; mineCells: WorkbookArtifactCell[]; raw: string; line: DiffLine }

function buildMode(base: string, mine: string, mode: WorkbookCompareMode, artifactId: string) {
  const lines = computeWorkbookDiff(base, mine, mode);
  const sections = getWorkbookSections(lines, mode);
  const index = buildWorkbookSectionRowIndex(lines, sections, mode);
  const sourceRegions = buildWorkbookDiffRegions(sections, index, 'base', 'mine', mode, null, null);
  const rowData: FixtureRow[] = [];
  const sheetIds: number[] = []; const baseRows: number[] = []; const mineRows: number[] = []; const kinds: number[] = [];
  const toneMasks: number[] = []; const counts: number[] = []; const baseColumns: number[] = []; const mineColumns: number[] = [];
  const offsets: number[] = [0]; const starts: number[] = []; const ends: number[] = []; const flags: number[] = []; const regionIds: number[] = [];
  const descriptor: WorkbookArtifactDescriptor = {
    version: 1, artifactId, comparisonSessionId: artifactId, compareMode: mode, sheets: [],
    rows: {} as WorkbookArtifactDescriptor['rows'], runs: {} as WorkbookArtifactDescriptor['runs'], regions: {} as WorkbookArtifactDescriptor['regions'],
    baseMetadata: { sheets: {} }, mineMetadata: { sheets: {} }, regionCount: sourceRegions.length,
    stats: { equalRows: 0, addedRows: 0, deletedRows: 0, modifiedRows: 0, changedCells: 0 },
    sourceCounts: { base: { rowCount: 0, cellCount: 0 }, mine: { rowCount: 0, cellCount: 0 } }, perf: { ingestMs: 0, alignmentMs: 0, totalMs: 0 },
  };
  const sourceIndexByLine = new Map<number, number>();
  sections.forEach((section, sheetId) => {
    const rows = index.get(section.name)?.rows ?? [];
    const pairStart = rowData.length;
    const used = { base: new Set<number>(), mine: new Set<number>() }; const changed = new Set<number>();
    const sheet = { id: sheetId, sheetId, name: section.name, hasBaseSide: section.hasBaseSide, hasMineSide: section.hasMineSide,
      pairStart, pairCount: rows.length, baseRowCount: 0, mineRowCount: 0, baseCellCount: 0, mineCellCount: 0,
      changeType: section.changeType, renamePeerName: section.renamePeerName, renameRole: section.renameRole, maxColumnCount: section.maxColumns, baseUsedColumns: [] as number[], mineUsedColumns: [] as number[], changedColumns: [] as number[],
      equalRows: 0, addedRows: 0, deletedRows: 0, modifiedRows: 0, changedCellCount: 0 };
    for (const side of ['base', 'mine'] as const) if (section[side === 'base' ? 'hasBaseSide' : 'hasMineSide']) descriptor[side === 'base' ? 'baseMetadata' : 'mineMetadata'].sheets[section.name] = {
      name: section.name, rowCount: section.rowCount, maxColumns: section.maxColumns, hiddenColumns: [], mergeRanges: [],
    };
    rows.forEach((row, localRow) => {
      const rowIndex = rowData.length;
      row.lineIdxs.forEach((line) => sourceIndexByLine.set(line, rowIndex));
      const baseEntry = buildWorkbookRowEntry(row, 'base', section.name, 'base');
      const mineEntry = buildWorkbookRowEntry(row, 'mine', section.name, 'mine');
      const baseCells = (baseEntry?.cells ?? []).map((cell, column) => ({ column, ...cell }));
      const mineCells = (mineEntry?.cells ?? []).map((cell, column) => ({ column, ...cell }));
      const delta = buildWorkbookSplitRowDelta(row, undefined, mode);
      const kind = delta.structuralChange === 'add' ? 1 : delta.structuralChange === 'delete' ? 2 : delta.hasChanges ? 3 : 0;
      const raw = kind === 2 ? createWorkbookRowLine(baseEntry!.rowNumber, baseEntry!.cells) : createWorkbookRowLine(mineEntry?.rowNumber ?? baseEntry!.rowNumber, mineEntry?.cells ?? baseEntry!.cells);
      const line: DiffLine = { type: kind === 2 ? 'delete' : 'equal', base: kind === 2 ? raw : null, mine: kind === 2 ? null : raw, baseLineNo: null, mineLineNo: null, baseCharSpans: null, mineCharSpans: null };
      rowData.push({ baseRowNumber: baseEntry?.rowNumber ?? 0, mineRowNumber: mineEntry?.rowNumber ?? 0, baseCells, mineCells, raw, line });
      sheetIds.push(sheetId); baseRows.push(baseEntry?.rowNumber ?? 0); mineRows.push(mineEntry?.rowNumber ?? 0); kinds.push(kind);
      baseColumns.push(baseEntry?.cells.length ?? 0); mineColumns.push(mineEntry?.cells.length ?? 0); counts.push(delta.changedCount);
      for (const side of ['base', 'mine'] as const) {
        const cells = side === 'base' ? baseCells : mineCells;
        if (side === 'base' ? baseEntry : mineEntry) { descriptor.sourceCounts[side].rowCount += 1; if (side === 'base') sheet.baseRowCount += 1; else sheet.mineRowCount += 1; }
        cells.forEach((cell) => { if (hasWorkbookCellContent(cell, mode)) { used[side].add(cell.column); descriptor.sourceCounts[side].cellCount += 1; if (side === 'base') sheet.baseCellCount += 1; else sheet.mineCellCount += 1; } });
      }
      let tone = 0;
      for (const cell of getWorkbookRowDeltaEntries(delta)) {
        if (!cell.changed) continue;
        changed.add(cell.column);
        const cellKind = cell.kind === 'add' ? 1 : cell.kind === 'delete' ? 2 : 3;
        const cellFlags = cellKind | (cell.strictOnly ? 4 : 0) | (cell.hasBaseContent ? 8 : 0) | (cell.hasMineContent ? 16 : 0);
        tone |= cellKind === 1 ? 1 : cellKind === 2 ? 2 : cell.strictOnly ? 8 : 4;
        const region = sourceRegions.findIndex((region) => region.sheetName === section.name && region.patches.some((patch) => localRow >= patch.startRowIndex && localRow <= patch.endRowIndex && cell.column >= patch.startCol && cell.column <= patch.endCol));
        const last = starts.length - 1;
        if (last >= offsets[offsets.length - 1]! && ends[last] === cell.column && flags[last] === cellFlags && regionIds[last] === region) ends[last] = cell.column + 1;
        else { starts.push(cell.column); ends.push(cell.column + 1); flags.push(cellFlags); regionIds.push(region); }
      }
      toneMasks.push(tone); offsets.push(starts.length);
      sheet.changedCellCount += delta.changedCount; descriptor.stats.changedCells += delta.changedCount;
      if (kind === 0) { sheet.equalRows += 1; descriptor.stats.equalRows += 1; }
      else if (kind === 1) { sheet.addedRows += 1; descriptor.stats.addedRows += 1; }
      else if (kind === 2) { sheet.deletedRows += 1; descriptor.stats.deletedRows += 1; }
      else { sheet.modifiedRows += 1; descriptor.stats.modifiedRows += 1; }
    });
    sheet.baseUsedColumns = [...used.base]; sheet.mineUsedColumns = [...used.mine]; sheet.changedColumns = [...changed]; descriptor.sheets.push(sheet);
  });
  descriptor.rows = { sheetIds: Uint32Array.from(sheetIds), baseOrdinals: Uint32Array.from(baseRows), mineOrdinals: Uint32Array.from(mineRows),
    baseRowNumbers: Uint32Array.from(baseRows), mineRowNumbers: Uint32Array.from(mineRows), kinds: Uint8Array.from(kinds), toneMasks: Uint8Array.from(toneMasks), changedCellCounts: Uint32Array.from(counts),
    baseColumnCounts: Uint32Array.from(baseColumns), mineColumnCounts: Uint32Array.from(mineColumns), searchBothSides: new Uint8Array(kinds.length), runOffsets: Uint32Array.from(offsets) };
  descriptor.runs = { starts: Uint32Array.from(starts), ends: Uint32Array.from(ends), flags: Uint32Array.from(flags), regionIds: Uint32Array.from(regionIds) };
  const sheetsByName = new Map(descriptor.sheets.map((sheet) => [sheet.name, sheet]));
  descriptor.regions = { sheetIds: Uint32Array.from(sourceRegions.map((region) => sheetsByName.get(region.sheetName)!.id)),
    startRows: Uint32Array.from(sourceRegions.map((region) => sheetsByName.get(region.sheetName)!.pairStart + region.startRowIndex)),
    endRows: Uint32Array.from(sourceRegions.map((region) => sheetsByName.get(region.sheetName)!.pairStart + region.endRowIndex + 1)),
    startColumns: Uint32Array.from(sourceRegions.map((region) => region.startCol)), endColumns: Uint32Array.from(sourceRegions.map((region) => region.endCol + 1)),
    anchorRows: Uint32Array.from(sourceRegions.map((region) => sourceIndexByLine.get(region.anchorLineIdx) ?? sheetsByName.get(region.sheetName)!.pairStart)),
    anchorColumns: Uint32Array.from(sourceRegions.map((region) => region.anchorSelection?.colIndex ?? region.startCol)), changedCellCounts: new Float64Array(sourceRegions.length) };
  return { descriptor, rowData };
}

export function createWorkbookArtifactFixture(base: string, mine: string, comparisonSessionId?: string): WorkbookArtifactDescriptor {
  const artifactId = `fixture:${crypto.randomUUID()}`;
  const modes = { strict: buildMode(base, mine, 'strict', artifactId), content: buildMode(base, mine, 'content', artifactId) };
  for (const mode of Object.values(modes)) mode.descriptor.comparisonSessionId = comparisonSessionId ?? artifactId;
  const readWindow = (request: WorkbookArtifactWindowRequest): WorkbookArtifactWindow => {
    const { descriptor, rowData } = modes[request.compareMode];
    const sheet = descriptor.sheets.find((item) => item.id === request.sheetId)!;
    const end = Math.min(sheet.pairCount, request.startRow + request.rowCount);
    const rows = [] as WorkbookArtifactWindow['rows'];
    for (let local = request.startRow; local < end; local += 1) {
      const rowIndex = sheet.pairStart + local; const row = rowData[rowIndex]!;
      const keep = (cell: WorkbookArtifactCell) => request.columnRanges.some((range) => cell.column >= range.start && cell.column < range.end);
      rows.push({ rowIndex, baseRowNumber: row.baseRowNumber, mineRowNumber: row.mineRowNumber,
        baseCells: row.baseCells.filter(keep), mineCells: row.mineCells.filter(keep), changedColumnRuns: [] });
    }
    return { artifactId, compareMode: request.compareMode, sheetId: request.sheetId, startRow: request.startRow, columnRanges: request.columnRanges, rows, nextRow: null };
  };
  registerWorkbookArtifactFixture(artifactId, {
    getWorkbookArtifactView: async (request) => modes[request.compareMode].descriptor,
    readWorkbookArtifactWindow: async (request) => readWindow(request),
    readWorkbookArtifactSourceRows: async (request) => {
      const sheet = modes[request.compareMode].descriptor.sheets.find((item) => item.id === request.sheetId)!;
      return { ...readWindow({ ...request, columnRanges: request.columns?.map((column) => ({ start: column, end: column + 1 })) ?? [{ start: 0, end: sheet.maxColumnCount }] }),
        nextRow: request.startRow + request.rowCount < sheet.pairCount ? request.startRow + request.rowCount : null };
    },
    readWorkbookArtifactCells: async (request) => ({ ...request, cells: request.cells.map((coordinate) => {
      const sheet = modes.strict.descriptor.sheets.find((item) => item.id === request.sheetId)!;
      const row = modes.strict.rowData.slice(sheet.pairStart, sheet.pairStart + sheet.pairCount).find((item) => (request.side === 'base' ? item.baseRowNumber : item.mineRowNumber) === coordinate.rowNumber);
      const cell = (request.side === 'base' ? row?.baseCells : row?.mineCells)?.find((item) => item.column === coordinate.column);
      return { ...coordinate, value: cell?.value ?? '', formula: cell?.formula ?? '', exists: Boolean(cell) };
    }) }),
    searchWorkbookArtifact: async (request) => {
      const { descriptor, rowData } = modes[request.compareMode];
      const visible = request.visibleRowIndexes ? new Set(request.visibleRowIndexes) : null;
      const matches: WorkbookArtifactSearchMatch[] = [];
      const pattern = compileSearchPattern(request.query, request).pattern;
      rowData.forEach((row, rowIndex) => {
        const sheetId = descriptor.rows.sheetIds[rowIndex]!;
        if ((request.sheetId != null && request.sheetId !== sheetId) || (visible && !visible.has(rowIndex))) return;
        const scanned = scanMatchesInSearchableLines([row.raw], pattern, 100_000, [getWorkbookSearchableContentStart(row.raw)]);
        for (const match of scanned.matches) {
          const column = resolveWorkbookSearchMatchColumnIndex(row.line, match) ?? 0;
          if (visible && !Array.from({ length: descriptor.rows.runOffsets[rowIndex + 1]! - descriptor.rows.runOffsets[rowIndex]! }, (_, offset) => descriptor.rows.runOffsets[rowIndex]! + offset).some((run) => column >= descriptor.runs.starts[run]! && column < descriptor.runs.ends[run]!)) continue;
          matches.push({ rowIndex, sheetId, side: row.mineRowNumber ? 'mine' : 'base', rowNumber: row.mineRowNumber || row.baseRowNumber,
            column, start: match.start, end: match.end, snippet: row.raw.slice(getWorkbookSearchableContentStart(row.raw)).slice(0, 120) });
        }
      });
      return { artifactId, requestId: request.requestId, matches, totalCount: matches.length, truncated: false };
    },
    cancelWorkbookArtifactSearch: async () => {},
  }, comparisonSessionId ?? artifactId);
  return modes.strict.descriptor;
}
