/**
 * The sole desktop workbook pipeline is:
 * --prepare-artifact <basePath> <minePath> <artifactDir> -> manifest + files.
 * CLI completion means both modes and all source rows were written completely.
 * All binary integers are little endian; offsets are absolute file offsets.
 *
 * rows.bin: ASCII VWRROW01 (8 bytes), followed by variable row records:
 *   physicalRow:u32, cellCount:u32;
 *   repeated column:u32, valueByteLength:u32, formulaByteLength:u32,
 *   value UTF-8 bytes, formula UTF-8 bytes. Columns are zero based and sorted.
 * rows.idx: ASCII VWRIDX01 + rowCount:u64, then 24-byte records:
 *   sheetId:u32, physicalRow:u32, rowOffset:u64, rowByteLength:u32,
 *   maxColumnCount:u32. Ordinals are zero based global record positions.
 * pairs.bin: ASCII VWRPAIR1 + pairCount:u64, then 40-byte records:
 *   sheetId:u32, baseOrdinal:u32, mineOrdinal:u32, baseRow:u32, mineRow:u32,
 *   kindAndTones:u32, changedCellCount:u32, runCount:u32, runOffset:u64.
 * Missing ordinal is 0xffffffff; missing physical row is 0.
 * kind is the low byte (0 equal, 1 add, 2 delete, 3 modify).
 * tone mask is the next byte (1 add, 2 delete, 4 modify, 8 strict-only).
 * bit16 selects base-then-mine search for replacement rows; anchors search mine.
 * runs.bin: ASCII VWRRUN01, then 16-byte change runs:
 *   startColumn:u32, endColumnExclusive:u32, flags:u32, regionId:u32.
 * Flags: kind low 2 bits; strict-only bit 2; base/mine content bits 3/4.
 * regions.bin: ASCII VWRREG01 + regionCount:u64, then 40-byte records:
 *   sheetId:u32, regionId:u32, startPair:u32, endPairExclusive:u32,
 *   startColumn:u32, endColumnExclusive:u32, anchorPair:u32, anchorColumn:u32,
 *   changedCellCount:u64. Row/column intervals have exclusive ends.
 * No cell values or expanded per-cell patches occur in either file.
 * Region navigation uses a compact global index; renderers derive summaries
 * only for requested regions and never hydrate every per-cell patch.
 */
export const WORKBOOK_ARTIFACT_KIND = 'versora-workbook-artifact-v1' as const;
export const WORKBOOK_ARTIFACT_MISSING_ORDINAL = 0xffff_ffff;
export type WorkbookArtifactCompareMode = 'strict' | 'content';
export type WorkbookArtifactSide = 'base' | 'mine';

export interface WorkbookArtifactMergeRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}
export interface WorkbookArtifactSheetMetadata {
  name: string;
  hiddenColumns: number[];
  mergeRanges: WorkbookArtifactMergeRange[];
  rowCount?: number;
  maxColumns?: number;
}
export interface WorkbookArtifactMetadata {
  sheets: Record<string, WorkbookArtifactSheetMetadata>;
}
export interface WorkbookArtifactNativeMetadata {
  s: Record<string, {
    h?: number[];
    m?: Array<{ sr: number; er: number; sc: number; ec: number }>;
    r?: number;
    c?: number;
  }>;
}
export interface WorkbookArtifactModeSheet {
  sheetId: number;
  pairStart: number;
  pairCount: number;
  equalRows: number;
  addedRows: number;
  deletedRows: number;
  modifiedRows: number;
  changedCellCount: number;
  changedColumns?: number[];
  changeType?: 'equal' | 'add' | 'delete' | 'rename';
  renamePeerName?: string | null;
  renameRole?: 'source' | 'target' | null;
}
export interface WorkbookArtifactManifest {
  kind: typeof WORKBOOK_ARTIFACT_KIND;
  version: 1;
  complete: true;
  artifactDir: string;
  files: { baseRows: string; baseIndex: string; mineRows: string; mineIndex: string };
  sheets: Array<{
    id: number;
    name: string;
    hasBaseSide: boolean;
    hasMineSide: boolean;
    baseUsedColumns?: number[];
    mineUsedColumns?: number[];
    baseRowCount: number;
    mineRowCount: number;
    baseCellCount: number;
    mineCellCount: number;
    changeType?: 'equal' | 'add' | 'delete' | 'rename';
    renamePeerName?: string | null;
    renameRole?: 'source' | 'target' | null;
  }>;
  baseMetadata: WorkbookArtifactNativeMetadata;
  mineMetadata: WorkbookArtifactNativeMetadata;
  modes: Record<WorkbookArtifactCompareMode, {
    pairsFile: string;
    runsFile: string;
    pairCount: number;
    changedCellCount: number;
    runRecordBytes: 16;
    regionsFile: string;
    regionCount: number;
    sheets: WorkbookArtifactModeSheet[];
  }>;
  base: { rowCount: number; cellCount: number };
  mine: { rowCount: number; cellCount: number };
  perf: { ingestMs: number; alignmentMs: number; totalMs: number };
}

