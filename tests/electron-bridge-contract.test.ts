import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

test('Electron exposes one renderer bridge and one launch-data path', () => {
  const preloadSource = readRepoFile('electron/preload.ts');
  const ipcSource = readRepoFile('electron/main/ipcHandlers.ts');
  const bridgeTypeSource = readRepoFile('src/types/bridge.ts');
  const lifecycleSource = readRepoFile('src/hooks/app/useElectronLifecycleEffects.ts');
  const appContentSource = readRepoFile('src/components/app-shell/AppContent.tsx');
  const exposedGlobals = [...preloadSource.matchAll(/exposeInMainWorld\('([^']+)'/g)]
    .map((match) => match[1]);
  const legacyBridgeName = ['svn', 'Diff'].join('');
  const legacyLaunchMethod = ['get', 'LaunchState'].join('');
  const legacyLaunchChannel = ['get', 'launch', 'state'].join('-');

  assert.deepEqual(exposedGlobals, ['versora']);
  assert.equal(preloadSource.includes(legacyBridgeName), false);

  for (const source of [preloadSource, bridgeTypeSource, lifecycleSource]) {
    assert.equal(source.includes(legacyLaunchMethod), false);
  }
  assert.equal(ipcSource.includes(legacyLaunchChannel), false);
  assert.match(preloadSource, /releaseSessionResources: \(comparisonSessionId\?: string\) => ipcRenderer\.invoke\('release-session-resources', \{ comparisonSessionId \}\)/);
  assert.match(bridgeTypeSource, /releaseSessionResources\?\(comparisonSessionId\?: string\): Promise<void>/);
  assert.match(ipcSource, /safeHandle\('release-session-resources'/);

  const noDiffRequestGuard = lifecycleSource.indexOf('if (!launchContext.hasDiffRequest)');
  assert.ok(noDiffRequestGuard >= 0);
  assert.ok(noDiffRequestGuard < lifecycleSource.indexOf('await reloadCliDiffData()'));
  assert.equal(lifecycleSource.includes('bridge.getDiffData('), false);
  assert.equal(lifecycleSource.includes('++loadSeqRef.current'), false);

  const bootstrapBranch = appContentSource.slice(
    appContentSource.indexOf("if (!hasLoadedDiff && loadPhase === 'bootstrapping')"),
    appContentSource.indexOf("if (!hasLoadedDiff && loadPhase === 'loading')"),
  );
  assert.ok(bootstrapBranch.includes('renderBootstrappingState()'));
  assert.equal(bootstrapBranch.includes('renderLoadingState'), false);
  assert.equal(bootstrapBranch.includes('onInitialVisualReady'), false);
  assert.ok(appContentSource.includes('waitForNextPaint().then('));
});
