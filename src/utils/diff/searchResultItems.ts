import type {
  DiffLine,
  SearchMatch,
  SearchResultItem,
} from '@/types';
import { parseWorkbookDisplayLine } from '@/utils/workbook/workbookDisplay';
import { getWorkbookColumnLabel } from '@/utils/workbook/workbookSections';

export const SEARCH_RESULTS_VIEWPORT_H = 360;
export const SEARCH_RESULT_ROW_H = 54;
const SEARCH_RESULT_ROW_GAP = 6;
export const SEARCH_RESULT_ITEM_H = SEARCH_RESULT_ROW_H + SEARCH_RESULT_ROW_GAP;

const DEFAULT_OVERSCAN = 6;
const SEARCH_SNIPPET_ELLIPSIS = '\u2026';

interface SearchResultResolverOptions {
  diffLines: readonly DiffLine[];
  searchMatches: readonly SearchMatch[];
  baseRoleTitle: string;
  mineRoleTitle: string;
  noResultsLabel: string;
}

export interface VirtualizedSearchResultsWindow {
  startIndex: number;
  endIndex: number;
  offsetTop: number;
  totalHeight: number;
}

function buildSearchKey(match: SearchMatch | null | undefined): string {
  if (!match) return '';
  return [
    match.lineIdx,
    match.start,
    match.end,
    match.workbookTarget?.sheetName ?? '',
    match.workbookTarget?.side ?? '',
    match.workbookTarget?.rowNumber ?? '',
    match.workbookTarget?.colIndex ?? '',
  ].join(':');
}

function normalizeSearchPreview(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/\n+/g, ' / ')
    .trim();
}

function buildSearchSnippet(content: string, start: number, end: number): string {
  if (!content) return '';
  const normalized = normalizeSearchPreview(content);
  if (normalized.length <= 96) return normalized;
  const snippetStart = Math.max(0, start - 28);
  const snippetEnd = Math.min(content.length, end + 44);
  const rawSnippet = content.slice(snippetStart, snippetEnd);
  const snippet = normalizeSearchPreview(rawSnippet);
  return `${snippetStart > 0 ? SEARCH_SNIPPET_ELLIPSIS : ''}${snippet}${snippetEnd < content.length ? SEARCH_SNIPPET_ELLIPSIS : ''}`;
}

function buildWorkbookLinePreview(
  parsedLine: ReturnType<typeof parseWorkbookDisplayLine>,
): string {
  if (!parsedLine) return '';
  if (parsedLine.kind === 'sheet') return normalizeSearchPreview(parsedLine.sheetName);

  return normalizeSearchPreview(
    parsedLine.cells
      .map((cell) => cell.value || cell.formula)
      .filter(Boolean)
      .join('\t'),
  );
}

function createSearchResultItem(
  match: SearchMatch,
  index: number,
  options: SearchResultResolverOptions,
): SearchResultItem {
  const {
    diffLines,
    baseRoleTitle,
    mineRoleTitle,
    noResultsLabel,
  } = options;
  const line = diffLines[match.lineIdx] ?? null;
  const workbookTarget = match.workbookTarget;
  const side = workbookTarget?.side ?? null;
  const sideLabel = side === 'base'
    ? baseRoleTitle
    : side === 'mine'
      ? mineRoleTitle
      : '';
  const workbookContent = line
    ? (line.type === 'delete' ? (line.base ?? line.mine ?? '') : (line.mine ?? line.base ?? ''))
    : '';
  const parsedWorkbookLine = workbookContent ? parseWorkbookDisplayLine(workbookContent) : null;
  const address = workbookTarget?.rowNumber != null
    ? workbookTarget.colIndex != null
      ? `${getWorkbookColumnLabel(workbookTarget.colIndex)}${workbookTarget.rowNumber}`
      : String(workbookTarget.rowNumber)
    : '';
  const workbookPreview = parsedWorkbookLine?.kind === 'row' && workbookTarget?.colIndex != null
    ? normalizeSearchPreview(
      parsedWorkbookLine.cells[workbookTarget.colIndex]?.value
      || parsedWorkbookLine.cells[workbookTarget.colIndex]?.formula
      || '',
    )
    : '';
  const preview = match.snippet ?? (parsedWorkbookLine
    ? workbookPreview || buildWorkbookLinePreview(parsedWorkbookLine)
    : buildSearchSnippet(workbookContent || '', match.start, match.end));
  const detail = workbookTarget?.sheetName
    ? [
      workbookTarget.sheetName,
      sideLabel,
    ].filter(Boolean).join(' / ')
    : sideLabel;
  const locationLabel = workbookTarget?.sheetName
    ? [workbookTarget.sheetName, address].filter(Boolean).join('!')
    : `#${match.lineIdx + 1}`;

  return {
    index,
    lineIdx: match.lineIdx,
    workbookTarget,
    scopeKey: buildSearchKey(match),
    sheetName: workbookTarget?.sheetName ?? null,
    side,
    sideLabel,
    rowNumber: workbookTarget?.rowNumber ?? null,
    colIndex: workbookTarget?.colIndex ?? null,
    address,
    locationLabel,
    preview: preview || noResultsLabel,
    detail,
  };
}

export function createSearchResultItemResolver(options: SearchResultResolverOptions) {
  const cache = new Map<number, SearchResultItem>();

  return (index: number): SearchResultItem | null => {
    if (index < 0 || index >= options.searchMatches.length) return null;
    const cached = cache.get(index);
    if (cached) return cached;

    const match = options.searchMatches[index];
    if (!match) return null;

    const item = createSearchResultItem(match, index, options);
    cache.set(index, item);
    return item;
  };
}

export function getVirtualizedSearchResultsWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  itemHeight = SEARCH_RESULT_ITEM_H,
  overscan = DEFAULT_OVERSCAN,
): VirtualizedSearchResultsWindow {
  if (itemCount <= 0 || viewportHeight <= 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      offsetTop: 0,
      totalHeight: 0,
    };
  }

  const safeItemHeight = Math.max(1, itemHeight);
  const safeOverscan = Math.max(0, overscan);
  const safeScrollTop = Math.max(0, scrollTop);
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / safeItemHeight));
  const startIndex = Math.max(0, Math.floor(safeScrollTop / safeItemHeight) - safeOverscan);
  const endIndex = Math.min(itemCount, startIndex + visibleCount + safeOverscan * 2);

  return {
    startIndex,
    endIndex,
    offsetTop: startIndex * safeItemHeight,
    totalHeight: Math.max(0, itemCount * safeItemHeight - SEARCH_RESULT_ROW_GAP),
  };
}
