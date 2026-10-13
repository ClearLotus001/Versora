import type { SplitRow, WorkbookCompareMode } from '@/types';
import { buildWorkbookSplitRowCompareState } from '@/utils/workbook/workbookCompare';
import { getWorkbookSideRowNumber, getWorkbookSplitRowNumber } from '@/utils/workbook/workbookNavigation';
import type { WorkbookRenderPolicy } from '@/utils/workbook/workbookVisibilityModel';

export interface WorkbookMaskedRegionModel {
  regionByCellKey: ReadonlyMap<string, string>;
  regionCount: number;
}

interface BuildWorkbookMaskedRegionModelOptions {
  rows: readonly SplitRow[];
  visibleColumns: readonly number[];
  compareMode: WorkbookCompareMode;
  renderPolicy: WorkbookRenderPolicy;
  sheetName: string;
  headerRowNumber: number;
}

interface MaskedRun {
  start: number;
  end: number;
  component: number;
}

interface MaskedRow {
  baseRowNumber: number | null;
  mineRowNumber: number | null;
  runs: MaskedRun[];
}

interface IndexedMaskedRow {
  groups: MaskedRun[][];
  coverage: Array<{ start: number; end: number }>;
}

function buildCellKey(side: 'base' | 'mine', rowNumber: number, column: number): string {
  return `${side}\u0000${rowNumber}\u0000${column}`;
}

// Keep the public read-only Map API, but store one entry per horizontal run,
// rather than two string keys for every masked cell. Iteration expands lazily.
class MaskedCellRegionMap implements ReadonlyMap<string, string> {
  readonly size: number;
  private readonly rowsBySide = {
    base: new Map<number, IndexedMaskedRow>(),
    mine: new Map<number, IndexedMaskedRow>(),
  };

  constructor(
    rows: MaskedRow[],
    private readonly columns: readonly number[],
    private readonly columnPositions: ReadonlyMap<number, number>,
    private readonly regionIds: readonly string[],
  ) {
    for (const row of rows) {
      if (row.runs.length === 0) continue;
      for (const side of ['base', 'mine'] as const) {
        const rowNumber = side === 'base' ? row.baseRowNumber : row.mineRowNumber;
        if (rowNumber == null) continue;
        let indexed = this.rowsBySide[side].get(rowNumber);
        if (!indexed) {
          indexed = { groups: [], coverage: [] };
          this.rowsBySide[side].set(rowNumber, indexed);
        }
        indexed.groups.push(row.runs);
      }
    }

    let size = 0;
    for (const side of ['base', 'mine'] as const) {
      for (const indexed of this.rowsBySide[side].values()) {
        const sortedRuns = indexed.groups.length === 1
          ? indexed.groups[0]!
          : indexed.groups.flat().sort((left, right) => left.start - right.start);
        for (const run of sortedRuns) {
          const previous = indexed.coverage[indexed.coverage.length - 1];
          if (previous && run.start <= previous.end + 1) {
            previous.end = Math.max(previous.end, run.end);
          } else {
            indexed.coverage.push({ start: run.start, end: run.end });
          }
        }
        for (const span of indexed.coverage) size += span.end - span.start + 1;
      }
    }
    this.size = size;
  }

