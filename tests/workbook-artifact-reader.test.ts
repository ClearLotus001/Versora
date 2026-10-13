import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkbookArtifactReader } from '../electron/main/workbookArtifactReader';
import { WORKBOOK_ARTIFACT_KIND, type WorkbookArtifactCell, type WorkbookArtifactManifest } from '../shared/workbookArtifactProtocol';

interface SourceRow { sheet: number; row: number; cells: WorkbookArtifactCell[] }
interface Pair { sheet: number; base: number; mine: number }

function header(magic: string, count?: number): Buffer {
  const result = Buffer.alloc(count == null ? 8 : 16);
  result.write(magic, 'ascii');
  if (count != null) result.writeBigUInt64LE(BigInt(count), 8);
  return result;
}

async function fixture(root: string, base: SourceRow[], mine: SourceRow[], pairs: Pair[]): Promise<WorkbookArtifactManifest> {
  const source = async (side: string, rows: SourceRow[]) => {
    const records: Buffer[] = [header('VWRROW01')];
    const index = Buffer.alloc(16 + rows.length * 24);
    header('VWRIDX01', rows.length).copy(index);
    let offset = 8;
    rows.forEach((row, ordinal) => {
      const recordHeader = Buffer.alloc(8); recordHeader.writeUInt32LE(row.row, 0); recordHeader.writeUInt32LE(row.cells.length, 4);
      const pieces = [recordHeader];
      for (const cell of row.cells) {
        const value = Buffer.from(cell.value); const formula = Buffer.from(cell.formula); const cellHeader = Buffer.alloc(12);
        cellHeader.writeUInt32LE(cell.column, 0); cellHeader.writeUInt32LE(value.length, 4); cellHeader.writeUInt32LE(formula.length, 8);
        pieces.push(cellHeader, value, formula);
      }
      const record = Buffer.concat(pieces); const p = 16 + ordinal * 24;
      index.writeUInt32LE(row.sheet, p); index.writeUInt32LE(row.row, p + 4); index.writeBigUInt64LE(BigInt(offset), p + 8);
      index.writeUInt32LE(record.length, p + 16); index.writeUInt32LE(Math.max(0, ...row.cells.map(cell => cell.column + 1)), p + 20);
      records.push(record); offset += record.length;
    });
    await Promise.all([fs.writeFile(path.join(root, `${side}.rows.bin`), Buffer.concat(records)), fs.writeFile(path.join(root, `${side}.rows.idx`), index)]);
  };
  await Promise.all([source('base', base), source('mine', mine)]);
  const pairBuffer = Buffer.alloc(16 + pairs.length * 40); header('VWRPAIR1', pairs.length).copy(pairBuffer);
  const runBuffer = Buffer.alloc(8 + pairs.length * 16); header('VWRRUN01').copy(runBuffer);
  const regions = Buffer.alloc(16 + pairs.length * 40); header('VWRREG01', pairs.length).copy(regions);
  pairs.forEach((pair, i) => {
    const p = 16 + i * 40;
    pairBuffer.writeUInt32LE(pair.sheet, p); pairBuffer.writeUInt32LE(pair.base, p + 4); pairBuffer.writeUInt32LE(pair.mine, p + 8);
    pairBuffer.writeUInt32LE(base[pair.base]!.row, p + 12); pairBuffer.writeUInt32LE(mine[pair.mine]!.row, p + 16);
    pairBuffer.writeUInt32LE(3 | (4 << 8) | (1 << 16), p + 20); pairBuffer.writeUInt32LE(1, p + 24); pairBuffer.writeUInt32LE(1, p + 28); pairBuffer.writeBigUInt64LE(BigInt(8 + i * 16), p + 32);
    runBuffer.writeUInt32LE(0, 8 + i * 16); runBuffer.writeUInt32LE(1, 12 + i * 16); runBuffer.writeUInt32LE(27, 16 + i * 16); runBuffer.writeUInt32LE(i, 20 + i * 16);
    [pair.sheet, i, i, i + 1, 0, 1, i, 0].forEach((value, field) => regions.writeUInt32LE(value, p + field * 4)); regions.writeBigUInt64LE(1n, p + 32);
  });
  await Promise.all([fs.writeFile(path.join(root, 'pairs.bin'), pairBuffer), fs.writeFile(path.join(root, 'runs.bin'), runBuffer), fs.writeFile(path.join(root, 'regions.bin'), regions)]);
  const sheets = [...new Set(pairs.map(pair => pair.sheet))].map(id => ({ id, name: `Sheet${id}`, hasBaseSide: true, hasMineSide: true,
    baseRowCount: base.filter(row => row.sheet === id).length, mineRowCount: mine.filter(row => row.sheet === id).length,
    baseCellCount: base.filter(row => row.sheet === id).reduce((count, row) => count + row.cells.length, 0), mineCellCount: mine.filter(row => row.sheet === id).reduce((count, row) => count + row.cells.length, 0), changeType: 'equal' as const }));
  const metadata = (rows: SourceRow[]) => ({ s: Object.fromEntries(sheets.map(sheet => [sheet.name, { r: Math.max(...rows.filter(row => row.sheet === sheet.id).map(row => row.row)), c: Math.max(...rows.filter(row => row.sheet === sheet.id).flatMap(row => row.cells.map(cell => cell.column + 1))) }])) });
  const mode = { pairsFile: 'pairs.bin', runsFile: 'runs.bin', regionsFile: 'regions.bin', pairCount: pairs.length, regionCount: pairs.length, changedCellCount: pairs.length, runRecordBytes: 16 as const,
    sheets: sheets.map(sheet => ({ sheetId: sheet.id, pairStart: pairs.findIndex(pair => pair.sheet === sheet.id), pairCount: pairs.filter(pair => pair.sheet === sheet.id).length, equalRows: 0, addedRows: 0, deletedRows: 0, modifiedRows: pairs.filter(pair => pair.sheet === sheet.id).length, changedCellCount: pairs.filter(pair => pair.sheet === sheet.id).length })) };
  return { kind: WORKBOOK_ARTIFACT_KIND, version: 1, complete: true, artifactDir: root,
    files: { baseRows: 'base.rows.bin', baseIndex: 'base.rows.idx', mineRows: 'mine.rows.bin', mineIndex: 'mine.rows.idx' }, sheets,
    baseMetadata: metadata(base), mineMetadata: metadata(mine), modes: { strict: mode, content: { ...mode, sheets: mode.sheets.map(sheet => ({ ...sheet, changeType: 'rename', renamePeerName: 'Peer', renameRole: 'source' })) } },
    base: { rowCount: base.length, cellCount: base.reduce((count, row) => count + row.cells.length, 0) }, mine: { rowCount: mine.length, cellCount: mine.reduce((count, row) => count + row.cells.length, 0) }, perf: { ingestMs: 0, alignmentMs: 0, totalMs: 0 } };
}

