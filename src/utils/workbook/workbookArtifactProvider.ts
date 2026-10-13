import type {
  WorkbookArtifactDescriptor,
  WorkbookArtifactWindowRow,
  WorkbookArtifactCell,
  WorkbookArtifactSourceRowsRequest,
  WorkbookArtifactSearchRequest,
  WorkbookArtifactViewRequest,
} from '../../../shared/workbookArtifactProtocol';
import type { VersoraBridge } from '@/types/bridge';
import type { SplitRow, WorkbookRowDelta, WorkbookCellDelta, WorkbookSelectedCell, WorkbookSection, WorkbookDiffRegion, DiffTypeFilter, WorkbookRowMiniMapPaintTone } from '@/types';
import type { WorkbookRowEntry } from '@/utils/workbook/workbookNavigation';
import { hasWorkbookCellContent } from '@/utils/workbook/workbookCellContract';
import { getWorkbookColumnLabel } from '@/utils/workbook/workbookSections';

export interface WorkbookArtifactRowReference {
  provider: WorkbookArtifactProvider;
  sheetId: number;
  rowIndex: number;
  localRowIndex: number;
  baseRowNumber: number | null;
  mineRowNumber: number | null;
  kind: number;
}

interface CachedWindow { rows: Array<WorkbookArtifactWindowRow | undefined>; bytes: number; cells: number }
const TILE_ROWS = 64;
const TILE_COLUMNS = 16;
const CACHE_BYTES = 24 * 1024 * 1024;
const CACHE_WINDOWS = 2048;
const SELECTION_CACHE_BYTES = 4 * 1024 * 1024;
const COLUMN_WIDTH_CACHE_ENTRIES = 4096;
const EMPTY_CELL = Object.freeze({ value: '', formula: '' });
const providers = new Map<string, WorkbookArtifactProvider>();
export type WorkbookArtifactIO = Pick<VersoraBridge, 'getWorkbookArtifactView' | 'readWorkbookArtifactWindow' | 'readWorkbookArtifactCells' | 'readWorkbookArtifactSourceRows' | 'searchWorkbookArtifact' | 'cancelWorkbookArtifactSearch'>;
const fixtureAdapters = new Map<string, { adapter: WorkbookArtifactIO; comparisonSessionId: string }>();
export function registerWorkbookArtifactFixture(artifactId: string, adapter: WorkbookArtifactIO, comparisonSessionId = artifactId) {
  fixtureAdapters.set(artifactId, { adapter, comparisonSessionId });
}
export function resolveWorkbookArtifactView(request: WorkbookArtifactViewRequest) {
  return (fixtureAdapters.get(request.artifactId)?.adapter ?? window.versora!).getWorkbookArtifactView(request);
}
const regionViews = new WeakMap<WorkbookDiffRegion[], { provider: WorkbookArtifactProvider; ordinalByRegion: Int32Array | null; sheetRanges: Map<string, { first: number; last: number }> }>();
let activeProvider: WorkbookArtifactProvider | null = null;

export function getActiveWorkbookArtifactProvider() { return activeProvider; }
export function activateWorkbookArtifact(descriptor: WorkbookArtifactDescriptor) {
  const key = `${descriptor.artifactId}:${descriptor.compareMode}`;
  let provider = providers.get(key);
  if (!provider) {
    for (const [previousKey, previous] of providers) {
      if (previous.descriptor.comparisonSessionId !== descriptor.comparisonSessionId || previous.descriptor.artifactId === descriptor.artifactId) continue;
      previous.dispose(); providers.delete(previousKey);
      fixtureAdapters.delete(previous.descriptor.artifactId);
    }
    provider = new WorkbookArtifactProvider(descriptor);
  }
  providers.delete(key); providers.set(key, provider);
  activeProvider = provider;
  // Keep only a few comparison modes; inactive canvases unsubscribe naturally.
  while (providers.size > 4) {
    const oldest = providers.keys().next().value;
    if (!oldest) break;
    providers.get(oldest)?.dispose();
    providers.delete(oldest);
  }
  return provider;
}
export function clearActiveWorkbookArtifact() { activeProvider = null; }
/** Release all modes and obsolete revisions owned by one closed comparison. */
export function releaseWorkbookArtifactSession(comparisonSessionId: string) {
  for (const [key, provider] of providers) {
    if (provider.descriptor.comparisonSessionId !== comparisonSessionId) continue;
    if (activeProvider === provider) activeProvider = null;
    provider.dispose();
    providers.delete(key);
  }
  for (const [artifactId, fixture] of fixtureAdapters) {
    if (fixture.comparisonSessionId === comparisonSessionId) fixtureAdapters.delete(artifactId);
  }
}

