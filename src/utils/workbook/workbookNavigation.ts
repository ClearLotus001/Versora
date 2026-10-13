import type {
  DiffLine,
  SearchMatch,
  SplitRow,
  WorkbookMoveDirection,
  WorkbookSearchTarget,
  WorkbookSelectedCell,
} from '@/types';
import type { WorkbookCellDisplay, WorkbookRowDisplayLine } from '@/utils/workbook/workbookDisplay';
import { parseWorkbookDiffLine, parseWorkbookDisplayLine } from '@/utils/workbook/workbookDisplay';
import type { WorkbookLineSheetContext, WorkbookSection } from '@/utils/workbook/workbookSections';
import type { WorkbookMergeRange } from '@/utils/workbook/workbookMeta';
import { findWorkbookMergeRange } from '@/utils/workbook/workbookMergeLayout';

export interface WorkbookRowEntry {
  sheetName: string;
  side: 'base' | 'mine';
  versionLabel: string;
  rowNumber: number;
  cells: WorkbookCellDisplay[];
  visibleColumns: number[];
  lineIdxs: number[];
  artifactRow?: import('@/utils/workbook/workbookArtifactProvider').WorkbookArtifactRowReference;
  loadedColumns?: ReadonlySet<number>;
}

function normalizeRowCells(cells: WorkbookCellDisplay[]): WorkbookCellDisplay[] {
  return cells.length > 0 ? cells : [{ value: '', formula: '' }];
}

function parseWorkbookRow(line: DiffLine | null, side?: 'base' | 'mine'): WorkbookRowDisplayLine | null {
  const parsed = parseWorkbookDiffLine(line, side);
  return parsed?.kind === 'row' ? parsed : null;
}

interface CachedSplitRowParse {
  base?: WorkbookRowDisplayLine | null;
  mine?: WorkbookRowDisplayLine | null;
  rowNumber?: number | null;
}

const splitRowParseCache = new WeakMap<SplitRow, CachedSplitRowParse>();

function getCachedSplitRowParse(row: SplitRow): CachedSplitRowParse {
  let cached = splitRowParseCache.get(row);
  if (!cached) {
    cached = {};
    splitRowParseCache.set(row, cached);
  }
  return cached;
}

function parseWorkbookSplitRowSide(
  row: SplitRow,
  side: 'base' | 'mine',
): WorkbookRowDisplayLine | null {
  const cached = getCachedSplitRowParse(row);
  const cachedParsed = side === 'base' ? cached.base : cached.mine;
  if (cachedParsed !== undefined) return cachedParsed;

  const parsed = side === 'base'
    ? parseWorkbookRow(row.left, 'base')
    : parseWorkbookRow(row.right, 'mine');

  if (side === 'base') {
    cached.base = parsed;
  } else {
    cached.mine = parsed;
  }
  return parsed;
}

export function getWorkbookSplitRowNumber(row: SplitRow): number | null {
  if (row.workbookArtifactRow) return row.workbookArtifactRow.baseRowNumber ?? row.workbookArtifactRow.mineRowNumber;
  const cached = getCachedSplitRowParse(row);
  if (cached.rowNumber !== undefined) return cached.rowNumber;

  const leftParsed = parseWorkbookRow(row.left);
  if (leftParsed) {
    cached.rowNumber = leftParsed.rowNumber;
    return leftParsed.rowNumber;
  }

  const rightParsed = row.right?.mine != null
    ? parseWorkbookRow(row.right, 'mine')
    : parseWorkbookRow(row.right, 'base');
  cached.rowNumber = rightParsed?.rowNumber ?? null;
  return cached.rowNumber;
}

export function getWorkbookSideRowNumber(
  row: SplitRow,
  side: 'base' | 'mine',
): number | null {
  if (row.workbookArtifactRow) return side === 'base' ? row.workbookArtifactRow.baseRowNumber : row.workbookArtifactRow.mineRowNumber;
  return parseWorkbookSplitRowSide(row, side)?.rowNumber ?? null;
}

