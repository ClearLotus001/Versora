import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWorkbookMetadataPayload, getPreparedDiffLinesForMode } from '../src/hooks/app/helpers';
import { buildE2EWorkbookDiffData } from '../src/utils/app/e2eBridge';
import type { WorkbookMetadataPayload } from '../src/types';

const content = '@@sheet\tSheet\n@@row\t1\tValue';

test('metadata follow-up updates the artifact session without introducing a workbook DTO snapshot', () => {
  const original = buildE2EWorkbookDiffData({ baseContent: content, mineContent: content });
  const payload: WorkbookMetadataPayload = {
    base: { sheets: { Sheet: { name: 'Sheet', hiddenColumns: [1], mergeRanges: [] } } },
    mine: { sheets: { Sheet: { name: 'Sheet', hiddenColumns: [], mergeRanges: [] } } },
    perf: { metadataMs: 4 },
  };
  const merged = mergeWorkbookMetadataPayload(original, payload);
  assert.equal(merged.workbookArtifact, original.workbookArtifact);
  assert.equal(merged.baseWorkbookMetadata, payload.base);
  assert.equal(merged.mineWorkbookMetadata, payload.mine);
  assert.equal(merged.perf?.metadataMs, 4);
  assert.equal(merged.analysisSnapshotsByMode, null);
  assert.equal(getPreparedDiffLinesForMode(merged, 'strict'), null);
});

test('metadata follow-up preserves source metadata and performance when the optional timing is absent', () => {
  const original = buildE2EWorkbookDiffData({ baseContent: content, mineContent: content });
  const merged = mergeWorkbookMetadataPayload(original, { base: null, mine: null });
  assert.equal(merged.baseWorkbookMetadata, null);
  assert.equal(merged.mineWorkbookMetadata, null);
  assert.equal(merged.perf, original.perf);
  assert.equal(merged.workbookArtifact, original.workbookArtifact);
});
