/** Small-fixture OpenXML semantic oracle; never part of the desktop parsing pipeline. */
import { XMLParser } from 'fast-xml-parser';
import { strFromU8, unzipSync } from 'fflate';
import { getRuntimeLocale, translate, type Locale } from '@/i18n/core';
import type { WorkbookCellDisplay } from '@/utils/workbook/workbookDisplay';
import { createWorkbookRowLine, createWorkbookSheetLine } from '@/utils/workbook/workbookDisplay';
import {
  normalizeWorkbookRowNumber,
  parseWorkbookColumnIndexFromCellRef,
} from '@/utils/workbook/workbookLimits';

const WORKBOOK_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xltx', '.xltm', '.xlsb', '.xls']);
const ZIP_WORKBOOK_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xltx', '.xltm']);
const CHARTSHEET_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/chartsheet',
]);
const textDecoder = new TextDecoder('utf-8');
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  textNodeName: '#text',
  trimValues: false,
  processEntities: false,
  htmlEntities: false,
});

type XmlNode = Record<string, unknown>;
interface ScannedXmlElement {
  startTag: string;
  body: string;
}
interface OpaqueXmlRange {
  start: number;
  end: number;
}

function asXmlNode(value: unknown): XmlNode | null {
  return value != null && typeof value === 'object' ? value as XmlNode : null;
}

function asXmlNodeArray(value: unknown): XmlNode[] {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(asXmlNode).filter((item): item is XmlNode => item != null);
}

function getXmlString(node: XmlNode | null, key: string): string {
  const value = node?.[key];
  return typeof value === 'string' ? value : '';
}

function getFileExtension(name: string): string {
  const normalized = name.trim().toLowerCase();
  const idx = normalized.lastIndexOf('.');
  return idx >= 0 ? normalized.slice(idx) : '';
}

function isWorkbookFileName(name: string): boolean {
  return WORKBOOK_EXTENSIONS.has(getFileExtension(name));
}

function isZipWorkbookFileName(name: string): boolean {
  return ZIP_WORKBOOK_EXTENSIONS.has(getFileExtension(name));
}

function decodeUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left === right) return true;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function getZipEntry(zip: Record<string, Uint8Array>, entryPath: string): Uint8Array | null {
  if (zip[entryPath]) return zip[entryPath];
  const normalized = entryPath.replace(/\\/g, '/');
  return zip[normalized] ?? null;
}

function parseXml(zip: Record<string, Uint8Array>, entryPath: string): XmlNode | null {
  const entry = getZipEntry(zip, entryPath);
  if (!entry) return null;
  return asXmlNode(xmlParser.parse(strFromU8(entry)));
}

function normalizeWorksheetPath(target: string): string {
  const trimmed = target.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/')) return trimmed.slice(1);
  if (trimmed.startsWith('xl/')) return trimmed;
  return `xl/${trimmed}`;
}

function normalizeCellValue(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, ' / ')
    .replace(/\t/g, '    ');
}

function isXmlNameBoundary(char: string): boolean {
  return char === ''
    || char === ' '
    || char === '\n'
    || char === '\r'
    || char === '\t'
    || char === '/'
    || char === '>';
}

function isXmlWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

function collectOpaqueXmlRanges(xml: string): OpaqueXmlRange[] {
  const ranges: OpaqueXmlRange[] = [];
  const pattern = /<!--|<!\[CDATA\[|<\?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) != null) {
    const terminator = match[0] === '<!--' ? '-->' : match[0] === '<![CDATA[' ? ']]>' : '?>';
    const close = xml.indexOf(terminator, pattern.lastIndex);
    if (close < 0) throw new Error('Incomplete XML comment, CDATA or processing instruction');
    const end = close + terminator.length;
    ranges.push({ start: match.index, end });
    pattern.lastIndex = end;
  }
  return ranges;
}

