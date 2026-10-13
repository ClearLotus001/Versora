import test from 'node:test';
import assert from 'node:assert/strict';

import { compactTextDiffLines } from '../electron/main/compactTextDiffLines';
import { compactTextSplitRowDescriptors } from '../shared/textSplitRowTransport';
import { computeDiff } from '../src/engine/text/diff';
import { materializeCompactTransportDiffData } from '../src/utils/diff/compactTextDiffLines';
import { filterTextDiffAnalysis } from '../src/utils/diff/diffTypeFilter';
import { attachLineBlameToDiffLines } from '../src/utils/diff/lineBlame';
import {
  materializeSplitRowsFromDescriptors,
  prepareTextDiffAnalysisFromDiffLines,
  resolvePreparedTextAnalysisForDiffLines,
} from '../src/utils/diff/preparedTextAnalysis';
import type { DiffData, DiffLine } from '../src/types';

test('large compact prepared analysis retains background attribution without repeating alignment', () => {
  const baseLines = Array.from({ length: 8100 }, (_, index) => `const value_${index} = 1;`);
  const mineLines = [...baseLines];
  mineLines[8099] = 'const value_8099 = 2;';
  const sourceLines = computeDiff(baseLines.join('\n'), mineLines.join('\n'));
  const sourceAnalysis = prepareTextDiffAnalysisFromDiffLines(sourceLines);
  const compactDiffLines = compactTextDiffLines(sourceLines);
  const compactSplitRowDescriptors = compactTextSplitRowDescriptors(sourceAnalysis.splitRowDescriptors, sourceLines.length);
  assert.ok(compactDiffLines);
  assert.ok(compactSplitRowDescriptors);
  const transportData: DiffData = {
    fileName: 'large-attribution.txt',
    baseName: 'base.txt',
    mineName: 'mine.txt',
    svnUrl: '',
    baseContent: null,
    mineContent: null,
    analysisSnapshotsByMode: {
      strict: {
        compareMode: 'strict',
        textAnalysis: {
          ...sourceAnalysis,
          diffLines: [],
          compactDiffLines,
          splitRowDescriptors: [],
          compactSplitRowDescriptors,
        },
      },
    },
  };
  const hydrated = materializeCompactTransportDiffData(structuredClone(transportData));
  const transportedAnalysis = hydrated.analysisSnapshotsByMode!.strict!.textAnalysis!;
  assert.equal(resolvePreparedTextAnalysisForDiffLines(transportedAnalysis, transportedAnalysis.diffLines), transportedAnalysis);
  const attributedLines = attachLineBlameToDiffLines(transportedAnalysis.diffLines, {
    base: [{ lineNo: 8100, revision: 'r41', author: 'alice', date: '2026-10-13', uncommitted: false }],
    mine: [{ lineNo: 8100, revision: 'r42', author: 'bob', date: '2026-10-13', uncommitted: false }],
  });
  const rebound = resolvePreparedTextAnalysisForDiffLines(transportedAnalysis, attributedLines);

  assert.equal(rebound.diffLines, attributedLines);
  assert.equal(rebound.stats, transportedAnalysis.stats);
  assert.equal(rebound.replacementPairs, transportedAnalysis.replacementPairs);
  assert.equal(rebound.splitRowDescriptors, transportedAnalysis.splitRowDescriptors);
  assert.equal(resolvePreparedTextAnalysisForDiffLines(transportedAnalysis, attributedLines), rebound);
  const filtered = filterTextDiffAnalysis(rebound, 'modify');
  const splitRows = materializeSplitRowsFromDescriptors(filtered.diffLines, filtered.splitRowDescriptors);
  assert.equal(splitRows.length, 1);
  assert.equal(splitRows[0]?.left?.baseBlame?.author, 'alice');
  assert.equal(splitRows[0]?.right?.mineBlame?.author, 'bob');
  assert.equal(splitRows[0]?.left?.base, 'const value_8099 = 1;');
  assert.equal(splitRows[0]?.right?.mine, 'const value_8099 = 2;');
});

test('prepared analysis rebuilds for changed content, ordering, line types or numbering', () => {
  const lines = computeDiff('same\nconst value = 1;', 'same\nconst value = 2;');
  const prepared = prepareTextDiffAnalysisFromDiffLines(lines);
  const variants: DiffLine[][] = [
    lines.map((line, index) => index === 1 ? { ...line, base: 'entirely different content' } : line),
    [lines[2]!, lines[1]!, lines[0]!],
    lines.map((line, index) => index === 0 ? { ...line, type: 'add', base: null, baseLineNo: null } : line),
    lines.map((line, index) => index === 0 ? { ...line, baseLineNo: 99 } : line),
    lines.slice(1),
    [],
  ];

  for (const changed of variants) {
    const resolved = resolvePreparedTextAnalysisForDiffLines(prepared, changed);
    assert.equal(resolved, prepareTextDiffAnalysisFromDiffLines(changed));
    assert.equal(resolved.diffLines, changed);
    assert.notEqual(resolved.splitRowDescriptors, prepared.splitRowDescriptors);
  }
});

test('legacy incomplete prepared analysis still rebuilds split descriptors', () => {
  const lines = computeDiff('same\nbefore', 'same\nafter');
  const complete = prepareTextDiffAnalysisFromDiffLines(lines);
  const resolved = resolvePreparedTextAnalysisForDiffLines({ ...complete, splitRowDescriptors: [] }, lines);

  assert.equal(resolved, complete);
  assert.ok(resolved.splitRowDescriptors.length > 0);
});
