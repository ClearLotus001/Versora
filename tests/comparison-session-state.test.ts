import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EMPTY_CLI_ARGS } from '../electron/cliArgs';
import { preserveExternalDiffTempInputsSync } from '../electron/externalDiffRequest';
import { configureRuntimePaths, cleanupManagedTempFilesOnExitSync } from '../electron/runtimePaths';
import { buildDiffData } from '../electron/main/diffBuilder';
import {
  consumePendingLaunchDiffRequest,
  createComparisonSession,
  getActiveCliArgs,
  getCachedSvnTarget,
  getCachedTimelineTarget,
  getComparisonGitWorkingFileSession,
  getComparisonTwoFileVersionSession,
  getCurrentComparisonSessionId,
  getHasPendingLaunchDiffRequest,
  getPendingLaunchDiffRequestCount,
  getPendingLaunchDiffSessionId,
  releaseComparisonSession,
  runInComparisonSession,
  runInComparisonSessionTransaction,
  resolveComparisonInputPath,
  resolveComparisonSourcePath,
  setActiveCliArgs,
  setCachedSvnTarget,
  setCachedTimelineTarget,
  setComparisonGitWorkingFileSession,
  setComparisonTwoFileVersionSession,
  setHasPendingLaunchDiffRequest,
} from '../electron/main/state';
import type { GitWorkingFileSession } from '../electron/main/gitOperations';

test('external comparison requests remain in FIFO order while a previous file loads', async () => {
  releaseComparisonSession();
  const firstId = createComparisonSession({ ...EMPTY_CLI_ARGS, minePath: 'first.txt' });
  setHasPendingLaunchDiffRequest(true);

  let completeFirst!: () => void;
  const firstPending = new Promise<void>(resolve => { completeFirst = resolve; });
  const firstLoad = runInComparisonSession(firstId, async () => {
    await firstPending;
    assert.equal(getActiveCliArgs().minePath, 'first.txt');
    assert.equal(consumePendingLaunchDiffRequest(getCurrentComparisonSessionId()), true);
  });

  const secondId = createComparisonSession({ ...EMPTY_CLI_ARGS, minePath: 'second.txt' });
  setHasPendingLaunchDiffRequest(true);
  const thirdId = createComparisonSession({ ...EMPTY_CLI_ARGS, minePath: 'third.txt' });
  setHasPendingLaunchDiffRequest(true);

  assert.equal(getPendingLaunchDiffRequestCount(), 3);
  assert.equal(getPendingLaunchDiffSessionId(), firstId);
  completeFirst();
  await firstLoad;
  assert.equal(getPendingLaunchDiffSessionId(), secondId);
  assert.equal(consumePendingLaunchDiffRequest(secondId), true);
  assert.equal(getPendingLaunchDiffSessionId(), thirdId);
  assert.equal(consumePendingLaunchDiffRequest(thirdId), true);
  assert.equal(getHasPendingLaunchDiffRequest(), false);
  releaseComparisonSession();
});

test('interleaved async comparisons retain their file and revision-provider contexts', async () => {
  releaseComparisonSession();
  const firstId = createComparisonSession({ ...EMPTY_CLI_ARGS, minePath: 'first.txt' });
  const secondId = createComparisonSession({ ...EMPTY_CLI_ARGS, minePath: 'second.txt' });
  const firstGit = { workingFilePath: 'first.txt' } as GitWorkingFileSession;
  const secondGit = { workingFilePath: 'second.txt' } as GitWorkingFileSession;
  const firstTwoFiles = {
    base: { provider: 'local' as const, path: 'first-base.txt' },
    mine: { provider: 'local' as const, path: 'first.txt' },
  };
  const secondTwoFiles = {
    base: { provider: 'local' as const, path: 'second-base.txt' },
    mine: { provider: 'local' as const, path: 'second.txt' },
  };
  let continueFirst!: () => void;
  const firstBarrier = new Promise<void>(resolve => { continueFirst = resolve; });
  const firstOperation = runInComparisonSession(firstId, async () => {
    setCachedSvnTarget('svn://repo/first.txt');
    setCachedTimelineTarget('svn://history/first.txt');
    setComparisonGitWorkingFileSession(firstGit);
    setComparisonTwoFileVersionSession(firstTwoFiles);
    await firstBarrier;
    assert.equal(getCurrentComparisonSessionId(), firstId);
    assert.equal(getActiveCliArgs().minePath, 'first.txt');
    assert.equal(getCachedSvnTarget(), 'svn://repo/first.txt');
    assert.equal(getCachedTimelineTarget(), 'svn://history/first.txt');
    assert.equal(getComparisonGitWorkingFileSession(), firstGit);
    assert.equal(getComparisonTwoFileVersionSession(), firstTwoFiles);
  });
  await runInComparisonSession(secondId, async () => {
    setCachedSvnTarget('svn://repo/second.txt');
    setCachedTimelineTarget('svn://history/second.txt');
    setComparisonGitWorkingFileSession(secondGit);
    setComparisonTwoFileVersionSession(secondTwoFiles);
    await Promise.resolve();
    assert.equal(getActiveCliArgs().minePath, 'second.txt');
    assert.equal(getComparisonGitWorkingFileSession(), secondGit);
    assert.equal(getComparisonTwoFileVersionSession(), secondTwoFiles);
    continueFirst();
  });
  await firstOperation;
  releaseComparisonSession();
});