function skipOpaqueXmlIndex(index: number, ranges: readonly OpaqueXmlRange[]): number {
  let left = 0;
  let right = ranges.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    const range = ranges[middle]!;
    if (index < range.start) right = middle;
    else if (index >= range.end) left = middle + 1;
    else return range.end;
  }
  return index;
}

function findXmlTagStart(
  xml: string,
  tagName: string,
  fromIndex: number,
  opaqueRanges: readonly OpaqueXmlRange[] = [],
): number {
  const needle = `<${tagName}`;
  let cursor = Math.max(0, fromIndex);

  while (cursor < xml.length) {
    const index = xml.indexOf(needle, cursor);
    if (index < 0) return -1;
    const afterOpaque = skipOpaqueXmlIndex(index, opaqueRanges);
    if (afterOpaque !== index) {
      cursor = afterOpaque;
      continue;
    }
    if (isXmlNameBoundary(xml[index + needle.length] ?? '')) {
      return index;
    }
    cursor = index + needle.length;
  }

  return -1;
}

function findXmlTagEnd(xml: string, startIndex: number): number {
  let quote: '"' | '\'' | null = null;

  for (let index = startIndex; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }

  return -1;
}

function isSelfClosingXmlStartTag(startTag: string): boolean {
  return startTag.replace(/\s+$/, '').endsWith('/>');
}

function findCompleteXmlClosingTag(
  xml: string,
  tagName: string,
  fromIndex: number,
  opaqueRanges: readonly OpaqueXmlRange[],
): { start: number; end: number } | null {
  const needle = `</${tagName}`;
  let cursor = fromIndex;
  while (cursor < xml.length) {
    const start = xml.indexOf(needle, cursor);
    if (start < 0) return null;
    const afterOpaque = skipOpaqueXmlIndex(start, opaqueRanges);
    if (afterOpaque !== start) {
      cursor = afterOpaque;
      continue;
    }
    let end = start + needle.length;
    while (isXmlWhitespace(xml[end] ?? '')) end += 1;
    if (xml[end] === '>') return { start, end: end + 1 };
    cursor = start + needle.length;
  }
  return null;
}

function getCompleteWorksheetElement(xml: string): ScannedXmlElement | null {
  const opaqueRanges = collectOpaqueXmlRanges(xml);
  const pattern = /<((?:[^<>\s/]+:)?worksheet)(?=[\s/>])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) != null) {
    const afterOpaque = skipOpaqueXmlIndex(match.index, opaqueRanges);
    if (afterOpaque !== match.index) {
      pattern.lastIndex = afterOpaque;
      continue;
    }
    const tagEnd = findXmlTagEnd(xml, match.index);
    if (tagEnd < 0) return null;
    const startTag = xml.slice(match.index, tagEnd + 1);
    if (isSelfClosingXmlStartTag(startTag)) return { startTag, body: '' };
    const close = findCompleteXmlClosingTag(xml, match[1]!, tagEnd + 1, opaqueRanges);
    if (!close) return null;
    return { startTag, body: xml.slice(tagEnd + 1, close.start) };
  }
  return null;
}

function scanXmlElements(
  xml: string,
  tagName: string,
  visit: (element: ScannedXmlElement) => void,
  requireComplete = false,
): void {
  const closeNeedle = `</${tagName}>`;
  const opaqueRanges = requireComplete ? collectOpaqueXmlRanges(xml) : [];
  let cursor = 0;

  while (cursor < xml.length) {
    const start = findXmlTagStart(xml, tagName, cursor, opaqueRanges);
    if (start < 0) return;

    const tagEnd = findXmlTagEnd(xml, start);
    if (tagEnd < 0) {
      if (requireComplete) throw new Error(`Incomplete XML element <${tagName}>`);
      return;
    }

    const startTag = xml.slice(start, tagEnd + 1);
    if (isSelfClosingXmlStartTag(startTag)) {
      visit({ startTag, body: '' });
      cursor = tagEnd + 1;
      continue;
    }

    const bodyStart = tagEnd + 1;
    const completeClose = requireComplete
      ? findCompleteXmlClosingTag(xml, tagName, bodyStart, opaqueRanges)
      : null;
    const close = requireComplete ? completeClose?.start ?? -1 : xml.indexOf(closeNeedle, bodyStart);
    if (close < 0) {
      if (requireComplete) throw new Error(`Incomplete XML element <${tagName}>`);
      return;
    }
    if (requireComplete) {
      const nestedStart = findXmlTagStart(xml, tagName, bodyStart, opaqueRanges);
      if (nestedStart >= 0 && nestedStart < close) {
        throw new Error(`Incomplete XML element <${tagName}>`);
      }
    }

    visit({
      startTag,
      body: xml.slice(bodyStart, close),
    });
    cursor = completeClose?.end ?? close + closeNeedle.length;
  }
}

