import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import type { VersoraBridge } from '../src/types/bridge';
import type { WorkbookArtifactWindowRequest } from '../shared/workbookArtifactProtocol';

function preload(invoke: (channel: string, payload: unknown) => Promise<unknown>): VersoraBridge {
  const source = fs.readFileSync(path.resolve('electron/preload.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  let bridge: VersoraBridge | undefined;
  vm.runInNewContext(compiled, { exports: {}, require: (module: string) => {
    assert.equal(module, 'electron');
    return { contextBridge: { exposeInMainWorld(name: string, api: VersoraBridge) { assert.equal(name, 'versora'); bridge = api; } },
      ipcRenderer: { invoke: (channel: string, payload: unknown) => invoke(channel, structuredClone(payload)) } };
  } });
  assert.ok(bridge);
  return bridge;
}

test('ordinary diff loader channels preserve revision, mode and comparison-session arguments', async () => {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const response = { fileName: '数据.xlsx', workbookArtifact: { rows: { baseOrdinals: Uint32Array.of(0xffffffff), kinds: Uint8Array.of(1) } }, extra: undefined };
  const bridge = preload(async (channel, payload) => { calls.push({ channel, payload }); return structuredClone(response); });
  assert.deepEqual(await bridge.getDiffData('strict', 'session'), response);
  await bridge.loadRevisionDiff('base', 'mine', 'content', 'session');
  await bridge.loadTwoFileRevisionDiff('base', 'mine', 'strict', 'session');
  await bridge.loadDevWorkingCopyDiff('file.xlsx', 'content', 'session');
  await bridge.loadLocalDiff('base.xlsx', 'mine.xlsx', 'strict', 'session');
  await bridge.loadLocalFileDiff('base.xlsx', 'mine.xlsx', 'content', 'session');
  await bridge.loadWorkbookCompareMode('content', 'base', 'mine', 'session');
  await bridge.loadWorkbookMetadata('base', 'mine', 'session');
  assert.deepEqual(calls, [
    { channel: 'get-diff-data', payload: { compareMode: 'strict', comparisonSessionId: 'session' } },
    { channel: 'load-revision-diff', payload: { baseRevisionId: 'base', mineRevisionId: 'mine', compareMode: 'content', comparisonSessionId: 'session' } },
    { channel: 'load-two-file-revision-diff', payload: { baseRevisionId: 'base', mineRevisionId: 'mine', compareMode: 'strict', comparisonSessionId: 'session' } },
    { channel: 'load-dev-working-copy-diff', payload: { filePath: 'file.xlsx', compareMode: 'content', comparisonSessionId: 'session' } },
    { channel: 'load-local-diff', payload: { basePath: 'base.xlsx', minePath: 'mine.xlsx', compareMode: 'strict', comparisonSessionId: 'session' } },
    { channel: 'load-local-file-diff', payload: { basePath: 'base.xlsx', minePath: 'mine.xlsx', compareMode: 'content', comparisonSessionId: 'session' } },
    { channel: 'load-workbook-compare-mode', payload: { compareMode: 'content', baseRevisionId: 'base', mineRevisionId: 'mine', comparisonSessionId: 'session' } },
    { channel: 'load-workbook-metadata', payload: { baseRevisionId: 'base', mineRevisionId: 'mine', comparisonSessionId: 'session' } },
  ]);
});

test('artifact IPC carries typed navigation indexes and window text without JSON transformations', async () => {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const response = { rows: { sheetIds: Uint32Array.of(1), kinds: Uint8Array.of(3), searchBothSides: Uint8Array.of(1), baseOrdinals: Uint32Array.of(0xffffffff) },
    regions: { changedCellCounts: Float64Array.of(4_294_967_296) }, cells: [{ value: '中文😀\ud800\u0000\n"\\', formula: 'SUM(A1:A2)' }],
    missing: undefined, nullValue: null, sparse: ['value', , undefined] };
  const bridge = preload(async (channel, payload) => { calls.push({ channel, payload }); return structuredClone(response); });
  const view = await bridge.getWorkbookArtifactView({ artifactId: 'artifact', compareMode: 'strict' });
  assert.deepEqual(view, response);
  assert.ok(view.rows.baseOrdinals instanceof Uint32Array);
  assert.ok(view.rows.kinds instanceof Uint8Array);
  assert.ok(view.regions.changedCellCounts instanceof Float64Array);
  assert.equal(Object.hasOwn(view, 'missing'), true);
  assert.equal(1 in (view as unknown as typeof response).sparse, false);
  const window: WorkbookArtifactWindowRequest = { artifactId: 'artifact', compareMode: 'content', sheetId: 1, startRow: 10, rowCount: 64, columnRanges: [{ start: 16, end: 32 }] };
  assert.deepEqual(await bridge.readWorkbookArtifactWindow(window), response);
  await bridge.readWorkbookArtifactCells({ artifactId: 'artifact', side: 'base', sheetId: 1, cells: [{ rowNumber: 99, column: 0 }] });
  await bridge.readWorkbookArtifactSourceRows({ artifactId: 'artifact', compareMode: 'content', sheetId: 1, startRow: 0, rowCount: 128, columns: [1] });
  const search = { artifactId: 'artifact', requestId: 'search', compareMode: 'strict' as const, query: 'SUM', isRegex: false, isCaseSensitive: false, visibleRowIndexes: Uint32Array.of(10) };
  await bridge.searchWorkbookArtifact(search);
  await bridge.cancelWorkbookArtifactSearch('artifact', 'search');
  assert.deepEqual(calls, [
    { channel: 'workbook-artifact-view', payload: { artifactId: 'artifact', compareMode: 'strict' } },
    { channel: 'workbook-artifact-window', payload: window },
    { channel: 'workbook-artifact-cells', payload: { artifactId: 'artifact', side: 'base', sheetId: 1, cells: [{ rowNumber: 99, column: 0 }] } },
    { channel: 'workbook-artifact-source-rows', payload: { artifactId: 'artifact', compareMode: 'content', sheetId: 1, startRow: 0, rowCount: 128, columns: [1] } },
    { channel: 'workbook-artifact-search', payload: search },
    { channel: 'workbook-artifact-cancel-search', payload: { artifactId: 'artifact', requestId: 'search' } },
  ]);
});

test('direct loader rejection propagates once without retrying another transport', async () => {
  let calls = 0;
  const bridge = preload(async () => { calls += 1; throw new Error('comparison is unavailable'); });
  await assert.rejects(bridge.getDiffData('strict'), /comparison is unavailable/);
  assert.equal(calls, 1);
});
