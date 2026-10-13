import test from 'node:test';
import assert from 'node:assert/strict';

import type { DiffLine } from '../src/types';
import {
  alignTextChangeBlock,
  buildReplacementPairIndex,
  summarizeDiffChanges,
} from '../src/engine/text/textChangeAlignment';
import { alignTextChangeBlock as alignSharedTextChangeBlock } from '../shared/textChangeAlignment';
import { buildSplitRows } from '../src/engine/text/diff';
import {
  buildSearchPattern,
  findMatchesInSearchableLines,
  scanMatchesInSearchableLines,
} from '../src/engine/text/search';

function makeDeleteLine(base: string, baseLineNo: number): DiffLine {
  return {
    type: 'delete',
    base,
    mine: null,
    baseLineNo,
    mineLineNo: null,
    baseCharSpans: null,
    mineCharSpans: null,
  };
}

function makeAddLine(mine: string, mineLineNo: number): DiffLine {
  return {
    type: 'add',
    base: null,
    mine,
    baseLineNo: null,
    mineLineNo,
    baseCharSpans: null,
    mineCharSpans: null,
  };
}

test('alignTextChangeBlock keeps insertions separate while preserving nearby replacements', () => {
  const pairs = alignTextChangeBlock(
    ['const alpha = 1;', 'const beta = 2;'],
    ['const alpha = 10;', 'const inserted = true;', 'const beta = 20;'],
  );

  assert.deepEqual(
    pairs.map((pair) => ({
      deleteIndex: pair.deleteIndex,
      addIndex: pair.addIndex,
      isReplacement: pair.isReplacement,
    })),
    [
      { deleteIndex: 0, addIndex: 0, isReplacement: true },
      { deleteIndex: null, addIndex: 1, isReplacement: false },
      { deleteIndex: 1, addIndex: 2, isReplacement: true },
    ],
  );
});

test('alignTextChangeBlock treats one-to-one prose rewrites as replacements', () => {
  const pairs = alignTextChangeBlock(
    ['可以直接运行测试脚本进行调试：'],
    ['框架提供了 `@auto_test` 装饰器的调试模式，支持单独运行测试用例：'],
  );

  assert.deepEqual(
    pairs.map((pair) => ({
      deleteIndex: pair.deleteIndex,
      addIndex: pair.addIndex,
      isReplacement: pair.isReplacement,
    })),
    [{ deleteIndex: 0, addIndex: 0, isReplacement: true }],
  );
});

test('summarizeDiffChanges does not count unrelated delete/add lines as modified', () => {
  const diffLines: DiffLine[] = [
    makeDeleteLine('remove legacy bootstrap block', 10),
    makeAddLine('add brand new telemetry section', 10),
  ];

  assert.deepEqual(summarizeDiffChanges(diffLines), { add: 1, del: 1, chg: 0 });
});

test('summarizeDiffChanges counts likely replacements as modified', () => {
  const diffLines: DiffLine[] = [
    makeDeleteLine('const retries = 1;', 4),
    makeAddLine('const retries = 2;', 4),
  ];

  assert.deepEqual(summarizeDiffChanges(diffLines), { add: 0, del: 0, chg: 1 });
});

test('alignTextChangeBlock treats short code token edits as replacements', () => {
  const pairs = alignTextChangeBlock(
    ['return a'],
    ['return b'],
  );

  assert.deepEqual(
    pairs.map((pair) => ({
      deleteIndex: pair.deleteIndex,
      addIndex: pair.addIndex,
      isReplacement: pair.isReplacement,
    })),
    [{ deleteIndex: 0, addIndex: 0, isReplacement: true }],
  );
});

test('renderer and shared main-process text alignment use the same implementation', () => {
  const deleteLines = ['return a', 'const stable = true;'];
  const addLines = ['return b', 'const inserted = true;', 'const stable = false;'];

  assert.deepEqual(
    alignSharedTextChangeBlock(deleteLines, addLines),
    alignTextChangeBlock(deleteLines, addLines),
  );
});

test('alignTextChangeBlock preserves indexes and scores for empty and one-sided blocks', () => {
  const lines = ['', 'return value;', '@@row\t3\tvalue', '汉字 😀', 'plain text '.repeat(300)];

  assert.deepEqual(alignTextChangeBlock([], []), []);
  assert.deepEqual(
    alignTextChangeBlock(lines, []),
    lines.map((_, deleteIndex) => ({ deleteIndex, addIndex: null, isReplacement: false, score: 0 })),
  );
  assert.deepEqual(
    alignTextChangeBlock([], lines),
    lines.map((_, addIndex) => ({ deleteIndex: null, addIndex, isReplacement: false, score: 0 })),
  );
});

test('alignTextChangeBlock preserves positional pairing when either side contains a structured line', () => {
  assert.deepEqual(
    alignTextChangeBlock(['unrelated deletion', '@@row\t3\told'], ['other addition', 'plain line', 'extra line']),
    [
      { deleteIndex: 0, addIndex: 0, isReplacement: true, score: 1 },
      { deleteIndex: 1, addIndex: 1, isReplacement: true, score: 1 },
      { deleteIndex: null, addIndex: 2, isReplacement: false, score: 0 },
    ],
  );
  assert.deepEqual(
    alignTextChangeBlock(['unrelated deletion', 'plain line', 'extra line'], ['other addition', '@@row\t3\tnew']),
    [
      { deleteIndex: 0, addIndex: 0, isReplacement: true, score: 1 },
      { deleteIndex: 1, addIndex: 1, isReplacement: true, score: 1 },
      { deleteIndex: 2, addIndex: null, isReplacement: false, score: 0 },
    ],
  );
});