export function findArtifactRegionSelectionIndex(regions: WorkbookDiffRegion[], selection: WorkbookSelectedCell): number | undefined {
  const view = regionViews.get(regions);
  if (!view) return undefined;
  const sheet = view.provider.descriptor.sheets.find((item) => item.name === selection.sheetName);
  if (!sheet) return -1;
  const metadata = selection.side === 'base' ? view.provider.descriptor.baseMetadata : view.provider.descriptor.mineMetadata;
  const merge = metadata.sheets[sheet.name]?.mergeRanges.find((range) => selection.rowNumber >= range.startRow && selection.rowNumber <= range.endRow && selection.colIndex >= range.startCol && selection.colIndex <= range.endCol);
  const row = view.provider.findPhysicalRowIndex(sheet.id, selection.side, merge?.startRow ?? selection.rowNumber);
  if (row == null) return -1;
  const run = view.provider.findRun(row, merge?.startCol ?? selection.colIndex);
  if (run < 0 || !view.provider.runHasSide(run, selection.side)) return -1;
  const region = view.provider.descriptor.runs.regionIds[run]!;
  return view.ordinalByRegion ? view.ordinalByRegion[region] ?? -1 : region;
}
export function findArtifactRegionNavigationIndex(regions: WorkbookDiffRegion[], currentIndex: number, direction: -1 | 1, activeSheetName: string | null, sheetOrder: string[]): number | undefined {
  const view = regionViews.get(regions);
  if (!view) return undefined;
  if (!regions.length) return 0;
  const valid = currentIndex >= 0 && currentIndex < regions.length;
  if (!activeSheetName || regions[currentIndex]?.sheetName === activeSheetName) return valid ? (currentIndex + direction + regions.length) % regions.length : direction === 1 ? 0 : regions.length - 1;
  const order = [...sheetOrder, ...view.sheetRanges.keys()].filter((name, index, names) => names.indexOf(name) === index);
  const active = order.indexOf(activeSheetName);
  for (let offset = 0; offset < order.length; offset += 1) {
    const name = order[((Math.max(0, active) + offset * direction) % order.length + order.length) % order.length]!;
    const range = view.sheetRanges.get(name);
    if (range) return direction === 1 ? range.first : range.last;
  }
  return valid ? (currentIndex + direction + regions.length) % regions.length : 0;
}

function tileKey(sheetId: number, row: number, column: number) { return `${sheetId}:${row}:${column}`; }

/** Cell values exist only in explicit, bounded windows. Reading cache never fetches. */
export class WorkbookArtifactProvider {
  private cache = new Map<string, CachedWindow>();
  private pending = new Map<string, Promise<void>>();
  private pendingRows = new Map<string, ReadonlySet<number>>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private notificationQueued = false;
  private disposed = false;
  private readonly lifetime = new AbortController();
  readonly closedSignal = this.lifetime.signal;
  private readonly measuredColumnWidths = new Map<string, number>();
  private columnMeasurement: AbortController | null = null;
  private bytes = 0;
  private cells = 0;
  private errors = new Map<string, Error>();
  private selections = new Map<string, WorkbookArtifactCell>();
  private selectionSizes = new Map<string, number>();
  private cellPending = new Map<string, Promise<void>>();
  private selectionBytes = 0;
  private activeReads = 0;
  private readonly readQueue: Array<() => void> = [];
  private physicalIndexes = new Map<string, Map<number, number>>();
  readonly sectionRows = new Map<string, SplitRow[]>();
  private regionCache = new Map<string, WorkbookDiffRegion>();
  private regionViewCache = new Map<string, WorkbookDiffRegion[]>();
  private readonly regionSideMasks: Uint8Array;