function getFirstXmlElementBody(xml: string, tagName: string): string {
  const element = getFirstXmlElement(xml, tagName);
  return element?.body ?? '';
}

function getFirstXmlElement(xml: string, tagName: string, requireComplete = false): ScannedXmlElement | null {
  const opaqueRanges = requireComplete ? collectOpaqueXmlRanges(xml) : [];
  const start = findXmlTagStart(xml, tagName, 0, opaqueRanges);
  if (start < 0) return null;

  const tagEnd = findXmlTagEnd(xml, start);
  if (tagEnd < 0) return null;

  const startTag = xml.slice(start, tagEnd + 1);
  if (isSelfClosingXmlStartTag(startTag)) {
    return { startTag, body: '' };
  }

  const close = requireComplete
    ? findCompleteXmlClosingTag(xml, tagName, tagEnd + 1, opaqueRanges)?.start ?? -1
    : xml.indexOf(`</${tagName}>`, tagEnd + 1);
  if (close < 0) return null;
  return {
    startTag,
    body: xml.slice(tagEnd + 1, close),
  };
}

function visitXmlAttributes(
  startTag: string,
  visit: (name: string, value: string) => boolean | void,
): void {
  let cursor = 1;

  while (cursor < startTag.length) {
    while (cursor < startTag.length && isXmlWhitespace(startTag[cursor] ?? '')) {
      cursor += 1;
    }
    if (cursor >= startTag.length || startTag[cursor] === '/' || startTag[cursor] === '>') {
      return;
    }

    const nameStart = cursor;
    while (
      cursor < startTag.length
      && !isXmlWhitespace(startTag[cursor] ?? '')
      && startTag[cursor] !== '='
      && startTag[cursor] !== '/'
      && startTag[cursor] !== '>'
    ) {
      cursor += 1;
    }

    const name = startTag.slice(nameStart, cursor);
    while (cursor < startTag.length && isXmlWhitespace(startTag[cursor] ?? '')) {
      cursor += 1;
    }

    if (startTag[cursor] !== '=') {
      continue;
    }
    cursor += 1;

    while (cursor < startTag.length && isXmlWhitespace(startTag[cursor] ?? '')) {
      cursor += 1;
    }

    const quote = startTag[cursor];
    let value = '';
    if (quote === '"' || quote === '\'') {
      cursor += 1;
      const valueStart = cursor;
      while (cursor < startTag.length && startTag[cursor] !== quote) {
        cursor += 1;
      }
      value = startTag.slice(valueStart, cursor);
      if (startTag[cursor] === quote) cursor += 1;
    } else {
      const valueStart = cursor;
      while (
        cursor < startTag.length
        && !isXmlWhitespace(startTag[cursor] ?? '')
        && startTag[cursor] !== '/'
        && startTag[cursor] !== '>'
      ) {
        cursor += 1;
      }
      value = startTag.slice(valueStart, cursor);
    }

    if (visit(name, value)) return;
  }
}

function getXmlAttribute(startTag: string, attributeName: string): string {
  let matchedValue = '';

  visitXmlAttributes(startTag, (name, value) => {
    if (name !== attributeName) return false;
    matchedValue = value;
    return true;
  });

  return matchedValue;
}