const cell = (value: string, column = 0): WorkbookArtifactCell => ({ column, value, formula: '' });

test('source-coordinate lookup respects reordered sheets and mode metadata overrides global annotations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-artifact-reader-'));
  let reader: WorkbookArtifactReader | undefined;
  try {
    const manifest = await fixture(root, [{ sheet: 0, row: 7, cells: [cell('A')] }, { sheet: 1, row: 2, cells: [cell('B')] }],
      [{ sheet: 1, row: 2, cells: [cell('D')] }, { sheet: 0, row: 7, cells: [cell('C')] }], [{ sheet: 0, base: 0, mine: 1 }, { sheet: 1, base: 1, mine: 0 }]);
    reader = await WorkbookArtifactReader.open(manifest, 'fixture', 'session', root);
    const strict = await reader.getView('strict');
    assert.deepEqual([...strict.rows.searchBothSides], [1, 1]);
    assert.deepEqual([...strict.runs.regionIds], [0, 1]);
    const content = await reader.getView('content');
    assert.equal(content.sheets[0]?.changeType, 'rename');
    const selected = await reader.readCells({ artifactId: 'fixture', side: 'mine', sheetId: 0, cells: [{ rowNumber: 7, column: 0 }, { rowNumber: 2, column: 0 }] });
    assert.deepEqual(selected.cells.map(item => [item.exists, item.value]), [[true, 'C'], [false, '']]);
    assert.equal(strict.regions.sheetIds[1], 1);
    assert.equal(strict.regions.startRows[1], 1);
  } finally { await reader?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('large rows preserve complete selected cells and paginate windows by bytes, including close during reads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-artifact-large-row-'));
  let reader: WorkbookArtifactReader | undefined;
  try {
    const value = '中'.repeat(2 * 1024 * 1024);
    const rows = [1, 2].map(row => ({ sheet: 0, row, cells: [cell(value), cell(`tail${row}`, 1)] }));
    const manifest = await fixture(root, rows, rows, [{ sheet: 0, base: 0, mine: 0 }, { sheet: 0, base: 1, mine: 1 }]);
    reader = await WorkbookArtifactReader.open(manifest, 'fixture', 'session', root);
    const selected = await reader.readCells({ artifactId: 'fixture', side: 'base', sheetId: 0, cells: [{ rowNumber: 2, column: 1 }] });
    assert.equal(selected.cells[0]?.value, 'tail2');
    const first = await reader.readWindow({ artifactId: 'fixture', compareMode: 'strict', sheetId: 0, startRow: 0, rowCount: 2, columnRanges: [{ start: 0, end: 2 }] });
    assert.equal(first.rows.length, 1);
    assert.equal(first.nextRow, 1);
    assert.equal(first.rows[0]?.baseCells[0]?.value, value);
    const reading = reader.readWindow({ artifactId: 'fixture', compareMode: 'strict', sheetId: 0, startRow: 1, rowCount: 1, columnRanges: [{ start: 1, end: 2 }] });
    const closing = reader.close();
    assert.equal((await reading).rows[0]?.mineCells[0]?.value, 'tail2');
    await closing;
    await assert.rejects(reader.readCells({ artifactId: 'fixture', side: 'base', sheetId: 0, cells: [] }), /closed/);
  } finally { await reader?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('malformed compact files fail explicitly instead of returning partial descriptors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-artifact-invalid-'));
  let reader: WorkbookArtifactReader | undefined;
  try {
    const manifest = await fixture(root, [{ sheet: 0, row: 1, cells: [cell('A')] }], [{ sheet: 0, row: 1, cells: [cell('B')] }], [{ sheet: 0, base: 0, mine: 0 }]);
    await fs.truncate(path.join(root, 'regions.bin'), 55);
    reader = await WorkbookArtifactReader.open(manifest, 'fixture', 'session', root);
    await assert.rejects(reader.getView('strict'), /Truncated/);
  } finally { await reader?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('sequential canonical pages share bounded read-ahead IO and retain random lookup values and formulas', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-artifact-sequential-'));
  let reader: WorkbookArtifactReader | undefined;
  try {
    const rows = (side: string): SourceRow[] => Array.from({ length: 2000 }, (_, index) => ({ sheet: 0, row: index + 1,
      cells: Array.from({ length: 20 }, (_, column) => ({ column, value: `${side}-${index}-${column}-${'w'.repeat(230)}`,
        formula: column === 7 ? `SUM(A${index + 1}:B${index + 1})` : '' })) }));
    const base = rows('base'); const mine = rows('mine');
    const manifest = await fixture(root, base, mine, base.map((_, index) => ({ sheet: 0, base: index, mine: index })));
    reader = await WorkbookArtifactReader.open(manifest, 'fixture', 'session', root);
    const internals = reader as unknown as { handles: Map<string, fs.FileHandle>; rowCacheBytes: number };
    const readSpies = [...internals.handles.values()].map(handle => context.mock.method(handle, 'read'));
    for (let cursor = 0; cursor < base.length; cursor += 256) {
      const page = await reader.readWindow({ artifactId: 'fixture', compareMode: 'strict', sheetId: 0,
        startRow: cursor, rowCount: Math.min(256, base.length - cursor), columnRanges: [{ start: 7, end: 9 }, { start: 8, end: 10 }] });
      assert.equal(page.rows.length, Math.min(256, base.length - cursor));
      for (const row of page.rows) {
        assert.deepEqual(row.baseCells, base[row.rowIndex]!.cells.slice(7, 10));
        assert.deepEqual(row.mineCells, mine[row.rowIndex]!.cells.slice(7, 10));
      }
      assert.ok(internals.rowCacheBytes <= 16 * 1024 * 1024);
    }
    // A complete scan previously issued 4000 reads. The bounded blocks require only a few.
    assert.ok(readSpies.reduce((total, spy) => total + spy.mock.callCount(), 0) <= 32);
    const selected = await reader.readCells({ artifactId: 'fixture', side: 'base', sheetId: 0, cells: [{ rowNumber: 1, column: 7 }] });
    assert.equal(selected.cells[0]?.value, base[0]!.cells[7]!.value);
    assert.equal(selected.cells[0]?.formula, 'SUM(A1:B1)');
    assert.ok(internals.rowCacheBytes <= 16 * 1024 * 1024);
  } finally { await reader?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('overlapping reads share pending blocks and closing waits for the complete responses', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-artifact-overlap-'));
  let reader: WorkbookArtifactReader | undefined;
  try {
    const rows = Array.from({ length: 32 }, (_, index) => ({ sheet: 0, row: index + 1, cells: [cell(`row-${index}`)] }));
    const manifest = await fixture(root, rows, rows, rows.map((_, index) => ({ sheet: 0, base: index, mine: index })));
    reader = await WorkbookArtifactReader.open(manifest, 'fixture', 'session', root);
    await reader.getView('strict');
    const handles = [...(reader as unknown as { handles: Map<string, fs.FileHandle> }).handles.values()];
    const spies = handles.map(handle => context.mock.method(handle, 'read'));
    const request = { artifactId: 'fixture', compareMode: 'strict' as const, sheetId: 0, startRow: 0, rowCount: 32, columnRanges: [{ start: 0, end: 1 }] };
    const reads = Promise.all([reader.readWindow(request), reader.readWindow(request)]);
    const closing = reader.close();
    const results = await reads;
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0]?.rows[31]?.mineCells[0]?.value, 'row-31');
    await closing;
    assert.equal(spies.reduce((total, spy) => total + spy.mock.callCount(), 0), 2);
    await assert.rejects(reader.readWindow(request), /closed/);
  } finally { await reader?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('wide source windows accept 300 disjoint intervals, preserve original range contracts and retain values and formulas', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-artifact-wide-ranges-'));
  let reader: WorkbookArtifactReader | undefined;
  try {
    const rows = (side: string): SourceRow[] => Array.from({ length: 3 }, (_, index) => ({ sheet: 0, row: index + 1,
      cells: Array.from({ length: 600 }, (_, column) => ({ column, value: `${side}-${index}-${column}`,
        formula: column % 10 === 0 ? `SUM(A${index + 1}:B${index + 1})` : '' })) }));
    const base = rows('base'); const mine = rows('mine');
    const manifest = await fixture(root, base, mine, base.map((_, index) => ({ sheet: 0, base: index, mine: index })));
    reader = await WorkbookArtifactReader.open(manifest, 'fixture', 'session', root);
    const intervals = Array.from({ length: 300 }, (_, i) => ({ start: i * 2, end: i * 2 + 1 })).reverse();
    const original = structuredClone(intervals);
    const page = await reader.readWindow({ artifactId: 'fixture', compareMode: 'strict', sheetId: 0, startRow: 0, rowCount: 3, columnRanges: intervals });
    assert.deepEqual(intervals, original, 'normalization must not mutate the request');
    assert.deepEqual(page.columnRanges, original, 'responses retain requested interval order');
    for (const row of page.rows) {
      assert.deepEqual(row.baseCells, base[row.rowIndex]!.cells.filter(cell => cell.column % 2 === 0));
      assert.deepEqual(row.mineCells, mine[row.rowIndex]!.cells.filter(cell => cell.column % 2 === 0));
    }
    const overlapping = [{ start: 594, end: 600 }, { start: 2, end: 5 }, { start: 0, end: 3 }, { start: 595, end: 599 }, { start: 20, end: 20 }];
    const subset = await reader.readWindow({ artifactId: 'fixture', compareMode: 'strict', sheetId: 0, startRow: 1, rowCount: 1, columnRanges: overlapping });
    assert.deepEqual(subset.columnRanges, overlapping);
    assert.deepEqual(subset.rows[0]?.baseCells, base[1]!.cells.filter(cell => cell.column < 5 || cell.column >= 594));
    assert.deepEqual(subset.rows[0]?.mineCells, mine[1]!.cells.filter(cell => cell.column < 5 || cell.column >= 594));
    const selected = await reader.readCells({ artifactId: 'fixture', side: 'mine', sheetId: 0, cells: [{ rowNumber: 3, column: 598 }, { rowNumber: 1, column: 0 }, { rowNumber: 2, column: 590 }] });
    assert.deepEqual(selected.cells.map(({ rowNumber, column, value, formula }) => ({ rowNumber, column, value, formula })), [
      { rowNumber: 3, ...mine[2]!.cells[598]! }, { rowNumber: 1, ...mine[0]!.cells[0]! }, { rowNumber: 2, ...mine[1]!.cells[590]! },
    ]);
    await assert.rejects(reader.readWindow({ artifactId: 'fixture', compareMode: 'strict', sheetId: 0, startRow: 0, rowCount: 257, columnRanges: intervals }), /row budget/);
    await assert.rejects(reader.readWindow({ artifactId: 'fixture', compareMode: 'strict', sheetId: 0, startRow: 0, rowCount: 1, columnRanges: [{ start: 16_384, end: 16_385 }] }), /column interval/);
  } finally { await reader?.close(); await fs.rm(root, { recursive: true, force: true }); }
});
