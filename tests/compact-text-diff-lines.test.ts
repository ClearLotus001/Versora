import test from 'node:test';
import assert from 'node:assert/strict';

import { compactTextDiffLines } from '../electron/main/compactTextDiffLines';
import {
  getTransportTextDiffLineCount,
  materializeCompactTextDiffLines,
  materializeCompactTransportDiffData,
} from '../src/utils/diff/compactTextDiffLines';
import type { DiffData, DiffLine } from '../src/types';

const DIFF_LINES: DiffLine[] = [
  {
    type: 'equal',
    base: 'same',
    mine: 'same',
    baseLineNo: 1,
    mineLineNo: 1,
    baseCharSpans: null,
    mineCharSpans: null,
  },
  {
    type: 'equal',
    base: 'normalized base',
    mine: 'normalized mine',
    baseLineNo: 2,
    mineLineNo: 2,
    baseCharSpans: null,
    mineCharSpans: null,
  },
  {
    type: 'delete',
    base: 'old value',
    mine: null,
    baseLineNo: 3,
    mineLineNo: null,
    baseCharSpans: [
      { text: 'old', highlight: true },
      { text: ' value', highlight: false },
    ],
    mineCharSpans: null,
  },
  {
    type: 'add',
    base: null,
    mine: 'new value',
    baseLineNo: null,
    mineLineNo: 3,
    baseCharSpans: null,
    mineCharSpans: [
      { text: 'new', highlight: true },
      { text: ' value', highlight: false },
    ],
  },
];

function createCompactOnlyData(diffLines: DiffLine[]): DiffData {
  const compactDiffLines = compactTextDiffLines(diffLines);
  assert.ok(compactDiffLines);
  return {
    baseName: 'base.ts',
    mineName: 'mine.ts',
    svnUrl: '',
    fileName: 'demo.ts',
    baseContent: null,
    mineContent: null,
    analysisSnapshotsByMode: {
      strict: {
        compareMode: 'strict',
        textAnalysis: {
          diffLines: [],
          compactDiffLines: structuredClone(compactDiffLines),
          stats: { add: 1, del: 1, chg: 1 },
          replacementPairs: [{ lineIdx: 2, pairedLineIdx: 3 }],
          splitRowDescriptors: [],
          perf: { diffMs: 1 },
        },
      },
    },
  };
}

test('compact text diff columns survive structured clone and materialize losslessly', () => {
  const compact = compactTextDiffLines(DIFF_LINES);
  assert.ok(compact);

  const transported = structuredClone(compact);
  assert.ok(transported.types instanceof Uint8Array);
  assert.ok(transported.baseLineNumbers instanceof Int32Array);
  assert.deepEqual(materializeCompactTextDiffLines(transported), DIFF_LINES);
});

test('compact transport data is recognized before loader hydration and materialized once', () => {
  const data = createCompactOnlyData(DIFF_LINES);
  const analysis = data.analysisSnapshotsByMode?.strict?.textAnalysis;

  assert.equal(getTransportTextDiffLineCount(analysis), DIFF_LINES.length);

  const first = materializeCompactTransportDiffData(data);
  const second = materializeCompactTransportDiffData(data);
  assert.equal(first, second);
  assert.notEqual(first, data);
  assert.deepEqual(first.analysisSnapshotsByMode?.strict?.textAnalysis?.diffLines, DIFF_LINES);
  assert.equal(first.analysisSnapshotsByMode?.strict?.textAnalysis?.compactDiffLines, undefined);
  assert.deepEqual(first.analysisSnapshotsByMode?.strict?.textAnalysis?.stats, { add: 1, del: 1, chg: 1 });
});

test('compact text transport declines lines carrying blame extensions', () => {
  const lines: DiffLine[] = [{
    ...DIFF_LINES[0]!,
    baseBlame: {
      revision: '42',
      author: 'Ada',
      date: '2026-08-21',
      uncommitted: false,
    },
  }];

  assert.equal(compactTextDiffLines(lines), null);
});
