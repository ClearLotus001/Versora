import test from 'node:test';
import assert from 'node:assert/strict';

import { strToU8, zipSync } from 'fflate';

import { workbookBytesToText } from './fixtures/workbookSourceOracle';
import { parseWorkbookDisplayLine } from '../src/utils/workbook/workbookDisplay';
import { parseWorkbookMetadata } from './fixtures/workbookMetadataOracle';

function buildWorkbookZipWithOutOfBoundsRefs() {
  return zipSync({
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="Bounds" sheetId="1" r:id="rId1" />
        </sheets>
      </workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml" />
      </Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <worksheet>
        <cols>
          <col min="16384" max="16390" hidden="1" />
          <col min="16385" max="16386" hidden="1" />
        </cols>
        <mergeCells count="3">
          <mergeCell ref="C3:D4" />
          <mergeCell ref="A1:XFE2" />
          <mergeCell ref="B4:A3" />
        </mergeCells>
        <sheetData>
          <row r="999999999">
            <c r="A1" t="inlineStr"><is><t>OK</t></is></c>
            <c r="XFE1" t="inlineStr"><is><t>OUT_OF_BOUNDS</t></is></c>
          </row>
        </sheetData>
      </worksheet>`),
  });
}

test('workbookBytesToText ignores cells with out-of-bounds refs and falls back to safe row numbers', () => {
  const bytes = buildWorkbookZipWithOutOfBoundsRefs();
  const text = workbookBytesToText(bytes, 'bounds.xlsx');
  const row = text
    .split('\n')
    .map(parseWorkbookDisplayLine)
    .find((line) => line?.kind === 'row');

  assert.ok(row && row.kind === 'row');
  assert.equal(row.rowNumber, 1);
  assert.deepEqual(row.cells, [{ value: 'OK', formula: '' }]);
});

test('parseWorkbookMetadata clamps hidden column ranges and ignores invalid merge refs', () => {
  const bytes = buildWorkbookZipWithOutOfBoundsRefs();
  const metadata = parseWorkbookMetadata(bytes, 'bounds.xlsx');

  assert.ok(metadata);
  const boundsSheet = metadata.sheets.Bounds;
  assert.ok(boundsSheet);
  assert.deepEqual(boundsSheet.hiddenColumns, [16383]);
  assert.deepEqual(boundsSheet.mergeRanges, [
    {
      startRow: 3,
      endRow: 4,
      startCol: 2,
      endCol: 3,
    },
  ]);
});
