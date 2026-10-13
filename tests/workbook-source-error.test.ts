import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { XMLValidator } from 'fast-xml-parser';

import { resolveDiffTexts, workbookBytesToText, type DiffTextSourceInput } from './fixtures/workbookSourceOracle';

function buildWorkbookWithSheetXml(sheetXml: string | null, sharedStringsXml?: string): Uint8Array {
  const entries = {
    'xl/workbook.xml': strToU8('<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1" /></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" /></Relationships>'),
    ...(sheetXml == null ? {} : { 'xl/worksheets/sheet1.xml': strToU8(sheetXml) }),
    ...(sharedStringsXml == null ? {} : { 'xl/sharedStrings.xml': strToU8(sharedStringsXml) }),
  };
  return zipSync(entries);
}

function buildWorkbook(value: string): Uint8Array {
  return buildWorkbookWithSheetXml(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${value}</t></is></c><c r="B1"><f>A2</f><v>42</v></c></row></sheetData></worksheet>`);
}

function source(baseBytes: Uint8Array, mineBytes: Uint8Array): DiffTextSourceInput {
  return {
    baseName: 'Book.xlsx', mineName: 'Book.xlsx', fileName: 'Book.xlsx',
    baseContent: null, mineContent: null, baseBytes, mineBytes,
  };
}

test('small OpenXML oracle preserves localized parser diagnostics', () => {
  const bytes = new Uint8Array([1]);
  assert.match(workbookBytesToText(bytes, 'broken.xlsx', 'en-US'), /Failed to parse workbook: broken\.xlsx\ninvalid zip data/);
  assert.match(workbookBytesToText(bytes, 'broken.xlsx', 'zh-CN'), /broken\.xlsx\ninvalid zip data/);
  assert.throws(() => workbookBytesToText(bytes, 'broken.xlsx', 'en-US', { throwOnParseError: true }), /Failed to parse workbook: broken\.xlsx/);
});

test('small OpenXML oracle rejects either corrupt side instead of comparing diagnostic text', () => {
  const valid = buildWorkbook('Value');
  const corrupt = new Uint8Array([1]);
  assert.throws(() => resolveDiffTexts(source(corrupt, valid), 'en-US'), /Failed to parse workbook: Book\.xlsx/);
  assert.throws(() => resolveDiffTexts(source(valid, corrupt), 'en-US'), /Failed to parse workbook: Book\.xlsx/);
  assert.throws(() => resolveDiffTexts(source(corrupt, new Uint8Array([2])), 'en-US'), /Failed to parse workbook: Book\.xlsx/);
});

test('identical corrupt bytes cannot bypass strict parsing through text reuse', () => {
  const corrupt = new Uint8Array([1]);
  assert.throws(() => resolveDiffTexts(source(corrupt, corrupt), 'en-US'), /invalid zip data/);
  assert.throws(() => resolveDiffTexts(source(corrupt, corrupt.slice()), 'en-US'), /invalid zip data/);
});

test('valid strict loads preserve workbook text and identical-byte reuse', () => {
  const base = buildWorkbook('Before');
  const mine = buildWorkbook('After');
  assert.deepEqual(resolveDiffTexts(source(base, mine), 'en-US'), {
    baseText: workbookBytesToText(base, 'Book.xlsx', 'en-US'),
    mineText: workbookBytesToText(mine, 'Book.xlsx', 'en-US'),
  });
  const text = workbookBytesToText(base, 'Book.xlsx', 'en-US');
  assert.deepEqual(resolveDiffTexts(source(base, base.slice()), 'en-US'), { baseText: text, mineText: text });
  assert.match(text, /@@sheet\tSheet1/);
});

test('strict loads reject missing, empty or incomplete worksheet XML', () => {
  const invalidSheets = [
    null,
    '',
    '<worksheet><sheetData><row r="1"/>',
    '<worksheet><row r="1"/></worksheet>',
    '<worksheet><sheetData><row r="1"/></worksheet>',
    '<worksheet><sheetData/><row r="1"/></worksheet>',
    '<worksheet><sheetData><c r="A1"><v>1</v></c></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></row></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1"><row r="2"/></row></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1"><c r="A1"><c r="B1"/></c></row></sheetData></worksheet>',
  ];
  for (const sheetXml of invalidSheets) {
    const bytes = buildWorkbookWithSheetXml(sheetXml);
    assert.throws(() => resolveDiffTexts(source(bytes, bytes), 'en-US'), /Failed to parse workbook: Book\.xlsx/);
  }
  const legacyMissingEntry = buildWorkbookWithSheetXml(null);
  assert.equal(workbookBytesToText(legacyMissingEntry, 'Book.xlsx', 'en-US'), '@@sheet\tSheet1');
});

test('strict loads preserve empty and self-closing sheetData as valid worksheets', () => {
  for (const sheetData of ['<sheetData/>', '<sheetData />', '<sheetData></sheetData>', '<sheetData>\n </sheetData>']) {
    const bytes = buildWorkbookWithSheetXml(`<worksheet>${sheetData}</worksheet>`);
    assert.deepEqual(resolveDiffTexts(source(bytes, bytes.slice()), 'en-US'), {
      baseText: '@@sheet\tSheet1', mineText: '@@sheet\tSheet1',
    });
  }
});

test('strict loads retain legacy chart-sheet markers while still rejecting damaged worksheets', () => {
  const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const chartXml = `<chartsheet xmlns="${namespace}" xmlns:r="${relationshipNamespace}"><sheetViews><sheetView workbookViewId="0"/></sheetViews><drawing r:id="rIdDrawing"/></chartsheet>`;
  assert.equal(XMLValidator.validate(chartXml), true);
  for (const chartType of [
    `${relationshipNamespace}/chartsheet`,
    'http://purl.oclc.org/ooxml/officeDocument/relationships/chartsheet',
  ]) {
    const buildMixedWorkbook = (worksheetXml: string | null) => zipSync({
      'xl/workbook.xml': strToU8(`<workbook xmlns="${namespace}" xmlns:r="${relationshipNamespace}"><sheets><sheet name="Chart" sheetId="1" r:id="rIdChart"/><sheet name="Data" sheetId="2" r:id="rIdData"/></sheets></workbook>`),
      'xl/_rels/workbook.xml.rels': strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdChart" Type="${chartType}" Target="chartsheets/sheet1.xml"/><Relationship Id="rIdData" Type="${relationshipNamespace}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`),
      'xl/chartsheets/sheet1.xml': strToU8(chartXml),
      'xl/chartsheets/_rels/sheet1.xml.rels': strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDrawing" Type="${relationshipNamespace}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`),
      'xl/drawings/drawing1.xml': strToU8('<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>'),
      ...(worksheetXml == null ? {} : { 'xl/worksheets/sheet2.xml': strToU8(worksheetXml) }),
    });
    const bytes = buildMixedWorkbook(`<worksheet xmlns="${namespace}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Value</t></is></c></row></sheetData></worksheet>`);
    const expected = '@@sheet\tChart\n\n@@sheet\tData\n@@row\t1\tValue';
    assert.equal(workbookBytesToText(bytes, 'Book.xlsx', 'en-US'), expected);
    assert.deepEqual(resolveDiffTexts(source(bytes, bytes.slice()), 'en-US'), {
      baseText: expected, mineText: expected,
    });
    for (const damagedSheet of [null, '', '<worksheet><sheetData><row r="1"/></worksheet>']) {
      const damaged = buildMixedWorkbook(damagedSheet);
      assert.throws(() => resolveDiffTexts(source(damaged, damaged), 'en-US'), /Failed to parse workbook: Book\.xlsx/);
    }
  }
});

