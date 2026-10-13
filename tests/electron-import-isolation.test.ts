import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function getElectronPathFile() {
  return path.join(process.cwd(), 'node_modules', 'electron', 'path.txt');
}

function hideElectronPathFile(): () => void {
  const electronPathFile = getElectronPathFile();
  const backupPath = `${electronPathFile}.import-isolation-bak`;
  if (fs.existsSync(backupPath)) {
    fs.rmSync(backupPath, { force: true });
  }

  if (!fs.existsSync(electronPathFile)) {
    return () => {};
  }

  fs.renameSync(electronPathFile, backupPath);
  return () => {
    if (fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, electronPathFile);
    }
  };
}

test('main-process pure logic imports do not require the Electron binary artifact', async () => {
  const restoreElectronPathFile = hideElectronPathFile();

  try {
    const [
      i18n,
      maintenance,
      analysisSnapshotService,
      diffBuilder,
      svnOperations,
      svnHelpers,
    ] = await Promise.all([
      import('../electron/i18n'),
      import('../electron/maintenance'),
      import('../electron/main/analysisSnapshotService'),
      import('../electron/main/diffBuilder'),
      import('../electron/main/svnOperations'),
      import('../electron/main/svnHelpers'),
    ]);

    assert.equal(typeof i18n.electronT, 'function');
    assert.equal(typeof maintenance.getMaintenanceModeFromArgv, 'function');
    assert.equal(typeof analysisSnapshotService.resolveAnalysisSnapshot, 'function');
    assert.equal(typeof diffBuilder.buildLocalDiffData, 'function');
    assert.equal(typeof svnOperations.queryRevisionOptionsForTarget, 'function');
    assert.equal(typeof svnHelpers.shouldResolveSvnRuntimeContext, 'function');
  } finally {
    restoreElectronPathFile();
  }
});
