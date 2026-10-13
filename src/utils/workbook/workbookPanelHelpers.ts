import type {
  Hunk,
  SplitRow,
  WorkbookCellDelta,
  WorkbookCompareMode,
  WorkbookRowDelta,
  WorkbookSelectedCell,
} from '@/types';
import type { WorkbookPerfDebugStats } from '@/components/workbook/WorkbookPerfDebugPanel';
import type { WorkbookMiniMapDebugStats } from '@/components/workbook/WorkbookMiniMap';
import { buildWorkbookSplitRowCompareState } from '@/utils/workbook/workbookCompare';
import type {
  WorkbookMiniMapSegment,
  WorkbookMiniMapPaintTone,
  WorkbookMiniMapTone,
} from '@/components/workbook/WorkbookMiniMap';
import {
  buildWorkbookRowEntry,
  getWorkbookSideRowNumber,
  type WorkbookRowEntry,
} from '@/utils/workbook/workbookNavigation';
import { getWorkbookRowMiniMapDescriptor } from '@/utils/workbook/workbookDelta';
import {
  buildWorkbookCacheSignature,
  getWorkbookSharedCacheBucket,
  getWorkbookSharedCacheEntry,
  setWorkbookSharedCacheEntry,
} from '@/utils/workbook/workbookSharedCache';

export const WORKBOOK_CONTEXT_LINES = 3;

export interface WorkbookRowEntryMaps {
  base: Map<number, WorkbookRowEntry>;
  mine: Map<number, WorkbookRowEntry>;
}

export interface WorkbookCompareCellsMaps {
  base: Map<number, Map<number, WorkbookCellDelta>>;
  mine: Map<number, Map<number, WorkbookCellDelta>>;
}

export type WorkbookCompareStateByRow = Map<SplitRow, WorkbookRowDelta>;

const workbookRowEntryMapsCache = new WeakMap<SplitRow[], Map<string, WorkbookRowEntryMaps>>();
const workbookCompareCellsMapsCache = new WeakMap<SplitRow[], Map<string, WorkbookCompareCellsMaps>>();
const workbookCompareStateByRowCache = new WeakMap<SplitRow[], Map<string, WorkbookCompareStateByRow>>();
const workbookMiniMapBaseStateCache = new WeakMap<
  object,
  Map<string, { value: WorkbookMiniMapBaseSegment[]; duration: number }>
>();

export function workbookRowHasLineIdx(row: SplitRow, lineIdx: number): boolean {
  return row.lineIdxs.includes(lineIdx);
}

export function workbookRowTouchesOrAfter(row: SplitRow, lineIdx: number): boolean {
  return row.lineIdxs.some(idx => idx >= lineIdx);
}

export function isEqualWorkbookRow(row: SplitRow): boolean {
  if (row.workbookRowDelta) return !row.workbookRowDelta.hasChanges;
  return row.left?.type === 'equal' && row.right?.type === 'equal';
}

export function rowTouchesGuidedHunk(row: SplitRow, guidedHunkRange: Hunk | null): boolean {
  if (!guidedHunkRange) return false;
  return row.lineIdxs.some(idx => idx >= guidedHunkRange.startIdx && idx <= guidedHunkRange.endIdx);
}

export function getWorkbookRowKey(row: SplitRow): string {
  return row.lineIdxs.length > 0 ? row.lineIdxs.join(':') : String(row.lineIdx);
}

export function buildSelectionAutoScrollKey(
  sheetName: string,
  selection: WorkbookSelectedCell | null,
): string {
  if (!selection) return '';
  return [
    sheetName,
    selection.kind,
    selection.side,
    selection.rowNumber,
    selection.colIndex,
  ].join(':');
}

export function getWorkbookMiniMapTone(
  row: SplitRow,
  visibleColumns: number[],
  compareMode: WorkbookCompareMode,
): WorkbookMiniMapTone {
  return getWorkbookMiniMapDescriptor(row, visibleColumns, compareMode).tone;
}