test('buildSplitRows uses replacement-aware alignment inside mixed change blocks', () => {
  const rows = buildSplitRows([
    makeDeleteLine('const alpha = 1;', 10),
    makeDeleteLine('const beta = 2;', 11),
    makeAddLine('const alpha = 10;', 10),
    makeAddLine('const inserted = true;', 11),
    makeAddLine('const beta = 20;', 12),
  ]);

  assert.deepEqual(
    rows.map((row) => ({
      left: row.left?.base ?? null,
      right: row.right?.mine ?? null,
      lineIdxs: row.lineIdxs,
    })),
    [
      { left: 'const alpha = 1;', right: 'const alpha = 10;', lineIdxs: [0, 2] },
      { left: null, right: 'const inserted = true;', lineIdxs: [3] },
      { left: 'const beta = 2;', right: 'const beta = 20;', lineIdxs: [1, 4] },
    ],
  );
});

test('buildSplitRows keeps code block rewrites paired for split layout without marking them as modifications', () => {
  const rows = buildSplitRows([
    makeDeleteLine("if __name__ == '__main__':", 725),
    makeDeleteLine('    # 创建模拟的 executor 进行调试', 726),
    makeDeleteLine('    pass', 727),
    makeAddLine('@auto_test(debug=True)  # 开启调试模式', 751),
    makeAddLine('class TCUpdate(AutoTestCase):', 752),
    makeAddLine('    ...', 753),
  ]);

  assert.deepEqual(
    rows.map((row) => ({
      left: row.left?.base ?? null,
      right: row.right?.mine ?? null,
      lineIdxs: row.lineIdxs,
    })),
    [
      { left: "if __name__ == '__main__':", right: '@auto_test(debug=True)  # 开启调试模式', lineIdxs: [0, 3] },
      { left: '    # 创建模拟的 executor 进行调试', right: 'class TCUpdate(AutoTestCase):', lineIdxs: [1, 4] },
      { left: '    pass', right: '    ...', lineIdxs: [2, 5] },
    ],
  );

  assert.deepEqual(summarizeDiffChanges([
    makeDeleteLine("if __name__ == '__main__':", 725),
    makeDeleteLine('    # 创建模拟的 executor 进行调试', 726),
    makeDeleteLine('    pass', 727),
    makeAddLine('@auto_test(debug=True)  # 开启调试模式', 751),
    makeAddLine('class TCUpdate(AutoTestCase):', 752),
    makeAddLine('    ...', 753),
  ]), { add: 3, del: 3, chg: 0 });
});

test('buildReplacementPairIndex tracks only high-confidence replacement pairs', () => {
  const diffLines: DiffLine[] = [
    makeDeleteLine('可以直接运行测试脚本进行调试：', 722),
    makeAddLine('框架提供了 `@auto_test` 装饰器的调试模式，支持单独运行测试用例：', 722),
    makeDeleteLine("if __name__ == '__main__':", 725),
    makeDeleteLine('    pass', 727),
    makeAddLine('@auto_test(debug=True)  # 开启调试模式', 751),
    makeAddLine('    ...', 753),
  ];

  const pairIndex = buildReplacementPairIndex(diffLines);

  assert.equal(pairIndex.get(0), 1);
  assert.equal(pairIndex.get(1), 0);
  assert.equal(pairIndex.has(2), false);
  assert.equal(pairIndex.has(3), false);
  assert.equal(pairIndex.has(4), false);
  assert.equal(pairIndex.has(5), false);
});

test('buildSplitRows reuses cached rows for the same diffLines reference', () => {
  const diffLines: DiffLine[] = [
    makeDeleteLine('const alpha = 1;', 10),
    makeAddLine('const alpha = 2;', 10),
  ];

  const first = buildSplitRows(diffLines);
  const second = buildSplitRows(diffLines);

  assert.equal(first, second);
});

test('findMatchesInSearchableLines returns stable line indexes without diff objects', () => {
  const pattern = buildSearchPattern('needle', { isRegex: false, isCaseSensitive: false });
  const matches = findMatchesInSearchableLines([
    'first needle',
    'second',
    'third needle needle',
  ], pattern);

  assert.deepEqual(
    matches.map((match) => ({ lineIdx: match.lineIdx, start: match.start, end: match.end })),
    [
      { lineIdx: 0, start: 6, end: 12 },
      { lineIdx: 2, start: 6, end: 12 },
      { lineIdx: 2, start: 13, end: 19 },
    ],
  );
});

test('scanMatchesInSearchableLines counts all matches while bounding materialized results', () => {
  const pattern = buildSearchPattern('x', { isRegex: false, isCaseSensitive: true });
  const result = scanMatchesInSearchableLines(['xxxx', 'xx'], pattern, 3);

  assert.equal(result.totalCount, 6);
  assert.equal(result.matches.length, 3);
  assert.equal(result.truncated, true);
});

test('scanMatchesInSearchableLines skips protocol prefixes and preserves source offsets', () => {
  const rowLine = '@@row\t12\twow';
  const sheetLine = '@@sheet\tWow';
  const contentStart = rowLine.indexOf('wow');
  const pattern = buildSearchPattern('w', { isRegex: false, isCaseSensitive: false });
  const result = scanMatchesInSearchableLines(
    [rowLine, sheetLine],
    pattern,
    Number.POSITIVE_INFINITY,
    [contentStart, sheetLine.length],
  );

  assert.equal(result.totalCount, 2);
  assert.deepEqual(
    result.matches.map((match) => ({ lineIdx: match.lineIdx, start: match.start, end: match.end })),
    [
      { lineIdx: 0, start: contentStart, end: contentStart + 1 },
      { lineIdx: 0, start: contentStart + 2, end: contentStart + 3 },
    ],
  );
});
