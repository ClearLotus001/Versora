import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EMPTY_CLI_ARGS } from '../electron/cliArgs';
import { clearAnalysisSnapshotCache } from '../electron/main/analysisSnapshotService';
import { buildLocalDiffData } from '../electron/main/diffBuilder';
import {
  filePayloadCache,
  revisionPayloadCache,
  setActiveCliArgs,
} from '../electron/main/state';

test('local text diff projects main-side prepared analysis while preserving raw text payloads', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'svn-diff-text-snapshot-'));
  const basePath = path.join(tempDir, 'base.ts');
  const minePath = path.join(tempDir, 'mine.ts');

  try {
    await fs.writeFile(basePath, ['const value = 1;', 'console.log(value);'].join('\n'), 'utf-8');
    await fs.writeFile(minePath, ['const value = 2;', 'console.log(value);'].join('\n'), 'utf-8');

    const data = await buildLocalDiffData(basePath, minePath, 'strict');
    const prepared = data.analysisSnapshotsByMode?.strict?.textAnalysis ?? null;

    assert.ok(prepared);
    assert.ok((prepared?.diffLines.length ?? 0) > 0);
    assert.ok((prepared?.replacementPairs.length ?? 0) > 0);
    assert.ok((prepared?.splitRowDescriptors.length ?? 0) > 0);
    assert.equal(data.basePath, basePath);
    assert.equal(data.minePath, minePath);
    assert.equal(data.analysisSnapshotsByMode?.strict?.textAnalysis?.diffLines, prepared?.diffLines ?? null);
    assert.equal(typeof data.baseContent, 'string');
    assert.equal(typeof data.mineContent, 'string');
  } finally {
    filePayloadCache.clear();
    revisionPayloadCache.clear();

    clearAnalysisSnapshotCache();
    setActiveCliArgs(EMPTY_CLI_ARGS);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