test('closing a comparison releases only its own context and queued request', () => {
  releaseComparisonSession();
  const firstId = createComparisonSession({ ...EMPTY_CLI_ARGS, minePath: 'first.txt' });
  setHasPendingLaunchDiffRequest(true);
  const secondId = createComparisonSession({ ...EMPTY_CLI_ARGS, minePath: 'second.txt' });
  setHasPendingLaunchDiffRequest(true);
  releaseComparisonSession(firstId);

  assert.equal(getPendingLaunchDiffRequestCount(), 1);
  assert.equal(getPendingLaunchDiffSessionId(), secondId);
  assert.throws(() => runInComparisonSession(firstId, () => {}), /unavailable/);
  runInComparisonSession(secondId, () => assert.equal(getActiveCliArgs().minePath, 'second.txt'));
  releaseComparisonSession();
});

test('source paths keep their input snapshots after ordered comparison paths change', () => {
  releaseComparisonSession();
  const sources = { basePath: path.resolve('original-base.txt'), minePath: path.resolve('original-mine.txt') };
  const inputs = { basePath: path.resolve('snapshot-base.txt'), minePath: path.resolve('snapshot-mine.txt') };
  createComparisonSession({ ...EMPTY_CLI_ARGS, ...inputs }, sources);
  try {
    setActiveCliArgs({ ...EMPTY_CLI_ARGS, basePath: inputs.minePath, minePath: inputs.basePath });
    assert.equal(resolveComparisonInputPath(sources.basePath), inputs.basePath);
    assert.equal(resolveComparisonInputPath(sources.minePath), inputs.minePath);
    assert.equal(resolveComparisonSourcePath(inputs.minePath), sources.minePath);
    assert.equal(resolveComparisonSourcePath(inputs.basePath), sources.basePath);
    const unknownPath = path.resolve('new-working-copy.txt');
    assert.equal(resolveComparisonInputPath(unknownPath), unknownPath);
    assert.equal(resolveComparisonSourcePath(unknownPath), unknownPath);
    assert.equal(resolveComparisonInputPath(''), '');
    assert.equal(resolveComparisonSourcePath(''), '');
  } finally {
    releaseComparisonSession();
  }
});

test('source mappings normalize file identity and allow unchanged or shared inputs', () => {
  releaseComparisonSession();
  const sourcePath = path.resolve('source.txt');
  const inputPath = path.resolve('snapshot.txt');
  createComparisonSession({ ...EMPTY_CLI_ARGS, basePath: inputPath, minePath: inputPath }, {
    basePath: sourcePath, minePath: sourcePath,
  });
  try {
    const relativeSource = path.relative(process.cwd(), sourcePath);
    assert.equal(resolveComparisonInputPath(relativeSource), inputPath);
    assert.equal(resolveComparisonSourcePath(path.relative(process.cwd(), inputPath)), sourcePath);
    if (process.platform === 'win32') {
      assert.equal(resolveComparisonInputPath(sourcePath.toUpperCase()), inputPath);
      assert.equal(resolveComparisonSourcePath(inputPath.toUpperCase()), sourcePath);
    }

    createComparisonSession({ ...EMPTY_CLI_ARGS, basePath: sourcePath, minePath: sourcePath }, {
      basePath: sourcePath, minePath: sourcePath,
    });
    setActiveCliArgs({ ...EMPTY_CLI_ARGS, basePath: inputPath, minePath: inputPath });
    assert.equal(resolveComparisonInputPath(sourcePath), sourcePath);
    assert.equal(resolveComparisonSourcePath(inputPath), inputPath);
  } finally {
    releaseComparisonSession();
  }
});

test('candidate source contexts commit atomically and failed or stale candidates cannot overwrite ready sources', async () => {
  releaseComparisonSession();
  const id = createComparisonSession({ ...EMPTY_CLI_ARGS, minePath: 'ready.txt' });
  try {
    await assert.rejects(runInComparisonSession(id, () => runInComparisonSessionTransaction(async () => {
      setActiveCliArgs({ ...EMPTY_CLI_ARGS, minePath: 'failed.txt' });
      throw new Error('Injected preparation failure');
    })), /Injected preparation failure/);
    runInComparisonSession(id, () => assert.equal(getActiveCliArgs().minePath, 'ready.txt'));

    let completeFirst!: () => void;
    const firstBarrier = new Promise<void>(resolve => { completeFirst = resolve; });
    const first = runInComparisonSession(id, () => runInComparisonSessionTransaction(async () => {
      setActiveCliArgs({ ...EMPTY_CLI_ARGS, minePath: 'stale.txt' });
      await firstBarrier;
    }));
    runInComparisonSession(id, () => assert.equal(getActiveCliArgs().minePath, 'ready.txt'));
    await runInComparisonSession(id, () => runInComparisonSessionTransaction(async () => {
      setActiveCliArgs({ ...EMPTY_CLI_ARGS, minePath: 'latest.txt' });
    }));
    completeFirst();
    await assert.rejects(first, error => error instanceof Error && error.name === 'AbortError');
    runInComparisonSession(id, () => assert.equal(getActiveCliArgs().minePath, 'latest.txt'));
  } finally {
    releaseComparisonSession();
  }
});