/** No filesystem paths cross the preload boundary. A fresh artifactId is a version. */
export interface WorkbookArtifactDescriptor {
  version: 1;
  artifactId: string;
  comparisonSessionId: string;
  compareMode: WorkbookArtifactCompareMode;
  sheets: Array<WorkbookArtifactModeSheet & {
    id: number;
    name: string;
    hasBaseSide: boolean;
    hasMineSide: boolean;
    maxColumnCount: number;
    baseUsedColumns: number[];
    mineUsedColumns: number[];
    baseRowCount: number;
    mineRowCount: number;
    baseCellCount: number;
    mineCellCount: number;
    changeType?: 'equal' | 'add' | 'delete' | 'rename';
    renamePeerName?: string | null;
    renameRole?: 'source' | 'target' | null;
  }>;
  rows: {
    sheetIds: Uint32Array;
    baseOrdinals: Uint32Array;
    mineOrdinals: Uint32Array;
    baseRowNumbers: Uint32Array;
    mineRowNumbers: Uint32Array;
    kinds: Uint8Array;
    toneMasks: Uint8Array;
    /** bit16 in pairs: old display protocol emitted delete/base then add/mine. */
    searchBothSides: Uint8Array;
    changedCellCounts: Uint32Array;
    baseColumnCounts: Uint32Array;
    mineColumnCounts: Uint32Array;
    /** CSR offsets into runs; intervals use exclusive ends. No cell values. */
    runOffsets: Uint32Array;
  };
  runs: { starts: Uint32Array; ends: Uint32Array; flags: Uint32Array; regionIds: Uint32Array };
  /** Compact navigation index. Objects and geometry are only resolved on demand. */
  regions: {
    sheetIds: Uint32Array;
    startRows: Uint32Array;
    endRows: Uint32Array;
    startColumns: Uint32Array;
    endColumns: Uint32Array;
    anchorRows: Uint32Array;
    anchorColumns: Uint32Array;
    changedCellCounts: Float64Array;
  };
  baseMetadata: WorkbookArtifactMetadata;
  mineMetadata: WorkbookArtifactMetadata;
  stats: { equalRows: number; addedRows: number; deletedRows: number; modifiedRows: number; changedCells: number };
  sourceCounts: { base: { rowCount: number; cellCount: number }; mine: { rowCount: number; cellCount: number } };
  regionCount: number;
  perf: WorkbookArtifactManifest['perf'];
}
export interface WorkbookArtifactViewRequest {
  artifactId: string;
  compareMode: WorkbookArtifactCompareMode;
}
/** Zero-based half-open column interval [start, end). */
export interface WorkbookArtifactColumnRange { start: number; end: number }
export interface WorkbookArtifactWindowRequest extends WorkbookArtifactViewRequest {
  sheetId: number;
  /** Sheet-local aligned row ordinal, not a physical Excel row number. */
  startRow: number;
  rowCount: number;
  columnRanges: WorkbookArtifactColumnRange[];
}
export interface WorkbookArtifactCell { column: number; value: string; formula: string }
export interface WorkbookArtifactChangeRun extends WorkbookArtifactColumnRange {
  kind: 'add' | 'delete' | 'modify';
  strictOnly: boolean;
  hasBaseContent: boolean;
  hasMineContent: boolean;
  regionId?: number;
}
export interface WorkbookArtifactWindowRow {
  rowIndex: number;
  baseRowNumber: number;
  mineRowNumber: number;
  baseCells: WorkbookArtifactCell[];
  mineCells: WorkbookArtifactCell[];
  changedColumnRuns: WorkbookArtifactChangeRun[];
}
export interface WorkbookArtifactWindow extends WorkbookArtifactViewRequest {
  sheetId: number;
  startRow: number;
  columnRanges: WorkbookArtifactColumnRange[];
  rows: WorkbookArtifactWindowRow[];
  /** Non-null when the byte budget ended this page before the requested rows. */
  nextRow: number | null;
}
export interface WorkbookArtifactCellsRequest {
  artifactId: string;
  side: WorkbookArtifactSide;
  sheetId: number;
  cells: Array<{ rowNumber: number; column: number }>;
}
export interface WorkbookArtifactCellsResult {
  artifactId: string;
  side: WorkbookArtifactSide;
  sheetId: number;
  cells: Array<WorkbookArtifactCell & { rowNumber: number; exists: boolean }>;
}
export interface WorkbookArtifactSourceRowsRequest extends WorkbookArtifactViewRequest {
  sheetId: number;
  startRow: number;
  rowCount: number;
  columns?: number[];
}
export interface WorkbookArtifactSourceRowsResult extends WorkbookArtifactWindow {
  nextRow: number | null;
}
export interface WorkbookArtifactSearchRequest extends WorkbookArtifactViewRequest {
  requestId: string;
  query: string;
  isRegex: boolean;
  isCaseSensitive: boolean;
  sheetId?: number;
  /** Optional aligned ordinals selected by the existing visibility model. */
  visibleRowIndexes?: Uint32Array;
}
export interface WorkbookArtifactSearchMatch {
  rowIndex: number;
  sheetId: number;
  side: WorkbookArtifactSide;
  rowNumber: number;
  column: number;
  start: number;
  end: number;
  snippet: string;
}
export interface WorkbookArtifactSearchResult {
  artifactId: string;
  requestId: string;
  matches: WorkbookArtifactSearchMatch[];
  totalCount: number;
  truncated: boolean;
}
export interface WorkbookArtifactRegionSummary {
  id: number;
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
  startCol: number;
  endCol: number;
  anchorRowIndex: number;
  anchorColumn: number;
  changedCellCount: number;
}
