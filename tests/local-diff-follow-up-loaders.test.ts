import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { Worker } from 'node:worker_threads';

import { EMPTY_CLI_ARGS } from '../electron/cliArgs';
import {
  clearAnalysisSnapshotCache,
} from '../electron/main/analysisSnapshotService';
import {
  buildLocalDiffData,
  loadWorkbookCompareModeData,
  loadWorkbookMetadataData,
} from '../electron/main/diffBuilder';
import { getCurrentWorkbookArtifact, getWorkbookArtifactReader, prepareWorkbookArtifact, releaseWorkbookArtifacts } from '../electron/main/workbookArtifactService';
import { cancelWorkbookArtifactSearch, searchWorkbookArtifact } from '../electron/main/workbookSearchService';
import { configureRuntimePaths } from '../electron/runtimePaths';
import {
  filePayloadCache,
  revisionPayloadCache,
  setActiveCliArgs,
  getCurrentComparisonSessionId,
} from '../electron/main/state';

function configureTestRuntime(tempDir: string) {
  if (!process.resourcesPath) Object.defineProperty(process, 'resourcesPath', { value: '', configurable: true });
  const paths = new Map<string, string>();
  configureRuntimePaths({ commandLine: { appendSwitch() {} }, setPath(name: string, value: string) { paths.set(name, value); },
    getPath(name: string) { return paths.get(name) ?? path.join(tempDir, name); } } as unknown as Parameters<typeof configureRuntimePaths>[0], path.join(tempDir, 'runtime'), null);
}

