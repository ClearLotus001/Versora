import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EMPTY_CLI_ARGS } from '../electron/cliArgs';
import { preserveExternalDiffTempInputsSync } from '../electron/externalDiffRequest';
import { cleanupManagedTempFilesOnExitSync, configureRuntimePaths, getRuntimePathState } from '../electron/runtimePaths';
import {
  createComparisonSession, getActiveCliArgs, releaseComparisonSession, runInComparisonSession,
  setHasPendingLaunchDiffRequest,
} from '../electron/main/state';
import { SPECIAL_BASE_ID, SPECIAL_MINE_ID } from '../electron/main/constants';
import { createComparisonIpcHarness } from './helpers/comparisonIpcHarness';

const bridgePromise = createComparisonIpcHarness();

function configure(root: string): void {
  const paths = new Map<string, string>();
  configureRuntimePaths({ commandLine: { appendSwitch() {} }, setPath(name: string, value: string) { paths.set(name, value); },
    getPath(name: string) { return paths.get(name) ?? path.join(root, name); } } as unknown as Parameters<typeof configureRuntimePaths>[0], path.join(root, '.runtime'), null);
}

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

test('real IPC projects each ordered source and swaps preserved inputs after originals disappear', async (t) => {
  const bridge = await bridgePromise;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'versora-ipc-sources-'));
  configure(root);
  releaseComparisonSession();
  t.after(() => { releaseComparisonSession(); cleanupManagedTempFilesOnExitSync(); fs.rmSync(root, { recursive: true, force: true }); });
  const basePath = path.join(root, 'base.txt');
  const minePath = path.join(root, 'mine.txt');
  fs.writeFileSync(basePath, 'original base\n');
  fs.writeFileSync(minePath, 'original mine\n');
  const sourceArgs = { ...EMPTY_CLI_ARGS, basePath, minePath };
  const inputArgs = preserveExternalDiffTempInputsSync(sourceArgs);
  const sessionId = createComparisonSession(inputArgs, sourceArgs);
  setHasPendingLaunchDiffRequest(true);
  fs.unlinkSync(basePath);
  fs.unlinkSync(minePath);
  const initial = await bridge.getDiffData('strict', sessionId);
  assert.deepEqual([initial.basePath, initial.minePath, initial.baseContent, initial.mineContent], [basePath, minePath, 'original base\n', 'original mine\n']);
  fs.unlinkSync(inputArgs.minePath);
  fs.mkdirSync(inputArgs.minePath);
  await assert.rejects(bridge.swapTwoFileDiff(null, null, 'strict', sessionId));
  runInComparisonSession(sessionId, () => assert.deepEqual([getActiveCliArgs().basePath, getActiveCliArgs().minePath], [inputArgs.basePath, inputArgs.minePath]));
  fs.rmdirSync(inputArgs.minePath);
  fs.writeFileSync(inputArgs.minePath, 'original mine\n');
  const swapped = await bridge.swapTwoFileDiff(initial.baseRevisionInfo?.id ?? null, initial.mineRevisionInfo?.id ?? null, 'strict', sessionId);
  assert.deepEqual([swapped.basePath, swapped.minePath, swapped.baseContent, swapped.mineContent], [minePath, basePath, 'original mine\n', 'original base\n']);
  assert.deepEqual([swapped.baseName, swapped.mineName], ['mine.txt', 'base.txt']);
  assert.equal(swapped.comparisonSessionId, sessionId);
  runInComparisonSession(sessionId, () => assert.deepEqual([getActiveCliArgs().basePath, getActiveCliArgs().minePath], [inputArgs.minePath, inputArgs.basePath]));
  const restored = await bridge.swapTwoFileDiff(swapped.baseRevisionInfo?.id ?? null, swapped.mineRevisionInfo?.id ?? null, 'strict', sessionId);
  assert.deepEqual([restored.basePath, restored.minePath, restored.baseContent, restored.mineContent], [basePath, minePath, 'original base\n', 'original mine\n']);
  runInComparisonSession(sessionId, () => assert.deepEqual([getActiveCliArgs().basePath, getActiveCliArgs().minePath], [inputArgs.basePath, inputArgs.minePath]));

  const reloaded = await bridge.loadLocalFileDiff(restored.minePath!, restored.basePath!, 'strict', sessionId);
  assert.deepEqual([reloaded.basePath, reloaded.minePath, reloaded.baseContent, reloaded.mineContent], [minePath, basePath, 'original mine\n', 'original base\n']);
  await bridge.releaseSessionResources!(sessionId);
  assert.equal(fs.existsSync(inputArgs.basePath), false);
  assert.equal(fs.existsSync(inputArgs.minePath), false);
});