test('queued external comparisons retain their temporary inputs after SVN removes the originals', async (t) => {
  const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versora-queued-diff-'));
  const mockApp = {
    commandLine: { appendSwitch() {} },
    setPath() {},
    getPath: (name: string) => path.join(inputDir, name),
  } as unknown as Parameters<typeof configureRuntimePaths>[0];
  configureRuntimePaths(mockApp, path.join(inputDir, 'profile'), null);
  releaseComparisonSession();
  t.after(() => {
    releaseComparisonSession();
    cleanupManagedTempFilesOnExitSync();
    fs.rmSync(inputDir, { recursive: true, force: true });
  });

  const requests = ['first', 'second'].map(name => {
    const basePath = path.join(inputDir, `${name}-base.txt`);
    const minePath = path.join(inputDir, `${name}-mine.txt`);
    fs.writeFileSync(basePath, `${name} before\n`);
    fs.writeFileSync(minePath, `${name} after\n`);
    const originalArgs = { ...EMPTY_CLI_ARGS, basePath, minePath };
    const preservedArgs = preserveExternalDiffTempInputsSync(originalArgs);
    assert.notEqual(preservedArgs.basePath, basePath);
    assert.notEqual(preservedArgs.minePath, minePath);
    assert.equal(preservedArgs.fileName, `${name}-mine.txt`);
    const id = createComparisonSession(preservedArgs, originalArgs);
    setHasPendingLaunchDiffRequest(true);
    fs.unlinkSync(basePath);
    fs.unlinkSync(minePath);
    return { id, originalArgs, name };
  });

  for (const request of requests) {
    assert.equal(getPendingLaunchDiffSessionId(), request.id);
    await runInComparisonSession(request.id, async () => {
      const data = await buildDiffData();
      assert.equal(data.baseContent, `${request.name} before\n`);
      assert.equal(data.mineContent, `${request.name} after\n`);
      assert.ok(data.basePath);
      assert.ok(data.minePath);
      assert.equal(resolveComparisonSourcePath(data.basePath), request.originalArgs.basePath);
      assert.equal(resolveComparisonSourcePath(data.minePath), request.originalArgs.minePath);
      consumePendingLaunchDiffRequest(request.id);
    });
  }
});

test('closing one external comparison deletes only its snapshots and preserves other inputs', (t) => {
  const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versora-release-diff-'));
  const mockApp = {
    commandLine: { appendSwitch() {} },
    setPath() {},
    getPath: (name: string) => path.join(inputDir, name),
  } as unknown as Parameters<typeof configureRuntimePaths>[0];
  configureRuntimePaths(mockApp, path.join(inputDir, 'profile'), null);
  releaseComparisonSession();
  t.after(() => {
    releaseComparisonSession();
    cleanupManagedTempFilesOnExitSync();
    fs.rmSync(inputDir, { recursive: true, force: true });
  });
  const requests = ['first', 'second'].map(name => {
    const basePath = path.join(inputDir, `${name}-base.txt`);
    const minePath = path.join(inputDir, `${name}-mine.txt`);
    fs.writeFileSync(basePath, `${name} before\n`);
    fs.writeFileSync(minePath, `${name} after\n`);
    const originalArgs = { ...EMPTY_CLI_ARGS, basePath, minePath };
    const preservedArgs = preserveExternalDiffTempInputsSync(originalArgs);
    const id = createComparisonSession(preservedArgs, originalArgs);
    return { id, originalArgs, preservedArgs };
  });
  const [first, second] = requests;
  assert.ok(first && second);

  releaseComparisonSession(first.id);
  assert.equal(fs.existsSync(first.preservedArgs.basePath), false);
  assert.equal(fs.existsSync(first.preservedArgs.minePath), false);
  assert.equal(fs.existsSync(second.preservedArgs.basePath), true);
  assert.equal(fs.existsSync(second.preservedArgs.minePath), true);
  for (const request of requests) {
    assert.equal(fs.existsSync(request.originalArgs.basePath), true);
    assert.equal(fs.existsSync(request.originalArgs.minePath), true);
  }

  const sharedId = createComparisonSession(second.preservedArgs);
  releaseComparisonSession(second.id);
  assert.equal(fs.existsSync(second.preservedArgs.basePath), true);
  assert.equal(fs.existsSync(second.preservedArgs.minePath), true);
  releaseComparisonSession(sharedId);
  assert.equal(fs.existsSync(second.preservedArgs.basePath), false);
  assert.equal(fs.existsSync(second.preservedArgs.minePath), false);
  assert.equal(fs.existsSync(second.originalArgs.basePath), true);
  assert.equal(fs.existsSync(second.originalArgs.minePath), true);
});
