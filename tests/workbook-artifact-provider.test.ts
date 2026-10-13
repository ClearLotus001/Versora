import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkbookArtifactProvider, findArtifactRegionSelectionIndex, activateWorkbookArtifact, getActiveWorkbookArtifactProvider, releaseWorkbookArtifactSession } from '../src/utils/workbook/workbookArtifactProvider';
import { buildWorkbookVisibilityModel, getWorkbookDiffTypeAvailability } from '../src/utils/workbook/workbookVisibilityModel';
import { buildWorkbookSelectedCell, buildWorkbookSearchSelectionFromTarget, getWorkbookSideRowNumber } from '../src/utils/workbook/workbookNavigation';
import { summarizeWorkbookCellChanges } from '../src/utils/workbook/workbookCellChangeSummary';
import { resolveWorkbookGotoTarget } from '../src/utils/workbook/workbookGoto';
import type { WorkbookArtifactDescriptor, WorkbookArtifactWindowRequest, WorkbookArtifactWindow } from '../shared/workbookArtifactProtocol';
import type { VersoraBridge } from '../src/types/bridge';

function descriptor(): WorkbookArtifactDescriptor {
  return {
    version: 1, artifactId: 'fixture', comparisonSessionId: 'session', compareMode: 'strict',
    sheets: [{ id: 0, sheetId: 0, name: 'Sheet', hasBaseSide: true, hasMineSide: true,
      pairStart: 0, pairCount: 4, maxColumnCount: 4, baseRowCount: 4, mineRowCount: 4, baseCellCount: 16, mineCellCount: 16, baseUsedColumns: [0, 1, 2, 3], mineUsedColumns: [0, 1, 2, 3], changedColumns: [0, 2],
      equalRows: 1, addedRows: 0, deletedRows: 0, modifiedRows: 3, changedCellCount: 3 }],
    rows: { sheetIds: new Uint32Array(4), baseOrdinals: Uint32Array.of(0, 1, 2, 3), mineOrdinals: Uint32Array.of(0, 1, 2, 3),
      baseRowNumbers: Uint32Array.of(1, 2, 3, 4), mineRowNumbers: Uint32Array.of(1, 2, 3, 4), kinds: Uint8Array.of(3, 3, 3, 0),
      toneMasks: Uint8Array.of(8, 4, 4, 0), changedCellCounts: Uint32Array.of(1, 1, 1, 0),
      baseColumnCounts: Uint32Array.of(4, 4, 4, 4), mineColumnCounts: Uint32Array.of(4, 4, 4, 4), searchBothSides: new Uint8Array(4), runOffsets: Uint32Array.of(0, 1, 2, 3, 3) },
    runs: { starts: Uint32Array.of(0, 0, 2), ends: Uint32Array.of(1, 1, 3), flags: Uint32Array.of(31, 27, 27), regionIds: Uint32Array.of(0, 0, 1) },
    regions: { sheetIds: Uint32Array.of(0, 0), startRows: Uint32Array.of(0, 2), endRows: Uint32Array.of(2, 3),
      startColumns: Uint32Array.of(0, 2), endColumns: Uint32Array.of(1, 3), anchorRows: Uint32Array.of(0, 2), anchorColumns: Uint32Array.of(0, 2), changedCellCounts: Float64Array.of(2, 1) },
    baseMetadata: { sheets: { Sheet: { name: 'Sheet', hiddenColumns: [], mergeRanges: [], rowCount: 4, maxColumns: 4 } } },
    mineMetadata: { sheets: { Sheet: { name: 'Sheet', hiddenColumns: [], mergeRanges: [], rowCount: 4, maxColumns: 4 } } },
    stats: { equalRows: 1, addedRows: 0, deletedRows: 0, modifiedRows: 3, changedCells: 3 },
    sourceCounts: { base: { rowCount: 4, cellCount: 16 }, mine: { rowCount: 4, cellCount: 16 } },
    regionCount: 2, perf: { ingestMs: 0, alignmentMs: 0, totalMs: 0 },
  };
}
function setBridge(bridge: Partial<VersoraBridge>) {
  Object.assign(globalThis, { window: { versora: bridge } });
}
function page(request: WorkbookArtifactWindowRequest, pageSize = request.rowCount): WorkbookArtifactWindow {
  const end = Math.min(4, request.startRow + request.rowCount, request.startRow + pageSize);
  return { artifactId: request.artifactId, compareMode: request.compareMode, sheetId: request.sheetId,
    startRow: request.startRow, columnRanges: request.columnRanges,
    nextRow: end < Math.min(4, request.startRow + request.rowCount) ? end : null,
    rows: Array.from({ length: end - request.startRow }, (_, index) => {
      const rowIndex = request.startRow + index;
      return { rowIndex, baseRowNumber: rowIndex + 1, mineRowNumber: rowIndex + 1,
        baseCells: [{ column: 0, value: 'same value', formula: '=A1' }], mineCells: [{ column: 0, value: 'same value', formula: '=A1' }], changedColumnRuns: [] };
    }) };
}