test('strict loads preserve UTF-8 shared strings, inline values and formulas', () => {
  const bytes = buildWorkbookWithSheetXml(
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t> 空格🎯 </t></is></c><c r="C1"><f>SUM(A2:A3)</f><v>42</v></c></row></sheetData></worksheet>',
    '<sst><si><t>标题🧪</t></si></sst>',
  );
  const expected = workbookBytesToText(bytes, 'Book.xlsx', 'en-US');
  const resolved = resolveDiffTexts(source(bytes, bytes.slice()), 'en-US');
  assert.deepEqual(resolved, { baseText: expected, mineText: expected });
  assert.match(expected, /标题🧪/);
  assert.match(expected, / 空格🎯 /);
  assert.match(expected, /=SUM\(A2:A3\)/);
  assert.match(expected, /42/);
});

test('strict integrity checks preserve supported legal XML wrappers and literal markup', () => {
  const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const populatedRow = '<sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData>';
  const fixtures = [
    ['CDATA', `<worksheet xmlns="${namespace}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t><![CDATA[<row>literal<c>]]></t></is></c></row></sheetData></worksheet>`],
    ['cell comment', `<worksheet xmlns="${namespace}"><sheetData><row r="1"><c r="A1"><v>42</v><!-- <c> legitimate comment --></c></row></sheetData></worksheet>`],
    ['closing whitespace', `<worksheet xmlns="${namespace}">${populatedRow}</worksheet >`],
    ['qualified worksheet', `<x:worksheet xmlns:x="${namespace}" xmlns="${namespace}">${populatedRow}</x:worksheet>`],
    ['processing instruction', `<worksheet xmlns="${namespace}"><sheetData><row r="1"><c r="A1"><v>42</v><?note <row>literal<c> ?></c></row></sheetData></worksheet>`],
  ];
  for (const [name, sheetXml] of fixtures) {
    assert.equal(XMLValidator.validate(sheetXml!), true, name);
    const bytes = buildWorkbookWithSheetXml(sheetXml!);
    const expected = workbookBytesToText(bytes, 'Book.xlsx', 'en-US');
    assert.equal(expected.split('\n').length, 2, name);
    assert.deepEqual(resolveDiffTexts(source(bytes, bytes.slice()), 'en-US'), {
      baseText: expected, mineText: expected,
    }, name);
  }
});

test('decoder returning empty or truncated XML cannot silently turn a populated sheet into an empty one', (context) => {
  const valid = buildWorkbook('Populated');
  const originalDecode = TextDecoder.prototype.decode;
  for (const decodedSheet of ['', '<worksheet><sheetData><row r="1"/>', '<worksheet><sheetData><row r="1"/></worksheet>']) {
    const mockedDecode = context.mock.method(TextDecoder.prototype, 'decode', function (
      this: TextDecoder,
      ...args: Parameters<TextDecoder['decode']>
    ) {
      const decoded = originalDecode.apply(this, args);
      return decoded.startsWith('<worksheet>') ? decodedSheet : decoded;
    });
    try {
      // This is the former silent failure: a populated sheet becomes only its header.
      assert.equal(workbookBytesToText(valid, 'Book.xlsx', 'en-US'), '@@sheet\tSheet1');
      assert.throws(() => resolveDiffTexts(source(valid, valid), 'en-US'), /Worksheet (XML is (empty or could not be decoded|incomplete)|sheetData is missing or incomplete)/);
    } finally {
      mockedDecode.mock.restore();
    }
  }
});
