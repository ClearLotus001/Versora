import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  WORKBOOK_ARTIFACT_KIND, WORKBOOK_ARTIFACT_MISSING_ORDINAL,
  type WorkbookArtifactCompareMode, type WorkbookArtifactManifest, type WorkbookArtifactSearchRequest, type WorkbookArtifactSide,
} from '../../shared/workbookArtifactProtocol.js';
import { visitWorkbookArtifactRow } from './workbookArtifactRowRecord.js';

const READ_AHEAD_BYTES = 1024 * 1024;
const BUFFERED_ROW_BYTES = 4 * 1024 * 1024;
const MAX_INDEX_BYTES = 512 * 1024 * 1024;

type SearchMode = Pick<WorkbookArtifactManifest['modes']['strict'], 'pairsFile' | 'runsFile' | 'pairCount' | 'regionCount'> & {
  sheets: Array<{ sheetId: number; pairStart: number; pairCount: number }>;
};
export type WorkbookSearchManifest = Pick<WorkbookArtifactManifest, 'kind' | 'version' | 'complete' | 'files'> & {
  base: { rowCount: number }; mine: { rowCount: number };
  sheets: Array<{ id: number }>;
  modes: Record<WorkbookArtifactCompareMode, SearchMode>;
};

/** Metadata can contain many merges; it has no role in search worker IO. */
export function createWorkbookSearchManifest(manifest: WorkbookArtifactManifest): WorkbookSearchManifest {
  const mode = (compareMode: WorkbookArtifactCompareMode): SearchMode => {
    const input = manifest.modes[compareMode];
    return { pairsFile: input.pairsFile, runsFile: input.runsFile, pairCount: input.pairCount, regionCount: input.regionCount,
      sheets: input.sheets.map(({ sheetId, pairStart, pairCount }) => ({ sheetId, pairStart, pairCount })) };
  };
  return { kind: manifest.kind, version: manifest.version, complete: manifest.complete, files: manifest.files,
    base: { rowCount: manifest.base.rowCount }, mine: { rowCount: manifest.mine.rowCount }, sheets: manifest.sheets.map(({ id }) => ({ id })),
    modes: { strict: mode('strict'), content: mode('content') } };
}

/** Worker-local positional IO. A full scan keeps one fixed read-ahead block per file. */
class ScanFile {
  private readonly fd: number;
  private readonly scratch = Buffer.allocUnsafe(READ_AHEAD_BYTES);
  private start = -1;
  private length = 0;
  readonly size: number;

  constructor(filePath: string, magic: string, index: boolean) {
    this.fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(this.fd);
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || (index && stat.size > MAX_INDEX_BYTES)) throw new Error('Workbook index exceeds its memory budget.');
      this.size = stat.size;
      if (this.read(0, 8).toString('ascii') !== magic) throw new Error(`Invalid workbook artifact ${magic} header.`);
    } catch (error) { fs.closeSync(this.fd); throw error; }
  }

  read(offset: number, bytes: number): Buffer {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(bytes) || bytes < 0 || offset + bytes > this.size) throw new Error('Truncated workbook artifact row.');
    if (offset >= this.start && offset + bytes <= this.start + this.length) return this.scratch.subarray(offset - this.start, offset - this.start + bytes);
    if (bytes > READ_AHEAD_BYTES) {
      const result = Buffer.allocUnsafe(bytes);
      this.readExactly(result, offset);
      return result;
    }
    this.start = offset;
    this.length = Math.min(READ_AHEAD_BYTES, this.size - offset);
    this.readExactly(this.scratch.subarray(0, this.length), offset);
    return this.scratch.subarray(0, bytes);
  }

  private readExactly(buffer: Buffer, offset: number): void {
    let position = 0;
    while (position < buffer.length) {
      const read = fs.readSync(this.fd, buffer, position, buffer.length - position, offset + position);
      if (!read) throw new Error('Truncated workbook artifact row.');
      position += read;
    }
  }
  close(): void { fs.closeSync(this.fd); }
}

export interface WorkbookSearchPair {
  rowIndex: number;
  sheetId: number;
  baseOrdinal: number;
  mineOrdinal: number;
  baseRowNumber: number;
  mineRowNumber: number;
  searchBothSides: boolean;
  runCount: number;
  runOffset: number;
}

export interface WorkbookSearchLine {
  fields: string[];
  content: string;
}