  constructor(readonly descriptor: WorkbookArtifactDescriptor) {
    this.regionSideMasks = new Uint8Array(descriptor.regionCount);
    for (let run = 0; run < descriptor.runs.flags.length; run += 1) {
      const region = descriptor.runs.regionIds[run]!;
      const kind = descriptor.runs.flags[run]! & 3;
      if (region < descriptor.regionCount) this.regionSideMasks[region] = this.regionSideMasks[region]! | (kind === 1 ? 2 : kind === 2 ? 1 : 3);
    }
    for (let region = 0; region < descriptor.regionCount; region += 1) {
      if (this.regionSideMasks[region]) continue;
      const sheet = descriptor.sheets.find((item) => item.id === descriptor.regions.sheetIds[region]);
      if (sheet) this.regionSideMasks[region] = (sheet.hasBaseSide ? 1 : 0) | (sheet.hasMineSide ? 2 : 0);
    }
  }
  private getBridge() { return fixtureAdapters.get(this.descriptor.artifactId)?.adapter ?? window.versora!; }
  readSourceRows(request: WorkbookArtifactSourceRowsRequest, signal?: AbortSignal) {
    if (this.disposed) return Promise.reject(new Error('Workbook comparison is closed'));
    const readSignal = signal ? AbortSignal.any([signal, this.closedSignal]) : this.closedSignal;
    return this.scheduleRead(() => this.getBridge().readWorkbookArtifactSourceRows(request), readSignal);
  }
  getMeasuredColumnWidth(sheetId: number, column: number, measurementIdentity: string) {
    if (this.disposed) return undefined;
    return this.measuredColumnWidths.get(`${sheetId}:${column}:${measurementIdentity}`);
  }
  cacheMeasuredColumnWidths(sheetId: number, measurementIdentity: string, widths: ReadonlyMap<number, number>) {
    if (this.disposed) return;
    for (const [column, width] of widths) {
      const key = `${sheetId}:${column}:${measurementIdentity}`;
      this.measuredColumnWidths.delete(key);
      this.measuredColumnWidths.set(key, width);
    }
    while (this.measuredColumnWidths.size > COLUMN_WIDTH_CACHE_ENTRIES) {
      this.measuredColumnWidths.delete(this.measuredColumnWidths.keys().next().value!);
    }
  }
  beginColumnMeasurement() {
    this.cancelColumnMeasurement();
    const controller = new AbortController();
    this.columnMeasurement = controller;
    if (this.disposed) controller.abort();
    return { signal: controller.signal, complete: () => {
      if (this.columnMeasurement === controller) this.columnMeasurement = null;
    } };
  }
  cancelColumnMeasurement() {
    this.columnMeasurement?.abort();
    this.columnMeasurement = null;
  }
  search(request: WorkbookArtifactSearchRequest) {
    if (this.disposed) return Promise.reject(new Error('Workbook comparison is closed'));
    return this.getBridge().searchWorkbookArtifact(request);
  }
  cancelSearch(requestId: string) {
    if (this.disposed) return Promise.resolve();
    return this.getBridge().cancelWorkbookArtifactSearch(this.descriptor.artifactId, requestId);
  }
  async readCell(request: { sheetId: number; side: 'base' | 'mine'; rowNumber: number; column: number }) {
    const result = await this.getBridge().readWorkbookArtifactCells({ artifactId: this.descriptor.artifactId,
      sheetId: request.sheetId, side: request.side, cells: [{ rowNumber: request.rowNumber, column: request.column }] });
    return result.cells[0];
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.revision;
  private emit() {
    if (this.notificationQueued || this.disposed) return;
    this.notificationQueued = true;
    const notify = () => {
      this.notificationQueued = false;
      if (this.disposed) return;
      this.revision += 1;
      this.listeners.forEach((listener) => listener());
    };
    // A tile completion paints at most once per frame, even if several IPC replies arrive together.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(notify);
    else queueMicrotask(notify);
  }
  dispose() {
    this.disposed = true;
    this.lifetime.abort();
    this.cancelColumnMeasurement();
    this.measuredColumnWidths.clear();
    this.cache.clear(); this.selections.clear(); this.selectionSizes.clear(); this.listeners.clear();
    this.sectionRows.clear(); this.physicalIndexes.clear(); this.regionCache.clear(); this.regionViewCache.clear(); this.errors.clear();
    this.bytes = 0; this.cells = 0; this.selectionBytes = 0;
  }
  getCacheStats() { return { bytes: this.bytes + this.selectionBytes, windows: this.cache.size, cells: this.cells + this.selections.size, pending: this.pending.size + this.cellPending.size }; }
  getErrorCount() { return this.errors.size; }
  getPerfSummary() {
    return { artifactId: this.descriptor.artifactId, sessionId: this.descriptor.comparisonSessionId,
      mode: this.descriptor.compareMode, sourceCounts: this.descriptor.sourceCounts,
      changedCells: this.descriptor.stats.changedCells, cache: this.getCacheStats(),
      sheets: this.descriptor.sheets.map((sheet) => {
        let baseRows = 0; let mineRows = 0;
        for (let row = sheet.pairStart; row < sheet.pairStart + sheet.pairCount; row += 1) {
          baseRows = Math.max(baseRows, this.descriptor.rows.baseRowNumbers[row]!);
          mineRows = Math.max(mineRows, this.descriptor.rows.mineRowNumbers[row]!);
        }
        return { id: sheet.id, name: sheet.name, displayRows: sheet.pairCount,
          maxColumns: sheet.maxColumnCount, changedCells: sheet.changedCellCount, baseRows, mineRows };
      }) };
  }

  getSections(): WorkbookSection[] {
    return this.descriptor.sheets.map((sheet) => {
      const baseMeta = this.descriptor.baseMetadata.sheets[sheet.name];
      const mineMeta = this.descriptor.mineMetadata.sheets[sheet.name];
      let maxRow = Math.max(baseMeta?.rowCount ?? 0, mineMeta?.rowCount ?? 0);
      for (let row = sheet.pairStart; row < sheet.pairStart + sheet.pairCount; row += 1) maxRow = Math.max(maxRow, this.descriptor.rows.baseRowNumbers[row]!, this.descriptor.rows.mineRowNumbers[row]!);
      return { name: sheet.name, displayName: sheet.name,
        changeType: sheet.changeType ?? (!sheet.hasBaseSide ? 'add' : !sheet.hasMineSide ? 'delete' : 'equal'),
        hasBaseSide: sheet.hasBaseSide, hasMineSide: sheet.hasMineSide,
        renamePeerName: sheet.renamePeerName ?? null, renameRole: sheet.renameRole ?? null, startLineIdx: sheet.pairStart - 1,
        endLineIdx: sheet.pairStart + sheet.pairCount - 1, maxColumns: sheet.maxColumnCount,
        rowCount: maxRow,
        firstDataLineIdx: sheet.pairCount ? sheet.pairStart : null,
        firstDataRowNumber: (this.descriptor.rows.baseRowNumbers[sheet.pairStart] || this.descriptor.rows.mineRowNumbers[sheet.pairStart]) ?? null };
    });
  }
  getRows(name: string) {
    const cached = this.sectionRows.get(name);
    if (cached) return cached;
    const sheet = this.descriptor.sheets.find((item) => item.name === name);
    if (!sheet) return undefined;
    const rows: SplitRow[] = [];
    for (let localRowIndex = 0; localRowIndex < sheet.pairCount; localRowIndex += 1) {
      const rowIndex = sheet.pairStart + localRowIndex;
      const kind = this.descriptor.rows.kinds[rowIndex]!;
      const ref: WorkbookArtifactRowReference = { provider: this, sheetId: sheet.id, localRowIndex, rowIndex,
        kind, baseRowNumber: this.descriptor.rows.baseRowNumbers[rowIndex] || null,
        mineRowNumber: this.descriptor.rows.mineRowNumbers[rowIndex] || null };
      const count = this.descriptor.rows.changedCellCounts[rowIndex]!;
      const mask = this.descriptor.rows.toneMasks[rowIndex]!;
      const miniMapPaintTones: WorkbookRowMiniMapPaintTone[] = [];
      if (mask & 1) miniMapPaintTones.push('add');
      if (mask & 2) miniMapPaintTones.push('delete');
      if (mask & 4) miniMapPaintTones.push('modify');
      if (mask & 8) miniMapPaintTones.push('strict-only');
      const tone = kind === 1 || mask === 1 ? 'add' : kind === 2 || mask === 2 ? 'delete' : count ? 'mixed' : 'equal';
      rows.push({ left: null, right: null, lineIdx: rowIndex, lineIdxs: [rowIndex], workbookArtifactRow: ref,
        workbookRowDelta: { cellDeltas: new Map(), changedColumns: [], strictOnlyColumns: [],
          changedCount: count, hasChanges: kind !== 0, tone,
          miniMapTone: miniMapPaintTones.length > 1 ? 'mixed' : miniMapPaintTones[0] ?? 'equal', miniMapPaintTones,
          artifactSummary: true, ...(kind === 1 ? { structuralChange: 'add' as const } : kind === 2 ? { structuralChange: 'delete' as const } : {}) } });
    }
    this.sectionRows.set(name, rows);
    return rows;
  }
  getRowReference(rowIndex: number) {
    const sheet = this.descriptor.sheets.find((item) => rowIndex >= item.pairStart && rowIndex < item.pairStart + item.pairCount);
    return sheet ? this.getRows(sheet.name)?.[rowIndex - sheet.pairStart]?.workbookArtifactRow : undefined;
  }
  findRun(rowIndex: number, column: number) {
    const { rows, runs } = this.descriptor;
    let low = rows.runOffsets[rowIndex]!; let high = rows.runOffsets[rowIndex + 1]!;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (runs.starts[middle]! <= column) low = middle + 1; else high = middle;
    }
    const index = low - 1;
    return index >= rows.runOffsets[rowIndex]! && column < runs.ends[index]! ? index : -1;
  }
  runHasSide(run: number, side: 'base' | 'mine') {
    const kind = this.descriptor.runs.flags[run]! & 3;
    return side === 'base' ? kind !== 1 : kind !== 2;
  }
  findPhysicalRowIndex(sheetId: number, side: 'base' | 'mine', rowNumber: number) {
    const key = `${sheetId}:${side}`;
    let index = this.physicalIndexes.get(key);
    if (!index) {
      index = new Map();
      const sheet = this.descriptor.sheets.find((item) => item.id === sheetId)!;
      const numbers = side === 'base' ? this.descriptor.rows.baseRowNumbers : this.descriptor.rows.mineRowNumbers;
      for (let row = sheet.pairStart; row < sheet.pairStart + sheet.pairCount; row += 1) if (numbers[row]) index.set(numbers[row]!, row);
      this.physicalIndexes.set(key, index);
    }
    return index.get(rowNumber);
  }
  containsRegion(index: number, selection: WorkbookSelectedCell) {
    const sheet = this.descriptor.sheets.find((item) => item.name === selection.sheetName);
    if (!sheet || sheet.id !== this.descriptor.regions.sheetIds[index]) return false;
    const metadata = selection.side === 'base' ? this.descriptor.baseMetadata : this.descriptor.mineMetadata;
    const merge = metadata.sheets[sheet.name]?.mergeRanges.find((range) => selection.rowNumber >= range.startRow && selection.rowNumber <= range.endRow && selection.colIndex >= range.startCol && selection.colIndex <= range.endCol);
    const rowIndex = this.findPhysicalRowIndex(sheet.id, selection.side, merge?.startRow ?? selection.rowNumber);
    if (rowIndex == null) return false;
    const run = this.findRun(rowIndex, merge?.startCol ?? selection.colIndex);
    return run >= 0 && this.runHasSide(run, selection.side) && this.descriptor.runs.regionIds[run] === index;
  }
  getRegion(index: number, baseVersion: string, mineVersion: string): WorkbookDiffRegion | undefined {
    if (index < 0 || index >= this.descriptor.regionCount) return undefined;
    const key = `${index}:${baseVersion}:${mineVersion}`;
    const cached = this.regionCache.get(key);
    if (cached) return cached;
    const regions = this.descriptor.regions;
    const sheet = this.descriptor.sheets.find((item) => item.id === regions.sheetIds[index])!;
    const startRow = regions.startRows[index]!; const endRow = regions.endRows[index]! - 1;
    const anchor = sheet.pairCount ? this.getRowReference(regions.anchorRows[index]!) : undefined;
    const baseStart = sheet.pairCount ? this.descriptor.rows.baseRowNumbers[startRow] ?? 0 : 0;
    const mineStart = sheet.pairCount ? this.descriptor.rows.mineRowNumbers[startRow] ?? 0 : 0;
    const baseEnd = sheet.pairCount ? this.descriptor.rows.baseRowNumbers[endRow] ?? 0 : 0;
    const mineEnd = sheet.pairCount ? this.descriptor.rows.mineRowNumbers[endRow] ?? 0 : 0;
    let anchorSelection = anchor ? this.makeSelection(anchor, regions.anchorColumns[index]!, baseVersion, mineVersion) : null;
    const anchorRun = anchor ? this.findRun(anchor.rowIndex, regions.anchorColumns[index]!) : -1;
    if (anchorSelection && anchor && anchorRun >= 0 && !this.runHasSide(anchorRun, 'mine') && anchor.baseRowNumber != null) {
      anchorSelection = { ...anchorSelection, side: 'base', versionLabel: baseVersion, rowNumber: anchor.baseRowNumber,
        address: `${anchorSelection.colLabel}${anchor.baseRowNumber}` };
    }
    const region: WorkbookDiffRegion = { id: `artifact:${this.descriptor.artifactId}:${index}`, sheetName: sheet.name,
      startRowIndex: startRow - sheet.pairStart, endRowIndex: Math.max(0, endRow - sheet.pairStart),
      startCol: regions.startColumns[index]!, endCol: Math.max(0, regions.endColumns[index]! - 1),
      rowNumberStart: baseStart || mineStart, rowNumberEnd: baseEnd || mineEnd,
      lineStartIdx: startRow, lineEndIdx: Math.max(startRow, endRow), anchorLineIdx: anchor?.rowIndex ?? startRow,
      hasBaseSide: Boolean(this.regionSideMasks[index]! & 1), hasMineSide: Boolean(this.regionSideMasks[index]! & 2),
      anchorSelection,
      patches: [], artifactRegion: { provider: this, index } };
    this.regionCache.set(key, region);
    while (this.regionCache.size > 64) this.regionCache.delete(this.regionCache.keys().next().value!);
    return region;
  }
  /** Array-compatible navigation view backed by a compact index, with bounded summary objects. */
  getRegions(baseVersion: string, mineVersion: string, filter: DiffTypeFilter = 'all'): WorkbookDiffRegion[] {
    const key = `${baseVersion}:${mineVersion}:${filter}`;
    const cached = this.regionViewCache.get(key);
    if (cached) return cached;
    const indices: number[] = [];
    if (filter !== 'all') for (let index = 0; index < this.descriptor.regionCount; index += 1) {
      const base = Boolean(this.regionSideMasks[index]! & 1);
      const mine = Boolean(this.regionSideMasks[index]! & 2);
      if ((filter === 'add' && !base && mine) || (filter === 'delete' && base && !mine) || (filter === 'modify' && base && mine)) indices.push(index);
    }
    const ordinalByRegion = filter === 'all' ? null : new Int32Array(this.descriptor.regionCount);
    ordinalByRegion?.fill(-1);
    const sheetRanges = new Map<string, { first: number; last: number }>();
    const sheetNames = new Map(this.descriptor.sheets.map((sheet) => [sheet.id, sheet.name]));
    const length = filter === 'all' ? this.descriptor.regionCount : indices.length;
    for (let ordinal = 0; ordinal < length; ordinal += 1) {
      const index = filter === 'all' ? ordinal : indices[ordinal]!;
      if (ordinalByRegion) ordinalByRegion[index] = ordinal;
      const name = sheetNames.get(this.descriptor.regions.sheetIds[index]!)!;
      const range = sheetRanges.get(name);
      if (range) range.last = ordinal; else sheetRanges.set(name, { first: ordinal, last: ordinal });
    }
    // The empty array target avoids allocating one JavaScript slot per native region.
    const view = new Proxy([] as WorkbookDiffRegion[], {
      get: (target, property, receiver) => {
        if (property === 'length') return length;
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          const ordinal = Number(property);
          return this.getRegion(ordinal < length ? filter === 'all' ? ordinal : indices[ordinal]! : -1, baseVersion, mineVersion);
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
      has(target, property) { return typeof property === 'string' && /^\d+$/.test(property) ? Number(property) < length : Reflect.has(target, property); },
    });
    regionViews.set(view, { provider: this, ordinalByRegion, sheetRanges });
    this.regionViewCache.set(key, view);
    return view;
  }
  getClippedRegionPatches(index: number, localRows: readonly number[], columns: readonly number[]) {
    const sheet = this.descriptor.sheets.find((item) => item.id === this.descriptor.regions.sheetIds[index])!;
    const patches: WorkbookDiffRegion['patches'] = [];
    const minColumn = columns.length ? Math.min(...columns) : 0;
    const maxColumn = columns.length ? Math.max(...columns) : sheet.maxColumnCount - 1;
    for (const localRow of localRows) {
      const globalRow = sheet.pairStart + localRow;
      for (let run = this.descriptor.rows.runOffsets[globalRow]!; run < this.descriptor.rows.runOffsets[globalRow + 1]!; run += 1) {
        if (this.descriptor.runs.regionIds[run] !== index) continue;
        const startCol = Math.max(minColumn, this.descriptor.runs.starts[run]!);
        const endCol = Math.min(maxColumn, this.descriptor.runs.ends[run]! - 1);
        if (startCol > endCol) continue;
        const baseRow = this.descriptor.rows.baseRowNumbers[globalRow] || null;
        const mineRow = this.descriptor.rows.mineRowNumbers[globalRow] || null;
        patches.push({ startRowIndex: localRow, endRowIndex: localRow, startCol, endCol,
          baseRowStart: baseRow, baseRowEnd: baseRow, mineRowStart: mineRow, mineRowEnd: mineRow,
          hasBaseSide: baseRow != null && this.runHasSide(run, 'base'), hasMineSide: mineRow != null && this.runHasSide(run, 'mine') });
      }
    }
    // Off-screen anchors still supply visible merged footprints, without reading their cell values.
    for (const side of ['base', 'mine'] as const) {
      const metadata = side === 'base' ? this.descriptor.baseMetadata : this.descriptor.mineMetadata;
      for (const merge of metadata.sheets[sheet.name]?.mergeRanges ?? []) {
        if (merge.endCol < minColumn || merge.startCol > maxColumn) continue;
        const anchorIndex = this.findPhysicalRowIndex(sheet.id, side, merge.startRow);
        if (anchorIndex == null) continue;
        const run = this.findRun(anchorIndex, merge.startCol);
        if (run < 0 || this.descriptor.runs.regionIds[run] !== index) continue;
        const matching = localRows.filter((localRow) => {
          const number = (side === 'base' ? this.descriptor.rows.baseRowNumbers : this.descriptor.rows.mineRowNumbers)[sheet.pairStart + localRow]!;
          return number >= merge.startRow && number <= merge.endRow;
        });
        for (const localRow of matching) patches.push({ startRowIndex: localRow, endRowIndex: localRow,
          startCol: Math.max(minColumn, merge.startCol), endCol: Math.min(maxColumn, merge.endCol),
          baseRowStart: side === 'base' ? merge.startRow : null, baseRowEnd: side === 'base' ? merge.endRow : null,
          mineRowStart: side === 'mine' ? merge.startRow : null, mineRowEnd: side === 'mine' ? merge.endRow : null,
          hasBaseSide: side === 'base', hasMineSide: side === 'mine' });
      }
    }
    return patches;
  }

  async ensureRows(rows: readonly SplitRow[], columns: readonly number[]) {
    const requests = new Map<string, { sheetId: number; row: number; column: number; rows: Set<number> }>();
    for (const row of rows) {
      const ref = row.workbookArtifactRow;
      if (!ref || ref.provider !== this) continue;
      const tileRow = Math.floor(ref.localRowIndex / TILE_ROWS) * TILE_ROWS;
      for (const column of columns) {
        const tileColumn = Math.floor(column / TILE_COLUMNS) * TILE_COLUMNS;
        const key = tileKey(ref.sheetId, tileRow, tileColumn);
        let request = requests.get(key);
        if (!request) { request = { sheetId: ref.sheetId, row: tileRow, column: tileColumn, rows: new Set() }; requests.set(key, request); }
        request.rows.add(ref.localRowIndex);
      }
    }
    // Register the entire demand before starting IO, so readiness never sees a gap between batches.
    await Promise.all([...requests].map(([key, request]) => this.ensureTile(key, request)));
  }

  private scheduleRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancellationError = () => signal?.reason instanceof Error ? signal.reason : new DOMException('Workbook read cancelled', 'AbortError');
      if (signal?.aborted) { reject(cancellationError()); return; }
      const cancelled = () => {
        const queued = this.readQueue.indexOf(start);
        if (queued >= 0) this.readQueue.splice(queued, 1);
        reject(cancellationError());
      };
      const start = () => {
        this.activeReads += 1;
        let task: Promise<T>;
        try { task = read(); }
        catch (error) { task = Promise.reject(error instanceof Error ? error : new Error(String(error))); }
        void task.then(resolve, reject).finally(() => {
          signal?.removeEventListener('abort', cancelled);
          this.activeReads -= 1;
          this.readQueue.shift()?.();
        });
      };
      signal?.addEventListener('abort', cancelled, { once: true });
      if (this.activeReads < 4) start(); else this.readQueue.push(start);
    });
  }

  private ensureTile(key: string, request: { sheetId: number; row: number; column: number; rows: ReadonlySet<number> }): Promise<void> {
    const cached = this.cache.get(key);
    const missing = [...request.rows].filter((row) => !cached?.rows[row - request.row]).sort((a, b) => a - b);
    if (!missing.length) { if (cached) { this.cache.delete(key); this.cache.set(key, cached); } return Promise.resolve(); }
    const pending = this.pending.get(key);
    if (pending) {
      if (missing.every((row) => this.pendingRows.get(key)?.has(row))) return pending;
      return pending.then(() => this.errors.has(key) || this.disposed ? undefined : this.ensureTile(key, request));
    }
    const bridge = this.getBridge();
    if (!bridge?.readWorkbookArtifactWindow) return Promise.reject(new Error('Workbook window provider unavailable'));
    const sheet = this.descriptor.sheets.find((item) => item.id === request.sheetId)!;
    this.pendingRows.set(key, new Set(missing));
    const task = this.scheduleRead(async () => {
      if (this.disposed) return null;
      const ranges: Array<{ start: number; end: number }> = [];
      for (const row of missing) {
        const last = ranges[ranges.length - 1];
        if (last?.end === row) last.end = row + 1; else ranges.push({ start: row, end: row + 1 });
      }
      const rows: WorkbookArtifactWindowRow[] = [];
      for (const range of ranges) {
        let cursor = range.start;
        while (cursor < range.end) {
          const page = await bridge.readWorkbookArtifactWindow!({
            artifactId: this.descriptor.artifactId, compareMode: this.descriptor.compareMode,
            sheetId: request.sheetId, startRow: cursor, rowCount: range.end - cursor,
            columnRanges: [{ start: request.column, end: Math.min(sheet.maxColumnCount, request.column + TILE_COLUMNS) }],
          });
          if (page.artifactId !== this.descriptor.artifactId || page.compareMode !== this.descriptor.compareMode) throw new Error('Stale workbook window');
          rows.push(...page.rows);
          if (page.nextRow == null || page.nextRow >= range.end) break;
          if (page.nextRow <= cursor) throw new Error('Workbook window did not advance');
          cursor = page.nextRow;
        }
      }
      if (rows.length !== missing.length) throw new Error('Incomplete workbook window');
      return rows;
    }).then((loadedRows) => {
      if (!loadedRows || this.disposed) return;
      const previous = this.cache.get(key);
      const rows = previous ? previous.rows.slice() : new Array<WorkbookArtifactWindowRow | undefined>(TILE_ROWS);
      for (const row of loadedRows) rows[row.rowIndex - sheet.pairStart - request.row] = row;
      // Account for cache keys, array slots, row records and change-run records even in blank windows.
      let bytes = 192 + 2 * key.length + TILE_ROWS * 8; let cells = 0;
      for (const row of rows) {
        if (!row) continue;
        bytes += 128 + row.changedColumnRuns.length * 32;
        for (const cell of [...row.baseCells, ...row.mineCells]) {
          bytes += 64 + 2 * (cell.value.length + cell.formula.length); cells += 1;
        }
      }
      if (previous) { this.bytes -= previous.bytes; this.cells -= previous.cells; this.cache.delete(key); }
      const entry = { rows, bytes, cells };
      this.cache.set(key, entry); this.bytes += bytes; this.cells += cells; this.errors.delete(key);
      this.trimWindows(key);
    }).catch((error: unknown) => {
      if (!this.disposed) this.errors.set(key, error instanceof Error ? error : new Error(String(error)));
    }).finally(() => { this.pending.delete(key); this.pendingRows.delete(key); if (!this.disposed) this.emit(); });
    this.pending.set(key, task);
    return task;
  }

  private trimWindows(protectedKey?: string) {
    while (this.cache.size > CACHE_WINDOWS || this.bytes + this.selectionBytes > CACHE_BYTES) {
      const oldest = this.cache.keys().next().value;
      if (!oldest || (oldest === protectedKey && this.cache.size === 1)) break;
      const old = this.cache.get(oldest)!;
      this.bytes -= old.bytes; this.cells -= old.cells; this.cache.delete(oldest);
    }
  }

  getWindowRow(ref: WorkbookArtifactRowReference, column: number): WorkbookArtifactWindowRow | undefined {
    const startRow = Math.floor(ref.localRowIndex / TILE_ROWS) * TILE_ROWS;
    const key = tileKey(ref.sheetId, startRow, Math.floor(column / TILE_COLUMNS) * TILE_COLUMNS);
    return this.cache.get(key)?.rows[ref.localRowIndex - startRow];
  }
  readCachedCell(ref: WorkbookArtifactRowReference, side: 'base' | 'mine', column: number) {
    const physicalRow = side === 'base' ? ref.baseRowNumber : ref.mineRowNumber;
    const anchor = this.selections.get(`${ref.sheetId}:${side}:${physicalRow}:${column}`);
    if (anchor) return anchor;
    const row = this.getWindowRow(ref, column);
    if (!row) return undefined;
    const cells = side === 'base' ? row.baseCells : row.mineCells;
    let low = 0; let high = cells.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (cells[middle]!.column < column) low = middle + 1; else high = middle;
    }
    return cells[low]?.column === column ? cells[low]! : EMPTY_CELL;
  }
  getCellStatus(ref: WorkbookArtifactRowReference, side: 'base' | 'mine', column: number): 'pending' | 'ready' | 'error' {
    if (this.readCachedCell(ref, side, column)) return 'ready';
    const rowNumber = side === 'base' ? ref.baseRowNumber : ref.mineRowNumber;
    const key = tileKey(ref.sheetId, Math.floor(ref.localRowIndex / TILE_ROWS) * TILE_ROWS, Math.floor(column / TILE_COLUMNS) * TILE_COLUMNS);
    return this.errors.has(key) || this.errors.has(`cell:${ref.sheetId}:${side}:${rowNumber}:${column}`) ? 'error' : 'pending';
  }
  async ensureCells(sheetId: number, side: 'base' | 'mine', cells: Array<{ rowNumber: number; column: number }>) {
    const keyFor = (cell: { rowNumber: number; column: number }) => `${sheetId}:${side}:${cell.rowNumber}:${cell.column}`;
    const waitFor = new Set<Promise<void>>();
    const missing = cells.filter((cell) => {
      if (this.selections.has(keyFor(cell))) return false;
      const pending = this.cellPending.get(keyFor(cell));
      if (pending) { waitFor.add(pending); return false; }
      return true;
    });
    if (!missing.length) { await Promise.all(waitFor); return; }
    const task = this.scheduleRead(async () => {
      if (this.disposed) return;
      const result = await this.getBridge().readWorkbookArtifactCells({ artifactId: this.descriptor.artifactId, sheetId, side, cells: missing });
      if (this.disposed || result.artifactId !== this.descriptor.artifactId) return;
      for (const cell of result.cells) {
        this.cacheSelection(`${sheetId}:${side}:${cell.rowNumber}:${cell.column}`, cell);
        this.errors.delete(`cell:${sheetId}:${side}:${cell.rowNumber}:${cell.column}`);
      }
    }).catch((error: unknown) => {
      if (this.disposed) return;
      for (const cell of missing) this.errors.set(`cell:${sheetId}:${side}:${cell.rowNumber}:${cell.column}`, error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      for (const cell of missing) this.cellPending.delete(keyFor(cell));
      this.emit();
    });
    for (const cell of missing) this.cellPending.set(keyFor(cell), task);
    waitFor.add(task);
    await Promise.all(waitFor);
  }
  private cacheSelection(key: string, cell: WorkbookArtifactCell) {
    this.selectionBytes -= this.selectionSizes.get(key) ?? 0;
    const bytes = 112 + 2 * (key.length + cell.value.length + cell.formula.length);
    this.selections.delete(key); this.selections.set(key, cell);
    this.selectionSizes.set(key, bytes); this.selectionBytes += bytes;
    while (this.selections.size > 256 || this.selectionBytes > SELECTION_CACHE_BYTES) {
      const oldest = this.selections.keys().next().value;
      // A single full cell may exceed the budget; never truncate its value or formula.
      if (!oldest || (oldest === key && this.selections.size === 1)) break;
      this.selectionBytes -= this.selectionSizes.get(oldest)!;
      this.selectionSizes.delete(oldest); this.selections.delete(oldest);
    }
    this.trimWindows();
  }
  buildEntry(ref: WorkbookArtifactRowReference, side: 'base' | 'mine', versionLabel: string, visibleColumns: number[], hydrate = false): WorkbookRowEntry | null {
    const rowNumber = side === 'base' ? ref.baseRowNumber : ref.mineRowNumber;
    if (rowNumber == null) return null;
    const cells: WorkbookRowEntry['cells'] = [];
    const loadedColumns = new Set<number>();
    if (hydrate) for (const column of visibleColumns) {
      const cell = this.readCachedCell(ref, side, column);
      if (cell) { cells[column] = cell; loadedColumns.add(column); }
    }
    return { sheetName: this.descriptor.sheets.find((sheet) => sheet.id === ref.sheetId)!.name,
      side, versionLabel, rowNumber, cells, visibleColumns, lineIdxs: [ref.rowIndex],
      artifactRow: ref, loadedColumns };
  }
  buildWindowDelta(ref: WorkbookArtifactRowReference, columns: readonly number[], summary: WorkbookRowDelta): WorkbookRowDelta {
    const cellDeltas = new Map<number, WorkbookCellDelta>();
    for (const column of columns) {
      const base = ref.baseRowNumber == null ? EMPTY_CELL : this.readCachedCell(ref, 'base', column);
      const mine = ref.mineRowNumber == null ? EMPTY_CELL : this.readCachedCell(ref, 'mine', column);
      if (!base || !mine) continue;
      const hasBaseContent = hasWorkbookCellContent(base, this.descriptor.compareMode);
      const hasMineContent = hasWorkbookCellContent(mine, this.descriptor.compareMode);
      if (!hasBaseContent && !hasMineContent) continue;
      const run = this.findRun(ref.rowIndex, column);
      const flags = run >= 0 ? this.descriptor.runs.flags[run]! : 0;
      const changed = run >= 0;
      cellDeltas.set(column, { column, baseCell: base, mineCell: mine, changed, masked: !changed,
        kind: !changed ? 'equal' : (flags & 3) === 1 ? 'add' : (flags & 3) === 2 ? 'delete' : 'modify',
        strictOnly: Boolean(flags & 4), hasBaseContent: changed ? Boolean(flags & 8) : hasBaseContent,
        hasMineContent: changed ? Boolean(flags & 16) : hasMineContent, hasContent: true });
    }
    return { ...summary, cellDeltas };
  }
  async resolveSelection(selection: WorkbookSelectedCell) {
    const sheet = this.descriptor.sheets.find((item) => item.name === selection.sheetName);
    if (!sheet) return selection;
    const key = `${sheet.id}:${selection.side}:${selection.rowNumber}:${selection.colIndex}`;
    await this.ensureCells(sheet.id, selection.side, [{ rowNumber: selection.rowNumber, column: selection.colIndex }]);
    const cell = this.selections.get(key);
    const error = this.errors.get(`cell:${key}`);
    if (error) throw error;
    if (!cell) throw new Error('Workbook selection did not return a cell');
    return { ...selection, value: cell?.value ?? '', formula: cell?.formula ?? '', dataStatus: 'ready' as const };
  }
  makeSelection(ref: WorkbookArtifactRowReference, column: number, baseVersion: string, mineVersion: string): WorkbookSelectedCell {
    const side = ref.mineRowNumber == null ? 'base' : 'mine';
    const rowNumber = (side === 'base' ? ref.baseRowNumber : ref.mineRowNumber)!;
    const colLabel = getWorkbookColumnLabel(column);
    return { kind: 'cell', sheetName: this.descriptor.sheets.find((item) => item.id === ref.sheetId)!.name,
      side, versionLabel: side === 'base' ? baseVersion : mineVersion, rowNumber, colIndex: column,
      colLabel, address: `${colLabel}${rowNumber}`, value: '', formula: '', dataStatus: 'pending' };
  }
}

/** A missing cell paints a load indicator; it never becomes a stored blank cell. */
export function getWorkbookPendingCellPaint(entry: WorkbookRowEntry | null | undefined, column: number) {
  if (!entry?.artifactRow) return '';
  return entry.artifactRow.provider.getCellStatus(entry.artifactRow, entry.side, column) === 'error' ? '⚠' : '…';
}
