import test from 'node:test';
import assert from 'node:assert/strict';

import type { DiffData, DiffLine, PreparedTextAnalysis } from '../src/types';
import {
  filterTextDiffAnalysis,
  getTextDiffTypeAvailability,
} from '../src/utils/diff/diffTypeFilter';
import { prepareTextDiffAnalysisFromDiffLines } from '../src/utils/diff/preparedTextAnalysis';
import { swapDiffDataSides, swapDiffLinesSides } from '../src/utils/diff/swapDiffSides';

const line = (
  type: DiffLine['type'],
  base: string | null,
  mine: string | null,
  baseLineNo: number | null,
  mineLineNo: number | null,
): DiffLine => ({
  type,
  base,
  mine,
  baseLineNo,
  mineLineNo,
  baseCharSpans: null,
  mineCharSpans: null,
});

test('text change filters distinguish replacements from independent additions and deletions', () => {
  const diffLines = [
    line('equal', 'same', 'same', 1, 1),
    line('delete', 'status: before', null, 2, null),
    line('add', null, 'status: after', null, 2),
    line('delete', 'removed', null, 3, null),
    line('add', null, 'added', null, 3),
  ];
  const analysis = {
    diffLines,
    stats: { add: 1, del: 1, chg: 1 },
    replacementPairs: [
      { lineIdx: 1, pairedLineIdx: 2 },
      { lineIdx: 2, pairedLineIdx: 1 },
    ],
    splitRowDescriptors: [
      { leftLineIdx: 0, rightLineIdx: 0, lineIdx: 0, lineIdxs: [0] },
      { leftLineIdx: 1, rightLineIdx: 2, lineIdx: 1, lineIdxs: [1, 2], isReplacementPair: true },
      { leftLineIdx: 3, rightLineIdx: null, lineIdx: 3, lineIdxs: [3] },
      { leftLineIdx: null, rightLineIdx: 4, lineIdx: 4, lineIdxs: [4] },
    ],
    perf: null,
  } satisfies PreparedTextAnalysis;

  const modified = filterTextDiffAnalysis(analysis, 'modify');
  const deleted = filterTextDiffAnalysis(analysis, 'delete');
  const added = filterTextDiffAnalysis(analysis, 'add');

  assert.deepEqual(
    modified.diffLines.map((entry) => entry.base ?? entry.mine),
    ['status: before', 'status: after'],
  );
  assert.deepEqual(
    deleted.diffLines.map((entry) => entry.base),
    ['removed'],
  );
  assert.deepEqual(
    added.diffLines.map((entry) => entry.mine),
    ['added'],
  );
  assert.deepEqual(modified.stats, { add: 0, del: 0, chg: 1 });
  assert.deepEqual(deleted.stats, { add: 0, del: 1, chg: 0 });
  assert.deepEqual(added.stats, { add: 1, del: 0, chg: 0 });
  assert.deepEqual(modified.replacementPairs, [
    { lineIdx: 0, pairedLineIdx: 1 },
    { lineIdx: 1, pairedLineIdx: 0 },
  ]);
  assert.equal(modified.splitRowDescriptors[0]?.isReplacementPair, true);
  assert.equal(filterTextDiffAnalysis(analysis, 'modify'), modified);
  assert.equal(filterTextDiffAnalysis(analysis, 'all'), analysis);
  assert.deepEqual(getTextDiffTypeAvailability(analysis), {
    add: true,
    modify: true,
    delete: true,
  });
  assert.deepEqual(getTextDiffTypeAvailability(modified), {
    add: false,
    modify: true,
    delete: false,
  });
});

test('side swapping preserves canonical replacement blocks and is reversible', () => {
  const diffLines = [
    line('equal', 'same', 'same', 1, 1),
    line('delete', 'status: before', null, 2, null),
    line('add', null, 'status: after', null, 2),
  ];
  const swappedLines = swapDiffLinesSides(diffLines);
  assert.deepEqual(swappedLines.map((entry) => entry.type), ['equal', 'delete', 'add']);
  assert.equal(swappedLines[1]?.base, 'status: after');
  assert.equal(swappedLines[2]?.mine, 'status: before');
  assert.equal(prepareTextDiffAnalysisFromDiffLines(swappedLines).stats.chg, 1);

  const data: DiffData = {
    svnUrl: '',
    fileName: 'sample.txt',
    baseName: 'left.txt',
    mineName: 'right.txt',
    basePath: 'C:\\left.txt',
    minePath: 'C:\\right.txt',
    launchBaseName: 'Left',
    launchMineName: 'Right',
    baseContent: 'same\nstatus: before',
    mineContent: 'same\nstatus: after',
    analysisSnapshotsByMode: {
      strict: {
        compareMode: 'strict',
        textAnalysis: prepareTextDiffAnalysisFromDiffLines(diffLines),
      },
    },
    revisionSwitchableSides: { base: true, mine: false },
  };

  const swapped = swapDiffDataSides(data);
  assert.equal(swapped.baseName, 'right.txt');
  assert.equal(swapped.mineName, 'left.txt');
  assert.equal(swapped.basePath, 'C:\\right.txt');
  assert.equal(swapped.minePath, 'C:\\left.txt');
  assert.deepEqual(swapped.revisionSwitchableSides, { base: false, mine: true });
  assert.equal(swapped.analysisSnapshotsByMode?.strict?.textAnalysis?.stats.chg, 1);
  assert.deepEqual(
    swapped.analysisSnapshotsByMode?.strict?.textAnalysis?.replacementPairs,
    [
      { lineIdx: 1, pairedLineIdx: 2 },
      { lineIdx: 2, pairedLineIdx: 1 },
    ],
  );

  const restored = swapDiffDataSides(swapped);
  assert.equal(restored.baseName, data.baseName);
  assert.equal(restored.mineName, data.mineName);
  assert.equal(restored.baseContent, data.baseContent);
  assert.equal(restored.mineContent, data.mineContent);
  assert.deepEqual(restored.revisionSwitchableSides, data.revisionSwitchableSides);
});