export function buildWorkbookRowEntry(
  row: SplitRow,
  side: 'base' | 'mine',
  sheetName: string,
  versionLabel: string,
  visibleColumns: number[] = [],
): WorkbookRowEntry | null {
  if (row.workbookArtifactRow) return row.workbookArtifactRow.provider.buildEntry(row.workbookArtifactRow, side, versionLabel, visibleColumns);
  const parsed = parseWorkbookSplitRowSide(row, side);

  if (!parsed) return null;

  return {
    sheetName,
    side,
    versionLabel,
    rowNumber: parsed.rowNumber,
    cells: normalizeRowCells(parsed.cells),
    visibleColumns,
    lineIdxs: row.lineIdxs,
  };
}

export function buildWorkbookSelectedCell(
  entry: WorkbookRowEntry,
  requestedColIndex: number,
  mergeRanges: ReadonlyArray<WorkbookMergeRange> = [],
): WorkbookSelectedCell {
  const fallbackColumns = entry.cells.map((_, index) => index);
  const visibleColumns = entry.visibleColumns.length > 0 ? entry.visibleColumns : fallbackColumns;
  const mergeRange = findWorkbookMergeRange(mergeRanges, entry.rowNumber, requestedColIndex);
  const normalizedColumn = mergeRange?.startCol ?? requestedColIndex;
  const clampedColumn = entry.artifactRow && visibleColumns.length === 0
    ? Math.max(0, Math.min(normalizedColumn, entry.artifactRow.provider.descriptor.sheets.find((sheet) => sheet.id === entry.artifactRow!.sheetId)!.maxColumnCount - 1))
    : visibleColumns.includes(normalizedColumn)
    ? normalizedColumn
    : visibleColumns[0] ?? 0;
  const colIndex = Math.max(0, clampedColumn);
  const cell = entry.cells[colIndex] ?? (entry.artifactRow ? entry.artifactRow.provider.readCachedCell(entry.artifactRow, entry.side, colIndex) : undefined) ?? { value: '', formula: '' };
  const colLabel = getWorkbookColumnLabel(colIndex);

  return {
    kind: 'cell',
    sheetName: entry.sheetName,
    side: entry.side,
    versionLabel: entry.versionLabel,
    rowNumber: entry.rowNumber,
    colIndex,
    colLabel,
    address: `${colLabel}${entry.rowNumber}`,
    value: cell.value,
    formula: cell.formula,
    ...(entry.artifactRow ? { dataStatus: entry.artifactRow.provider.getCellStatus(entry.artifactRow, entry.side, colIndex) } : {}),
  };
}

export function resolveWorkbookSearchSide(
  line: DiffLine | null,
): 'base' | 'mine' | null {
  if (!line) return null;
  return line.type === 'delete' || line.mine == null ? 'base' : 'mine';
}

function resolveWorkbookSearchContent(line: DiffLine | null): string {
  if (!line) return '';
  return line.type === 'delete'
    ? (line.base ?? line.mine ?? '')
    : (line.mine ?? line.base ?? '');
}

export function resolveWorkbookSearchMatchColumnIndex(
  line: DiffLine | null,
  match: Pick<SearchMatch, 'start' | 'end'>,
): number | null {
  const content = resolveWorkbookSearchContent(line);
  if (!content) return null;

  const parsed = parseWorkbookDisplayLine(content);
  if (parsed?.kind !== 'row') return null;

  const prefixEnd = content.indexOf('\t', content.indexOf('\t') + 1);
  if (prefixEnd < 0) return null;

  const clampedStart = Math.max(0, Math.min(match.start, content.length - 1));
  if (clampedStart <= prefixEnd) return null;

  let fieldStart = prefixEnd + 1;
  let column = 0;
  while (fieldStart <= content.length) {
    const fieldEnd = content.indexOf('\t', fieldStart);
    const normalizedFieldEnd = fieldEnd >= 0 ? fieldEnd : content.length;
    if (clampedStart < normalizedFieldEnd) return column;
    if (fieldEnd < 0) break;
    fieldStart = normalizedFieldEnd + 1;
    column += 1;
  }

  return parsed.cells.length > 0 ? Math.max(0, parsed.cells.length - 1) : null;
}