test('descriptor preparation stores coordinates and summaries without fetching or materializing cells', () => {
  let calls = 0;
  setBridge({ readWorkbookArtifactWindow: async (request) => { calls += 1; return page(request); } });
  const provider = new WorkbookArtifactProvider(descriptor());
  const rows = provider.getRows('Sheet')!;
  assert.equal(calls, 0);
  assert.equal(rows.length, 4);
  assert.equal(getWorkbookSideRowNumber(rows[3]!, 'mine'), 4);
  assert.ok(rows.every((row) => row.left === null && row.right === null && row.workbookRowDelta!.cellDeltas.size === 0));
  assert.equal(provider.buildEntry(rows[0]!.workbookArtifactRow!, 'mine', 'mine', [0, 1])!.cells.length, 0);
  assert.deepEqual(summarizeWorkbookCellChanges('Sheet', { get: () => ({ rows }) }, 'strict'), { added: 0, removed: 0, modified: 2, strictOnly: 1 });
});

test('budget pages reassemble the requested window exactly and distinguish loading from a known blank cell', async () => {
  const calls: WorkbookArtifactWindowRequest[] = [];
  setBridge({ readWorkbookArtifactWindow: async (request) => { calls.push(request); return page(request, 2); } });
  const provider = new WorkbookArtifactProvider(descriptor());
  const rows = provider.getRows('Sheet')!;
  const ref = rows[0]!.workbookArtifactRow!;
  assert.equal(provider.readCachedCell(ref, 'mine', 1), undefined);
  assert.equal(provider.getCellStatus(ref, 'mine', 1), 'pending');
  await provider.ensureRows(rows, [0, 1]);
  assert.deepEqual(calls.map((call) => [call.startRow, call.rowCount]), [[0, 4], [2, 2]]);
  assert.deepEqual(provider.readCachedCell(ref, 'mine', 1), { value: '', formula: '' });
  assert.equal(provider.getCellStatus(ref, 'mine', 1), 'ready');
  const entry = provider.buildEntry(ref, 'mine', 'mine', [0, 1], true)!;
  assert.equal(buildWorkbookSelectedCell(entry, 0).formula, '=A1');
  assert.equal(buildWorkbookSelectedCell(entry, 0).dataStatus, 'ready');
  assert.equal(provider.getCacheStats().windows, 1);
  assert.equal(provider.getCacheStats().pending, 0);
});

test('cell deltas retain native merge-aware flags even when raw window values are equal', async () => {
  setBridge({ readWorkbookArtifactWindow: async (request) => page(request) });
  const provider = new WorkbookArtifactProvider(descriptor());
  const row = provider.getRows('Sheet')![0]!;
  await provider.ensureRows([row], [0]);
  const delta = provider.buildWindowDelta(row.workbookArtifactRow!, [0], row.workbookRowDelta!).cellDeltas.get(0)!;
  assert.equal(delta.changed, true);
  assert.equal(delta.strictOnly, true);
  assert.equal(delta.kind, 'modify');
  assert.equal(delta.baseCell.value, delta.mineCell.value);
});

