import test from 'node:test';
import assert from 'node:assert/strict';

import { computeDiff } from '../src/engine/text/diff';
import { computeCharDiff } from '../shared/textMyers';

test('character diff highlights complete low-similarity replacements', () => {
  assert.deepEqual(computeCharDiff('暗夜', '原色'), {
    baseSpans: [{ highlight: true, text: '暗夜' }],
    mineSpans: [{ highlight: true, text: '原色' }],
  });

  const lines = computeDiff('暗夜', '原色');
  const deleted = lines.find(line => line.type === 'delete');
  const added = lines.find(line => line.type === 'add');
  assert.deepEqual(deleted?.baseCharSpans, [{ highlight: true, text: '暗夜' }]);
  assert.deepEqual(added?.mineCharSpans, [{ highlight: true, text: '原色' }]);
});

test('character diff keeps the existing length guard', () => {
  assert.equal(computeCharDiff('a'.repeat(2001), 'b'.repeat(2001)), null);
});

test('character diff leaves one-character replacements on row-level highlighting', () => {
  assert.equal(computeCharDiff('开', '关'), null);

  const lines = computeDiff('开', '关');
  assert.equal(lines.find(line => line.type === 'delete')?.baseCharSpans, null);
  assert.equal(lines.find(line => line.type === 'add')?.mineCharSpans, null);
});

test('character diff suppresses only the one-character side of an asymmetric replacement', () => {
  assert.deepEqual(computeCharDiff('6', 'CustomHDAvatar'), {
    baseSpans: [{ highlight: false, text: '6' }],
    mineSpans: [{ highlight: true, text: 'CustomHDAvatar' }],
  });
});

test('character diff keeps a single whitespace character visible', () => {
  assert.deepEqual(computeCharDiff(' ', ''), {
    baseSpans: [{ highlight: true, text: ' ' }],
    mineSpans: [],
  });
});

test('character diff bounds unrelated long replacements while preserving shared edges', () => {
  const base = `header:${'a'.repeat(1_800)}:footer`;
  const mine = `header:${'b'.repeat(1_800)}:footer`;
  const result = computeCharDiff(base, mine);
  assert.deepEqual(result, {
    baseSpans: [
      { highlight: false, text: 'header:' },
      { highlight: true, text: 'a'.repeat(1_800) },
      { highlight: false, text: ':footer' },
    ],
    mineSpans: [
      { highlight: false, text: 'header:' },
      { highlight: true, text: 'b'.repeat(1_800) },
      { highlight: false, text: ':footer' },
    ],
  });
});

test('exhausted character work budget falls back without losing either input', () => {
  const result = computeCharDiff('prefix-abcd-suffix', 'prefix-acbd-suffix', { maxWork: 0 });
  assert.ok(result);
  assert.equal(result.baseSpans.map(span => span.text).join(''), 'prefix-abcd-suffix');
  assert.equal(result.mineSpans.map(span => span.text).join(''), 'prefix-acbd-suffix');
  assert.ok(result.baseSpans.some(span => span.highlight));
  assert.ok(result.mineSpans.some(span => span.highlight));
});

test('bounded character diff reconstructs both sides of short edits', () => {
  const values = ['', ' ', 'ab', 'ba', 'abc', 'axc', 'abab', 'baba', 'abcde', 'aedcb'];
  for (const base of values) {
    for (const mine of values) {
      const result = computeCharDiff(base, mine);
      if (!result) {
        assert.ok(base === mine || (base.length <= 1 && mine.length <= 1));
        continue;
      }
      assert.equal(result.baseSpans.map(span => span.text).join(''), base);
      assert.equal(result.mineSpans.map(span => span.text).join(''), mine);
    }
  }
});