export function getWorkbookMiniMapDescriptor(
  row: SplitRow,
  visibleColumns: number[],
  compareMode: WorkbookCompareMode,
): { tone: WorkbookMiniMapTone; tones: WorkbookMiniMapPaintTone[] } {
  return getWorkbookRowMiniMapDescriptor(
    buildWorkbookSplitRowCompareState(row, visibleColumns, compareMode),
  );
}

function mergeWorkbookMiniMapTone(
  left: WorkbookMiniMapTone,
  right: WorkbookMiniMapTone,
): WorkbookMiniMapTone {
  if (left === 'equal') return right;
  if (right === 'equal') return left;
  if (left === right) return left;
  return 'mixed';
}

export function buildWorkbookRowEntryMaps(
  rows: SplitRow[],
  sheetName: string,
  baseVersion: string,
  mineVersion: string,
  visibleColumns: number[],
): WorkbookRowEntryMaps {
  let cacheByRows = workbookRowEntryMapsCache.get(rows);
  if (!cacheByRows) {
    cacheByRows = new Map();
    workbookRowEntryMapsCache.set(rows, cacheByRows);
  }

  const cacheKey = [
    sheetName,
    baseVersion,
    mineVersion,
    visibleColumns.join(','),
  ].join('::');
  const cached = cacheByRows.get(cacheKey);
  if (cached) return cached;

  const next: WorkbookRowEntryMaps = {
    base: new Map<number, WorkbookRowEntry>(),
    mine: new Map<number, WorkbookRowEntry>(),
  };

  rows.forEach((row) => {
    const baseEntry = buildWorkbookRowEntry(row, 'base', sheetName, baseVersion, visibleColumns);
    const mineEntry = buildWorkbookRowEntry(row, 'mine', sheetName, mineVersion, visibleColumns);
    if (baseEntry) next.base.set(baseEntry.rowNumber, baseEntry);
    if (mineEntry) next.mine.set(mineEntry.rowNumber, mineEntry);
  });

  cacheByRows.set(cacheKey, next);
  return next;
}

export function buildWorkbookCompareCellsMaps(
  rows: SplitRow[],
  visibleColumns: number[],
  compareMode: WorkbookCompareMode,
): WorkbookCompareCellsMaps {
  if (rows[0]?.workbookArtifactRow) return { base: new Map(), mine: new Map() };
  let cacheByRows = workbookCompareCellsMapsCache.get(rows);
  if (!cacheByRows) {
    cacheByRows = new Map();
    workbookCompareCellsMapsCache.set(rows, cacheByRows);
  }

  const cacheKey = `${compareMode}::${visibleColumns.join(',')}`;
  const cached = cacheByRows.get(cacheKey);
  if (cached) return cached;

  const next: WorkbookCompareCellsMaps = {
    base: new Map<number, Map<number, WorkbookCellDelta>>(),
    mine: new Map<number, Map<number, WorkbookCellDelta>>(),
  };

  const compareStateByRow = buildWorkbookCompareStateByRow(rows, visibleColumns, compareMode);

  rows.forEach((row) => {
    const rowDelta = compareStateByRow.get(row);
    if (!rowDelta) return;
    const baseRowNumber = getWorkbookSideRowNumber(row, 'base');
    if (baseRowNumber != null) next.base.set(baseRowNumber, rowDelta.cellDeltas);

    const mineRowNumber = getWorkbookSideRowNumber(row, 'mine');
    if (mineRowNumber != null) next.mine.set(mineRowNumber, rowDelta.cellDeltas);
  });

  cacheByRows.set(cacheKey, next);
  return next;
}


export function buildWorkbookCompareStateByRow(
  rows: SplitRow[],
  visibleColumns: number[],
  compareMode: WorkbookCompareMode,
): WorkbookCompareStateByRow {
  let cacheByRows = workbookCompareStateByRowCache.get(rows);
  if (!cacheByRows) {
    cacheByRows = new Map();
    workbookCompareStateByRowCache.set(rows, cacheByRows);
  }

  const cacheKey = `${compareMode}::${visibleColumns.join(',')}`;
  const cached = cacheByRows.get(cacheKey);
  if (cached) return cached;

  const next: WorkbookCompareStateByRow = new Map();
  rows.forEach((row) => {
    next.set(row, buildWorkbookSplitRowCompareState(row, visibleColumns, compareMode));
  });

  cacheByRows.set(cacheKey, next);
  return next;
}

