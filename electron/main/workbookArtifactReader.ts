import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { visitWorkbookArtifactRow } from './workbookArtifactRowRecord.js';
import {
  WORKBOOK_ARTIFACT_KIND,
  WORKBOOK_ARTIFACT_MISSING_ORDINAL,
  type WorkbookArtifactCell,
  type WorkbookArtifactCellsRequest,
  type WorkbookArtifactCellsResult,
  type WorkbookArtifactColumnRange,
  type WorkbookArtifactCompareMode,
  type WorkbookArtifactDescriptor,
  type WorkbookArtifactManifest,
  type WorkbookArtifactMetadata,
  type WorkbookArtifactNativeMetadata,
  type WorkbookArtifactSide,
  type WorkbookArtifactWindow,
  type WorkbookArtifactWindowRequest,
} from '../../shared/workbookArtifactProtocol.js';

const MAX_INDEX_BYTES = 512 * 1024 * 1024;
const BUFFERED_ROW_BYTES = 4 * 1024 * 1024;
const READ_AHEAD_BYTES = 1024 * 1024;
const ROW_CACHE_BYTES = 16 * 1024 * 1024;
const ROW_CACHE_BLOCKS = 128;
const WINDOW_RESPONSE_BYTES = 16 * 1024 * 1024;
const DESCRIPTOR_CACHE_BYTES = 64 * 1024 * 1024;
const EMPTY_ROW = 0xffff_ffff;

interface RowBlock { side: WorkbookArtifactSide; offset: number; buffer: Buffer }
interface PendingRowBlock { side: WorkbookArtifactSide; offset: number; bytes: number; promise: Promise<Buffer> }