test('compact region navigation preserves exclusive bounds, holes and exact late-cell lookup', () => {
  const provider = new WorkbookArtifactProvider(descriptor());
  const regions = provider.getRegions('base', 'mine');
  assert.equal(provider.getRegions('base', 'mine'), regions);
  assert.equal(regions.length, 2);
  assert.equal(regions.map((region) => region.startRowIndex).join(','), '0,2');
  const selection = provider.makeSelection(provider.getRows('Sheet')![2]!.workbookArtifactRow!, 2, 'base', 'mine');
  assert.equal(findArtifactRegionSelectionIndex(regions, selection), 1);
  assert.equal(findArtifactRegionSelectionIndex(regions, { ...selection, colIndex: 1 }), -1);
  assert.equal(regions[0]!.endRowIndex, 1);
  assert.equal(regions[0]!.lineEndIdx, 1);
  assert.equal(regions[0]!.endCol, 0);
  assert.deepEqual(provider.getClippedRegionPatches(1, [0, 1, 2], [0, 1, 2, 3]).map((patch) => [patch.startRowIndex, patch.startCol, patch.endCol]), [[2, 2, 2]]);
});

test('structure-only blank changes retain both region sides and exact membership', () => {
  const source = descriptor();
  source.runs.flags[0] = 3;
  const provider = new WorkbookArtifactProvider(source);
  const regions = provider.getRegions('base', 'mine');
  const selection = provider.makeSelection(provider.getRows('Sheet')![0]!.workbookArtifactRow!, 0, 'base', 'mine');
  assert.equal(regions[0]!.hasBaseSide, true);
  assert.equal(regions[0]!.hasMineSide, true);
  assert.equal(findArtifactRegionSelectionIndex(regions, selection), 0);
  assert.equal(findArtifactRegionSelectionIndex(regions, { ...selection, side: 'base' }), 0);
  assert.equal(provider.getClippedRegionPatches(0, [0], [0])[0]!.hasBaseSide, true);
  assert.equal(provider.getClippedRegionPatches(0, [0], [0])[0]!.hasMineSide, true);
});

test('all queued window and exact-cell demand is counted and shares a four-read concurrency bound', async () => {
  let active = 0; let peak = 0; let windowCalls = 0; let cellCalls = 0;
  const read = async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
  };
  setBridge({ readWorkbookArtifactWindow: async (request) => { windowCalls += 1; await read(); return page(request); },
    readWorkbookArtifactCells: async (request) => { cellCalls += 1; await read(); return { ...request, cells: request.cells.map((cell) => ({ ...cell, exists: true, value: 'anchor', formula: '' })) }; } });
  const source = descriptor(); source.sheets[0]!.maxColumnCount = 64;
  const provider = new WorkbookArtifactProvider(source);
  const rows = provider.getRows('Sheet')!;
  const coordinates = [{ rowNumber: 1, column: 1 }, { rowNumber: 2, column: 1 }];
  const tasks = [provider.ensureRows(rows, [0, 16, 32, 48]), provider.ensureRows(rows, [0, 16, 32, 48]),
    provider.ensureCells(0, 'mine', coordinates), provider.ensureCells(0, 'mine', coordinates)];
  assert.equal(provider.getCacheStats().pending, 6);
  await Promise.all(tasks);
  assert.equal(peak, 4);
  assert.equal(windowCalls, 4);
  assert.equal(cellCalls, 1);
  assert.equal(provider.getCacheStats().pending, 0);
});

test('exact-cell cache accounts for complete value bytes and evicts to its bounded budget', async () => {
  const value = 'v'.repeat(100_000);
  setBridge({ readWorkbookArtifactCells: async (request) => ({ ...request, cells: request.cells.map((cell) => ({ ...cell, exists: true, value, formula: '=A1' })) }) });
  const provider = new WorkbookArtifactProvider(descriptor());
  await provider.ensureCells(0, 'mine', Array.from({ length: 100 }, (_, column) => ({ rowNumber: 1, column })));
  assert.ok(provider.getCacheStats().bytes <= 4 * 1024 * 1024);
  assert.ok(provider.getCacheStats().cells > 0 && provider.getCacheStats().cells < 100);
});

