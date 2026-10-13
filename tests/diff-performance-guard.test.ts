import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

async function loadComputeDiff() {
  const require = createRequire(import.meta.url);
  const diffExports = require('../src/engine/text/diff.ts') as typeof import('../src/engine/text/diff');

  if (typeof diffExports.computeDiff !== 'function') {
    throw new Error('Failed to load computeDiff test exports.');
  }

  return diffExports.computeDiff;
}

test('computeDiff keeps identical large files aligned', async () => {
  const computeDiff = await loadComputeDiff();
  const text = Array.from({ length: 60_000 }, (_, index) => `line ${index % 7}`).join('\n');

  const result = computeDiff(text, text);

  assert.equal(result.length, 60_000);
  assert.ok(result.every((line) => line.type === 'equal'));
});

test('computeDiff falls back to anchored replacement for highly repetitive text', async () => {
  const computeDiff = await loadComputeDiff();
  const repeatedBase = Array.from({ length: 3_200 }, (_, index) => (index % 2 === 0 ? 'x' : 'y'));
  const repeatedMine = Array.from({ length: 3_200 }, (_, index) => (index % 2 === 0 ? 'y' : 'x'));
  const baseText = ['header', ...repeatedBase, 'footer'].join('\n');
  const mineText = ['header', ...repeatedMine, 'footer'].join('\n');

  const result = computeDiff(baseText, mineText);

  assert.equal(result[0]?.type, 'equal');
  assert.equal(result[0]?.base, 'header');
  assert.equal(result.at(-1)?.type, 'equal');
  assert.equal(result.at(-1)?.base, 'footer');
  assert.equal(result.length, repeatedBase.length + repeatedMine.length + 2);
  assert.ok(result.slice(1, -1).every((line) => line.type !== 'equal'));
});

test('computeDiff caps character-level diff work for large replacement blocks', async () => {
  const computeDiff = await loadComputeDiff();
  const lineCount = 500;
  const baseText = Array.from({ length: lineCount }, (_, index) => `alpha value ${index}`).join('\n');
  const mineText = Array.from({ length: lineCount }, (_, index) => `beta value ${index} updated`).join('\n');

  const result = computeDiff(baseText, mineText);
  const deleteLines = result.filter((line) => line.type === 'delete');
  const addLines = result.filter((line) => line.type === 'add');
  const deleteSpanCount = deleteLines.filter((line) => line.baseCharSpans?.length).length;
  const addSpanCount = addLines.filter((line) => line.mineCharSpans?.length).length;

  assert.equal(deleteLines.length, lineCount);
  assert.equal(addLines.length, lineCount);
  assert.ok(deleteSpanCount > 0);
  assert.ok(deleteSpanCount < lineCount);
  assert.equal(deleteSpanCount, addSpanCount);
});

test('computeDiff preserves unique anchors when duplicated lines shift around them', async () => {
  const computeDiff = await loadComputeDiff();
  const baseText = ['header', 'dup', 'dup', 'anchor', 'dup', 'footer'].join('\n');
  const mineText = ['header', 'dup', 'anchor', 'dup', 'dup', 'footer'].join('\n');

  const result = computeDiff(baseText, mineText);
  const equalLines = result.filter((line) => line.type === 'equal').map((line) => line.base);

  assert.deepEqual(equalLines, ['header', 'dup', 'anchor', 'dup', 'footer']);
});

test('computeDiff fallback preserves unique anchors for oversized shifted files', async () => {
  const computeDiff = await loadComputeDiff();
  const baseLines = Array.from({ length: 60_005 }, (_, index) => `line-${index + 1}`);
  const mineLines = ['line-NEW', ...baseLines];

  const result = computeDiff(baseLines.join('\n'), mineLines.join('\n'));

  assert.equal(result[0]?.type, 'add');
  assert.equal(result[0]?.mine, 'line-NEW');
  assert.equal(result[1]?.type, 'equal');
  assert.equal(result[1]?.base, 'line-1');
  assert.equal(result[1]?.mineLineNo, 2);
  assert.equal(result.filter((line) => line.type === 'equal').length, baseLines.length);
});

test('computeDiff preserves oversized shared prefix and suffix around a middle insertion', async () => {
  const computeDiff = await loadComputeDiff();
  const baseLines = Array.from({ length: 60_005 }, (_, index) => `line-${index + 1}`);
  const insertAt = 1_234;
  const mineLines = [
    ...baseLines.slice(0, insertAt),
    'line-NEW',
    ...baseLines.slice(insertAt),
  ];

  const result = computeDiff(baseLines.join('\n'), mineLines.join('\n'));

  assert.equal(result[insertAt - 1]?.type, 'equal');
  assert.equal(result[insertAt - 1]?.base, `line-${insertAt}`);
  assert.equal(result[insertAt]?.type, 'add');
  assert.equal(result[insertAt]?.mine, 'line-NEW');
  assert.equal(result[insertAt + 1]?.type, 'equal');
  assert.equal(result[insertAt + 1]?.base, `line-${insertAt + 1}`);
  assert.equal(result[insertAt + 1]?.mineLineNo, insertAt + 2);
  assert.equal(result.filter((line) => line.type === 'equal').length, baseLines.length);
});

for (const lineCount of [25_000, 60_000]) {
  test(`computeDiff preserves ${lineCount} middle anchors between changed boundaries`, async () => {
    const computeDiff = await loadComputeDiff();
    const sharedLines = Array.from({ length: lineCount }, (_, index) => `unique-line-${index}`);
    const baseText = ['base boundary', ...sharedLines, 'base end'].join('\n');
    const mineText = ['mine boundary', ...sharedLines, 'mine end'].join('\n');

    const result = computeDiff(baseText, mineText);

    assert.equal(result.length, lineCount + 4);
    assert.equal(result[0]?.type, 'delete');
    assert.equal(result[1]?.type, 'add');
    for (let index = 0; index < lineCount; index += 1) {
      const line = result[index + 2]!;
      assert.equal(line.type, 'equal');
      assert.equal(line.base, sharedLines[index]);
      assert.equal(line.mine, sharedLines[index]);
      assert.equal(line.baseLineNo, index + 2);
      assert.equal(line.mineLineNo, index + 2);
    }
    assert.equal(result.at(-2)?.type, 'delete');
    assert.equal(result.at(-1)?.type, 'add');
  });
}
