import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAnalysisSnapshotCacheKey,
  clearAnalysisSnapshotCache,
  estimateAnalysisSnapshotMemoryBytes,
  resolveAnalysisSnapshot,
} from '../electron/main/analysisSnapshotService';
import type { FilePayload } from '../electron/main/types';

function createTextPayload(content: string): FilePayload {
  return {
    content,
    perf: {
      readMs: 0,
      byteLength: Buffer.byteLength(content, 'utf-8'),
    },
  };
}

test('buildAnalysisSnapshotCacheKey differentiates compare modes and revision pairs', () => {
  const strictKey = buildAnalysisSnapshotCacheKey({
    sourceIdentity: 'cli::same-source',
    baseRevisionId: 'r10',
    mineRevisionId: 'r11',
    compareMode: 'strict',
  });
  const contentKey = buildAnalysisSnapshotCacheKey({
    sourceIdentity: 'cli::same-source',
    baseRevisionId: 'r10',
    mineRevisionId: 'r11',
    compareMode: 'content',
  });
  const otherRevisionKey = buildAnalysisSnapshotCacheKey({
    sourceIdentity: 'cli::same-source',
    baseRevisionId: 'r10',
    mineRevisionId: 'r12',
    compareMode: 'strict',
  });

  assert.notEqual(strictKey, contentKey);
  assert.notEqual(strictKey, otherRevisionKey);
});

test('resolveAnalysisSnapshot reuses cached text analysis for identical keys', async () => {
  clearAnalysisSnapshotCache();
  const basePayload = createTextPayload(['header', 'alpha', 'tail'].join('\n'));
  const minePayload = createTextPayload(['header', 'alpha updated', 'tail'].join('\n'));

  const first = await resolveAnalysisSnapshot({
    sourceIdentity: 'cli::text-source',
    compareMode: 'strict',
    basePayload,
    minePayload,
  });
  const second = await resolveAnalysisSnapshot({
    sourceIdentity: 'cli::text-source',
    compareMode: 'strict',
    basePayload: createTextPayload(basePayload.content ?? ''),
    minePayload: createTextPayload(minePayload.content ?? ''),
  });

  assert.equal(first, second);
  assert.ok((first.textAnalysis?.diffLines.length ?? 0) > 0);
  assert.ok((first.textAnalysis?.splitRowDescriptors.length ?? 0) > 0);
  assert.ok((first.textAnalysis?.replacementPairs.length ?? 0) > 0);
});

test('estimateAnalysisSnapshotMemoryBytes scales with prepared analysis payload size', async () => {
  clearAnalysisSnapshotCache();
  const small = await resolveAnalysisSnapshot({
    sourceIdentity: 'cli::estimate-small',
    compareMode: 'strict',
    basePayload: createTextPayload('before'),
    minePayload: createTextPayload('after'),
  });
  const largeBase = Array.from({ length: 4_000 }, (_, index) => `line-${index}`).join('\n');
  const largeMine = `${largeBase}\nadded-tail`;
  const large = await resolveAnalysisSnapshot({
    sourceIdentity: 'cli::estimate-large',
    compareMode: 'strict',
    basePayload: createTextPayload(largeBase),
    minePayload: createTextPayload(largeMine),
  });

  assert.ok(estimateAnalysisSnapshotMemoryBytes(small) > 0);
  assert.ok(estimateAnalysisSnapshotMemoryBytes(large) > estimateAnalysisSnapshotMemoryBytes(small));
});