function getCellXmlAttributes(startTag: string): { ref: string; type: string } {
  let ref = '';
  let type = '';

  visitXmlAttributes(startTag, (name, value) => {
    if (name === 'r') ref = value;
    if (name === 't') type = value;
    return Boolean(ref && type);
  });

  return { ref, type };
}

function collectOpenXmlTextFromTextRuns(xml: string): string {
  let output = '';

  scanXmlElements(xml, 't', ({ body }) => {
    output += body;
  });

  return output;
}

function collectFormulaTextFromScannedCell(cellBody: string): string {
  const formulaElement = getFirstXmlElement(cellBody, 'f');
  if (!formulaElement) return '';
  if (formulaElement.body !== '') return formulaElement.body;
  return getXmlAttribute(formulaElement.startTag, 't');
}

function buildUnsupportedWorkbookMessage(fileName: string, locale: Locale): string {
  const ext = getFileExtension(fileName) || translate(locale, 'commonUnknown');
  return [
    `[${translate(locale, 'workbookParserHeader')}]`,
    translate(locale, 'workbookParserUnsupportedFormat', { ext }),
    translate(locale, 'workbookParserSupportedFormatsHint'),
    translate(locale, 'workbookParserRustHint'),
  ].join('\n');
}

function buildWorkbookErrorMessage(fileName: string, error: unknown, locale: Locale): string {
  const message = error instanceof Error ? error.message : String(error);
  const resolvedFileName = fileName || translate(locale, 'commonUnknown');
  return [
    `[${translate(locale, 'workbookParserHeader')}]`,
    translate(locale, 'workbookParserFailed', { fileName: resolvedFileName }),
    message,
  ].join('\n');
}

function parseSharedStrings(zip: Record<string, Uint8Array>): string[] {
  const entry = getZipEntry(zip, 'xl/sharedStrings.xml');
  if (!entry) return [];

  const sharedStrings: string[] = [];
  scanXmlElements(strFromU8(entry), 'si', ({ body }) => {
    sharedStrings.push(normalizeCellValue(collectOpenXmlTextFromTextRuns(body)));
  });
  return sharedStrings;
}

function parseScannedCellValue(
  cellStartTag: string,
  cellBody: string,
  sharedStrings: string[],
): WorkbookCellDisplay {
  const { type } = getCellXmlAttributes(cellStartTag);
  const rawValue = normalizeCellValue(getFirstXmlElementBody(cellBody, 'v'));
  const formula = normalizeCellValue(collectFormulaTextFromScannedCell(cellBody));

  const value = type === 's'
    ? (() => {
      const index = Number(rawValue.trim());
      return Number.isFinite(index) ? normalizeCellValue(sharedStrings[index] ?? '') : rawValue;
    })()
    : type === 'inlineStr'
      ? normalizeCellValue(collectOpenXmlTextFromTextRuns(getFirstXmlElementBody(cellBody, 'is')))
      : type === 'b'
        ? (rawValue === '1' ? 'TRUE' : 'FALSE')
        : type === 'e'
          ? (rawValue ? `#${rawValue}` : '#ERROR')
          : rawValue;

  if (formula) {
    const normalizedFormula = `=${formula}`;
    return {
      value,
      formula: normalizedFormula,
    };
  }

  return { value, formula: '' };
}

