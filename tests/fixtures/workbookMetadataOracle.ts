/** Small-fixture metadata oracle; production metadata comes from the Rust artifact. */
import { XMLParser } from 'fast-xml-parser';
import { strFromU8, unzipSync } from 'fflate';
import type { WorkbookMergeRange, WorkbookMetadataMap, WorkbookSheetMetadata } from '@/types';
import { normalizeWorkbookColumnRange, parseWorkbookColumnIndexFromCellRef, parseWorkbookRowNumberFromCellRef } from '@/utils/workbook/workbookLimits';
const ZIP_WORKBOOK_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xltx', '.xltm']);
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, textNodeName: '#text', trimValues: false, processEntities: false, htmlEntities: false });
type XmlNode = Record<string, unknown>;

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

function isZipWorkbookFileName(name: string): boolean {
  return ZIP_WORKBOOK_EXTENSIONS.has(getFileExtension(name));
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

function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true';
  }
  return false;
}

function parseWorkbookSheets(zip: Record<string, Uint8Array>): { name: string; path: string }[] {
  const workbookXml = parseXml(zip, 'xl/workbook.xml');
  const relsXml = parseXml(zip, 'xl/_rels/workbook.xml.rels');
  const relationships = asXmlNodeArray(asXmlNode(relsXml?.Relationships)?.Relationship);
  const relMap = new Map<string, string>();

  relationships.forEach(rel => {
    const id = getXmlString(rel, 'Id');
    const target = getXmlString(rel, 'Target');
    if (id && target) relMap.set(id, normalizeWorksheetPath(target));
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
      return { name: sheetName, path: sheetPath };
    })
    .filter(sheet => Boolean(sheet.path));
}

function parseMergeRange(ref: string): WorkbookMergeRange | null {
  const [startRef, endRef] = ref.split(':');
  if (!startRef) return null;
  const resolvedEndRef = endRef || startRef;
  const startRow = parseWorkbookRowNumberFromCellRef(startRef);
  const endRow = parseWorkbookRowNumberFromCellRef(resolvedEndRef);
  const startCol = parseWorkbookColumnIndexFromCellRef(startRef);
  const endCol = parseWorkbookColumnIndexFromCellRef(resolvedEndRef);
  if (startRow == null || endRow == null || startCol == null || endCol == null) return null;
  if (endRow < startRow || endCol < startCol) return null;

  return {
    startRow,
    endRow,
    startCol,
    endCol,
  };
}

function parseSheetMetadata(
  zip: Record<string, Uint8Array>,
  sheetName: string,
  sheetPath: string,
): WorkbookSheetMetadata {
  const sheetXml = parseXml(zip, sheetPath);
  const hiddenColumns = new Set<number>();
  const mergeRanges: WorkbookMergeRange[] = [];

  asXmlNodeArray(asXmlNode(sheetXml?.worksheet)?.cols)
    .flatMap(cols => asXmlNodeArray(cols.col))
    .forEach(col => {
      if (!isTruthyFlag(col.hidden)) return;
      const range = normalizeWorkbookColumnRange(col.min, col.max);
      if (!range) return;
      for (let colIndex = range.min - 1; colIndex <= range.max - 1; colIndex += 1) {
        hiddenColumns.add(colIndex);
      }
    });

  asXmlNodeArray(asXmlNode(asXmlNode(sheetXml?.worksheet)?.mergeCells)?.mergeCell)
    .map(mergeCell => getXmlString(mergeCell, 'ref'))
    .filter(Boolean)
    .forEach(ref => {
      const parsed = parseMergeRange(ref);
      if (parsed) mergeRanges.push(parsed);
    });

  return {
    name: sheetName,
    hiddenColumns: [...hiddenColumns].sort((left, right) => left - right),
    mergeRanges,
  };
}

export function parseWorkbookMetadata(bytes: Uint8Array | null, fileName: string): WorkbookMetadataMap | null {
  if (!bytes || bytes.length === 0 || !isZipWorkbookFileName(fileName)) return null;

  try {
    const zip = unzipSync(bytes);
    const sheets = parseWorkbookSheets(zip);
    const metadata: WorkbookMetadataMap = { sheets: {} };

    sheets.forEach(sheet => {
      metadata.sheets[sheet.name] = parseSheetMetadata(zip, sheet.name, sheet.path);
    });

    return metadata;
  } catch {
    return null;
  }
}

