import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { EMPTY_CLI_ARGS } from '../electron/cliArgs';
import { preserveExternalDiffTempInputsSync } from '../electron/externalDiffRequest';
import { cleanupManagedTempFilesOnExitSync, configureRuntimePaths } from '../electron/runtimePaths';
import {
  createComparisonSession, getActiveCliArgs, getCurrentComparisonSessionId, releaseComparisonSession, runInComparisonSession,
  runInComparisonSessionTransaction, setActiveCliArgs, setHasPendingLaunchDiffRequest,
} from '../electron/main/state';
import {
  abortWorkbookPreparations, getCurrentWorkbookArtifact, getWorkbookArtifactReader,
  prepareWorkbookArtifact, releaseWorkbookArtifacts,
} from '../electron/main/workbookArtifactService';
import { createComparisonIpcHarness } from './helpers/comparisonIpcHarness';
import { getPeggedSvnTarget } from '../electron/main/svnHelpers';

const bridgePromise = createComparisonIpcHarness();

function workbook(value: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${value}</t></is></c></row></sheetData></worksheet>`),
  });
}

function configure(root: string): void {
  if (!process.resourcesPath) Object.defineProperty(process, 'resourcesPath', { value: '', configurable: true });
  const paths = new Map<string, string>();
  configureRuntimePaths({ commandLine: { appendSwitch() {} }, setPath(name: string, value: string) { paths.set(name, value); },
    getPath(name: string) { return paths.get(name) ?? path.join(root, name); } } as unknown as Parameters<typeof configureRuntimePaths>[0], path.join(root, '.runtime'), null);
}

async function values(artifactId: string): Promise<string[]> {
  const window = await getWorkbookArtifactReader(artifactId).readWindow({ artifactId, compareMode: 'strict', sheetId: 0,
    startRow: 0, rowCount: 1, columnRanges: [{ start: 0, end: 1 }] });
  return [window.rows[0]?.baseCells[0]?.value ?? '', window.rows[0]?.mineCells[0]?.value ?? ''];
}

test('native IPC swaps preserved workbook inputs and rolls back a failed replacement with the old artifact usable', async (t) => {
  const bridge = await bridgePromise;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-ipc-workbook-'));
  configure(root);
  releaseComparisonSession();
  t.after(async () => { await releaseWorkbookArtifacts(); releaseComparisonSession(); cleanupManagedTempFilesOnExitSync(); await fs.rm(root, { recursive: true, force: true }); });
  const basePath = path.join(root, 'base.xlsx');
  const minePath = path.join(root, 'mine.xlsx');
  const baseBytes = workbook('base value');
  const mineBytes = workbook('mine value');
  await fs.writeFile(basePath, baseBytes); await fs.writeFile(minePath, mineBytes);
  const sourceArgs = { ...EMPTY_CLI_ARGS, basePath, minePath };
  const inputs = preserveExternalDiffTempInputsSync(sourceArgs);
  const id = createComparisonSession(inputs, sourceArgs);
  setHasPendingLaunchDiffRequest(true);
  await fs.unlink(basePath); await fs.unlink(minePath);
  const initial = await bridge.getDiffData('strict', id);
  assert.ok(initial.workbookArtifact);
  assert.deepEqual(await values(initial.workbookArtifact.artifactId), ['base value', 'mine value']);
  await fs.writeFile(inputs.minePath, 'invalid workbook');
  await assert.rejects(bridge.swapTwoFileDiff(null, null, 'strict', id));
  assert.deepEqual(await values(initial.workbookArtifact.artifactId), ['base value', 'mine value']);
  assert.equal(getCurrentWorkbookArtifact(id)?.artifactId, initial.workbookArtifact.artifactId);
  runInComparisonSession(id, () => assert.deepEqual([getActiveCliArgs().basePath, getActiveCliArgs().minePath], [inputs.basePath, inputs.minePath]));
  await fs.writeFile(inputs.minePath, mineBytes);
  const swapped = await bridge.swapTwoFileDiff(null, null, 'strict', id);
  assert.ok(swapped.workbookArtifact);
  assert.deepEqual([swapped.basePath, swapped.minePath, swapped.baseName, swapped.mineName], [minePath, basePath, 'mine.xlsx', 'base.xlsx']);
  assert.deepEqual(await values(swapped.workbookArtifact.artifactId), ['mine value', 'base value']);
  const restored = await bridge.swapTwoFileDiff(null, null, 'strict', id);
  assert.ok(restored.workbookArtifact);
  assert.deepEqual([restored.basePath, restored.minePath], [basePath, minePath]);
  assert.deepEqual(await values(restored.workbookArtifact.artifactId), ['base value', 'mine value']);
});

test('identical native preparations share computation while only the newest source transaction commits', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-native-commit-'));
  configure(root);
  releaseComparisonSession();
  t.after(async () => { await releaseWorkbookArtifacts(); releaseComparisonSession(); cleanupManagedTempFilesOnExitSync(); await fs.rm(root, { recursive: true, force: true }); });
  const basePath = path.join(root, 'base.xlsx'); const minePath = path.join(root, 'mine.xlsx');
  await fs.writeFile(basePath, workbook('base')); await fs.writeFile(minePath, workbook('mine'));
  const args = { ...EMPTY_CLI_ARGS, basePath, minePath };
  const id = createComparisonSession(args);
  const initial = await prepareWorkbookArtifact({ comparisonSessionId: id, compareMode: 'strict', sourceKey: 'initial', resolveSources: async () => ({ basePath, minePath }) });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void;
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const first = runInComparisonSession(id, () => runInComparisonSessionTransaction(async () => {
    setActiveCliArgs({ ...args, basePath: minePath, minePath: basePath });
    return prepareWorkbookArtifact({ comparisonSessionId: id, compareMode: 'strict', sourceKey: 'swapped', resolveSources: async () => {
      entered(); await barrier; return { basePath: minePath, minePath: basePath };
    } });
  }));
  await started;
  assert.deepEqual(await values(initial.artifactId), ['base', 'mine']);
  runInComparisonSession(id, () => assert.equal(getActiveCliArgs().basePath, basePath));
  const second = runInComparisonSession(id, () => runInComparisonSessionTransaction(async () => {
    setActiveCliArgs({ ...args, basePath: minePath, minePath: basePath });
    return prepareWorkbookArtifact({ comparisonSessionId: id, compareMode: 'strict', sourceKey: 'swapped', resolveSources: async () => {
      assert.fail('The identical native preparation should be shared');
    } });
  }));
  finish();
  const [oldResult, newestResult] = await Promise.allSettled([first, second]);
  assert.equal(oldResult.status, 'rejected');
  if (oldResult.status === 'rejected') assert.equal(oldResult.reason.name, 'AbortError');
  assert.equal(newestResult.status, 'fulfilled');
  if (newestResult.status === 'fulfilled') {
    assert.deepEqual(await values(newestResult.value.artifactId), ['mine', 'base']);
    assert.equal(getCurrentWorkbookArtifact(id)?.artifactId, newestResult.value.artifactId);
  }
  runInComparisonSession(id, () => assert.equal(getActiveCliArgs().basePath, minePath));
});

test('cancelled native source transactions retain the ready artifact and ordered source context', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-native-cancel-'));
  configure(root);
  releaseComparisonSession();
  t.after(async () => { await releaseWorkbookArtifacts(); releaseComparisonSession(); cleanupManagedTempFilesOnExitSync(); await fs.rm(root, { recursive: true, force: true }); });
  const basePath = path.join(root, 'base.xlsx'); const minePath = path.join(root, 'mine.xlsx');
  await fs.writeFile(basePath, workbook('base')); await fs.writeFile(minePath, workbook('mine'));
  const args = { ...EMPTY_CLI_ARGS, basePath, minePath };
  const id = createComparisonSession(args);
  const initial = await prepareWorkbookArtifact({ comparisonSessionId: id, compareMode: 'strict', sourceKey: 'initial', resolveSources: async () => ({ basePath, minePath }) });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void; const barrier = new Promise<void>(resolve => { finish = resolve; });
  const cancelled = runInComparisonSession(id, () => runInComparisonSessionTransaction(async () => {
    setActiveCliArgs({ ...args, basePath: minePath, minePath: basePath });
    return prepareWorkbookArtifact({ comparisonSessionId: id, compareMode: 'strict', sourceKey: 'cancelled', resolveSources: async () => {
      entered(); await barrier; return { basePath: minePath, minePath: basePath };
    } });
  }));
  await started; abortWorkbookPreparations(); finish();
  await assert.rejects(cancelled, error => error instanceof Error && error.name === 'AbortError');
  assert.equal(getCurrentWorkbookArtifact(id)?.artifactId, initial.artifactId);
  assert.deepEqual(await values(initial.artifactId), ['base', 'mine']);
  runInComparisonSession(id, () => assert.deepEqual([getActiveCliArgs().basePath, getActiveCliArgs().minePath], [basePath, minePath]));
});

test('read-only native joins cannot remove the transaction guard or replace a newer source context', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-native-readonly-'));
  configure(root);
  releaseComparisonSession();
  t.after(async () => { await releaseWorkbookArtifacts(); releaseComparisonSession(); cleanupManagedTempFilesOnExitSync(); await fs.rm(root, { recursive: true, force: true }); });
  const basePath = path.join(root, 'base.xlsx'); const minePath = path.join(root, 'mine.xlsx');
  await fs.writeFile(basePath, workbook('base')); await fs.writeFile(minePath, workbook('mine'));
  const args = { ...EMPTY_CLI_ARGS, basePath, minePath };
  const id = createComparisonSession(args);
  const initial = await prepareWorkbookArtifact({ comparisonSessionId: id, compareMode: 'strict', sourceKey: 'initial', resolveSources: async () => ({ basePath, minePath }) });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void; const barrier = new Promise<void>(resolve => { finish = resolve; });
  const stale = runInComparisonSession(id, () => runInComparisonSessionTransaction(async () => {
    setActiveCliArgs({ ...args, basePath: minePath, minePath: basePath });
    return prepareWorkbookArtifact({ comparisonSessionId: id, compareMode: 'strict', sourceKey: 'swapped', resolveSources: async () => {
      entered(); await barrier; return { basePath: minePath, minePath: basePath };
    } });
  }));
  await started;
  const readonly = prepareWorkbookArtifact({ comparisonSessionId: id, compareMode: 'content', sourceKey: 'swapped', resolveSources: async () => {
    assert.fail('A read-only caller should share the pending calculation');
  } });
  runInComparisonSession(id, () => setActiveCliArgs({ ...args, fileName: 'newer-source.xlsx' }));
  finish();
  const results = await Promise.allSettled([stale, readonly]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason.name, 'AbortError');
  }
  assert.equal(getCurrentWorkbookArtifact(id)?.artifactId, initial.artifactId);
  assert.deepEqual(await values(initial.artifactId), ['base', 'mine']);
  runInComparisonSession(id, () => assert.equal(getActiveCliArgs().fileName, 'newer-source.xlsx'));
});

test('queued native sources retain their own session, SVN peg and candidate context', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-native-queued-context-'));
  configure(root);
  releaseComparisonSession();
  t.after(async () => { await releaseWorkbookArtifacts(); releaseComparisonSession(); cleanupManagedTempFilesOnExitSync(); await fs.rm(root, { recursive: true, force: true }); });
  const firstPath = path.join(root, 'first.xlsx'); const secondPath = path.join(root, 'second.xlsx');
  await fs.writeFile(firstPath, workbook('first session')); await fs.writeFile(secondPath, workbook('second session'));
  const firstId = createComparisonSession({ ...EMPTY_CLI_ARGS, pegRevision: '1' });
  const secondId = createComparisonSession({ ...EMPTY_CLI_ARGS, pegRevision: 'initial' });
  const seen: Array<{ sessionId: string; target: string }> = [];
  const target = 'https://example.invalid/workbook.xlsx';
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void; const barrier = new Promise<void>(resolve => { finish = resolve; });
  const first = runInComparisonSession(firstId, () => prepareWorkbookArtifact({ comparisonSessionId: firstId,
    compareMode: 'strict', sourceKey: 'first', resolveSources: async () => {
      seen.push({ sessionId: getCurrentComparisonSessionId(), target: getPeggedSvnTarget(target) });
      entered(); await barrier; return { basePath: firstPath, minePath: firstPath };
    } }));
  await started;
  const second = runInComparisonSession(secondId, () => runInComparisonSessionTransaction(async () => {
    setActiveCliArgs({ ...EMPTY_CLI_ARGS, pegRevision: '2', fileName: 'candidate.xlsx' });
    return prepareWorkbookArtifact({ comparisonSessionId: secondId, compareMode: 'strict', sourceKey: 'second', resolveSources: async () => {
      const peggedTarget = getPeggedSvnTarget(target);
      seen.push({ sessionId: getCurrentComparisonSessionId(), target: peggedTarget });
      assert.equal(getActiveCliArgs().fileName, 'candidate.xlsx');
      const sourcePath = peggedTarget.endsWith('@2') ? secondPath : firstPath;
      return { basePath: sourcePath, minePath: sourcePath };
    } });
  }));
  runInComparisonSession(secondId, () => assert.equal(getActiveCliArgs().pegRevision, 'initial'));
  finish();
  const [, secondArtifact] = await Promise.all([first, second]);
  assert.deepEqual(seen, [{ sessionId: firstId, target: `${target}@1` }, { sessionId: secondId, target: `${target}@2` }]);
  assert.deepEqual(await values(secondArtifact.artifactId), ['second session', 'second session']);
  runInComparisonSession(secondId, () => assert.deepEqual([getActiveCliArgs().pegRevision, getActiveCliArgs().fileName], ['2', 'candidate.xlsx']));
});

test('native IPC keeps selected workbook revisions attached to their independent Git repositories when swapped', async (t) => {
  const bridge = await bridgePromise;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-ipc-workbook-git-'));
  configure(root);
  releaseComparisonSession();
  t.after(async () => { await releaseWorkbookArtifacts(); releaseComparisonSession(); cleanupManagedTempFilesOnExitSync(); await fs.rm(root, { recursive: true, force: true }); });
  const createRepository = async (name: string) => {
    const repository = path.join(root, name); await fs.mkdir(repository);
    const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', windowsHide: true }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', name); git('config', 'user.email', `${name}@example.invalid`);
    const filePath = path.join(repository, 'sample.xlsx');
    await fs.writeFile(filePath, workbook(`${name} committed`)); git('add', 'sample.xlsx'); git('commit', '-m', name);
    const revision = git('rev-parse', 'HEAD'); await fs.writeFile(filePath, workbook(`${name} working`));
    return { filePath, revision };
  };
  const base = await createRepository('left'); const mine = await createRepository('right');
  const initial = await bridge.loadLocalFileDiff(base.filePath, mine.filePath, 'strict');
  const id = initial.comparisonSessionId!;
  const selected = await bridge.loadTwoFileRevisionDiff(base.revision, mine.revision, 'strict', id);
  assert.ok(selected.workbookArtifact); assert.deepEqual(await values(selected.workbookArtifact.artifactId), ['left committed', 'right committed']);
  const swapped = await bridge.swapTwoFileDiff(base.revision, mine.revision, 'strict', id);
  assert.ok(swapped.workbookArtifact); assert.deepEqual(await values(swapped.workbookArtifact.artifactId), ['right committed', 'left committed']);
  assert.deepEqual([swapped.basePath, swapped.minePath, swapped.baseRevisionInfo?.id, swapped.mineRevisionInfo?.id], [mine.filePath, base.filePath, mine.revision, base.revision]);
  await assert.rejects(bridge.swapTwoFileDiff('invalid-revision', base.revision, 'strict', id));
  assert.equal(getCurrentWorkbookArtifact(id)?.artifactId, swapped.workbookArtifact.artifactId);
  assert.deepEqual(await values(swapped.workbookArtifact.artifactId), ['right committed', 'left committed']);
  const restored = await bridge.swapTwoFileDiff(mine.revision, base.revision, 'strict', id);
  assert.ok(restored.workbookArtifact); assert.deepEqual(await values(restored.workbookArtifact.artifactId), ['left committed', 'right committed']);
});