export function buildWorkbookNavigationRows(
  sheetName: string | null,
  hasSelection: boolean,
  frozenRows: SplitRow[],
  bodyRows: SplitRow[],
  baseVersion: string,
  mineVersion: string,
  visibleColumns: number[],
): WorkbookRowEntry[] {
  if (!sheetName || !hasSelection) return [];

  const sourceRows = [
    ...frozenRows,
    ...bodyRows,
  ];

  return sourceRows.flatMap((row) => {
    const entries: WorkbookRowEntry[] = [];
    const baseEntry = buildWorkbookRowEntry(row, 'base', sheetName, baseVersion, visibleColumns);
    const mineEntry = buildWorkbookRowEntry(row, 'mine', sheetName, mineVersion, visibleColumns);
    if (baseEntry) entries.push(baseEntry);
    if (mineEntry) entries.push(mineEntry);
    return entries;
  });
}

function projectWorkbookNavigationRowsFromEntryMaps(
  rows: readonly SplitRow[],
  rowEntryByRowNumber: WorkbookRowEntryMaps,
): WorkbookRowEntry[] {
  const next: WorkbookRowEntry[] = [];
  rows.forEach((row) => {
    const baseRowNumber = getWorkbookSideRowNumber(row, 'base');
    const mineRowNumber = getWorkbookSideRowNumber(row, 'mine');
    if (baseRowNumber != null) {
      const baseEntry = rowEntryByRowNumber.base.get(baseRowNumber);
      if (baseEntry) next.push(baseEntry);
    }
    if (mineRowNumber != null) {
      const mineEntry = rowEntryByRowNumber.mine.get(mineRowNumber);
      if (mineEntry) next.push(mineEntry);
    }
  });
  return next;
}

export function projectWorkbookNavigationRowsFromEntryMapParts(
  rowParts: readonly (readonly SplitRow[])[],
  rowEntryByRowNumber: WorkbookRowEntryMaps,
): WorkbookRowEntry[] {
  const next: WorkbookRowEntry[] = [];
  rowParts.forEach((rows) => {
    projectWorkbookNavigationRowsFromEntryMaps(rows, rowEntryByRowNumber)
      .forEach((entry) => next.push(entry));
  });
  return next;
}

function getNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function buildWorkbookRowsSignature(
  rows: readonly SplitRow[],
): string {
  return rows.map((row) => getWorkbookRowKey(row)).join('|');
}

export interface WorkbookMiniMapEntry {
  tone: WorkbookMiniMapTone;
  tones?: WorkbookMiniMapPaintTone[];
  height: number;
  lineIdxs: number[];
}

export interface WorkbookMiniMapBaseSegment {
  tone: WorkbookMiniMapTone;
  tones?: WorkbookMiniMapPaintTone[];
  height: number;
  lineIdxs: number[];
}

export interface BuildWorkbookMiniMapBaseStateParams<TItem> {
  headerHeight?: number;
  compareMode: WorkbookCompareMode;
  frozenRows: SplitRow[];
  frozenRowsViewportIsOverflowing: boolean;
  frozenRowsViewportHeight: number;
  items: TItem[];
  visibleColumns: number[];
  resolveRowHeight: (row: SplitRow) => number;
  resolveItemEntry: (item: TItem, index: number) => WorkbookMiniMapEntry;
}

