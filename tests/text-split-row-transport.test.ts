import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compactTextSplitRowDescriptors,
  materializeCompactTextSplitRowDescriptors,
} from '../shared/textSplitRowTransport';
import { prepareTextDiffAnalysis } from '../electron/main/text/diff';
import { projectTransportDiffData } from '../electron/main/transportProjection';
import { materializeCompactTransportDiffData } from '../src/utils/diff/compactTextDiffLines';
import type { DiffData } from '../electron/main/types';

test('compact split rows preserve pairing order, unmatched rows and optional flags through clone', () => {
  const descriptors = [
    { leftLineIdx: 0, rightLineIdx: 0, lineIdx: 0, lineIdxs: [0] },
    { leftLineIdx: null, rightLineIdx: 4, lineIdx: 4, lineIdxs: [4] },
    { leftLineIdx: 1, rightLineIdx: 5, lineIdx: 1, lineIdxs: [1, 5], isReplacementPair: true },
    { leftLineIdx: 2, rightLineIdx: null, lineIdx: 2, lineIdxs: [2] },
    { leftLineIdx: 3, rightLineIdx: 6, lineIdx: 3, lineIdxs: [3, 6], isReplacementPair: false },
  ];
  const compact = compactTextSplitRowDescriptors(descriptors, 7);
  assert.ok(compact);
  assert.deepEqual(materializeCompactTextSplitRowDescriptors(structuredClone(compact), 7), descriptors);
  assert.equal(compact.leftLineIndexes.byteLength + compact.rightLineIndexes.byteLength + compact.replacementFlags.byteLength, descriptors.length * 9);
});

test('compact split rows decline noncanonical descriptors and reject malformed transport', () => {
  assert.equal(compactTextSplitRowDescriptors([], 1), null);
  for (const descriptor of [
    { leftLineIdx: 0, rightLineIdx: 1, lineIdx: 1, lineIdxs: [1, 0] },
    { leftLineIdx: 0, rightLineIdx: 1, lineIdx: 0, lineIdxs: [0] },
    { leftLineIdx: -2, rightLineIdx: null, lineIdx: -2, lineIdxs: [-2] },
    { leftLineIdx: null, rightLineIdx: null, lineIdx: 0, lineIdxs: [] },
    { leftLineIdx: 2, rightLineIdx: null, lineIdx: 2, lineIdxs: [2] },
  ]) assert.equal(compactTextSplitRowDescriptors([descriptor], 2), null);

  const compact = compactTextSplitRowDescriptors([
    { leftLineIdx: 0, rightLineIdx: 0, lineIdx: 0, lineIdxs: [0] },
  ], 1)!;
  assert.throws(() => materializeCompactTextSplitRowDescriptors({ ...compact, version: 2 as 1 }, 1), /column lengths/);
  assert.throws(() => materializeCompactTextSplitRowDescriptors({ ...compact, rightLineIndexes: new Int32Array() }, 1), /column lengths/);
  assert.throws(() => materializeCompactTextSplitRowDescriptors({ ...compact, replacementFlags: new Uint8Array([3]) }, 1), /row value/);
  assert.throws(() => materializeCompactTextSplitRowDescriptors(compact, 0), /row value/);
});

function createData(baseContent: string, mineContent: string): DiffData {
  return {
    svnUrl: '', fileName: 'large.ts', sourceIdentity: 'test::large.ts',
    compareContext: 'literal_two_file_compare', timelineTargetUrl: null,
    workingCopyAvailable: false, initialPair: null, resetPair: null,
    launchBaseName: 'base.ts', launchMineName: 'mine.ts', baseName: 'base.ts', mineName: 'mine.ts',
    baseContent, mineContent,
    analysisSnapshotsByMode: {
      strict: { compareMode: 'strict', textAnalysis: prepareTextDiffAnalysis(baseContent, mineContent) },
    },
    baseWorkbookMetadata: null, mineWorkbookMetadata: null, revisionOptions: null,
    baseRevisionInfo: null, mineRevisionInfo: null, canSwitchRevisions: false,
    workbookArtifactDiff: null, sourceNoticeCode: null, perf: { source: 'cli' },
  };
}

test('large text transport reuses complete prepared analysis without realigning changes', () => {
  const baseLines = Array.from({ length: 4_500 }, (_, index) => `const value_${index} = 'original-${index}';`);
  const mineLines = baseLines.map((line, index) => index % 5 === 0 ? line.replace('original', 'updated') : line);
  mineLines.splice(30, 0, 'inserted line');
  baseLines.splice(52, 0, 'deleted line');
  const data = createData(baseLines.join('\n'), mineLines.join('\n'));
  const expected = data.analysisSnapshotsByMode!.strict!.textAnalysis!;
  const projected = projectTransportDiffData(data);
  const transported = projected.analysisSnapshotsByMode!.strict!.textAnalysis!;
  assert.equal(transported.diffLines.length, 0);
  assert.equal(transported.splitRowDescriptors.length, 0);
  assert.ok(transported.compactSplitRowDescriptors);
  assert.equal(data.analysisSnapshotsByMode!.strict!.textAnalysis, expected);

  const cloned = structuredClone(projected);
  const hydrated = materializeCompactTransportDiffData(cloned);
  assert.deepEqual(hydrated.analysisSnapshotsByMode!.strict!.textAnalysis, expected);
  assert.equal(materializeCompactTransportDiffData(cloned), hydrated);
});

test('long-line transport restores descriptors when diff lines stay on the object path', () => {
  const data = createData(`old ${'a'.repeat(2_100)}`, `new ${'b'.repeat(2_100)}`);
  const projected = projectTransportDiffData(data);
  assert.equal(projected.analysisSnapshotsByMode!.strict!.textAnalysis!.compactDiffLines, undefined);
  assert.ok(projected.analysisSnapshotsByMode!.strict!.textAnalysis!.compactSplitRowDescriptors);
  const hydrated = materializeCompactTransportDiffData(structuredClone(projected));
  assert.deepEqual(hydrated.analysisSnapshotsByMode!.strict!.textAnalysis, data.analysisSnapshotsByMode!.strict!.textAnalysis);
});
