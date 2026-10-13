import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alignWorkbookEntries,
  createWorkbookAlignmentEntry,
  type WorkbookAlignmentEntry,
} from '../src/utils/workbook/workbookAlignment';
import { createWorkbookRowLine } from '../src/utils/workbook/workbookDisplay';

function entries(signatures: string[]): WorkbookAlignmentEntry<number>[] {
  return signatures.map((value, index) => createWorkbookAlignmentEntry(
    createWorkbookRowLine(index + 1, [value]), index,
  )!);
}

function assertCoverage(
  base: WorkbookAlignmentEntry<number>[],
  mine: WorkbookAlignmentEntry<number>[],
  pairs: ReturnType<typeof alignWorkbookEntries<number>>,
) {
  assert.deepEqual(pairs.flatMap((pair) => pair.base ? [pair.base] : []), base);
  assert.deepEqual(pairs.flatMap((pair) => pair.mine ? [pair.mine] : []), mine);
}

test('equal repeated workbook rows use linear prefix alignment', { timeout: 5000 }, () => {
  const base = entries(Array.from({ length: 30_000 }, () => 'repeated'));
  const mine = entries(Array.from({ length: 30_000 }, () => 'repeated'));
  const pairs = alignWorkbookEntries(base, mine);
  assert.equal(pairs.length, base.length);
  pairs.forEach((pair, index) => {
    assert.equal(pair.base, base[index]);
    assert.equal(pair.mine, mine[index]);
  });
});

test('candidate budget preserves a large repeated block across a moved unique row', { timeout: 5000 }, () => {
  for (const reverse of [false, true]) {
    const repeated = Array.from({ length: 10_000 }, () => 'repeated');
    const left = ['marker', ...repeated];
    const right = [...repeated, 'marker'];
    const base = entries(reverse ? right : left);
    const mine = entries(reverse ? left : right);
    const pairs = alignWorkbookEntries(base, mine);
    assertCoverage(base, mine, pairs);
    const equalPairs = pairs.filter((pair) => pair.base && pair.mine && pair.base.signature === pair.mine.signature);
    assert.equal(equalPairs.length, repeated.length);
    assert.equal(pairs.filter((pair) => pair.base && !pair.mine).length, 1);
    assert.equal(pairs.filter((pair) => !pair.base && pair.mine).length, 1);
  }
});

test('bounded alignment keeps prefix and suffix around an inserted block', () => {
  const base = entries(['start', 'a', 'a', 'a', 'end']);
  const mine = entries(['start', 'a', 'inserted', 'a', 'a', 'end']);
  const pairs = alignWorkbookEntries(base, mine);
  assertCoverage(base, mine, pairs);
  assert.equal(pairs.length, mine.length);
  assert.equal(pairs.filter((pair) => !pair.base && pair.mine).length, 1);
  assert.equal(pairs.find((pair) => !pair.base)?.mine?.meta, 2);
});

function equalPairCount(pairs: ReturnType<typeof alignWorkbookEntries<number>>): number {
  return pairs.filter((pair) => pair.base && pair.mine && pair.base.signature === pair.mine.signature).length;
}

test('candidate budget preserves strong repeated blocks beyond both greedy directions', { timeout: 5000 }, () => {
  const expand = (text: string) => [...text].flatMap((character) => Array.from({ length: 1000 }, () => character));
  const base = entries(expand('DBADAACABC'));
  const mine = entries(expand('BDAACCCCAB'));
  const pairs = alignWorkbookEntries(base, mine);
  assertCoverage(base, mine, pairs);
  // B, D, AA, C, A, B is a shared subsequence of seven 1000-row blocks.
  assert.ok(equalPairCount(pairs) >= 7000);
});

test('run anchors weight the number of equal rows rather than the number of blocks', { timeout: 5000 }, () => {
  const block = (value: string, count: number) => Array.from({ length: count }, () => value);
  const base = entries([...block('A', 1000), ...block('B', 4000), ...block('C', 1000)]);
  const mine = entries([...block('B', 4000), ...block('A', 1000), ...block('C', 1000)]);
  const pairs = alignWorkbookEntries(base, mine);
  assertCoverage(base, mine, pairs);
  assert.equal(equalPairCount(pairs), 5000);
});

test('a split long run can match its remaining rows across inserted blocks', { timeout: 5000 }, () => {
  const block = (count: number) => Array.from({ length: count }, () => 'A');
  const base = entries(['base-start', ...block(6000), 'base-end']);
  const mine = entries(['mine-start', ...block(3000), 'inserted', ...block(3000), 'mine-end']);
  const pairs = alignWorkbookEntries(base, mine);
  assertCoverage(base, mine, pairs);
  assert.equal(equalPairCount(pairs), 6000);
});

test('numerous short runs use bounded row candidates without losing shifted shared rows', { timeout: 5000 }, () => {
  const alternating = Array.from({ length: 10_000 }, (_, index) => index % 2 === 0 ? 'A' : 'B');
  const base = entries(['base-start', ...alternating, 'base-end']);
  const mine = entries(['mine-start', 'inserted', ...alternating, 'mine-end']);
  const pairs = alignWorkbookEntries(base, mine);
  assertCoverage(base, mine, pairs);
  assert.equal(equalPairCount(pairs), alternating.length);
});

test('compressed equal-size row blocks preserve the scalar LCS across reordered repeated runs', { timeout: 5000 }, () => {
  const scalarLcsLength = (left: string, right: string): number => {
    let previous = new Array<number>(right.length + 1).fill(0);
    for (const value of left) {
      const current = [0];
      for (let column = 1; column <= right.length; column += 1) {
        current[column] = value === right[column - 1]
          ? previous[column - 1]! + 1
          : Math.max(previous[column]!, current[column - 1]!);
      }
      previous = current;
    }
    return previous[right.length]!;
  };
  let seed = 4187;
  const randomText = () => Array.from({ length: 10 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return String.fromCharCode(65 + seed % 5);
  }).join('');
  const expand = (text: string) => [...text].flatMap((value) => Array.from({ length: 1000 }, () => value));
  for (let sample = 0; sample < 24; sample += 1) {
    const left = randomText();
    const right = randomText();
    const base = entries(expand(left));
    const mine = entries(expand(right));
    const pairs = alignWorkbookEntries(base, mine);
    assertCoverage(base, mine, pairs);
    assert.equal(equalPairCount(pairs), scalarLcsLength(left, right) * 1000, `${left} / ${right}`);
  }
});