function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid workbook artifact ${name}.`);
  }
  return value;
}
function count64(buffer: Buffer, offset: number, name: string): number {
  const value = Number(buffer.readBigUInt64LE(offset));
  return integer(value, name);
}
function assertHeader(buffer: Buffer, magic: string, recordBytes?: number, count?: number): void {
  if (buffer.length < 8 || buffer.toString('ascii', 0, 8) !== magic) {
    throw new Error(`Invalid workbook artifact ${magic} header.`);
  }
  if (recordBytes != null && count != null && buffer.length !== 16 + recordBytes * count) {
    throw new Error(`Truncated workbook artifact ${magic} index.`);
  }
}
function inRange(column: number, ranges: readonly WorkbookArtifactColumnRange[]): boolean {
  let low = 0; let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const range = ranges[mid]!;
    if (column < range.start) high = mid;
    else if (column >= range.end) low = mid + 1;
    else return true;
  }
  return false;
}
function validateRanges(ranges: readonly WorkbookArtifactColumnRange[]): void {
  if (!ranges || !Number.isInteger(ranges.length) || ranges.length > 16_384) throw new Error('Invalid workbook column window.');
  for (const range of ranges) {
    integer(range.start, 'column start');
    integer(range.end, 'column end');
    if (range.end < range.start || range.end > 16_384) throw new Error('Invalid workbook column interval.');
  }
}
function mergeRanges(ranges: readonly WorkbookArtifactColumnRange[]): WorkbookArtifactColumnRange[] {
  const result: WorkbookArtifactColumnRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (range.start === range.end) continue;
    const previous = result[result.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}
function normalizeMetadata(input: WorkbookArtifactNativeMetadata): WorkbookArtifactMetadata {
  if (!input || typeof input !== 'object') throw new Error('Missing workbook artifact metadata.');
  const sheets = input.s;
  if (!sheets || typeof sheets !== 'object') throw new Error('Invalid workbook artifact metadata.');
  return { sheets: Object.fromEntries(Object.entries(sheets).map(([name, sheet]) => {
    const ranges = sheet.m ?? [];
    const rowCount = integer(sheet.r ?? 0, 'metadata row count');
    const maxColumns = integer(sheet.c ?? 0, 'metadata column count');
    return [name, {
      name,
      hiddenColumns: (sheet.h ?? []).map(column => integer(column, 'hidden column')),
      mergeRanges: ranges.map(range => ({
        startRow: integer(range.sr, 'merge row start'),
        endRow: integer(range.er, 'merge row end'),
        startCol: integer(range.sc, 'merge column start'),
        endCol: integer(range.ec, 'merge column end'),
      })),
      rowCount,
      maxColumns,
    }];
  })) };
}

/** Reads canonical rows by ordinal. Only compact indexes and a byte-bounded row LRU live in RAM. */
export class WorkbookArtifactReader {
  private readonly handles = new Map<WorkbookArtifactSide, FileHandle>();
  private readonly rowFileBytes = new Map<WorkbookArtifactSide, number>();
  private readonly indexes = new Map<WorkbookArtifactSide, Buffer>();
  private readonly physicalRowIndexes = new Map<WorkbookArtifactSide, Map<number, Uint32Array>>();
  private readonly rowCache = new Map<string, RowBlock>();
  private readonly rowReads = new Map<string, PendingRowBlock>();
  private readonly descriptorBytes = new Map<WorkbookArtifactCompareMode, number>();
  private rowCacheBytes = 0;
  private closed = false;
  private activeReads = 0;
  private drained: (() => void) | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly descriptors = new Map<WorkbookArtifactCompareMode, Promise<WorkbookArtifactDescriptor>>();
  readonly baseMetadata: WorkbookArtifactMetadata;
  readonly mineMetadata: WorkbookArtifactMetadata;
  sourceByteLengths = { base: 0, mine: 0 };
  contentsEqual: boolean | null = null;

  private constructor(
    readonly manifest: WorkbookArtifactManifest,
    readonly artifactId: string,
    readonly comparisonSessionId: string,
    private readonly root: string,
  ) {
    this.baseMetadata = normalizeMetadata(manifest.baseMetadata);
    this.mineMetadata = normalizeMetadata(manifest.mineMetadata);
  }

  static async open(
    manifest: WorkbookArtifactManifest,
    artifactId: string,
    comparisonSessionId: string,
    root: string,
  ): Promise<WorkbookArtifactReader> {
    if (manifest.kind !== WORKBOOK_ARTIFACT_KIND || manifest.version !== 1 || manifest.complete !== true) {
      throw new Error('Incomplete or unsupported workbook artifact.');
    }
    const reader = new WorkbookArtifactReader(manifest, artifactId, comparisonSessionId, await fs.realpath(root));
    try {
      for (const side of ['base', 'mine'] as const) {
        const index = await reader.readIndex(manifest.files[side === 'base' ? 'baseIndex' : 'mineIndex']);
        if (index.length < 16) throw new Error('Truncated workbook row index.');
        const count = count64(index, 8, 'row count');
        assertHeader(index, 'VWRIDX01', 24, count);
        if (count !== manifest[side].rowCount) throw new Error('Workbook row count does not match its manifest.');
        reader.indexes.set(side, index);
        const ordinalsBySheet = new Map<number, number[]>();
        for (let ordinal = 0; ordinal < count; ordinal += 1) {
          const sheetId = index.readUInt32LE(16 + ordinal * 24);
          const ordinals = ordinalsBySheet.get(sheetId) ?? [];
          ordinals.push(ordinal);
          ordinalsBySheet.set(sheetId, ordinals);
        }
        reader.physicalRowIndexes.set(side, new Map([...ordinalsBySheet].map(([sheetId, ordinals]) => [
          sheetId, Uint32Array.from(ordinals).sort((a, b) => index.readUInt32LE(20 + a * 24) - index.readUInt32LE(20 + b * 24)),
        ])));
        const file = await fs.open(await reader.resolveFile(manifest.files[side === 'base' ? 'baseRows' : 'mineRows']), 'r');
        reader.handles.set(side, file);
        reader.rowFileBytes.set(side, (await file.stat()).size);
        const header = Buffer.alloc(8);
        await reader.readExactly(file, header, 0);
        assertHeader(header, 'VWRROW01');
      }
      return reader;
    } catch (error) {
      await reader.close();
      throw error;
    }
  }

  private async resolveFile(fileName: string): Promise<string> {
    if (typeof fileName !== 'string' || !fileName || path.isAbsolute(fileName)) {
      throw new Error('Invalid workbook artifact filename.');
    }
    const resolved = await fs.realpath(path.resolve(this.root, fileName));
    const relative = path.relative(this.root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Workbook artifact file is outside its lease.');
    }
    return resolved;
  }
  private async readIndex(fileName: string): Promise<Buffer> {
    const filePath = await this.resolveFile(fileName);
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) throw new Error('Workbook index exceeds its memory budget.');
    return fs.readFile(filePath);
  }
  private async readExactly(file: FileHandle, buffer: Buffer, offset: number): Promise<void> {
    let position = 0;
    while (position < buffer.length) {
      const { bytesRead } = await file.read(buffer, position, buffer.length - position, offset + position);
      if (bytesRead === 0) throw new Error('Truncated workbook artifact row.');
      position += bytesRead;
    }
  }
  private async withRead<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Workbook artifact is closed.');
    this.activeReads += 1;
    try { return await run(); }
    finally {
      this.activeReads -= 1;
      if (this.activeReads === 0) this.drained?.();
    }
  }
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      if (this.activeReads > 0) await new Promise<void>(resolve => { this.drained = resolve; });
      await Promise.all([...this.handles.values()].map(handle => handle.close()));
      this.handles.clear();
      this.rowFileBytes.clear();
      this.indexes.clear();
      this.physicalRowIndexes.clear();
      this.rowCache.clear();
      this.rowReads.clear();
      this.descriptors.clear();
      this.descriptorBytes.clear();
      this.rowCacheBytes = 0;
    })();
    return this.closePromise;
  }
  private rowIndex(side: WorkbookArtifactSide, ordinal: number): number {
    const index = this.indexes.get(side);
    if (!index || ordinal < 0 || ordinal >= (index.length - 16) / 24) throw new Error('Invalid workbook source row ordinal.');
    return 16 + ordinal * 24;
  }
  private columnCount(side: WorkbookArtifactSide, ordinal: number): number {
    if (ordinal === EMPTY_ROW) return 0;
    return this.indexes.get(side)!.readUInt32LE(this.rowIndex(side, ordinal) + 20);
  }

  getView(compareMode: WorkbookArtifactCompareMode): Promise<WorkbookArtifactDescriptor> {
    if (compareMode !== 'strict' && compareMode !== 'content') return Promise.reject(new Error('Invalid workbook comparison mode.'));
    const cached = this.descriptors.get(compareMode);
    if (cached) { this.descriptors.delete(compareMode); this.descriptors.set(compareMode, cached); return cached; }
    const mode = this.manifest.modes[compareMode];
    if (mode.pairCount * 43 + mode.regionCount * 36 > DESCRIPTOR_CACHE_BYTES) {
      for (const other of this.descriptorBytes.keys()) { this.descriptors.delete(other); this.descriptorBytes.delete(other); }
    }
    const promise = this.withRead(() => this.buildView(compareMode));
    this.descriptors.set(compareMode, promise);
    void promise.then(view => {
      if (this.closed || this.descriptors.get(compareMode) !== promise) return;
      const bytes = [...Object.values(view.rows), ...Object.values(view.runs), ...Object.values(view.regions)].reduce((total, array) => total + array.byteLength, 0);
      this.descriptorBytes.set(compareMode, bytes);
      let total = [...this.descriptorBytes.values()].reduce((sum, value) => sum + value, 0);
      for (const other of this.descriptors.keys()) {
        if (total <= DESCRIPTOR_CACHE_BYTES) break;
        if (other === compareMode || !this.descriptorBytes.has(other)) continue;
        total -= this.descriptorBytes.get(other) ?? 0;
        this.descriptors.delete(other); this.descriptorBytes.delete(other);
      }
    }, () => { if (this.descriptors.get(compareMode) === promise) this.descriptors.delete(compareMode); });
    return promise;
  }

  /** Decode fixed records into their final typed arrays with bounded scratch space. */
  private async decodeRecords(fileName: string, magic: string, headerBytes: 8 | 16, recordBytes: number, expectedCount: number | null,
    decode: (buffer: Buffer, offset: number, ordinal: number) => void): Promise<number> {
    const file = await fs.open(await this.resolveFile(fileName), 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_INDEX_BYTES || stat.size < headerBytes || (stat.size - headerBytes) % recordBytes !== 0) throw new Error('Truncated workbook artifact index.');
      const count = (stat.size - headerBytes) / recordBytes;
      const header = Buffer.alloc(headerBytes);
      await this.readExactly(file, header, 0);
      assertHeader(header, magic);
      if (expectedCount != null && (count !== expectedCount || count64(header, 8, 'index count') !== expectedCount)) throw new Error('Invalid workbook artifact index count.');
      const recordsPerChunk = Math.floor(1024 * 1024 / recordBytes);
      const scratch = Buffer.allocUnsafe(Math.min(count, recordsPerChunk) * recordBytes);
      for (let start = 0; start < count; start += recordsPerChunk) {
        const records = Math.min(recordsPerChunk, count - start);
        const chunk = scratch.subarray(0, records * recordBytes);
        await this.readExactly(file, chunk, headerBytes + start * recordBytes);
        for (let ordinal = 0; ordinal < records; ordinal += 1) decode(chunk, ordinal * recordBytes, start + ordinal);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      return count;
    } finally { await file.close(); }
  }
  private async buildView(compareMode: WorkbookArtifactCompareMode): Promise<WorkbookArtifactDescriptor> {
    const mode = this.manifest.modes[compareMode];
    const runStat = await fs.stat(await this.resolveFile(mode.runsFile));
    if (runStat.size < 8 || (runStat.size - 8) % 16 !== 0 || runStat.size > MAX_INDEX_BYTES) throw new Error('Invalid workbook change runs.');
    const runCount = (runStat.size - 8) / 16;
    const rows: WorkbookArtifactDescriptor['rows'] = {
      sheetIds: new Uint32Array(mode.pairCount), baseOrdinals: new Uint32Array(mode.pairCount), mineOrdinals: new Uint32Array(mode.pairCount),
      baseRowNumbers: new Uint32Array(mode.pairCount), mineRowNumbers: new Uint32Array(mode.pairCount),
      kinds: new Uint8Array(mode.pairCount), toneMasks: new Uint8Array(mode.pairCount), searchBothSides: new Uint8Array(mode.pairCount), changedCellCounts: new Uint32Array(mode.pairCount),
      baseColumnCounts: new Uint32Array(mode.pairCount), mineColumnCounts: new Uint32Array(mode.pairCount), runOffsets: new Uint32Array(mode.pairCount + 1),
    };
    await this.decodeRecords(mode.pairsFile, 'VWRPAIR1', 16, 40, mode.pairCount, (pairs, p, i) => {
      rows.sheetIds[i] = pairs.readUInt32LE(p);
      rows.baseOrdinals[i] = pairs.readUInt32LE(p + 4);
      rows.mineOrdinals[i] = pairs.readUInt32LE(p + 8);
      rows.baseRowNumbers[i] = pairs.readUInt32LE(p + 12);
      rows.mineRowNumbers[i] = pairs.readUInt32LE(p + 16);
      const flags = pairs.readUInt32LE(p + 20);
      rows.kinds[i] = flags & 255;
      rows.toneMasks[i] = (flags >>> 8) & 255;
      rows.searchBothSides[i] = (flags >>> 16) & 1;
      if (rows.kinds[i]! > 3) throw new Error('Invalid workbook aligned row kind.');
      rows.changedCellCounts[i] = pairs.readUInt32LE(p + 24);
      rows.baseColumnCounts[i] = this.columnCount('base', rows.baseOrdinals[i]!);
      rows.mineColumnCounts[i] = this.columnCount('mine', rows.mineOrdinals[i]!);
      const offset = count64(pairs, p + 32, 'run offset');
      const count = pairs.readUInt32LE(p + 28);
      const runStart = count === 0 && offset === 0 ? rows.runOffsets[i]! : (offset - 8) / 16;
      if (!Number.isInteger(runStart) || runStart < 0 || runStart + count > runCount) throw new Error('Invalid workbook change run offset.');
      rows.runOffsets[i] = runStart;
      rows.runOffsets[i + 1] = runStart + count;
    });
    const runs: WorkbookArtifactDescriptor['runs'] = {
      starts: new Uint32Array(runCount), ends: new Uint32Array(runCount), flags: new Uint32Array(runCount), regionIds: new Uint32Array(runCount),
    };
    await this.decodeRecords(mode.runsFile, 'VWRRUN01', 8, 16, null, (runBuffer, p, i) => {
      runs.starts[i] = runBuffer.readUInt32LE(p);
      runs.ends[i] = runBuffer.readUInt32LE(p + 4);
      runs.flags[i] = runBuffer.readUInt32LE(p + 8);
      runs.regionIds[i] = runBuffer.readUInt32LE(p + 12);
      if (runs.ends[i]! <= runs.starts[i]! || runs.regionIds[i]! >= mode.regionCount) throw new Error('Invalid workbook change interval.');
    });
    const regions: WorkbookArtifactDescriptor['regions'] = {
      sheetIds: new Uint32Array(mode.regionCount), startRows: new Uint32Array(mode.regionCount), endRows: new Uint32Array(mode.regionCount),
      startColumns: new Uint32Array(mode.regionCount), endColumns: new Uint32Array(mode.regionCount),
      anchorRows: new Uint32Array(mode.regionCount), anchorColumns: new Uint32Array(mode.regionCount), changedCellCounts: new Float64Array(mode.regionCount),
    };
    await this.decodeRecords(mode.regionsFile, 'VWRREG01', 16, 40, mode.regionCount, (regionBuffer, p, i) => {
      if (regionBuffer.readUInt32LE(p + 4) !== i) throw new Error('Invalid workbook region ordinal.');
      regions.sheetIds[i] = regionBuffer.readUInt32LE(p);
      regions.startRows[i] = regionBuffer.readUInt32LE(p + 8);
      regions.endRows[i] = regionBuffer.readUInt32LE(p + 12);
      regions.startColumns[i] = regionBuffer.readUInt32LE(p + 16);
      regions.endColumns[i] = regionBuffer.readUInt32LE(p + 20);
      regions.anchorRows[i] = regionBuffer.readUInt32LE(p + 24);
      regions.anchorColumns[i] = regionBuffer.readUInt32LE(p + 28);
      regions.changedCellCounts[i] = count64(regionBuffer, p + 32, 'region changed count');
    });
    const stats = { equalRows: 0, addedRows: 0, deletedRows: 0, modifiedRows: 0, changedCells: mode.changedCellCount };
    const sheets = this.manifest.sheets.map(sheet => {
      const summary = mode.sheets.find(item => item.sheetId === sheet.id);
      if (!summary) throw new Error('Missing workbook sheet alignment summary.');
      for (const key of ['equalRows', 'addedRows', 'deletedRows', 'modifiedRows'] as const) stats[key] += summary[key];
      const maxColumnCount = Math.max(this.baseMetadata.sheets[sheet.name]?.maxColumns ?? 0, this.mineMetadata.sheets[sheet.name]?.maxColumns ?? 0);
      return { ...sheet, ...summary, maxColumnCount, baseUsedColumns: sheet.baseUsedColumns ?? [], mineUsedColumns: sheet.mineUsedColumns ?? [] };
    });
    return {
      version: 1, artifactId: this.artifactId, comparisonSessionId: this.comparisonSessionId, compareMode, sheets, rows, runs, regions,
      baseMetadata: this.baseMetadata, mineMetadata: this.mineMetadata, stats, sourceCounts: { base: this.manifest.base, mine: this.manifest.mine },
      regionCount: mode.regionCount, perf: this.manifest.perf,
    };
  }

  private async readRow(side: WorkbookArtifactSide, ordinal: number, ranges: readonly WorkbookArtifactColumnRange[]): Promise<WorkbookArtifactCell[]> {
    if (ordinal === WORKBOOK_ARTIFACT_MISSING_ORDINAL) return [];
    const index = this.indexes.get(side)!;
    const record = this.rowIndex(side, ordinal);
    const offset = count64(index, record + 8, 'row offset');
    const bytes = index.readUInt32LE(record + 16);
    if (bytes < 8) throw new Error('Invalid workbook source row length.');
    if (bytes > BUFFERED_ROW_BYTES) return this.readLargeRow(side, offset, bytes, ranges, index.readUInt32LE(record + 4));
    const buffer = await this.readRowBlock(side, offset, bytes);
    const result: WorkbookArtifactCell[] = [];
    visitWorkbookArtifactRow(buffer, (column, valueOffset, valueLength, formulaOffset, formulaLength) => {
      if (inRange(column, ranges)) result.push({ column,
        value: buffer.toString('utf8', valueOffset, valueOffset + valueLength),
        formula: buffer.toString('utf8', formulaOffset, formulaOffset + formulaLength) });
    }, index.readUInt32LE(record + 4));
    return result;
  }

  /** Cache whole read-ahead blocks so neighboring rows share IO and backing-byte accounting. */
  private async readRowBlock(side: WorkbookArtifactSide, offset: number, bytes: number): Promise<Buffer> {
    const covered = (blockOffset: number, blockBytes: number) => offset >= blockOffset && offset + bytes <= blockOffset + blockBytes;
    for (const [key, block] of this.rowCache) {
      if (block.side !== side || !covered(block.offset, block.buffer.length)) continue;
      this.rowCache.delete(key); this.rowCache.set(key, block);
      return block.buffer.subarray(offset - block.offset, offset - block.offset + bytes);
    }
    for (const pending of this.rowReads.values()) {
      if (pending.side !== side || !covered(pending.offset, pending.bytes)) continue;
      const buffer = await pending.promise;
      return buffer.subarray(offset - pending.offset, offset - pending.offset + bytes);
    }
    const blockBytes = Math.min(Math.max(READ_AHEAD_BYTES, bytes), this.rowFileBytes.get(side)! - offset);
    if (blockBytes < bytes) throw new Error('Truncated workbook artifact row.');
    const key = `${side}:${offset}`;
    const promise = (async () => {
      const buffer = Buffer.allocUnsafe(blockBytes);
      await this.readExactly(this.handles.get(side)!, buffer, offset);
      while ((this.rowCacheBytes + blockBytes > ROW_CACHE_BYTES || this.rowCache.size >= ROW_CACHE_BLOCKS) && this.rowCache.size) {
        const oldest = this.rowCache.entries().next().value!;
        this.rowCacheBytes -= oldest[1].buffer.length;
        this.rowCache.delete(oldest[0]);
      }
      this.rowCache.set(key, { side, offset, buffer }); this.rowCacheBytes += blockBytes;
      return buffer;
    })();
    const pending = { side, offset, bytes: blockBytes, promise };
    this.rowReads.set(key, pending);
    try { return (await promise).subarray(0, bytes); }
    finally { if (this.rowReads.get(key) === pending) this.rowReads.delete(key); }
  }

  /** Large rows are scanned without allocating their unselected cell bytes. */
  private async readLargeRow(side: WorkbookArtifactSide, offset: number, bytes: number, ranges: readonly WorkbookArtifactColumnRange[], expectedPhysicalRow: number): Promise<WorkbookArtifactCell[]> {
    const file = this.handles.get(side)!;
    const header = Buffer.alloc(12);
    await this.readExactly(file, header.subarray(0, 8), offset);
    if (header.readUInt32LE(0) !== expectedPhysicalRow) throw new Error('Invalid workbook source row number.');
    const cellCount = header.readUInt32LE(4);
    const result: WorkbookArtifactCell[] = [];
    let cursor = 8; let lastColumn = -1;
    for (let i = 0; i < cellCount; i += 1) {
      if (cursor + 12 > bytes) throw new Error('Truncated workbook cell header.');
      await this.readExactly(file, header, offset + cursor);
      const column = header.readUInt32LE(0); const valueLength = header.readUInt32LE(4); const formulaLength = header.readUInt32LE(8);
      cursor += 12;
      if (cursor + valueLength + formulaLength > bytes || column <= lastColumn) throw new Error('Invalid workbook cell record.');
      lastColumn = column;
      if (inRange(column, ranges)) {
        const contents = Buffer.allocUnsafe(valueLength + formulaLength);
        await this.readExactly(file, contents, offset + cursor);
        result.push({ column, value: contents.toString('utf8', 0, valueLength), formula: contents.toString('utf8', valueLength) });
      }
      cursor += valueLength + formulaLength;
    }
    if (cursor !== bytes) throw new Error('Invalid workbook row length.');
    return result;
  }

  async readWindow(request: WorkbookArtifactWindowRequest): Promise<WorkbookArtifactWindow> {
    integer(request.sheetId, 'sheet id'); integer(request.startRow, 'row start'); integer(request.rowCount, 'window rows');
    if (request.rowCount > 256) throw new Error('Workbook window exceeds its row budget.');
    validateRanges(request.columnRanges);
    const ranges = mergeRanges(request.columnRanges);
    return this.withRead(async () => {
      const view = await this.getView(request.compareMode);
      const sheet = view.sheets.find(item => item.id === request.sheetId);
      if (!sheet || request.startRow > sheet.pairCount) throw new Error('Invalid workbook sheet window.');
      const result: WorkbookArtifactWindow = { artifactId: this.artifactId, compareMode: request.compareMode, sheetId: request.sheetId, startRow: request.startRow, columnRanges: request.columnRanges, rows: [], nextRow: null };
      let responseBytes = 0;
      const end = sheet.pairStart + Math.min(sheet.pairCount, request.startRow + request.rowCount);
      for (let rowIndex = sheet.pairStart + request.startRow; rowIndex < end; rowIndex += 1) {
        const [baseCells, mineCells] = await Promise.all([
          this.readRow('base', view.rows.baseOrdinals[rowIndex]!, ranges),
          this.readRow('mine', view.rows.mineOrdinals[rowIndex]!, ranges),
        ]);
        const rowBytes = [...baseCells, ...mineCells].reduce((sum, cell) => sum + 64 + (cell.value.length + cell.formula.length) * 2, 0);
        if (responseBytes + rowBytes > WINDOW_RESPONSE_BYTES && result.rows.length > 0) {
          result.nextRow = rowIndex - sheet.pairStart;
          break;
        }
        responseBytes += rowBytes;
        const changedColumnRuns = [];
        for (let i = view.rows.runOffsets[rowIndex]!; i < view.rows.runOffsets[rowIndex + 1]!; i += 1) {
          const flags = view.runs.flags[i]!;
          changedColumnRuns.push({ start: view.runs.starts[i]!, end: view.runs.ends[i]!, kind: (flags & 3) === 1 ? 'add' as const : (flags & 3) === 2 ? 'delete' as const : 'modify' as const,
            strictOnly: Boolean(flags & 4), hasBaseContent: Boolean(flags & 8), hasMineContent: Boolean(flags & 16), regionId: view.runs.regionIds[i]! });
        }
        result.rows.push({ rowIndex, baseRowNumber: view.rows.baseRowNumbers[rowIndex]!, mineRowNumber: view.rows.mineRowNumbers[rowIndex]!, baseCells, mineCells, changedColumnRuns });
      }
      return result;
    });
  }

  async readCells(request: WorkbookArtifactCellsRequest): Promise<WorkbookArtifactCellsResult> {
    if (request.side !== 'base' && request.side !== 'mine') throw new Error('Invalid workbook source side.');
    if (!Array.isArray(request.cells) || request.cells.length > 4096) throw new Error('Workbook selection exceeds its read budget.');
    return this.withRead(async () => {
      const cells: WorkbookArtifactCellsResult['cells'] = [];
      for (const requested of request.cells) {
        integer(requested.rowNumber, 'physical row'); integer(requested.column, 'column');
        const ordinal = this.findOrdinal(request.side, request.sheetId, requested.rowNumber);
        const source = ordinal === EMPTY_ROW ? [] : await this.readRow(request.side, ordinal, [{ start: requested.column, end: requested.column + 1 }]);
        const cell = source[0];
        cells.push({ rowNumber: requested.rowNumber, column: requested.column, exists: ordinal !== EMPTY_ROW, value: cell?.value ?? '', formula: cell?.formula ?? '' });
      }
      return { artifactId: this.artifactId, side: request.side, sheetId: request.sheetId, cells };
    });
  }
  private findOrdinal(side: WorkbookArtifactSide, sheetId: number, rowNumber: number): number {
    const index = this.indexes.get(side)!;
    const ordinals = this.physicalRowIndexes.get(side)?.get(sheetId);
    if (!ordinals) return EMPTY_ROW;
    let low = 0; let high = ordinals.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2); const offset = 16 + ordinals[mid]! * 24;
      const row = index.readUInt32LE(offset + 4);
      if (row < rowNumber) low = mid + 1;
      else high = mid;
    }
    if (low < ordinals.length && index.readUInt32LE(20 + ordinals[low]! * 24) === rowNumber) return ordinals[low]!;
    return EMPTY_ROW;
  }
}