test('sparse display demand spanning more than 128 tiles loads only requested rows and stays resident', async () => {
  const source = descriptor();
  const count = 64 * 200;
  source.sheets[0]!.pairCount = count;
  source.rows = { sheetIds: new Uint32Array(count), baseOrdinals: new Uint32Array(count), mineOrdinals: new Uint32Array(count),
    baseRowNumbers: Uint32Array.from({ length: count }, (_, index) => index + 1), mineRowNumbers: Uint32Array.from({ length: count }, (_, index) => index + 1),
    kinds: new Uint8Array(count), toneMasks: new Uint8Array(count), changedCellCounts: new Uint32Array(count),
    baseColumnCounts: new Uint32Array(count), mineColumnCounts: new Uint32Array(count), searchBothSides: new Uint8Array(count), runOffsets: new Uint32Array(count + 1) };
  const calls: WorkbookArtifactWindowRequest[] = [];
  setBridge({ readWorkbookArtifactWindow: async (request) => {
    calls.push(request);
    return { artifactId: request.artifactId, compareMode: request.compareMode, sheetId: request.sheetId, startRow: request.startRow,
      columnRanges: request.columnRanges, nextRow: null, rows: Array.from({ length: request.rowCount }, (_, offset) => ({
        rowIndex: request.startRow + offset, baseRowNumber: request.startRow + offset + 1, mineRowNumber: request.startRow + offset + 1,
        baseCells: [{ column: 0, value: 'base', formula: '' }], mineCells: [{ column: 0, value: 'mine', formula: '' }], changedColumnRuns: [],
      })) };
  } });
  const provider = new WorkbookArtifactProvider(source);
  const rows = provider.getRows('Sheet')!.filter((_, index) => index % 64 === 0);
  await provider.ensureRows(rows, [0]);
  assert.equal(calls.length, 200);
  assert.ok(calls.every((call) => call.rowCount === 1));
  assert.equal(provider.getCacheStats().windows, 200);
  assert.equal(provider.getCacheStats().cells, 400);
  assert.ok(provider.getCacheStats().bytes > 200 * 512 && provider.getCacheStats().bytes < 1024 * 1024);
  assert.ok(rows.every((row) => provider.getCellStatus(row.workbookArtifactRow!, 'mine', 0) === 'ready'));
  await provider.ensureRows(rows, [0]);
  assert.equal(calls.length, 200);
  const adjacent = provider.getRows('Sheet')![1]!;
  assert.equal(provider.getCellStatus(adjacent.workbookArtifactRow!, 'mine', 0), 'pending');
  await provider.ensureRows([adjacent], [0]);
  assert.equal(provider.getCellStatus(rows[0]!.workbookArtifactRow!, 'mine', 0), 'ready');
  assert.equal(provider.getCellStatus(adjacent.workbookArtifactRow!, 'mine', 0), 'ready');
});

test('artifact goto preserves exact side priority, deleted sides, nearest rows and row selection', () => {
  const source = descriptor();
  source.rows.baseRowNumbers = Uint32Array.of(1, 4, 9, 20);
  source.rows.mineRowNumbers = Uint32Array.of(1, 0, 8, 20);
  const resolve = (lineNo: number, preferredSide: 'base' | 'mine', allowed?: ReadonlySet<number>) => resolveWorkbookGotoTarget({
    artifact: source, diffLines: [], lineSheetContexts: [], sheetName: 'Sheet', lineNo, preferredSide,
    baseVersionLabel: 'BASE', mineVersionLabel: 'MINE', preferredColumn: 3, ...(allowed ? { allowedLineIndexes: allowed } : {}),
  });
  assert.equal(resolve(20, 'base')?.selection.versionLabel, 'BASE');
  assert.equal(resolve(20, 'base')?.selection.kind, 'row');
  assert.equal(resolve(4, 'mine')?.selection.side, 'base');
  assert.equal(resolve(5, 'mine')?.selection.rowNumber, 8);
  assert.equal(resolve(100, 'base')?.selection.rowNumber, 20);
  assert.equal(resolve(4, 'mine', new Set([0, 3]))?.selection.rowNumber, 20);
});