function parseWorkbookSheets(zip: Record<string, Uint8Array>): { name: string; path: string; isChartSheet: boolean }[] {
  const workbookXml = parseXml(zip, 'xl/workbook.xml');
  const relsXml = parseXml(zip, 'xl/_rels/workbook.xml.rels');
  const relationships = asXmlNodeArray(asXmlNode(relsXml?.Relationships)?.Relationship);
  const relMap = new Map<string, string>();
  const chartSheetRelationshipIds = new Set<string>();

  relationships.forEach(rel => {
    const id = getXmlString(rel, 'Id');
    const target = getXmlString(rel, 'Target');
    if (id && target) {
      relMap.set(id, normalizeWorksheetPath(target));
      if (CHARTSHEET_RELATIONSHIP_TYPES.has(getXmlString(rel, 'Type'))) chartSheetRelationshipIds.add(id);
    }
  });

  return asXmlNodeArray(asXmlNode(asXmlNode(workbookXml?.workbook)?.sheets)?.sheet)
    .filter((sheet) => {
      const state = getXmlString(sheet, 'state').trim().toLowerCase();
      return state !== 'hidden' && state !== 'veryhidden';
    })
    .map((sheet, index) => {
      const sheetName = getXmlString(sheet, 'name') || `Sheet${index + 1}`;
      const relId = getXmlString(sheet, 'r:id');
      const sheetPath = relMap.get(relId) ?? `xl/worksheets/sheet${index + 1}.xml`;
      return { name: sheetName, path: sheetPath, isChartSheet: chartSheetRelationshipIds.has(relId) };
    })
    .filter(sheet => Boolean(sheet.path));
}

function serializeWorkbookSheet(
  zip: Record<string, Uint8Array>,
  sheetName: string,
  sheetPath: string,
  sharedStrings: string[],
  requireComplete: boolean,
): string[] {
  const output: string[] = [createWorkbookSheetLine(sheetName)];
  const sheetEntry = getZipEntry(zip, sheetPath);
  if (!sheetEntry) {
    if (requireComplete) throw new Error(`Worksheet XML is missing: ${sheetPath}`);
    return output;
  }

  const sheetXml = strFromU8(sheetEntry);
  let worksheetBody = sheetXml;
  if (requireComplete) {
    if (!sheetXml) throw new Error(`Worksheet XML is empty or could not be decoded: ${sheetPath}`);
    const worksheet = getCompleteWorksheetElement(sheetXml);
    if (!worksheet) throw new Error(`Worksheet XML is incomplete: ${sheetPath}`);
    worksheetBody = worksheet.body;
  }
  const sheetDataElement = getFirstXmlElement(worksheetBody, 'sheetData', requireComplete);
  if (requireComplete && !sheetDataElement) {
    throw new Error(`Worksheet sheetData is missing or incomplete: ${sheetPath}`);
  }
  const sheetData = sheetDataElement?.body ?? '';
  if (!sheetData) {
    if (requireComplete && findXmlTagStart(worksheetBody, 'row', 0, collectOpaqueXmlRanges(worksheetBody)) >= 0) {
      throw new Error(`Worksheet rows are outside sheetData: ${sheetPath}`);
    }
    return output;
  }

  let rowIndex = 0;
  scanXmlElements(sheetData, 'row', (row) => {
    rowIndex += 1;
    const rowNumber = normalizeWorkbookRowNumber(getXmlAttribute(row.startTag, 'r'), rowIndex);
    let fallbackColumnIndex = 0;
    const cells: Array<{ colIndex: number; value: WorkbookCellDisplay }> = [];

    scanXmlElements(row.body, 'c', (cell) => {
      const { ref } = getCellXmlAttributes(cell.startTag);
      const colIndex = ref
        ? parseWorkbookColumnIndexFromCellRef(ref)
        : fallbackColumnIndex;
      if (colIndex == null) return;

      fallbackColumnIndex = colIndex + 1;
      const value = parseScannedCellValue(cell.startTag, cell.body, sharedStrings);
      if (value.value !== '' || value.formula !== '') {
        cells.push({ colIndex, value });
      }
    }, requireComplete);

    cells.sort((left, right) => left.colIndex - right.colIndex);

    const maxCol = (cells[cells.length - 1]?.colIndex ?? -1) + 1;
    const rowValues: Array<string | WorkbookCellDisplay> = [];
    for (let columnIndex = 0; columnIndex < Math.max(0, maxCol); columnIndex += 1) {
      rowValues.push('');
    }
    cells.forEach(cell => {
      rowValues[cell.colIndex] = cell.value.formula ? cell.value : cell.value.value;
    });
    output.push(createWorkbookRowLine(rowNumber, rowValues));
  }, requireComplete);

  if (requireComplete && rowIndex === 0 && findXmlTagStart(sheetData, 'c', 0, collectOpaqueXmlRanges(sheetData)) >= 0) {
    throw new Error(`Worksheet cells are outside rows: ${sheetPath}`);
  }

  return output;
}

