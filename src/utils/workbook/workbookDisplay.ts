const WORKBOOK_SHEET_PREFIX = '@@sheet';
const WORKBOOK_ROW_PREFIX = '@@row';
export const WORKBOOK_CELL_WIDTH = 148;
const WORKBOOK_FORMULA_SEPARATOR = '\u001F';

export interface WorkbookSheetDisplayLine {
  kind: 'sheet';
  sheetName: string;
}

export interface WorkbookCellDisplay {
  value: string;
  formula: string;
}

export interface WorkbookRowDisplayLine {
  kind: 'row';
  rowNumber: number;
  cells: WorkbookCellDisplay[];
}

export type WorkbookDisplayLine = WorkbookSheetDisplayLine | WorkbookRowDisplayLine;
const PARSE_CACHE_LIMIT = 4000;
const parsedDisplayLineCache = new Map<string, WorkbookDisplayLine | null>();
const parsedDiffLineCache = new WeakMap<object, {
  baseText: string | null;
  mineText: string | null;
  base: WorkbookDisplayLine | null;
  mine: WorkbookDisplayLine | null;
}>();

function normalizeWorkbookField(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+/g, ' / ')
    .replace(/\t/g, '    ')
    .replace(/\u001F/g, ' ');
}

export function createWorkbookSheetLine(sheetName: string): string {
  return `${WORKBOOK_SHEET_PREFIX}\t${normalizeWorkbookField(sheetName).trim()}`;
}

function serializeWorkbookCell(cell: string | WorkbookCellDisplay): string {
  if (typeof cell === 'string') return normalizeWorkbookField(cell);

  const value = normalizeWorkbookField(cell.value);
  const formula = normalizeWorkbookField(cell.formula);
  return formula ? `${value}${WORKBOOK_FORMULA_SEPARATOR}${formula}` : value;
}

function parseWorkbookCell(field: string): WorkbookCellDisplay {
  const separatorIdx = field.indexOf(WORKBOOK_FORMULA_SEPARATOR);
  if (separatorIdx < 0) {
    return { value: field, formula: '' };
  }

  return {
    value: field.slice(0, separatorIdx),
    formula: field.slice(separatorIdx + 1),
  };
}

export function createWorkbookRowLine(rowNumber: number, cells: Array<string | WorkbookCellDisplay>): string {
  const normalizedCells = cells.map(serializeWorkbookCell);
  return `${WORKBOOK_ROW_PREFIX}\t${rowNumber}\t${normalizedCells.join('\t')}`;
}

/**
 * Returns the first offset that contains user-authored workbook content.
 * Keeping the original line intact while searching from this offset preserves
 * match coordinates without exposing the internal sheet/row protocol fields.
 */
export function getWorkbookSearchableContentStart(line: string): number {
  if (line.startsWith(`${WORKBOOK_SHEET_PREFIX}\t`)) return line.length;
  if (!line.startsWith(`${WORKBOOK_ROW_PREFIX}\t`)) return 0;

  const rowNumberEnd = line.indexOf('\t', WORKBOOK_ROW_PREFIX.length + 1);
  return rowNumberEnd >= 0 ? rowNumberEnd + 1 : line.length;
}

export function parseWorkbookDisplayLine(line: string): WorkbookDisplayLine | null {
  if (typeof line !== 'string') return null;
  const cached = parsedDisplayLineCache.get(line);
  if (cached !== undefined) return cached;

  let parsed: WorkbookDisplayLine | null = null;
  if (!line.startsWith('@@')) return null;

  const parts = line.split('\t');
  if (parts[0] === WORKBOOK_SHEET_PREFIX) {
    parsed = {
      kind: 'sheet',
      sheetName: parts.slice(1).join('\t').trim(),
    };
  } else if (parts[0] === WORKBOOK_ROW_PREFIX) {
    const rowNumber = Number(parts[1] ?? 0);
    parsed = {
      kind: 'row',
      rowNumber: Number.isFinite(rowNumber) ? rowNumber : 0,
      cells: parts.slice(2).map(parseWorkbookCell),
    };
  }

  if (parsedDisplayLineCache.size >= PARSE_CACHE_LIMIT) {
    const oldestKey = parsedDisplayLineCache.keys().next().value;
    if (oldestKey) parsedDisplayLineCache.delete(oldestKey);
  }
  parsedDisplayLineCache.set(line, parsed);
  return parsed;
}

/** Retain parsed rows only for the lifetime of their owning diff line. */
export function parseWorkbookDiffLine(
  line: { base: string | null; mine: string | null } | null,
  side?: 'base' | 'mine',
): WorkbookDisplayLine | null {
  if (!line) return null;
  let parsed = parsedDiffLineCache.get(line);
  if (!parsed || parsed.baseText !== line.base || parsed.mineText !== line.mine) {
    const base = line.base != null ? parseWorkbookDisplayLine(line.base) : null;
    parsed = {
      baseText: line.base,
      mineText: line.mine,
      base,
      mine: line.mine === line.base
        ? base
        : line.mine != null ? parseWorkbookDisplayLine(line.mine) : null,
    };
    parsedDiffLineCache.set(line, parsed);
  }
  return side === 'base' ? parsed.base : side === 'mine' ? parsed.mine : (
    line.base != null ? parsed.base : parsed.mine
  );
}