test('selection reads complete values and formulas independently of viewport cache', async () => {
  const longValue = 'x'.repeat(100_000);
  setBridge({ readWorkbookArtifactCells: async (request) => ({ ...request, cells: request.cells.map((cell) => ({ ...cell, exists: true, value: longValue, formula: '=SUM(A1:A100)' })) }) });
  const provider = new WorkbookArtifactProvider(descriptor());
  const selection = provider.makeSelection(provider.getRows('Sheet')![3]!.workbookArtifactRow!, 3, 'base', 'mine');
  assert.equal(selection.dataStatus, 'pending');
  const resolved = await provider.resolveSelection(selection);
  assert.equal(resolved.value.length, longValue.length);
  assert.equal(resolved.formula, '=SUM(A1:A100)');
  assert.equal(resolved.dataStatus, 'ready');
  assert.equal(provider.getCacheStats().windows, 0);
});

test('search selections retain the exact off-screen target column without hydrated cell arrays', () => {
  const provider = new WorkbookArtifactProvider(descriptor());
  const row = provider.getRows('Sheet')![3]!;
  const entry = provider.buildEntry(row.workbookArtifactRow!, 'mine', 'mine', [0, 2, 3])!;
  const selection = buildWorkbookSearchSelectionFromTarget({ sheetName: 'Sheet', side: 'mine', rowNumber: 4, colIndex: 3 }, {
    base: new Map(), mine: new Map([[4, entry]]),
  });
  assert.equal(selection?.colIndex, 3);
  assert.equal(selection?.address, 'D4');
  assert.equal(selection?.dataStatus, 'pending');
});

test('failed and obsolete windows remain explicit errors or discarded results', async () => {
  setBridge({ readWorkbookArtifactWindow: async () => { throw new Error('disk read failed'); } });
  const failed = new WorkbookArtifactProvider(descriptor());
  const row = failed.getRows('Sheet')![0]!;
  await failed.ensureRows([row], [0]);
  assert.equal(failed.getCellStatus(row.workbookArtifactRow!, 'mine', 0), 'error');
  assert.equal(failed.readCachedCell(row.workbookArtifactRow!, 'mine', 0), undefined);
  assert.equal(failed.getErrorCount(), 1);
  let complete!: (value: WorkbookArtifactWindow) => void;
  let request!: WorkbookArtifactWindowRequest;
  setBridge({ readWorkbookArtifactWindow: (value) => { request = value; return new Promise((resolve) => { complete = resolve; }); } });
  const obsolete = new WorkbookArtifactProvider(descriptor());
  const task = obsolete.ensureRows(obsolete.getRows('Sheet')!.slice(0, 1), [0]);
  obsolete.dispose(); complete(page(request)); await task;
  assert.equal(obsolete.getCacheStats().windows, 0);
});

test('empty leading sheets and empty structural sheets obey each diff type filter', () => {
  const source = descriptor();
  const sheet = { ...source.sheets[0]!, id: 1, sheetId: 1 };
  const empty = { ...sheet, pairCount: 0, maxColumnCount: 0, baseRowCount: 0, mineRowCount: 0,
    baseCellCount: 0, mineCellCount: 0, baseUsedColumns: [], mineUsedColumns: [], changedColumns: [],
    equalRows: 0, addedRows: 0, deletedRows: 0, modifiedRows: 0, changedCellCount: 0 };
  source.sheets = [
    { ...empty, id: 0, sheetId: 0, name: 'EmptyFirst', changeType: 'equal' }, sheet,
    { ...empty, id: 2, sheetId: 2, name: 'AddedEmpty', changeType: 'add', hasBaseSide: false },
    { ...empty, id: 3, sheetId: 3, name: 'DeletedEmpty', changeType: 'delete', hasMineSide: false },
    { ...empty, id: 4, sheetId: 4, name: 'RenamedEmpty', changeType: 'rename', hasMineSide: false },
  ];
  source.rows.sheetIds.fill(1); source.regions.sheetIds.fill(1);
  const provider = new WorkbookArtifactProvider(source);
  const sections = provider.getSections();
  const sectionRowIndex = { artifactProvider: provider, get: (name: string) => ({ rows: provider.getRows(name)! }) };
  assert.deepEqual(getWorkbookDiffTypeAvailability({ sections, sectionRowIndex, compareMode: 'strict' }), { add: true, modify: true, delete: true });
  const expected = { add: ['AddedEmpty'], delete: ['DeletedEmpty'], modify: ['Sheet', 'RenamedEmpty'], all: ['Sheet', 'AddedEmpty', 'DeletedEmpty', 'RenamedEmpty'] };
  for (const filter of ['add', 'delete', 'modify', 'all'] as const) {
    const model = buildWorkbookVisibilityModel({ sections, sectionRowIndex, compareMode: 'strict', modifiedSheetNames: new Set(), showOnlyDifferences: true, diffTypeFilter: filter });
    assert.deepEqual([...model.visibleSheetNames], expected[filter]);
    assert.equal(model.searchableCellKeys.size, source.stats.changedCells);
  }
});