  getRegionId(side: 'base' | 'mine', rowNumber: number, column: number): string | undefined {
    const columnIndex = this.columnPositions.get(column);
    const indexed = this.rowsBySide[side].get(rowNumber);
    if (columnIndex == null || !indexed) return undefined;
    let regionIndex = -1;
    for (const runs of indexed.groups) {
      let low = 0;
      let high = runs.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (runs[middle]!.start <= columnIndex) low = middle + 1;
        else high = middle;
      }
      const run = runs[low - 1];
      if (run && columnIndex <= run.end) {
        // The previous BFS wrote later components last for duplicate row keys.
        regionIndex = Math.max(regionIndex, run.component);
      }
    }
    return regionIndex < 0 ? undefined : this.regionIds[regionIndex];
  }

  get(key: string): string | undefined {
    const [side, row, column, extra] = key.split('\u0000');
    if ((side !== 'base' && side !== 'mine') || extra !== undefined || row == null || column == null) {
      return undefined;
    }
    const rowNumber = Number(row);
    const columnNumber = Number(column);
    if (buildCellKey(side, rowNumber, columnNumber) !== key) return undefined;
    return this.getRegionId(side, rowNumber, columnNumber);
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  *entries(): MapIterator<[string, string]> {
    for (const side of ['base', 'mine'] as const) {
      for (const [rowNumber, indexed] of this.rowsBySide[side]) {
        for (const span of indexed.coverage) {
          for (let index = span.start; index <= span.end; index += 1) {
            const column = this.columns[index]!;
            yield [buildCellKey(side, rowNumber, column), this.getRegionId(side, rowNumber, column)!];
          }
        }
      }
    }
  }

  *keys(): MapIterator<string> {
    for (const [key] of this.entries()) yield key;
  }

  *values(): MapIterator<string> {
    for (const [, value] of this.entries()) yield value;
  }

  forEach(callbackfn: (value: string, key: string, map: ReadonlyMap<string, string>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[string, string]> {
    return this.entries();
  }
}

const EMPTY_WORKBOOK_MASKED_REGION_MODEL: WorkbookMaskedRegionModel = {
  regionByCellKey: new Map(),
  regionCount: 0,
};

const cache = new WeakMap<readonly SplitRow[], Map<string, WorkbookMaskedRegionModel>>();

export function buildWorkbookMaskedRegionModel({
  rows,
  visibleColumns,
  compareMode,
  renderPolicy,
  sheetName,
  headerRowNumber,
}: BuildWorkbookMaskedRegionModelOptions): WorkbookMaskedRegionModel {
  if (!renderPolicy.maskIrrelevantCells || rows.length === 0 || visibleColumns.length === 0) {
    return EMPTY_WORKBOOK_MASKED_REGION_MODEL;
  }

  const cacheKey = [sheetName, headerRowNumber, compareMode, visibleColumns.join(',')].join('::');
  let rowCache = cache.get(rows);
  if (!rowCache) {
    rowCache = new Map();
    cache.set(rows, rowCache);
  }
  const cached = rowCache.get(cacheKey);
  if (cached) return cached;

  const columnPositions = new Map(visibleColumns.map((column, index) => [column, index]));
  const parents: number[] = [];
  const findRoot = (component: number): number => {
    let root = component;
    while (parents[root] !== root) root = parents[root]!;
    while (component !== root) {
      const next = parents[component]!;
      parents[component] = root;
      component = next;
    }
    return root;
  };
  const join = (left: number, right: number) => {
    const leftRoot = findRoot(left);
    const rightRoot = findRoot(right);
    parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };

  const maskedRows: MaskedRow[] = [];
  let previousRuns: MaskedRun[] = [];
  for (const row of rows) {
    const rowNumber = getWorkbookSplitRowNumber(row);
    if (rowNumber == null || rowNumber === headerRowNumber) continue;
    // A precomputed delta already includes the summary. Avoid materializing
    // another full cell map merely to discover the changed column positions.
    const delta = row.workbookRowDelta
      ?? buildWorkbookSplitRowCompareState(row, undefined, compareMode);
    const changedPositions = delta.changedColumns
      .flatMap((column) => {
        const position = columnPositions.get(column);
        return position == null ? [] : [position];
      })
      .sort((left, right) => left - right);
    const changedSpans: Array<{ start: number; end: number }> = [];
    const lowerBound = (column: number) => {
      let low = 0; let high = visibleColumns.length;
      while (low < high) { const middle = (low + high) >>> 1; if (visibleColumns[middle]! < column) low = middle + 1; else high = middle; }
      return low;
    };
    if (row.workbookArtifactRow) {
      const { descriptor } = row.workbookArtifactRow.provider;
      const rowIndex = row.workbookArtifactRow.rowIndex;
      for (let run = descriptor.rows.runOffsets[rowIndex]!; run < descriptor.rows.runOffsets[rowIndex + 1]!; run += 1) {
        const start = lowerBound(descriptor.runs.starts[run]!);
        const end = lowerBound(descriptor.runs.ends[run]!) - 1;
        if (start > end) continue;
        const previous = changedSpans[changedSpans.length - 1];
        if (previous && previous.end + 1 >= start) previous.end = Math.max(previous.end, end);
        else changedSpans.push({ start, end });
      }
    } else for (const position of changedPositions) {
      const previous = changedSpans[changedSpans.length - 1];
      if (previous && previous.end + 1 === position) previous.end = position;
      else changedSpans.push({ start: position, end: position });
    }
    if (changedSpans.length === 0 && !delta.structuralChange) continue;

    const runs: MaskedRun[] = [];
    const appendRun = (start: number, end: number) => {
      if (start > end) return;
      const component = parents.length;
      parents.push(component);
      runs.push({ start, end, component });
    };
    if (!delta.structuralChange || changedSpans.length > 0) {
      let start = 0;
      for (const span of changedSpans) {
        appendRun(start, span.start - 1);
        start = span.end + 1;
      }
      appendRun(start, visibleColumns.length - 1);
    }

    // Horizontal runs already encode horizontal connectivity. Overlapping
    // intervals in consecutive retained rows encode all vertical connections.
    let previousIndex = 0;
    let currentIndex = 0;
    while (previousIndex < previousRuns.length && currentIndex < runs.length) {
      const previous = previousRuns[previousIndex]!;
      const current = runs[currentIndex]!;
      if (previous.end < current.start) previousIndex += 1;
      else if (current.end < previous.start) currentIndex += 1;
      else {
        join(previous.component, current.component);
        if (previous.end <= current.end) previousIndex += 1;
        if (current.end <= previous.end) currentIndex += 1;
      }
    }
    maskedRows.push({
      baseRowNumber: getWorkbookSideRowNumber(row, 'base'),
      mineRowNumber: getWorkbookSideRowNumber(row, 'mine'),
      runs,
    });
    previousRuns = runs;
  }

  const regionByRoot = new Map<number, number>();
  const regionIds: string[] = [];
  for (const row of maskedRows) {
    for (const run of row.runs) {
      const root = findRoot(run.component);
      let regionIndex = regionByRoot.get(root);
      if (regionIndex == null) {
        regionIndex = regionIds.length;
        regionByRoot.set(root, regionIndex);
        regionIds.push(`${sheetName}:masked:${regionIndex}`);
      }
      run.component = regionIndex;
    }
  }

  const model = {
    regionByCellKey: new MaskedCellRegionMap(maskedRows, [...visibleColumns], columnPositions, regionIds),
    regionCount: regionIds.length,
  };
  rowCache.set(cacheKey, model);
  return model;
}

export function getWorkbookMaskedRegionId(
  model: WorkbookMaskedRegionModel,
  side: 'base' | 'mine',
  rowNumber: number,
  column: number,
): string | null {
  if (model.regionByCellKey instanceof MaskedCellRegionMap) {
    return model.regionByCellKey.getRegionId(side, rowNumber, column) ?? null;
  }
  return model.regionByCellKey.get(buildCellKey(side, rowNumber, column)) ?? null;
}