test('real IPC swaps selected versions across independent Git repositories and preserves histories, blame and rollback', async (t) => {
  const bridge = await bridgePromise;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'versora-ipc-git-'));
  configure(root);
  releaseComparisonSession();
  t.after(() => { releaseComparisonSession(); cleanupManagedTempFilesOnExitSync(); fs.rmSync(root, { recursive: true, force: true }); });
  const createRepository = (name: string) => {
    const repository = path.join(root, name);
    fs.mkdirSync(repository);
    const git = (...args: string[]) => run('git', ['-C', repository, ...args]);
    git('init', '-b', 'main'); git('config', 'user.name', name); git('config', 'user.email', `${name}@example.invalid`); git('config', 'core.autocrlf', 'false');
    const filePath = path.join(repository, 'sample.txt');
    fs.writeFileSync(filePath, `${name} committed\n`);
    git('add', 'sample.txt'); git('commit', '-m', name);
    const revision = git('rev-parse', 'HEAD');
    fs.writeFileSync(filePath, `${name} working\n`);
    return { filePath, revision };
  };
  const base = createRepository('left');
  const mine = createRepository('right');
  const initial = await bridge.loadLocalFileDiff(base.filePath, mine.filePath, 'strict');
  const id = initial.comparisonSessionId!;
  const selected = await bridge.loadTwoFileRevisionDiff(base.revision, mine.revision, 'strict', id);
  assert.deepEqual([selected.baseContent, selected.mineContent], ['left committed\n', 'right committed\n']);
  const swapped = await bridge.swapTwoFileDiff(base.revision, mine.revision, 'strict', id);
  assert.deepEqual([swapped.basePath, swapped.minePath, swapped.baseContent, swapped.mineContent], [mine.filePath, base.filePath, 'right committed\n', 'left committed\n']);
  assert.deepEqual([swapped.baseRevisionInfo?.id, swapped.mineRevisionInfo?.id], [mine.revision, base.revision]);
  const histories = await Promise.all([
    bridge.queryRevisionOptions({ targetSide: 'base', includeSpecials: true }, id),
    bridge.queryRevisionOptions({ targetSide: 'mine', includeSpecials: true }, id),
  ]);
  assert.deepEqual(histories.map(history => history.items.map(item => item.id)), [[SPECIAL_BASE_ID, mine.revision], [SPECIAL_MINE_ID, base.revision]]);
  const blame = await bridge.loadTwoFileVersionLineBlame(mine.revision, base.revision, id);
  assert.deepEqual([blame.base[0]?.author, blame.mine[0]?.author], ['right', 'left']);
  await assert.rejects(bridge.swapTwoFileDiff('invalid-revision', base.revision, 'strict', id));
  const afterFailure = await bridge.loadTwoFileRevisionDiff(mine.revision, base.revision, 'strict', id);
  assert.deepEqual([afterFailure.baseContent, afterFailure.mineContent], ['right committed\n', 'left committed\n']);
  runInComparisonSession(id, () => assert.deepEqual([getActiveCliArgs().basePath, getActiveCliArgs().minePath], [mine.filePath, base.filePath]));
  const restored = await bridge.swapTwoFileDiff(mine.revision, base.revision, 'strict', id);
  assert.deepEqual([restored.basePath, restored.minePath, restored.baseContent, restored.mineContent], [base.filePath, mine.filePath, 'left committed\n', 'right committed\n']);
  const working = await bridge.loadTwoFileRevisionDiff(SPECIAL_BASE_ID, SPECIAL_MINE_ID, 'strict', id);
  const swappedWorking = await bridge.swapTwoFileDiff(working.baseRevisionInfo?.id ?? null, working.mineRevisionInfo?.id ?? null, 'strict', id);
  assert.deepEqual([swappedWorking.baseRevisionInfo?.id, swappedWorking.mineRevisionInfo?.id, swappedWorking.baseContent, swappedWorking.mineContent], [SPECIAL_BASE_ID, SPECIAL_MINE_ID, 'right working\n', 'left working\n']);
  const tempRoot = getRuntimePathState().tempRootPath!;
  assert.equal(fs.readdirSync(tempRoot).some(name => name.startsWith('versora-two-file-')), false);

  const plainPath = path.join(root, 'plain.txt');
  fs.writeFileSync(plainPath, 'plain input\n');
  const mixed = await bridge.loadLocalFileDiff(base.filePath, plainPath, 'strict');
  const mixedId = mixed.comparisonSessionId!;
  await bridge.loadTwoFileRevisionDiff(base.revision, SPECIAL_MINE_ID, 'strict', mixedId);
  const swappedMixed = await bridge.swapTwoFileDiff(base.revision, SPECIAL_MINE_ID, 'strict', mixedId);
  assert.deepEqual([swappedMixed.basePath, swappedMixed.minePath, swappedMixed.baseContent, swappedMixed.mineContent], [plainPath, base.filePath, 'plain input\n', 'left committed\n']);
  assert.deepEqual(swappedMixed.revisionSwitchableSides, { base: false, mine: true });
  assert.deepEqual((await bridge.queryRevisionOptions({ targetSide: 'base' }, mixedId)).items, []);
  assert.deepEqual((await bridge.queryRevisionOptions({ targetSide: 'mine' }, mixedId)).items.map(item => item.id), [base.revision]);
});

