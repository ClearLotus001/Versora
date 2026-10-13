import type {
  DiffLine,
  WorkbookCellDelta,
  WorkbookCompareMode,
  WorkbookRowDelta,
  WorkbookRowMiniMapPaintTone,
  WorkbookRowMiniMapTone,
  WorkbookRowDeltaTone,
} from '@/types';
import type { WorkbookCellDisplay, WorkbookRowDisplayLine } from '@/utils/workbook/workbookDisplay';
import {
  hasWorkbookCellContent,
  isWorkbookStrictOnlyDifference,
  workbookCellsDiffer,
} from '@/utils/workbook/workbookCellContract';
import {
  resolveWorkbookCellDeltaKind,
  resolveWorkbookMiniMapDescriptorFromDeltas,
  resolveWorkbookRowDeltaTone,
} from '../../../shared/workbookCellSemantics';
import { parseWorkbookDiffLine } from '@/utils/workbook/workbookDisplay';

const EMPTY_CELL: WorkbookCellDisplay = { value: '', formula: '' };
const NULL_LINE_CACHE_KEY: object = {};
const rowDeltaCache = new WeakMap<object, WeakMap<object, Map<string, WorkbookRowDelta>>>();
const splitRowSubsetDeltaCache = new WeakMap<object, Map<string, WorkbookRowDelta>>();

// Offscreen unchanged rows need their summary during preparation, but their
// cell maps are only needed when drawing, selecting, or iterating their cells.
class DeferredWorkbookCellMap extends Map<number, WorkbookCellDelta> {
  #initialize: (() => Iterable<readonly [number, WorkbookCellDelta]>) | null;

  constructor(initialize: () => Iterable<readonly [number, WorkbookCellDelta]>) {
    super();
    this.#initialize = initialize;
  }

  private ensureInitialized() {
    const initialize = this.#initialize;
    if (!initialize) return;
    this.#initialize = null;
    for (const [column, delta] of initialize()) super.set(column, delta);
  }

