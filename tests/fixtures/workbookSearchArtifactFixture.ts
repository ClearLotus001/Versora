import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  WORKBOOK_ARTIFACT_KIND, WORKBOOK_ARTIFACT_MISSING_ORDINAL,
  type WorkbookArtifactManifest, type WorkbookArtifactWindowRow,
} from '../../shared/workbookArtifactProtocol';

export type SearchFixtureRow = WorkbookArtifactWindowRow & { sheetId: number; baseColumnCount: number; mineColumnCount: number; searchBothSides: boolean };

function header(magic: string, count?: number): Buffer {
  const result = Buffer.alloc(count == null ? 8 : 16); result.write(magic, 'ascii');
  if (count != null) result.writeBigUInt64LE(BigInt(count), 8);
  return result;
}

export async function writeWorkbookSearchArtifact(root: string, selected: SearchFixtureRow[]): Promise<WorkbookArtifactManifest> {
  const sheetIds = [...new Set(selected.map(row => row.sheetId))];
  const firstSheet = sheetIds[0] ?? 0;
  const pairs = new Array<SearchFixtureRow>(Math.max(0, ...selected.map(row => row.rowIndex + 1)));
  for (let i = 0; i < pairs.length; i += 1) pairs[i] = { rowIndex: i, sheetId: firstSheet, baseRowNumber: 0, mineRowNumber: 0, baseColumnCount: 0, mineColumnCount: 0, searchBothSides: false, baseCells: [], mineCells: [], changedColumnRuns: [] };
  for (const row of selected) pairs[row.rowIndex] = row;
  const ordinals = { base: new Map<number, number>(), mine: new Map<number, number>() };
  const counts = { base: { rowCount: 0, cellCount: 0 }, mine: { rowCount: 0, cellCount: 0 } };
  for (const side of ['base', 'mine'] as const) {
    const rows = selected.filter(row => (side === 'base' ? row.baseRowNumber : row.mineRowNumber) > 0);
    const index = Buffer.alloc(16 + rows.length * 24); header('VWRIDX01', rows.length).copy(index);
    const records = [header('VWRROW01')]; let offset = 8;
    rows.forEach((row, ordinal) => {
      ordinals[side].set(row.rowIndex, ordinal);
      const cells = side === 'base' ? row.baseCells : row.mineCells;
      const physicalRow = side === 'base' ? row.baseRowNumber : row.mineRowNumber;
      const recordHeader = Buffer.alloc(8); recordHeader.writeUInt32LE(physicalRow, 0); recordHeader.writeUInt32LE(cells.length, 4);
      const pieces = [recordHeader];
      for (const cell of cells) {
        const value = Buffer.from(cell.value); const formula = Buffer.from(cell.formula); const cellHeader = Buffer.alloc(12);
        cellHeader.writeUInt32LE(cell.column, 0); cellHeader.writeUInt32LE(value.length, 4); cellHeader.writeUInt32LE(formula.length, 8);
        pieces.push(cellHeader, value, formula);
      }
      const record = Buffer.concat(pieces); const p = 16 + ordinal * 24;
      index.writeUInt32LE(row.sheetId, p); index.writeUInt32LE(physicalRow, p + 4); index.writeBigUInt64LE(BigInt(offset), p + 8);
      index.writeUInt32LE(record.length, p + 16); index.writeUInt32LE(side === 'base' ? row.baseColumnCount : row.mineColumnCount, p + 20);
      records.push(record); offset += record.length; counts[side].cellCount += cells.length;
    });
    counts[side].rowCount = rows.length;
    await Promise.all([fs.writeFile(path.join(root, `${side}.rows.bin`), Buffer.concat(records)), fs.writeFile(path.join(root, `${side}.rows.idx`), index)]);
  }
  const pairBuffer = Buffer.alloc(16 + pairs.length * 40); header('VWRPAIR1', pairs.length).copy(pairBuffer);
  const runCount = selected.reduce((count, row) => count + row.changedColumnRuns.length, 0);
  const runs = Buffer.alloc(8 + runCount * 16); header('VWRRUN01').copy(runs);
  const regions = Buffer.alloc(16 + runCount * 40); header('VWRREG01', runCount).copy(regions);
  let runIndex = 0;
  for (const row of pairs) {
    const p = 16 + row.rowIndex * 40;
    [row.sheetId, ordinals.base.get(row.rowIndex) ?? WORKBOOK_ARTIFACT_MISSING_ORDINAL, ordinals.mine.get(row.rowIndex) ?? WORKBOOK_ARTIFACT_MISSING_ORDINAL, row.baseRowNumber, row.mineRowNumber].forEach((value, field) => pairBuffer.writeUInt32LE(value, p + field * 4));
    pairBuffer.writeUInt32LE(3 | (row.searchBothSides ? (1 << 16) : 0), p + 20);
    pairBuffer.writeUInt32LE(row.changedColumnRuns.length, p + 28); pairBuffer.writeBigUInt64LE(BigInt(row.changedColumnRuns.length ? 8 + runIndex * 16 : 0), p + 32);
    for (const run of row.changedColumnRuns) {
      const r = 8 + runIndex * 16;
      runs.writeUInt32LE(run.start, r); runs.writeUInt32LE(run.end, r + 4); runs.writeUInt32LE(3, r + 8); runs.writeUInt32LE(runIndex, r + 12);
      const region = 16 + runIndex * 40;
      [row.sheetId, runIndex, row.rowIndex, row.rowIndex + 1, run.start, run.end, row.rowIndex, run.start].forEach((value, field) => regions.writeUInt32LE(value, region + field * 4));
      runIndex += 1;
    }
  }
  await Promise.all([fs.writeFile(path.join(root, 'pairs.bin'), pairBuffer), fs.writeFile(path.join(root, 'runs.bin'), runs), fs.writeFile(path.join(root, 'regions.bin'), regions)]);
  const sheets = sheetIds.map(id => ({ id, name: `Sheet${id}`, hasBaseSide: true, hasMineSide: true, baseRowCount: counts.base.rowCount, mineRowCount: counts.mine.rowCount, baseCellCount: counts.base.cellCount, mineCellCount: counts.mine.cellCount }));
  const mode = { pairsFile: 'pairs.bin', runsFile: 'runs.bin', regionsFile: 'regions.bin', pairCount: pairs.length, regionCount: runCount, changedCellCount: runCount, runRecordBytes: 16 as const,
    sheets: sheets.map(sheet => ({ sheetId: sheet.id, pairStart: pairs.findIndex(row => row.sheetId === sheet.id), pairCount: pairs.filter(row => row.sheetId === sheet.id).length, equalRows: 0, addedRows: 0, deletedRows: 0, modifiedRows: pairs.filter(row => row.sheetId === sheet.id).length, changedCellCount: 0 })) };
  return { kind: WORKBOOK_ARTIFACT_KIND, version: 1, complete: true, artifactDir: root, files: { baseRows: 'base.rows.bin', baseIndex: 'base.rows.idx', mineRows: 'mine.rows.bin', mineIndex: 'mine.rows.idx' }, sheets,
    baseMetadata: { s: Object.fromEntries(sheets.map(sheet => [sheet.name, { h: [1] }])) }, mineMetadata: { s: Object.fromEntries(sheets.map(sheet => [sheet.name, { h: [1] }])) }, modes: { strict: mode, content: mode }, base: counts.base, mine: counts.mine, perf: { ingestMs: 0, alignmentMs: 0, totalMs: 0 } };
}