export function resolveWorkbookSearchMatchTarget(
  line: DiffLine | null,
  match: Pick<SearchMatch, 'start' | 'end'>,
  context: WorkbookLineSheetContext | null | undefined = null,
): WorkbookSearchTarget | null {
  const side = resolveWorkbookSearchSide(line);
  if (!side) return null;

  const content = resolveWorkbookSearchContent(line);
  if (!content) return null;

  const parsed = parseWorkbookDisplayLine(content);
  const contextSheetName = side === 'base'
    ? (context?.baseSheetName ?? context?.mineSheetName ?? null)
    : (context?.mineSheetName ?? context?.baseSheetName ?? null);

  if (parsed?.kind === 'sheet') {
    return {
      sheetName: parsed.sheetName || contextSheetName,
      side,
      rowNumber: null,
      colIndex: null,
    };
  }

  if (parsed?.kind !== 'row') return null;

  return {
    sheetName: contextSheetName,
    side,
    rowNumber: parsed.rowNumber,
    colIndex: resolveWorkbookSearchMatchColumnIndex(line, match),
  };
}

export function buildWorkbookSearchSelectionFromTarget(
  target: WorkbookSearchTarget | null | undefined,
  rowEntryByRowNumber: {
    base: Map<number, WorkbookRowEntry>;
    mine: Map<number, WorkbookRowEntry>;
  },
  mergeRangesBySide: Partial<Record<'base' | 'mine', ReadonlyArray<WorkbookMergeRange>>> = {},
): WorkbookSelectedCell | null {
  if (!target?.side || target.rowNumber == null) return null;

  const entry = rowEntryByRowNumber[target.side].get(target.rowNumber);
  if (!entry) return null;

  const unclampedEntry = entry.visibleColumns.length > 0
    ? { ...entry, visibleColumns: [] }
    : entry;
  const selection = buildWorkbookSelectedCell(
    unclampedEntry,
    target.colIndex ?? 0,
    mergeRangesBySide[target.side] ?? [],
  );

  if (target.colIndex != null) return selection;

  return {
    ...selection,
    kind: 'row',
    address: String(entry.rowNumber),
    value: '',
    formula: '',
  };
}

export function moveWorkbookSelection(
  entries: WorkbookRowEntry[],
  selection: WorkbookSelectedCell | null,
  direction: WorkbookMoveDirection,
  mergeRangesBySide: Partial<Record<'base' | 'mine', ReadonlyArray<WorkbookMergeRange>>> = {},
): WorkbookSelectedCell | null {
  if (!selection || selection.kind !== 'cell') return null;

  const scopedEntries = entries.filter(entry => (
    entry.sheetName === selection.sheetName
    && entry.side === selection.side
  ));

  if (scopedEntries.length === 0) return null;

  const currentIndex = scopedEntries.findIndex(entry => entry.rowNumber === selection.rowNumber);
  if (currentIndex < 0) return null;

  const sideMergeRanges = mergeRangesBySide[selection.side] ?? [];

  if (direction === 'left' || direction === 'right') {
    const currentEntry = scopedEntries[currentIndex]!;
    const visibleColumns = currentEntry.visibleColumns.length > 0
      ? currentEntry.visibleColumns
      : currentEntry.cells.map((_, index) => index);
    const currentRange = findWorkbookMergeRange(sideMergeRanges, selection.rowNumber, selection.colIndex);
    const currentStartColumn = currentRange?.startCol ?? selection.colIndex;
    const currentEndColumn = currentRange?.endCol ?? selection.colIndex;
    const startVisibleIndex = Math.max(
      0,
      visibleColumns.findIndex(column => column === currentStartColumn),
    );
    const endVisibleIndex = Math.max(
      startVisibleIndex,
      visibleColumns.findIndex(column => column === currentEndColumn),
    );
    const nextVisibleIndex = direction === 'left'
      ? Math.max(0, startVisibleIndex - 1)
      : Math.min(visibleColumns.length - 1, endVisibleIndex + 1);
    return buildWorkbookSelectedCell(
      currentEntry,
      visibleColumns[nextVisibleIndex] ?? selection.colIndex,
      sideMergeRanges,
    );
  }

  const nextIndex = direction === 'up'
    ? Math.max(0, currentIndex - 1)
    : Math.min(scopedEntries.length - 1, currentIndex + 1);

  return buildWorkbookSelectedCell(scopedEntries[nextIndex]!, selection.colIndex, sideMergeRanges);
}

export function findWorkbookSectionIndexByName(
  sections: WorkbookSection[],
  sheetName: string,
): number {
  const foundIndex = sections.findIndex(section => section.name === sheetName);
  return foundIndex >= 0 ? foundIndex : 0;
}

function getWorkbookColumnLabel(index: number): string {
  let value = index + 1;
  let label = '';

  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }

  return label;
}