function buildWorkbookMiniMapBaseStateUncached<TItem>({
  headerHeight = 0,
  compareMode,
  frozenRows,
  frozenRowsViewportIsOverflowing,
  frozenRowsViewportHeight,
  items,
  visibleColumns,
  resolveRowHeight,
  resolveItemEntry,
}: BuildWorkbookMiniMapBaseStateParams<TItem>): { value: WorkbookMiniMapBaseSegment[]; duration: number } {
  const start = getNow();
  const segments: WorkbookMiniMapBaseSegment[] = [];

  if (headerHeight > 0) {
    segments.push({ tone: 'equal', height: headerHeight, lineIdxs: [] });
  }

  if (frozenRowsViewportIsOverflowing) {
    const frozenDescriptors = frozenRows.map((row) => getWorkbookMiniMapDescriptor(row, visibleColumns, compareMode));
    const frozenTone = frozenDescriptors.reduce<WorkbookMiniMapTone>(
      (mergedTone, descriptor) => mergeWorkbookMiniMapTone(mergedTone, descriptor.tone),
      'equal',
    );
    const frozenTones = [...new Set(
      frozenDescriptors.flatMap((descriptor) => descriptor.tones),
    )];
    segments.push({
      tone: frozenTone,
      tones: frozenTones,
      height: frozenRowsViewportHeight,
      lineIdxs: frozenRows.flatMap((row) => row.lineIdxs),
    });
  } else {
    frozenRows.forEach((row) => {
      const descriptor = getWorkbookMiniMapDescriptor(row, visibleColumns, compareMode);
      segments.push({
        tone: descriptor.tone,
        tones: descriptor.tones,
        height: resolveRowHeight(row),
        lineIdxs: row.lineIdxs,
      });
    });
  }

  items.forEach((item, index) => {
    const entry = resolveItemEntry(item, index);
    segments.push({
      tone: entry.tone,
      ...(entry.tones ? { tones: entry.tones } : {}),
      height: entry.height,
      lineIdxs: entry.lineIdxs,
    });
  });

  return {
    value: segments,
    duration: getNow() - start,
  };
}

export function buildWorkbookMiniMapBaseState<TItem>(
  params: BuildWorkbookMiniMapBaseStateParams<TItem>,
): { value: WorkbookMiniMapBaseSegment[]; duration: number } {
  return buildWorkbookMiniMapBaseStateUncached(params);
}

export interface ResolveWorkbookMiniMapBaseStateParams<TItem> extends BuildWorkbookMiniMapBaseStateParams<TItem> {
  cacheOwner: object | null;
  cacheKey: string | null;
}

export function resolveWorkbookMiniMapBaseState<TItem>({
  cacheOwner,
  cacheKey,
  ...params
}: ResolveWorkbookMiniMapBaseStateParams<TItem>): { value: WorkbookMiniMapBaseSegment[]; duration: number } {
  if (!cacheOwner || !cacheKey) {
    return buildWorkbookMiniMapBaseStateUncached(params);
  }

  const cacheBucket = getWorkbookSharedCacheBucket(
    workbookMiniMapBaseStateCache,
    cacheOwner,
  );
  const cached = getWorkbookSharedCacheEntry(cacheBucket, cacheKey);
  if (cached) return cached;

  const nextValue = buildWorkbookMiniMapBaseStateUncached(params);
  setWorkbookSharedCacheEntry(cacheBucket, cacheKey, nextValue);
  return nextValue;
}

export function buildWorkbookMiniMapBaseCacheKey(
  parts: {
    scope: string;
    headerHeight: number;
    compareMode: WorkbookCompareMode;
    visibleColumns: readonly number[];
    frozenRows: readonly SplitRow[];
    frozenRowsViewportIsOverflowing: boolean;
    frozenRowsViewportHeight: number;
    mode?: string | null;
    rowHeight?: number | null;
  },
): string {
  return buildWorkbookCacheSignature([
    parts.scope,
    parts.headerHeight,
    parts.compareMode,
    parts.visibleColumns.join(','),
    buildWorkbookRowsSignature(parts.frozenRows),
    parts.frozenRowsViewportIsOverflowing,
    parts.frozenRowsViewportHeight,
    parts.mode ?? null,
    parts.rowHeight ?? null,
  ]);
}

