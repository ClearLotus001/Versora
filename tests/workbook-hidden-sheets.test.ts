import test from 'node:test';
import assert from 'node:assert/strict';

import { zipSync, strToU8 } from 'fflate';

import { workbookBytesToText } from './fixtures/workbookSourceOracle';
import { parseWorkbookMetadata } from './fixtures/workbookMetadataOracle';

function buildWorkbookZipWithHiddenSheet() {
  const files = {
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="Visible" sheetId="1" r:id="rId1" />
          <sheet name="Sheet2" sheetId="2" state="hidden" r:id="rId2" />
        </sheets>
      </workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml" />
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml" />
      </Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <worksheet>
        <sheetData>
          <row r="1">
            <c r="A1" t="inlineStr"><is><t>ID</t></is></c>
          </row>
        </sheetData>
      </worksheet>`),
    'xl/worksheets/sheet2.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <worksheet>
        <sheetData>
          <row r="1">
            <c r="A1" t="inlineStr"><is><t>HIDDEN</t></is></c>
          </row>
        </sheetData>
      </worksheet>`),
  };

  return zipSync(files);
}

test('workbookBytesToText ignores hidden sheets', () => {
  const bytes = buildWorkbookZipWithHiddenSheet();
  const text = workbookBytesToText(bytes, 'hidden-sheet.xlsx');

  assert.match(text, /@@sheet\tVisible/);
  assert.doesNotMatch(text, /@@sheet\tSheet2/);
  assert.doesNotMatch(text, /HIDDEN/);
});

test('parseWorkbookMetadata ignores hidden sheets', () => {
  const bytes = buildWorkbookZipWithHiddenSheet();
  const metadata = parseWorkbookMetadata(bytes, 'hidden-sheet.xlsx');

  assert.ok(metadata);
  assert.deepEqual(Object.keys(metadata.sheets), ['Visible']);
});
