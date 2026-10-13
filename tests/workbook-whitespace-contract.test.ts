import test from 'node:test';
import assert from 'node:assert/strict';

import { zipSync, strToU8 } from 'fflate';

import { computeWorkbookDiff } from '../src/engine/workbook/workbookDiff';
import { resolveDiffTexts, workbookBytesToText } from './fixtures/workbookSourceOracle';
import { getWorkbookCellChangeKind, isWorkbookStrictOnlyDifference } from '../src/utils/workbook/workbookCellContract';
import { parseWorkbookDisplayLine } from '../src/utils/workbook/workbookDisplay';
import { getWorkbookSections } from '../src/utils/workbook/workbookSections';
import { buildWorkbookSectionRowIndex } from '../src/utils/workbook/workbookSheetIndex';
import {
  buildWorkbookCompareCells,
  buildWorkbookCompareRowState,
  buildWorkbookSplitRowCompareState,
  parseWorkbookRowLine,
} from '../src/utils/workbook/workbookCompare';
import { getWorkbookMiniMapTone } from '../src/utils/workbook/workbookPanelHelpers';

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sharedStringEntry(value: string) {
  const text = escapeXml(value);
  const preserveWhitespace = value.trim() !== value;
  return preserveWhitespace
    ? `<si><t xml:space="preserve">${text}</t></si>`
    : `<si><t>${text}</t></si>`;
}

function buildSharedStringWorkbook(flagValue: string | null) {
  const sharedStrings = [
    'ID',
    'Flag',
    '10001',
    ...(flagValue != null ? [flagValue] : []),
  ];
  const flagCell = flagValue == null
    ? ''
    : `<c r="B2" t="s"><v>${sharedStrings.length - 1}</v></c>`;

  return zipSync({
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="Thing" sheetId="1" r:id="rId1" />
        </sheets>
      </workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml" />
      </Relationships>`),
    'xl/sharedStrings.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
        ${sharedStrings.map(sharedStringEntry).join('')}
      </sst>`),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <worksheet>
        <sheetData>
          <row r="1">
            <c r="A1" t="s"><v>0</v></c>
            <c r="B1" t="s"><v>1</v></c>
          </row>
          <row r="2">
            <c r="A2" t="s"><v>2</v></c>
            ${flagCell}
          </row>
        </sheetData>
      </worksheet>`),
  });
}

function buildSharedFormulaWorkbook() {
  return zipSync({
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="Formula" sheetId="1" r:id="rId1" />
        </sheets>
      </workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml" />
      </Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <worksheet>
        <sheetData>
          <row r="1">
            <c r="A1"><f t="shared" si="0" /><v>42</v></c>
          </row>
        </sheetData>
      </worksheet>`),
  });
}

test('workbookBytesToText preserves shared-string whitespace instead of XML attribute text', () => {
  const text = workbookBytesToText(buildSharedStringWorkbook(' '), 'strict-space.xlsx');
  const row = text
    .split('\n')
    .map(parseWorkbookDisplayLine)
    .find((line) => line?.kind === 'row' && line.rowNumber === 2);

  assert.ok(row && row.kind === 'row');
  assert.equal(row.cells[1]?.value, ' ');
  assert.doesNotMatch(text, /preserve/);
});

test('workbookBytesToText preserves empty shared-formula markers from OpenXML attributes', () => {
  const text = workbookBytesToText(buildSharedFormulaWorkbook(), 'shared-formula.xlsx');
  const row = text
    .split('\n')
    .map(parseWorkbookDisplayLine)
    .find((line) => line?.kind === 'row');

  assert.ok(row && row.kind === 'row');
  assert.equal(row.cells[0]?.value, '42');
  assert.equal(row.cells[0]?.formula, '=shared');
});

test('resolveDiffTexts reuses workbook text for identical byte payloads', () => {
  const bytes = buildSharedFormulaWorkbook();
  const { baseText, mineText } = resolveDiffTexts({
    baseName: 'same.xlsx',
    mineName: 'same.xlsx',
    fileName: 'same.xlsx',
    baseContent: null,
    mineContent: null,
    baseBytes: bytes,
    mineBytes: bytes,
  });

  assert.equal(baseText, mineText);
  assert.match(baseText, /^@@sheet\tFormula/m);
});

test('independent workbook oracle keeps shared-string whitespace-only cells as strict diffs', () => {
  const baseText = workbookBytesToText(buildSharedStringWorkbook(' '), 'strict-space-base.xlsx');
  const mineText = workbookBytesToText(buildSharedStringWorkbook(null), 'strict-space-mine.xlsx');
  const diffLines = computeWorkbookDiff(baseText, mineText);

  assert.equal(diffLines.some((line) => line.type === 'delete' && line.baseLineNo === 2), true);
  assert.equal(diffLines.some((line) => line.type === 'add' && line.mineLineNo === 2), true);

  const rows = buildWorkbookSectionRowIndex(diffLines, getWorkbookSections(diffLines)).get('Thing')?.rows ?? [];
  const changedRow = rows.find((row) => {
    const left = parseWorkbookRowLine(row.left);
    const right = parseWorkbookRowLine(row.right);
    return left?.rowNumber === 2 && right?.rowNumber === 2;
  });

  assert.ok(changedRow);
  const compareCells = buildWorkbookCompareCells(changedRow.left, changedRow.right);
  assert.equal(compareCells.get(1)?.changed, true);
  assert.equal(compareCells.get(1)?.baseCell.value, ' ');
  assert.equal(compareCells.get(1)?.mineCell.value, '');
});