/** Canonical search projection; no renderer cells, metadata, regions or page IPC. */
export class WorkbookSearchSource {
  private readonly opened: ScanFile[] = [];
  private readonly indexes = new Map<WorkbookArtifactSide, ScanFile>();
  private readonly rows = new Map<WorkbookArtifactSide, ScanFile>();
  private readonly pairs: ScanFile;
  private readonly runs: ScanFile;
  private readonly mode: SearchMode;

  constructor(private readonly manifest: WorkbookSearchManifest, root: string, private readonly request: WorkbookArtifactSearchRequest) {
    if (manifest.kind !== WORKBOOK_ARTIFACT_KIND || manifest.version !== 1 || manifest.complete !== true) throw new Error('Incomplete or unsupported workbook artifact.');
    if (request.compareMode !== 'strict' && request.compareMode !== 'content') throw new Error('Invalid workbook comparison mode.');
    this.mode = manifest.modes[request.compareMode];
    const canonicalRoot = fs.realpathSync(root);
    const open = (name: string, magic: string, index = true): ScanFile => {
      if (typeof name !== 'string' || !name || path.isAbsolute(name)) throw new Error('Invalid workbook artifact filename.');
      const filePath = fs.realpathSync(path.resolve(canonicalRoot, name));
      const relative = path.relative(canonicalRoot, filePath);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Workbook artifact file is outside its lease.');
      const file = new ScanFile(filePath, magic, index); this.opened.push(file); return file;
    };
    try {
      for (const side of ['base', 'mine'] as const) {
        const index = open(manifest.files[side === 'base' ? 'baseIndex' : 'mineIndex'], 'VWRIDX01');
        const count = this.count64(index.read(8, 8), 0);
        if (count !== manifest[side].rowCount || index.size !== 16 + count * 24) throw new Error('Truncated workbook row index.');
        this.indexes.set(side, index);
        this.rows.set(side, open(manifest.files[side === 'base' ? 'baseRows' : 'mineRows'], 'VWRROW01', false));
      }
      this.pairs = open(this.mode.pairsFile, 'VWRPAIR1');
      if (this.count64(this.pairs.read(8, 8), 0) !== this.mode.pairCount || this.pairs.size !== 16 + this.mode.pairCount * 40) throw new Error('Invalid workbook artifact index count.');
      this.runs = open(this.mode.runsFile, 'VWRRUN01');
      if ((this.runs.size - 8) % 16 !== 0) throw new Error('Invalid workbook change runs.');
    } catch (error) { this.close(); throw error; }
  }

  private count64(buffer: Buffer, offset: number): number {
    const value = Number(buffer.readBigUInt64LE(offset));
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid workbook artifact offset.');
    return value;
  }

  *alignedRows(): Generator<WorkbookSearchPair> {
    // Visibility changes membership, never display order. Sorting also avoids a
    // second full-workbook Set and lets sparse selections skip disk IO entirely.
    const visible = this.request.visibleRowIndexes?.sort();
    for (const sheet of this.manifest.sheets) {
      if (this.request.sheetId != null && this.request.sheetId !== sheet.id) continue;
      const summary = this.mode.sheets.find(item => item.sheetId === sheet.id);
      if (!summary || !Number.isSafeInteger(summary.pairStart) || !Number.isSafeInteger(summary.pairCount)
        || summary.pairStart < 0 || summary.pairCount < 0 || summary.pairStart + summary.pairCount > this.mode.pairCount) throw new Error('Invalid workbook sheet alignment summary.');
      const end = summary.pairStart + summary.pairCount;
      let cursor = summary.pairStart;
      let selection = 0;
      if (visible) {
        let low = 0; let high = visible.length;
        while (low < high) { const mid = (low + high) >>> 1; if (visible[mid]! < cursor) low = mid + 1; else high = mid; }
        selection = low;
      }
      while (cursor < end) {
        if (visible) {
          const selected = visible[selection++];
          if (selected == null || selected >= end) break;
          if (selected < cursor) continue;
          cursor = selected;
        }
        const record = this.pairs.read(16 + cursor * 40, 40);
        const flags = record.readUInt32LE(20);
        if (record.readUInt32LE(0) !== sheet.id || (flags & 255) > 3) throw new Error('Invalid workbook aligned row kind.');
        const pair: WorkbookSearchPair = {
          rowIndex: cursor, sheetId: sheet.id, baseOrdinal: record.readUInt32LE(4), mineOrdinal: record.readUInt32LE(8),
          baseRowNumber: record.readUInt32LE(12), mineRowNumber: record.readUInt32LE(16), searchBothSides: Boolean((flags >>> 16) & 1),
          runCount: record.readUInt32LE(28), runOffset: this.count64(record, 32),
        };
        if (pair.runCount > 16_384 || (pair.runCount && (pair.runOffset < 8 || (pair.runOffset - 8) % 16 !== 0 || pair.runOffset + pair.runCount * 16 > this.runs.size))) throw new Error('Invalid workbook change run offset.');
        yield pair;
        cursor += 1;
      }
    }
  }

