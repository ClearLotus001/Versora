import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDiffCacheKey, buildDiffSessionKey } from '../src/utils/diff/diffCacheKey';
import type { DiffData } from '../src/types';

function createDiffData(overrides: Partial<DiffData> = {}): DiffData {
  return {
    baseName: 'Working Base',
    mineName: 'Local',
    svnUrl: '',
    fileName: '[1]新物品表.xlsm',
    baseContent: null,
    mineContent: null,
    baseWorkbookMetadata: null,
    mineWorkbookMetadata: null,
    revisionOptions: null,
    baseRevisionInfo: null,
    mineRevisionInfo: null,
    canSwitchRevisions: false,
    workbookArtifactDiff: null,
    sourceNoticeCode: null,
    perf: null,
    ...overrides,
  };
}

test('buildDiffCacheKey differentiates same file opened from different svn sources', () => {
  const localKey = buildDiffCacheKey(createDiffData({
    sourceIdentity: 'cli::local-temp-a::local-temp-b',
  }), 'strict');
  const previousKey = buildDiffCacheKey(createDiffData({
    sourceIdentity: 'cli::prev-temp-a::prev-temp-b',
  }), 'strict');

  assert.notEqual(localKey, previousKey);
});

test('buildDiffCacheKey still separates compare modes for the same source', () => {
  const data = createDiffData({
    sourceIdentity: 'cli::same-source',
  });

  assert.notEqual(buildDiffCacheKey(data, 'strict'), buildDiffCacheKey(data, 'content'));
});

test('buildDiffSessionKey stays stable across compare modes while changing with the source', () => {
  const first = createDiffData({ sourceIdentity: 'cli::first-source' });
  const second = createDiffData({ sourceIdentity: 'cli::second-source' });

  assert.equal(buildDiffSessionKey(first), 'cli::first-source');
  assert.notEqual(buildDiffSessionKey(first), buildDiffSessionKey(second));
});

test('buildDiffCacheKey separates swapped side order for the same source identity', () => {
  const data = createDiffData({
    sourceIdentity: 'cli::same-source',
  });
  const swapped = createDiffData({
    sourceIdentity: 'cli::same-source',
    isSideOrderSwapped: true,
  });

  assert.notEqual(buildDiffCacheKey(data, 'strict'), buildDiffCacheKey(swapped, 'strict'));
});