test('independent workbook oracle content mode folds whitespace-only cells into equality', () => {
  const baseText = workbookBytesToText(buildSharedStringWorkbook(' '), 'content-space-base.xlsx');
  const mineText = workbookBytesToText(buildSharedStringWorkbook(null), 'content-space-mine.xlsx');
  const diffLines = computeWorkbookDiff(baseText, mineText, 'content');

  assert.equal(diffLines.every((line) => line.type === 'equal'), true);

  const sections = getWorkbookSections(diffLines, 'content');
  const rows = buildWorkbookSectionRowIndex(diffLines, sections, 'content').get('Thing')?.rows ?? [];
  const targetRow = rows.find((row) => {
    const left = parseWorkbookRowLine(row.left);
    const right = parseWorkbookRowLine(row.right);
    return left?.rowNumber === 2 && right?.rowNumber === 2;
  });

  assert.ok(targetRow);
  const compareCells = buildWorkbookCompareCells(targetRow.left, targetRow.right, undefined, 'content');
  assert.equal([...compareCells.values()].filter((cell) => cell.changed).length, 0);
});

test('strict-only helper flags whitespace-sensitive workbook differences', () => {
  assert.equal(
    isWorkbookStrictOnlyDifference(
      { value: ' ', formula: '' },
      { value: '', formula: '' },
    ),
    true,
  );

  assert.equal(
    isWorkbookStrictOnlyDifference(
      { value: 'abc', formula: '' },
      { value: 'abd', formula: '' },
    ),
    false,
  );
});

test('cell change kind identifies clear and add transitions', () => {
  assert.equal(
    getWorkbookCellChangeKind(
      { value: 'before', formula: '' },
      { value: '', formula: '' },
    ),
    'delete',
  );

  assert.equal(
    getWorkbookCellChangeKind(
      { value: '', formula: '' },
      { value: 'after', formula: '' },
    ),
    'add',
  );
});

test('row delta exposes strict-only columns and delete tone from one structured result', () => {
  const rowDelta = buildWorkbookCompareRowState(
    { type: 'delete', base: '@@row\t2\t10001\t ', mine: null, baseLineNo: 2, mineLineNo: null, baseCharSpans: null, mineCharSpans: null },
    { type: 'add', base: null, mine: '@@row\t2\t10001\t', baseLineNo: null, mineLineNo: 2, baseCharSpans: null, mineCharSpans: null },
    undefined,
    'strict',
  );

  assert.deepEqual(rowDelta.changedColumns, [1]);
  assert.deepEqual(rowDelta.strictOnlyColumns, [1]);
  assert.equal(rowDelta.tone, 'delete');
  assert.equal(rowDelta.miniMapTone, 'strict-only');
  assert.deepEqual(rowDelta.miniMapPaintTones, ['strict-only']);
});

test('row delta content mode collapses whitespace-only changes into equality', () => {
  const rowDelta = buildWorkbookCompareRowState(
    { type: 'delete', base: '@@row\t2\t10001\t ', mine: null, baseLineNo: 2, mineLineNo: null, baseCharSpans: null, mineCharSpans: null },
    { type: 'add', base: null, mine: '@@row\t2\t10001\t', baseLineNo: null, mineLineNo: 2, baseCharSpans: null, mineCharSpans: null },
    undefined,
    'content',
  );

  assert.deepEqual(rowDelta.changedColumns, []);
  assert.deepEqual(rowDelta.strictOnlyColumns, []);
  assert.equal(rowDelta.tone, 'equal');
  assert.equal(rowDelta.miniMapTone, 'equal');
  assert.deepEqual(rowDelta.miniMapPaintTones, []);
});

test('workbook minimap keeps strict-only rows on the blue strict-only tone', () => {
  const baseText = workbookBytesToText(buildSharedStringWorkbook(' '), 'strict-space-base.xlsx');
  const mineText = workbookBytesToText(buildSharedStringWorkbook(null), 'strict-space-mine.xlsx');
  const diffLines = computeWorkbookDiff(baseText, mineText);
  const rows = buildWorkbookSectionRowIndex(diffLines, getWorkbookSections(diffLines)).get('Thing')?.rows ?? [];
  const changedRow = rows.find((row) => {
    const left = parseWorkbookRowLine(row.left);
    const right = parseWorkbookRowLine(row.right);
    return left?.rowNumber === 2 && right?.rowNumber === 2;
  });

  assert.ok(changedRow);
  assert.equal(buildWorkbookSplitRowCompareState(changedRow, undefined, 'strict').strictOnlyColumns.includes(1), true);
  assert.equal(getWorkbookMiniMapTone(changedRow, [], 'strict'), 'strict-only');
});