export function applyWorkbookMiniMapSearchState(
  baseSegments: readonly WorkbookMiniMapBaseSegment[],
  searchMatchSet: ReadonlySet<number>,
  activeSearchLineIdx: number,
): WorkbookMiniMapSegment[] {
  const segmentHasSearchHit = (lineIdxs: number[]) => lineIdxs.some((idx) => searchMatchSet.has(idx));
  const segmentHasActiveSearchHit = (lineIdxs: number[]) => lineIdxs.includes(activeSearchLineIdx);

  return baseSegments.map((segment) => ({
    tone: segment.tone,
    ...(segment.tones ? { tones: segment.tones } : {}),
    height: segment.height,
    searchHit: segmentHasSearchHit(segment.lineIdxs),
    activeSearchHit: segmentHasActiveSearchHit(segment.lineIdxs),
  }));
}

export interface BuildWorkbookPerfStatsParams {
  panel: WorkbookPerfDebugStats['panel'];
  sheetName: string;
  totalRows: number;
  renderedRows: number;
  collapseBlocks: number;
  totalColumns: number;
  renderedColumns: number;
  frozenRows: number;
  frozenColumns: number;
  collapsedItemsDuration: number;
  hiddenRowNumberCount: number;
  renderItemsDuration: number;
  itemsDuration: number;
  hiddenRows: number;
  miniMapDuration: number;
  rowWindowMs: number;
  rowWindowUpdates: number;
  rowOverscan: number;
  rowViewport: number;
  columnWindowMs: number;
  columnWindowUpdates: number;
  columnOverscan: number;
  columnViewport: number;
  miniMapDebug: WorkbookMiniMapDebugStats | null;
  scrollSyncCount: number;
  frozenRowsViewport: number;
  frozenRowsTotalSize: number;
  frozenRowsOverflow: boolean;
  frozenColumnsViewport: number;
  frozenColumnsTotalSize: number;
  frozenColumnsOverflow: boolean;
  frozenColumnsScrollLeft: number;
}

export function buildWorkbookPerfStats({
  panel,
  sheetName,
  totalRows,
  renderedRows,
  collapseBlocks,
  totalColumns,
  renderedColumns,
  frozenRows,
  frozenColumns,
  collapsedItemsDuration,
  hiddenRowNumberCount,
  renderItemsDuration,
  itemsDuration,
  hiddenRows,
  miniMapDuration,
  rowWindowMs,
  rowWindowUpdates,
  rowOverscan,
  rowViewport,
  columnWindowMs,
  columnWindowUpdates,
  columnOverscan,
  columnViewport,
  miniMapDebug,
  scrollSyncCount,
  frozenRowsViewport,
  frozenRowsTotalSize,
  frozenRowsOverflow,
  frozenColumnsViewport,
  frozenColumnsTotalSize,
  frozenColumnsOverflow,
  frozenColumnsScrollLeft,
}: BuildWorkbookPerfStatsParams): WorkbookPerfDebugStats {
  return {
    panel,
    sheetName,
    totalRows,
    renderedRows,
    collapseBlocks,
    totalColumns,
    renderedColumns,
    frozenRows,
    frozenColumns,
    buildItemsMs: collapsedItemsDuration
      + (hiddenRowNumberCount > 0 ? renderItemsDuration : 0)
      + itemsDuration,
    collapseBuildMs: collapsedItemsDuration,
    hiddenOverlayMs: hiddenRowNumberCount > 0 ? renderItemsDuration : 0,
    hiddenRows,
    miniMapMs: miniMapDuration,
    rowWindowMs,
    rowWindowUpdates,
    rowOverscan,
    rowViewport,
    columnWindowMs,
    columnWindowUpdates,
    columnOverscan,
    columnViewport,
    miniMapClickMs: miniMapDebug?.lastClickMs ?? 0,
    miniMapClickCount: miniMapDebug?.clickCount ?? 0,
    scrollSyncCount,
    frozenRowsViewport,
    frozenRowsTotalSize,
    frozenRowsOverflow,
    frozenColumnsViewport,
    frozenColumnsTotalSize,
    frozenColumnsOverflow,
    frozenColumnsScrollLeft,
  };
}

export interface SelectionAutoScrollLock {
  sheetName: string;
  hunkIdx: number;
  rowKey: string;
  cellKey: string;
}