  override get size() { this.ensureInitialized(); return super.size; }
  override get(column: number) { this.ensureInitialized(); return super.get(column); }
  override has(column: number) { this.ensureInitialized(); return super.has(column); }
  override set(column: number, delta: WorkbookCellDelta): this { this.ensureInitialized(); return super.set(column, delta); }
  override delete(column: number) { this.ensureInitialized(); return super.delete(column); }
  override clear() { this.#initialize = null; super.clear(); }
  override entries() { this.ensureInitialized(); return super.entries(); }
  override keys() { this.ensureInitialized(); return super.keys(); }
  override values() { this.ensureInitialized(); return super.values(); }
  override [Symbol.iterator]() { return this.entries(); }
  override forEach(callback: (value: WorkbookCellDelta, key: number, map: Map<number, WorkbookCellDelta>) => void, thisArg?: unknown) {
    this.ensureInitialized();
    super.forEach(callback, thisArg);
  }
}

function createEqualWorkbookRowDelta(
  initializeCells: () => Iterable<readonly [number, WorkbookCellDelta]>,
): WorkbookRowDelta {
  return {
    cellDeltas: new DeferredWorkbookCellMap(initializeCells),
    changedColumns: [],
    strictOnlyColumns: [],
    changedCount: 0,
    hasChanges: false,
    tone: 'equal',
    miniMapTone: 'equal',
    miniMapPaintTones: [],
  };
}

function* buildEqualWorkbookCellEntries(
  line: DiffLine,
  columns: number[] | undefined,
  compareMode: WorkbookCompareMode,
): IterableIterator<[number, WorkbookCellDelta]> {
  const row = parseWorkbookRowLine(line);
  if (!row) return;
  const columnSet = columns && columns.length > 0
    ? columns
    : row.cells.map((_, index) => index);
  for (const column of columnSet) {
    const cell = row.cells[column] ?? EMPTY_CELL;
    if (!hasWorkbookCellContent(cell, compareMode)) continue;
    yield [column, {
      column,
      baseCell: cell,
      mineCell: cell,
      changed: false,
      masked: true,
      strictOnly: false,
      kind: 'equal',
      hasBaseContent: true,
      hasMineContent: true,
      hasContent: true,
    }];
  }
}

interface WorkbookRowDeltaSummary {
  changedColumns: number[];
  strictOnlyColumns: number[];
  changedCount: number;
  hasChanges: boolean;
  tone: WorkbookRowDeltaTone;
  miniMapTone: WorkbookRowMiniMapTone;
  miniMapPaintTones: WorkbookRowMiniMapPaintTone[];
}

export function parseWorkbookRowLine(line: DiffLine | null): WorkbookRowDisplayLine | null {
  if (!line) return null;
  const parsed = parseWorkbookDiffLine(line);
  return parsed?.kind === 'row' ? parsed : null;
}

function summarizeWorkbookCellDeltas(
  cellDeltas: Iterable<WorkbookCellDelta>,
): WorkbookRowDeltaSummary {
  const entries = [...cellDeltas];
  const changedColumns: number[] = [];
  const strictOnlyColumns: number[] = [];

  entries.forEach((delta) => {
    if (!delta.changed) return;
    changedColumns.push(delta.column);
    if (delta.strictOnly) strictOnlyColumns.push(delta.column);
  });

  const miniMapDescriptor = resolveWorkbookMiniMapDescriptorFromDeltas(entries);
  return {
    changedColumns,
    strictOnlyColumns,
    changedCount: changedColumns.length,
    hasChanges: changedColumns.length > 0,
    tone: resolveWorkbookRowDeltaTone(entries),
    miniMapTone: miniMapDescriptor.tone,
    miniMapPaintTones: miniMapDescriptor.tones,
  };
}

export function buildWorkbookRowDelta(
  leftLine: DiffLine | null,
  rightLine: DiffLine | null,
  columns?: number[],
  compareMode: WorkbookCompareMode = 'strict',
): WorkbookRowDelta {
  const columnsKey = `${compareMode}::${columns && columns.length > 0 ? columns.join(',') : '*'}`;
  const leftKey = (leftLine ?? NULL_LINE_CACHE_KEY) as object;
  const rightKey = (rightLine ?? NULL_LINE_CACHE_KEY) as object;

  let rightCache = rowDeltaCache.get(leftKey);
  if (!rightCache) {
    rightCache = new WeakMap<object, Map<string, WorkbookRowDelta>>();
    rowDeltaCache.set(leftKey, rightCache);
  }

  let columnsCache = rightCache.get(rightKey);
  if (!columnsCache) {
    columnsCache = new Map<string, WorkbookRowDelta>();
    rightCache.set(rightKey, columnsCache);
  }

  const cached = columnsCache.get(columnsKey);
  if (cached) return cached;

  if (
    leftLine && rightLine
    && (leftLine.base ?? leftLine.mine) === (rightLine.base ?? rightLine.mine)
  ) {
    const equal = createEqualWorkbookRowDelta(
      () => buildEqualWorkbookCellEntries(leftLine, columns, compareMode),
    );
    columnsCache.set(columnsKey, equal);
    return equal;
  }

  const leftRow = parseWorkbookRowLine(leftLine);
  const rightRow = parseWorkbookRowLine(rightLine);
  const cellDeltas = new Map<number, WorkbookCellDelta>();

  if (!leftRow && !rightRow) {
    const empty: WorkbookRowDelta = {
      cellDeltas,
      changedColumns: [],
      strictOnlyColumns: [],
      changedCount: 0,
      hasChanges: false,
      tone: 'equal',
      miniMapTone: 'equal',
      miniMapPaintTones: [],
    };
    columnsCache.set(columnsKey, empty);
    return empty;
  }

  const columnSet = columns && columns.length > 0
    ? columns
    : Array.from(
        { length: Math.max(leftRow?.cells.length ?? 0, rightRow?.cells.length ?? 0) },
        (_, index) => index,
      );

  if (!leftRow || !rightRow) {
    const existingSide = leftRow ? 'base' : 'mine';
    const existingRow = leftRow ?? rightRow;

    if (existingRow) {
      columnSet.forEach((column) => {
        const existingCell = existingRow.cells[column] ?? EMPTY_CELL;
        const hasContent = hasWorkbookCellContent(existingCell, compareMode);
        if (!hasContent) return;

        cellDeltas.set(column, {
          column,
          baseCell: existingSide === 'base' ? existingCell : EMPTY_CELL,
          mineCell: existingSide === 'mine' ? existingCell : EMPTY_CELL,
          changed: true,
          masked: false,
          strictOnly: false,
          kind: existingSide === 'base' ? 'delete' : 'add',
          hasBaseContent: existingSide === 'base' ? hasContent : false,
          hasMineContent: existingSide === 'mine' ? hasContent : false,
          hasContent: true,
        });
      });
    }
  } else {
    columnSet.forEach((column) => {
      const leftCell = leftRow.cells[column] ?? EMPTY_CELL;
      const rightCell = rightRow.cells[column] ?? EMPTY_CELL;
      const hasBaseContent = hasWorkbookCellContent(leftCell, compareMode);
      const hasMineContent = hasWorkbookCellContent(rightCell, compareMode);
      const hasContent = hasBaseContent || hasMineContent;
      const changed = workbookCellsDiffer(leftCell, rightCell, compareMode);

      if (!changed && !hasContent) return;

      cellDeltas.set(column, {
        column,
        baseCell: leftCell,
        mineCell: rightCell,
        changed,
        masked: !changed,
        strictOnly: changed && isWorkbookStrictOnlyDifference(leftCell, rightCell),
        kind: resolveWorkbookCellDeltaKind(leftCell, rightCell, compareMode),
        hasBaseContent,
        hasMineContent,
        hasContent,
      });
    });
  }

  const summary = summarizeWorkbookCellDeltas(cellDeltas.values());
  const rowDelta: WorkbookRowDelta = {
    cellDeltas,
    changedColumns: summary.changedColumns,
    strictOnlyColumns: summary.strictOnlyColumns,
    changedCount: summary.changedCount,
    hasChanges: summary.hasChanges,
    tone: summary.tone,
    miniMapTone: summary.miniMapTone,
    miniMapPaintTones: summary.miniMapPaintTones,
  };

  columnsCache.set(columnsKey, rowDelta);
  return rowDelta;
}

export function getWorkbookRowMiniMapDescriptor(
  rowDelta: WorkbookRowDelta,
): { tone: WorkbookRowMiniMapTone; tones: WorkbookRowMiniMapPaintTone[] } {
  if (rowDelta.miniMapTone && Array.isArray(rowDelta.miniMapPaintTones)) {
    return {
      tone: rowDelta.miniMapTone,
      tones: rowDelta.miniMapPaintTones,
    };
  }
  return resolveWorkbookMiniMapDescriptorFromDeltas(getWorkbookRowDeltaEntries(rowDelta));
}

export function getWorkbookRowDeltaEntries(
  rowDelta: WorkbookRowDelta,
  columns?: readonly number[],
): readonly WorkbookCellDelta[] {
  if (!columns || columns.length === 0) {
    return [...rowDelta.cellDeltas.values()];
  }
  const selected: WorkbookCellDelta[] = [];
  columns.forEach((column) => {
    const delta = rowDelta.cellDeltas.get(column);
    if (delta) selected.push(delta);
  });
  return selected;
}

export function buildWorkbookSplitRowDelta(
  row: { left: DiffLine | null; right: DiffLine | null; workbookRowDelta?: WorkbookRowDelta },
  columns?: number[],
  compareMode: WorkbookCompareMode = 'strict',
): WorkbookRowDelta {
  const precomputed = row.workbookRowDelta;
  if (precomputed?.artifactSummary) return precomputed;
  if (!precomputed) {
    return buildWorkbookRowDelta(row.left, row.right, columns, compareMode);
  }
  if (precomputed.structuralChange) return precomputed;
  if (!columns || columns.length === 0) return precomputed;

  const subsetCacheKey = `${compareMode}::${columns.join(',')}`;
  let subsetCache = splitRowSubsetDeltaCache.get(row as object);
  if (!subsetCache) {
    subsetCache = new Map<string, WorkbookRowDelta>();
    splitRowSubsetDeltaCache.set(row as object, subsetCache);
  }

  const cachedSubset = subsetCache.get(subsetCacheKey);
  if (cachedSubset) return cachedSubset;

  if (!precomputed.hasChanges) {
    const equalSubset = createEqualWorkbookRowDelta(() => (
      getWorkbookRowDeltaEntries(precomputed, columns).map((delta) => [delta.column, delta] as const)
    ));
    subsetCache.set(subsetCacheKey, equalSubset);
    return equalSubset;
  }

  const deltas = getWorkbookRowDeltaEntries(precomputed, columns);
  const nextCellDeltas = new Map<number, WorkbookCellDelta>(
    deltas.map((delta) => [delta.column, delta]),
  );
  const summary = summarizeWorkbookCellDeltas(deltas);
  const subsetDelta = {
    cellDeltas: nextCellDeltas,
    changedColumns: summary.changedColumns,
    strictOnlyColumns: summary.strictOnlyColumns,
    changedCount: summary.changedCount,
    hasChanges: summary.hasChanges,
    tone: summary.tone,
    miniMapTone: summary.miniMapTone,
    miniMapPaintTones: summary.miniMapPaintTones,
  };

  subsetCache.set(subsetCacheKey, subsetDelta);
  return subsetDelta;
}