  readLine(pair: WorkbookSearchPair, side: WorkbookArtifactSide): WorkbookSearchLine | null {
    const ordinal = side === 'base' ? pair.baseOrdinal : pair.mineOrdinal;
    if (ordinal === WORKBOOK_ARTIFACT_MISSING_ORDINAL) return null;
    if (ordinal >= this.manifest[side].rowCount) throw new Error('Invalid workbook source row ordinal.');
    const index = this.indexes.get(side)!.read(16 + ordinal * 24, 24);
    const physicalRow = side === 'base' ? pair.baseRowNumber : pair.mineRowNumber;
    if (index.readUInt32LE(0) !== pair.sheetId || index.readUInt32LE(4) !== physicalRow) throw new Error('Invalid workbook source row number.');
    const offset = this.count64(index, 8); const bytes = index.readUInt32LE(16); const columns = index.readUInt32LE(20);
    if (offset < 8 || bytes < 8 || columns > 16_384) throw new Error('Invalid workbook source row length.');
    const fields = new Array<string>(columns).fill('');
    const file = this.rows.get(side)!;
    const decode = (buffer: Buffer, column: number, valueOffset: number, valueLength: number, formulaOffset: number, formulaLength: number): void => {
      if (column >= columns) throw new Error('Invalid workbook cell column.');
      const value = buffer.toString('utf8', valueOffset, valueOffset + valueLength);
      fields[column] = formulaLength ? `${value}\u001f${buffer.toString('utf8', formulaOffset, formulaOffset + formulaLength)}` : value;
    };
    if (bytes <= BUFFERED_ROW_BYTES) {
      const buffer = file.read(offset, bytes);
      visitWorkbookArtifactRow(buffer, (column, valueOffset, valueLength, formulaOffset, formulaLength) => decode(buffer, column, valueOffset, valueLength, formulaOffset, formulaLength), physicalRow);
    } else {
      // Regex semantics need one complete row string, but its binary record need
      // not coexist in RAM. Very wide rows decode one cell at a time.
      const header = file.read(offset, 8);
      if (header.readUInt32LE(0) !== physicalRow) throw new Error('Invalid workbook source row number.');
      const count = header.readUInt32LE(4);
      let cursor = 8; let lastColumn = -1;
      for (let i = 0; i < count; i += 1) {
        if (cursor + 12 > bytes) throw new Error('Truncated workbook cell header.');
        const cell = file.read(offset + cursor, 12);
        const column = cell.readUInt32LE(0); const valueLength = cell.readUInt32LE(4); const formulaLength = cell.readUInt32LE(8);
        cursor += 12;
        if (cursor + valueLength + formulaLength > bytes || column <= lastColumn) throw new Error('Invalid workbook cell record.');
        lastColumn = column;
        const contents = file.read(offset + cursor, valueLength + formulaLength);
        decode(contents, column, 0, valueLength, valueLength, formulaLength);
        cursor += valueLength + formulaLength;
      }
      if (cursor !== bytes) throw new Error('Invalid workbook row length.');
    }
    return { fields, content: fields.join('\t') };
  }

  changedIntervals(pair: WorkbookSearchPair): Uint32Array {
    const intervals = new Uint32Array(pair.runCount * 2);
    for (let i = 0; i < pair.runCount; i += 1) {
      const run = this.runs.read(pair.runOffset + i * 16, 16);
      const start = run.readUInt32LE(0); const end = run.readUInt32LE(4);
      if (end <= start || run.readUInt32LE(12) >= this.mode.regionCount) throw new Error('Invalid workbook change interval.');
      intervals[i * 2] = start; intervals[i * 2 + 1] = end;
    }
    return intervals;
  }

  close(): void { for (const file of this.opened.splice(0)) file.close(); }
}