test('local diff keeps compare-mode and metadata loaders usable after initial load', async () => {
  resetLoaderCaches();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-local-follow-up-'));
  const basePath = path.join(tempDir, 'base.xlsx');
  const minePath = path.join(tempDir, 'mine.xlsx');
  configureTestRuntime(tempDir);
  try {
    await fs.writeFile(basePath, buildWorkbookZip('Thing', [['ID', 'Name'], ['10001', 'Alpha']]));
    await fs.writeFile(minePath, buildWorkbookZip('Thing', [['ID', 'Name'], ['10001', 'Bravo']]));
    const initial = await buildLocalDiffData(basePath, minePath, 'strict');
    const [strict, content, metadata] = await Promise.all([
      loadWorkbookCompareModeData('strict'), loadWorkbookCompareModeData('content'), loadWorkbookMetadataData(),
    ]);
    assert.ok(initial.workbookArtifact);
    assert.equal(initial.analysisSnapshotsByMode, null);
    assert.equal('baseBytes' in initial, false);
    assert.equal(initial.mineContent, null);
    assert.equal(strict.workbookArtifact?.artifactId, initial.workbookArtifact.artifactId);
    assert.equal(content.workbookArtifact?.artifactId, initial.workbookArtifact.artifactId);
    assert.equal(content.workbookArtifact?.compareMode, 'content');
    assert.equal(content.workbookArtifact?.stats.changedCells, 1);
    assert.equal(metadata.base, initial.workbookArtifact.baseMetadata);
    assert.equal(metadata.mine, initial.workbookArtifact.mineMetadata);
    const window = await getWorkbookArtifactReader(initial.workbookArtifact.artifactId).readWindow({
      artifactId: initial.workbookArtifact.artifactId, compareMode: 'content', sheetId: 0, startRow: 0, rowCount: 2, columnRanges: [{ start: 0, end: 2 }],
    });
    assert.equal(window.rows[1]?.baseCells[1]?.value, 'Alpha');
    assert.equal(window.rows[1]?.mineCells[1]?.value, 'Bravo');
    const query = searchWorkbookArtifact({ artifactId: initial.workbookArtifact.artifactId, requestId: 'cancel-pending', compareMode: 'content', query: 'Bravo', isRegex: false, isCaseSensitive: false });
    const cancelled = assert.rejects(query, { name: 'AbortError' });
    await cancelWorkbookArtifactSearch(initial.workbookArtifact.artifactId, 'cancel-pending');
    await cancelled;

  } finally {
    await releaseWorkbookArtifacts();
    resetLoaderCaches();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('cold metadata follow-up prepares an artifact without materializing a full snapshot', async () => {
  resetLoaderCaches();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-cold-metadata-'));
  const basePath = path.join(tempDir, 'base.xlsx');
  const minePath = path.join(tempDir, 'mine.xlsx');
  configureTestRuntime(tempDir);
  try {
    await fs.writeFile(basePath, buildWorkbookZip('Thing', [['Alpha']]));
    await fs.writeFile(minePath, buildWorkbookZip('Thing', [['Bravo']]));
    setActiveCliArgs({ ...EMPTY_CLI_ARGS, basePath, minePath, fileName: 'mine.xlsx' });
    const first = await loadWorkbookMetadataData();
    const prepared = getCurrentWorkbookArtifact(getCurrentComparisonSessionId());
    const second = await loadWorkbookMetadataData();
    assert.ok(prepared);
    assert.equal(first.base, second.base);
    assert.equal(first.mine, second.mine);
    assert.equal(getCurrentWorkbookArtifact(getCurrentComparisonSessionId()), prepared);
    assert.deepEqual(Object.keys(first.base?.sheets ?? {}), ['Thing']);
    assert.deepEqual(Object.keys(first.mine?.sheets ?? {}), ['Thing']);
    assert.equal('analysisSnapshot' in first, false);

    assert.equal(filePayloadCache.size, 0);
  } finally {
    await releaseWorkbookArtifacts();
    resetLoaderCaches();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('concurrent cold metadata and mode follow-ups share one canonical preparation', async () => {
  resetLoaderCaches();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-cold-follow-up-'));
  const basePath = path.join(tempDir, 'base.xlsx');
  const minePath = path.join(tempDir, 'mine.xlsx');
  configureTestRuntime(tempDir);
  try {
    await fs.writeFile(basePath, buildWorkbookZip('Thing', [['Alpha']]));
    await fs.writeFile(minePath, buildWorkbookZip('Thing', [['Bravo']]));
    setActiveCliArgs({ ...EMPTY_CLI_ARGS, basePath, minePath, fileName: 'mine.xlsx' });
    const [first, second, strict, content] = await Promise.all([
      loadWorkbookMetadataData(), loadWorkbookMetadataData(), loadWorkbookCompareModeData('strict'), loadWorkbookCompareModeData('content'),
    ]);
    const prepared = getCurrentWorkbookArtifact(getCurrentComparisonSessionId());
    assert.ok(prepared);
    assert.equal(strict.workbookArtifact?.artifactId, content.workbookArtifact?.artifactId);
    assert.equal(strict.workbookArtifact?.artifactId, prepared.artifactId);
    assert.equal(first.base, second.base);
    assert.equal(first.mine, second.mine);
    assert.equal(content.workbookArtifact?.stats.changedCells, 1);
    const files = await fs.readdir(path.dirname(prepared.manifest.artifactDir), { withFileTypes: true });
    assert.equal(files.filter(entry => entry.isDirectory()).length, 1);

  } finally {
    await releaseWorkbookArtifacts();
    resetLoaderCaches();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('returning to a ready pair cancels its pending replacement and native failure preserves it', async () => {
  resetLoaderCaches();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-artifact-replacement-'));
  configureTestRuntime(tempDir);
  const basePath = path.join(tempDir, 'base.xlsx');
  const minePath = path.join(tempDir, 'mine.xlsx');
  try {
    await fs.writeFile(basePath, buildWorkbookZip('Thing', [['Alpha']]));
    await fs.writeFile(minePath, buildWorkbookZip('Thing', [['Bravo']]));
    const request = { comparisonSessionId: getCurrentComparisonSessionId(), sourceKey: 'ready-A', compareMode: 'strict' as const,
      resolveSources: async () => ({ basePath, minePath }) };
    const ready = await prepareWorkbookArtifact(request);
    let started!: () => void; let proceed!: () => void;
    const sourceStarted = new Promise<void>(resolve => { started = resolve; });
    const deferred = new Promise<void>(resolve => { proceed = resolve; });
    const replacement = prepareWorkbookArtifact({ ...request, sourceKey: 'pending-B', resolveSources: async () => {
      started(); await deferred; return { basePath, minePath };
    } });
    const cancelled = assert.rejects(replacement, { name: 'AbortError' });
    await sourceStarted;
    assert.equal((await prepareWorkbookArtifact(request)).artifactId, ready.artifactId);
    proceed();
    await cancelled;
    const invalidPath = path.join(tempDir, 'invalid.xlsx');
    await fs.writeFile(invalidPath, 'invalid ZIP');
    await assert.rejects(prepareWorkbookArtifact({ ...request, sourceKey: 'invalid', resolveSources: async () => ({ basePath, minePath: invalidPath }) }));
    assert.equal(getCurrentWorkbookArtifact(getCurrentComparisonSessionId())?.artifactId, ready.artifactId);
    const selected = await getWorkbookArtifactReader(ready.artifactId).readCells({ artifactId: ready.artifactId, side: 'mine', sheetId: 0, cells: [{ rowNumber: 1, column: 0 }] });
    assert.equal(selected.cells[0]?.value, 'Bravo');
  } finally {
    await releaseWorkbookArtifacts(); resetLoaderCaches(); await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('native artifact navigation keeps distant changed rows as separate visual regions', async () => {
  resetLoaderCaches();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-artifact-navigation-'));
  configureTestRuntime(tempDir);
  const basePath = path.join(tempDir, 'base.xlsx');
  const minePath = path.join(tempDir, 'mine.xlsx');
  const baseRows = Array.from({ length: 600 }, (_, index) => [String(index + 1), `Value-${index + 1}`]);
  const mineRows = baseRows.map(row => [...row]);
  mineRows[99]![1] = 'Changed-100';
  mineRows[499]![1] = 'Changed-500';
  try {
    await fs.writeFile(basePath, buildWorkbookZip('Thing', baseRows));
    await fs.writeFile(minePath, buildWorkbookZip('Thing', mineRows));
    const data = await buildLocalDiffData(basePath, minePath, 'strict');
    const view = data.workbookArtifact!;
    assert.equal(data.analysisSnapshotsByMode, null);
    assert.equal(view.stats.changedCells, 2);
    assert.equal(view.regionCount, 2);
    assert.deepEqual([...view.regions.startRows], [99, 499]);
    assert.deepEqual([...view.regions.anchorRows].map(row => view.rows.mineRowNumbers[row]), [100, 500]);
    assert.deepEqual([...view.regions.anchorRows], [99, 499]);
  } finally {
    await releaseWorkbookArtifacts(); resetLoaderCaches(); await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('artifact binary equality runs only for equal cells and preserves the binary-only notice', async (t) => {
  resetLoaderCaches();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-artifact-binary-equality-'));
  configureTestRuntime(tempDir);
  const basePath = path.join(tempDir, 'base.xlsx');
  const minePath = path.join(tempDir, 'mine.xlsx');
  const buildBytes = (value: string, properties: string) => zipSync({
    ...unzipSync(buildWorkbookZip('Thing', [['ID', 'Name'], ['10001', value]])),
    'docProps/core.xml': strToU8(`<properties>${properties}</properties>`),
  }, { level: 0 });
  const filePromises = await import('node:fs');
  const openMock = t.mock.method(filePromises.promises, 'open');
  const sourceOpens = () => openMock.mock.calls.filter(call => call.arguments[0] === basePath || call.arguments[0] === minePath).length;
  try {
    const baseBytes = buildBytes('Alpha', 'before');
    const changedCellBytes = buildBytes('Bravo', 'before');
    assert.equal(baseBytes.byteLength, changedCellBytes.byteLength);
    await fs.writeFile(basePath, baseBytes);
    await fs.writeFile(minePath, changedCellBytes);
    const cellsChanged = await buildLocalDiffData(basePath, minePath, 'strict');
    assert.equal(cellsChanged.workbookArtifact?.stats.changedCells, 1);
    assert.equal(cellsChanged.workbookArtifactDiff, null);
    assert.equal(sourceOpens(), 0);

    const artifactBytes = buildBytes('Alpha', 'after!');
    assert.equal(baseBytes.byteLength, artifactBytes.byteLength);
    await fs.writeFile(minePath, artifactBytes);
    await fs.utimes(minePath, new Date(), new Date(Date.now() + 1000));
    const artifactOnly = await buildLocalDiffData(basePath, minePath, 'strict');
    assert.deepEqual(artifactOnly.workbookArtifactDiff, {
      hasArtifactOnlyDiff: true, kind: 'binary-only', baseBytes: baseBytes.byteLength, mineBytes: artifactBytes.byteLength,
    });
    assert.equal(sourceOpens(), 2);

    await fs.writeFile(minePath, baseBytes);
    await fs.utimes(minePath, new Date(), new Date(Date.now() + 2000));
    const identical = await buildLocalDiffData(basePath, minePath, 'strict');
    assert.equal(identical.workbookArtifactDiff, null);
    assert.equal(sourceOpens(), 4);
  } finally {
    openMock.mock.restore();
    await releaseWorkbookArtifacts(); resetLoaderCaches(); await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('concurrent search cancellation and artifact release wait for the same worker termination', async (t) => {
  resetLoaderCaches();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-search-cancel-release-'));
  configureTestRuntime(tempDir);
  const basePath = path.join(tempDir, 'base.xlsx'); const minePath = path.join(tempDir, 'mine.xlsx');
  let unblock: () => void = () => {};
  const terminationGate = new Promise<void>(resolve => { unblock = resolve; });
  let started: () => void = () => {};
  const workerStarted = new Promise<void>(resolve => { started = resolve; });
  const originalEmit = Worker.prototype.emit;
  const emitMock = t.mock.method(Worker.prototype, 'emit', function (this: Worker, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'online') started();
    return originalEmit.call(this, event, ...args);
  });
  const originalTerminate = Worker.prototype.terminate;
  const terminateMock = t.mock.method(Worker.prototype, 'terminate', async function (this: Worker): Promise<number> {
    const code = await originalTerminate.call(this);
    await terminationGate;
    return code;
  });
  try {
    const bytes = buildWorkbookZip('Thing', [['a'.repeat(16_000) + '!']]);
    await fs.writeFile(basePath, bytes); await fs.writeFile(minePath, bytes);
    const initial = await buildLocalDiffData(basePath, minePath, 'strict');
    const artifactId = initial.workbookArtifact!.artifactId;
    const lease = getWorkbookArtifactReader(artifactId).manifest.artifactDir;
    const query = searchWorkbookArtifact({ artifactId, requestId: 'active', compareMode: 'strict', query: '(a+)+$', isRegex: true, isCaseSensitive: true });
    const cancelled = assert.rejects(query, { name: 'AbortError' });
    await workerStarted;
    const firstCancel = cancelWorkbookArtifactSearch(artifactId, 'active');
    const secondCancel = cancelWorkbookArtifactSearch(artifactId, 'active');
    let released = false;
    const release = releaseWorkbookArtifacts().then(() => { released = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(released, false, 'lease cleanup must wait for worker termination even when a cancel is already active');
    assert.equal((await fs.stat(lease)).isDirectory(), true);
    unblock();
    await Promise.all([firstCancel, secondCancel, release, cancelled]);
    assert.equal(terminateMock.mock.callCount(), 1);
    await assert.rejects(fs.stat(lease), { code: 'ENOENT' });
  } finally {
    unblock(); emitMock.mock.restore(); terminateMock.mock.restore();
    await cancelWorkbookArtifactSearch(); await releaseWorkbookArtifacts(); resetLoaderCaches(); await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('superseding a pending search and releasing its artifact preserve a new artifact query', async () => {
  resetLoaderCaches();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-search-replace-'));
  configureTestRuntime(tempDir);
  const basePath = path.join(tempDir, 'base.xlsx'); const minePath = path.join(tempDir, 'mine.xlsx');
  try {
    await fs.writeFile(basePath, buildWorkbookZip('Thing', [['Alpha']]));
    await fs.writeFile(minePath, buildWorkbookZip('Thing', [['Bravo']]));
    const initial = await buildLocalDiffData(basePath, minePath, 'strict');
    const initialId = initial.workbookArtifact!.artifactId;
    const stale = searchWorkbookArtifact({ artifactId: initialId, requestId: 'pending', compareMode: 'strict', query: 'Alpha', isRegex: false, isCaseSensitive: false });
    const superseded = assert.rejects(stale, { name: 'AbortError' });
    const current = searchWorkbookArtifact({ artifactId: initialId, requestId: 'current', compareMode: 'strict', query: 'Bravo', isRegex: false, isCaseSensitive: false });
    await superseded;
    assert.equal((await current).matches[0]?.side, 'mine');
    await fs.writeFile(minePath, buildWorkbookZip('Thing', [['Delta']]));
    await fs.utimes(minePath, new Date(), new Date(Date.now() + 1000));
    const replacement = await buildLocalDiffData(basePath, minePath, 'strict');
    const replacementId = replacement.workbookArtifact!.artifactId;
    assert.notEqual(replacementId, initialId);
    const next = searchWorkbookArtifact({ artifactId: replacementId, requestId: 'new-artifact', compareMode: 'strict', query: 'Delta', isRegex: false, isCaseSensitive: false });
    await cancelWorkbookArtifactSearch(initialId);
    const result = await next;
    assert.equal(result.artifactId, replacementId); assert.equal(result.totalCount, 1); assert.equal(result.matches[0]?.side, 'mine');
  } finally {
    await cancelWorkbookArtifactSearch(); await releaseWorkbookArtifacts(); resetLoaderCaches(); await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function resetLoaderCaches() {
  filePayloadCache.clear();
  revisionPayloadCache.clear();

  clearAnalysisSnapshotCache();
  setActiveCliArgs(EMPTY_CLI_ARGS);
}

function buildWorkbookZip(sheetName: string, rows: string[][]) {
  const sheetRows = rows.map((cells, rowIndex) => {
    const cellXml = cells.map((value, columnIndex) => {
      const columnLabel = String.fromCharCode(65 + columnIndex);
      return `<c r="${columnLabel}${rowIndex + 1}" t="inlineStr"><is><t>${value}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cellXml}</row>`;
  }).join('');

  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
        <Default Extension="xml" ContentType="application/xml" />
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" />
        <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" />
      </Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml" />
      </Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="${sheetName}" sheetId="1" r:id="rId1" />
        </sheets>
      </workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml" />
      </Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <worksheet><sheetData>${sheetRows}</sheetData></worksheet>`),
  });
}