test('closing a comparison releases both renderer modes while retaining another open comparison', async () => {
  setBridge({ readWorkbookArtifactWindow: async (request) => page(request) });
  const source = { ...descriptor(), artifactId: 'close-fixture', comparisonSessionId: 'close-session' };
  const strict = activateWorkbookArtifact(source);
  const content = activateWorkbookArtifact({ ...source, compareMode: 'content' });
  await strict.ensureRows(strict.getRows('Sheet')!.slice(0, 1), [0]);
  const other = activateWorkbookArtifact({ ...descriptor(), artifactId: 'other-fixture', comparisonSessionId: 'other-session' });
  releaseWorkbookArtifactSession(source.comparisonSessionId);
  assert.equal(strict.getCacheStats().bytes, 0);
  assert.equal(strict.sectionRows.size, 0);
  assert.equal(content.sectionRows.size, 0);
  assert.equal(getActiveWorkbookArtifactProvider(), other);
  await assert.rejects(strict.search({ artifactId: source.artifactId, compareMode: 'strict', requestId: 'closed-search', query: 'x', isRegex: false, isCaseSensitive: false }), /closed/);
  await strict.cancelSearch('closed-search');
  assert.notEqual(activateWorkbookArtifact(source), strict);
  releaseWorkbookArtifactSession(source.comparisonSessionId);
  releaseWorkbookArtifactSession('other-session');
  assert.equal(getActiveWorkbookArtifactProvider(), null);
});

test('a new revision disposes previous renderer artifacts and pending responses cannot restore their cache', async () => {
  let complete!: (value: WorkbookArtifactWindow) => void;
  let request!: WorkbookArtifactWindowRequest;
  setBridge({ readWorkbookArtifactWindow: (value) => { request = value; return new Promise((resolve) => { complete = resolve; }); } });
  const source = { ...descriptor(), artifactId: 'old-revision', comparisonSessionId: 'revision-session' };
  const old = activateWorkbookArtifact(source);
  const pending = old.ensureRows(old.getRows('Sheet')!.slice(0, 1), [0]);
  const latest = activateWorkbookArtifact({ ...source, artifactId: 'new-revision' });
  complete(page(request)); await pending;
  assert.equal(old.getCacheStats().bytes, 0);
  assert.equal(old.sectionRows.size, 0);
  assert.equal(getActiveWorkbookArtifactProvider(), latest);
  releaseWorkbookArtifactSession(source.comparisonSessionId);
});

test('complete source scans share the viewport read concurrency limit', async () => {
  let active = 0; let peak = 0;
  setBridge({ readWorkbookArtifactSourceRows: async (request) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return { ...request, rows: [], columnRanges: [], nextRow: null };
  } });
  const provider = new WorkbookArtifactProvider(descriptor());
  await Promise.all(Array.from({ length: 20 }, (_, column) => provider.readSourceRows({ artifactId: provider.descriptor.artifactId, compareMode: 'strict', sheetId: 0, startRow: 0, rowCount: 4, columns: [column] })));
  assert.equal(peak, 4);
});
