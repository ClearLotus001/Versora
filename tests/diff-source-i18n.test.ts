import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDiffTexts, workbookBytesToText } from './fixtures/workbookSourceOracle';

test('workbookBytesToText localizes unsupported workbook format errors by locale', () => {
  const bytes = new Uint8Array([0x50, 0x4b]);

  for (const extension of ['xls', 'xlsb']) {
    const fileName = `legacy.${extension}`;
    const english = workbookBytesToText(bytes, fileName, 'en-US');
    const chinese = workbookBytesToText(bytes, fileName, 'zh-CN');

    assert.ok(english.includes(`Unsupported workbook format: .${extension}`));
    assert.doesNotMatch(english, /不支持的工作簿格式/);

    assert.ok(chinese.includes(`不支持的工作簿格式：.${extension}`));
    assert.doesNotMatch(chinese, /Unsupported workbook format/);

    for (const [locale, expected] of [['en-US', english], ['zh-CN', chinese]] as const) {
      const texts = resolveDiffTexts({
        baseName: fileName, mineName: fileName, fileName,
        baseContent: null, mineContent: null, baseBytes: bytes, mineBytes: bytes.slice(),
      }, locale);
      assert.deepEqual(texts, { baseText: expected, mineText: expected });
    }
  }
});
