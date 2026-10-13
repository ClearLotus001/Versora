import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDiffTexts } from '../src/utils/diff/diffSource';

test('the production source resolver preserves complete text and explicit empty sides', () => {
  assert.deepEqual(resolveDiffTexts({ fileName: 'text.txt', baseName: 'text.txt', mineName: 'text.txt', baseContent: '标题\nvalue\t🧪', mineContent: '' }),
    { baseText: '标题\nvalue\t🧪', mineText: '' });
  assert.deepEqual(resolveDiffTexts({ fileName: 'text.txt', baseName: 'text.txt', mineName: 'text.txt', baseContent: null, mineContent: null }),
    { baseText: '', mineText: '' });
});

test('the production source resolver rejects any workbook side instead of invoking a JS parser', () => {
  for (const names of [
    { fileName: 'Book.xlsx', baseName: 'Book.xlsx', mineName: 'Book.xlsx' },
    { fileName: 'text.txt', baseName: 'Book.xlsb', mineName: 'text.txt' },
    { fileName: 'text.txt', baseName: 'text.txt', mineName: 'Book.xlsm' },
  ]) {
    assert.throws(() => resolveDiffTexts({ ...names, baseContent: null, mineContent: null }), /requires a prepared artifact/);
  }
});