const haveSvnTools = spawnSync('svn', ['--version', '--quiet'], { windowsHide: true }).status === 0
  && spawnSync('svnadmin', ['--version', '--quiet'], { windowsHide: true }).status === 0;

test('real IPC swaps independent SVN sources and selected revisions without resetting to latest', { skip: !haveSvnTools }, async (t) => {
  const bridge = await bridgePromise;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'versora-ipc-svn-'));
  configure(root);
  releaseComparisonSession();
  t.after(() => { releaseComparisonSession(); cleanupManagedTempFilesOnExitSync(); fs.rmSync(root, { recursive: true, force: true }); });
  const repository = path.join(root, 'repository');
  const imports = path.join(root, 'imports');
  const repositoryUrl = pathToFileURL(repository).href;
  run('svnadmin', ['create', repository]);
  fs.mkdirSync(imports);
  for (const name of ['left', 'right']) fs.writeFileSync(path.join(imports, `${name}.txt`), `${name} initial\n`);
  run('svn', ['import', imports, repositoryUrl, '-m', 'initial']);
  const working = path.join(root, 'working');
  run('svn', ['checkout', repositoryUrl, working]);
  const basePath = path.join(working, 'left.txt');
  const minePath = path.join(working, 'right.txt');
  fs.writeFileSync(basePath, 'left latest\n'); run('svn', ['commit', basePath, '-m', 'left latest']);
  fs.writeFileSync(minePath, 'right latest\n'); run('svn', ['commit', minePath, '-m', 'right latest']);
  fs.writeFileSync(basePath, 'left working\n'); fs.writeFileSync(minePath, 'right working\n');
  const initial = await bridge.loadLocalFileDiff(basePath, minePath, 'strict');
  const id = initial.comparisonSessionId!;
  const selected = await bridge.loadTwoFileRevisionDiff('r1', 'r3', 'strict', id);
  assert.deepEqual([selected.baseContent, selected.mineContent], ['left initial\n', 'right latest\n']);
  const swapped = await bridge.swapTwoFileDiff('r1', 'r3', 'strict', id);
  assert.deepEqual([swapped.basePath, swapped.minePath, swapped.baseContent, swapped.mineContent], [minePath, basePath, 'right latest\n', 'left initial\n']);
  assert.deepEqual([swapped.baseRevisionInfo?.id, swapped.mineRevisionInfo?.id], ['r3', 'r1']);
  const histories = await Promise.all([
    bridge.queryRevisionOptions({ targetSide: 'base' }, id), bridge.queryRevisionOptions({ targetSide: 'mine' }, id),
  ]);
  assert.deepEqual(histories.map(history => history.items.map(item => item.id)), [['r3', 'r1'], ['r2', 'r1']]);
  const blame = await bridge.loadLineBlame('r3', 'r1', id);
  assert.deepEqual([blame.base[0]?.revision, blame.mine[0]?.revision], ['r3', 'r1']);
  await assert.rejects(bridge.swapTwoFileDiff('r999', 'r1', 'strict', id));
  const restored = await bridge.swapTwoFileDiff('r3', 'r1', 'strict', id);
  assert.deepEqual([restored.basePath, restored.minePath, restored.baseContent, restored.mineContent], [basePath, minePath, 'left initial\n', 'right latest\n']);
  runInComparisonSession(id, () => assert.deepEqual(
    [getActiveCliArgs().baseUrl, getActiveCliArgs().mineUrl].map(decodeURI),
    [`${repositoryUrl}/left.txt`, `${repositoryUrl}/right.txt`].map(decodeURI),
  ));
});