export function workbookBytesToText(
  bytes: Uint8Array,
  fileName: string,
  locale: Locale = getRuntimeLocale(),
  options: { throwOnParseError?: boolean } = {},
): string {
  if (!isZipWorkbookFileName(fileName)) {
    return buildUnsupportedWorkbookMessage(fileName, locale);
  }

  try {
    const zip = unzipSync(bytes);
    const sheets = parseWorkbookSheets(zip);
    const sharedStrings = parseSharedStrings(zip);

    if (sheets.length === 0) {
      return [
        `[${translate(locale, 'workbookParserHeader')}]`,
        translate(locale, 'workbookParserNoWorksheets', {
          fileName: fileName || translate(locale, 'commonUnknown'),
        }),
      ].join('\n');
    }

    return sheets
      .flatMap((sheet, index) => {
        const lines = serializeWorkbookSheet(
          zip, sheet.name, sheet.path, sharedStrings,
          options.throwOnParseError === true && !sheet.isChartSheet,
        );
        if (index < sheets.length - 1) lines.push('');
        return lines;
      })
      .join('\n');
  } catch (error) {
    const message = buildWorkbookErrorMessage(fileName, error, locale);
    if (options.throwOnParseError) throw new Error(message);
    return message;
  }
}

export interface DiffTextSourceInput {
  baseName: string;
  mineName: string;
  fileName: string;
  baseContent: string | null;
  mineContent: string | null;
  baseBytes: Uint8Array | null;
  mineBytes: Uint8Array | null;
}

function normalizeSideText(
  name: string,
  fallbackName: string,
  content: string | null,
  bytes: Uint8Array | null,
  locale: Locale,
): string {
  if (content != null && content !== '') {
    return content;
  }
  if (bytes && bytes.byteLength > 0) {
    const workbookName = [name, fallbackName].find(isWorkbookFileName) ?? (name || fallbackName);
    if (workbookName && isWorkbookFileName(workbookName)) {
      // Parser diagnostics must not become ordinary text or an equal comparison.
      return workbookBytesToText(bytes, workbookName, locale, { throwOnParseError: true });
    }
    return decodeUtf8(bytes);
  }
  return content ?? '';
}

function canReuseBaseTextForMine(data: DiffTextSourceInput): boolean {
  const baseName = data.baseName || data.fileName;
  const mineName = data.mineName || data.fileName;
  if (baseName !== mineName) return false;

  const hasBaseInlineContent = data.baseContent != null && data.baseContent !== '';
  const hasMineInlineContent = data.mineContent != null && data.mineContent !== '';
  if (hasBaseInlineContent || hasMineInlineContent) {
    return data.baseContent === data.mineContent;
  }

  if (!data.baseBytes || !data.mineBytes) return data.baseBytes === data.mineBytes;
  return bytesEqual(data.baseBytes, data.mineBytes);
}

export function resolveDiffTexts(data: DiffTextSourceInput, locale: Locale = getRuntimeLocale()): { baseText: string; mineText: string } {
  const baseText = normalizeSideText(
    data.baseName,
    data.fileName,
    data.baseContent,
    data.baseBytes,
    locale,
  );
  if (canReuseBaseTextForMine(data)) {
    return {
      baseText,
      mineText: baseText,
    };
  }

  return {
    baseText,
    mineText: normalizeSideText(
      data.mineName,
      data.fileName,
      data.mineContent,
      data.mineBytes,
      locale,
    ),
  };
}
