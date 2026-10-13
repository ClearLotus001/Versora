import test from 'node:test';
import assert from 'node:assert/strict';

import type { WorkbookCellDelta } from '../src/types';
import { getThemeTokensSnapshot } from '../src/theme';
import {
  formatWorkbookCanvasCellText,
  getWorkbookCanvasCellTextDiff,
  layoutWorkbookCanvasTextDrawSegments,
  resolveWorkbookCanvasTextDiffHighlight,
} from '../src/utils/workbook/workbookCanvasTextDiff';

function createCellDelta(
  baseValue: string,
  mineValue: string,
  overrides: Partial<WorkbookCellDelta> = {},
): WorkbookCellDelta {
  return {
    column: 0,
    baseCell: { value: baseValue, formula: '' },
    mineCell: { value: mineValue, formula: '' },
    changed: true,
    masked: false,
    kind: 'modify',
    hasBaseContent: baseValue !== '',
    hasMineContent: mineValue !== '',
    hasContent: baseValue !== '' || mineValue !== '',
    ...overrides,
  };
}

test('workbook canvas text diff highlights only the changed date characters', () => {
  const diff = getWorkbookCanvasCellTextDiff(createCellDelta(
    '2026-06-13 00:00:00',
    '2050-06-13 00:00:00',
  ));

  assert.ok(diff);
  assert.equal(diff.baseSpans.map(span => span.text).join(''), '2026-06-13 00:00:00');
  assert.equal(diff.mineSpans.map(span => span.text).join(''), '2050-06-13 00:00:00');
  assert.equal(diff.baseSpans.filter(span => span.highlight).map(span => span.text).join(''), '26');
  assert.equal(diff.mineSpans.filter(span => span.highlight).map(span => span.text).join(''), '50');
});

test('workbook canvas text diff highlights both complete values when short text has no shared characters', () => {
  const diff = getWorkbookCanvasCellTextDiff(createCellDelta('暗夜', '原色'));

  assert.ok(diff);
  assert.deepEqual(diff.baseSpans, [{ highlight: true, text: '暗夜' }]);
  assert.deepEqual(diff.mineSpans, [{ highlight: true, text: '原色' }]);
});

test('workbook canvas text diff leaves one-character replacements on cell-level highlighting', () => {
  assert.equal(getWorkbookCanvasCellTextDiff(createCellDelta('开', '关')), null);
});

test('workbook canvas text diff suppresses only the one-character side of an asymmetric replacement', () => {
  const diff = getWorkbookCanvasCellTextDiff(createCellDelta('6', 'CustomHDAvatar'));

  assert.ok(diff);
  assert.deepEqual(diff.baseSpans, [{ highlight: false, text: '6' }]);
  assert.deepEqual(diff.mineSpans, [{ highlight: true, text: 'CustomHDAvatar' }]);
});

test('workbook canvas text diff preserves and highlights whitespace-only changes', () => {
  const diff = getWorkbookCanvasCellTextDiff(createCellDelta(
    '2026-06-13 00:00:00',
    '2026-06-1300:00:00',
    { strictOnly: true },
  ));

  assert.ok(diff);
  assert.equal(diff.baseSpans.filter(span => span.highlight).map(span => span.text).join(''), ' ');
  assert.equal(diff.mineSpans.filter(span => span.highlight).map(span => span.text).join(''), '');

  const blankDiff = getWorkbookCanvasCellTextDiff(createCellDelta(' ', '', {
    kind: 'delete',
    strictOnly: true,
  }));
  assert.ok(blankDiff);
  assert.deepEqual(blankDiff.baseSpans, [{ highlight: true, text: ' ' }]);
  assert.deepEqual(blankDiff.mineSpans, []);
});

test('workbook canvas text diff leaves pure add and delete cells on whole-cell semantics', () => {
  assert.equal(getWorkbookCanvasCellTextDiff(createCellDelta('', 'added', { kind: 'add' })), null);
  assert.equal(getWorkbookCanvasCellTextDiff(createCellDelta('deleted', '', { kind: 'delete' })), null);
});

test('workbook canvas text segments keep highlight geometry aligned with rendered text', () => {
  const text = formatWorkbookCanvasCellText('2026');
  const segments = layoutWorkbookCanvasTextDrawSegments({
    text,
    x: 6,
    charSpans: [
      { highlight: false, text: '20' },
      { highlight: true, text: '26' },
    ],
    measureText: value => value.length * 5,
  });

  assert.deepEqual(segments, [
    { highlight: false, text: '20', x: 6, width: 10 },
    { highlight: true, text: '26', x: 16, width: 10 },
  ]);
});

test('workbook canvas text diff uses a stronger fill and semantic edge', () => {
  const theme = getThemeTokensSnapshot('light');
  assert.deepEqual(
    resolveWorkbookCanvasTextDiffHighlight(theme, createCellDelta('2026', '2050')),
    { background: theme.chgHl, edge: `${theme.chgBrd}cc` },
  );
  assert.deepEqual(
    resolveWorkbookCanvasTextDiffHighlight(theme, createCellDelta(' ', '', { strictOnly: true })),
    { background: theme.whitespaceHl, edge: theme.whitespaceBrd },
  );
});

test('workbook canvas long replacements keep shared context and use whole changed spans', () => {
  const diff = getWorkbookCanvasCellTextDiff(createCellDelta(
    `ID:${'a'.repeat(1_900)}:end`,
    `ID:${'b'.repeat(1_900)}:end`,
  ));
  assert.ok(diff);
  assert.deepEqual(diff.baseSpans, [
    { highlight: false, text: 'ID:' },
    { highlight: true, text: 'a'.repeat(1_900) },
    { highlight: false, text: ':end' },
  ]);
  assert.deepEqual(diff.mineSpans, [
    { highlight: false, text: 'ID:' },
    { highlight: true, text: 'b'.repeat(1_900) },
    { highlight: false, text: ':end' },
  ]);
});
