import type { WorkbookArtifactDiffSummary } from '../workbookArtifactDiff.js';
import type { AppUpdateState } from '../updater/types.js';
import type { ComparisonSourceDescriptor } from '../../shared/comparison.js';
import type { CompactTextSplitRowDescriptors } from '../../shared/textSplitRowTransport.js';
import type { WorkbookArtifactDescriptor } from '../../shared/workbookArtifactProtocol.js';

export type SvnRevisionSourceKind = 'revision' | 'working-copy' | 'input-file';
export type WorkbookCompareMode = 'strict' | 'content';
export type CompareContext =
  | 'standard_local_compare'
  | 'literal_two_file_compare'
  | 'revision_vs_revision_compare'
  | 'git_compare';

export interface SvnRevisionInfo {
  id: string;
  revision: string;
  title: string;
  author: string;
  date: string;
  message: string;
  kind: SvnRevisionSourceKind;
}

export interface RevisionOptionsQuery {
  limit?: number;
  beforeRevisionId?: string;
  anchorDateTime?: string;
  includeSpecials?: boolean;
  targetSide?: 'base' | 'mine';
}

export interface RevisionOptionsPayload {
  items: SvnRevisionInfo[];
  hasMore: boolean;
  nextBeforeRevisionId: string | null;
  anchorRevisionId: string | null;
  queryDateTime: string | null;
}

export interface RevisionSelectionPair {
  baseRevisionId: string | null;
  mineRevisionId: string | null;
}

export interface LineBlameInfo {
  revision: string;
  author: string;
  date: string;
  uncommitted: boolean;
}

export interface LineBlameLine extends LineBlameInfo {
  lineNo: number;
}

export interface LineBlamePayload {
  base: LineBlameLine[];
  mine: LineBlameLine[];
}

export interface CharSpan {
  highlight: boolean;
  text: string;
}

export interface TextReplacementPair {
  lineIdx: number;
  pairedLineIdx: number;
}

export interface SplitRowDescriptor {
  leftLineIdx: number | null;
  rightLineIdx: number | null;
  isReplacementPair?: boolean;
  lineIdx: number;
  lineIdxs: number[];
}

export interface DiffLine {
  type: 'equal' | 'add' | 'delete';
  base: string | null;
  mine: string | null;
  baseLineNo: number | null;
  mineLineNo: number | null;
  baseCharSpans: CharSpan[] | null;
  mineCharSpans: CharSpan[] | null;
  baseBlame?: LineBlameInfo | null;
  mineBlame?: LineBlameInfo | null;
}

export interface CompactTextDiffLines {
  version: 1;
  types: Uint8Array;
  baseLineNumbers: Int32Array;
  mineLineNumbers: Int32Array;
  texts: string[];
  mineTextOverrides: Array<[lineIdx: number, text: string]>;
  charSpans: Array<[
    lineIdx: number,
    baseCharSpans: CharSpan[] | null,
    mineCharSpans: CharSpan[] | null,
  ]>;
}

export interface DiffPerformanceMetrics {
  source: 'cli' | 'revision-switch' | 'local-dev';
  mainLoadMs?: number;
  baseReadMs?: number;
  mineReadMs?: number;
  metadataMs?: number;
  diffMs?: number;
  rustDiffMs?: number;
  baseBytes?: number;
  mineBytes?: number;
}

export interface PreparedTextAnalysis {
  diffLines: DiffLine[];
  compactDiffLines?: CompactTextDiffLines;
  compactSplitRowDescriptors?: CompactTextSplitRowDescriptors;
  stats: {
    add: number;
    del: number;
    chg: number;
  };
  replacementPairs: TextReplacementPair[];
  splitRowDescriptors: SplitRowDescriptor[];
  perf: Pick<DiffPerformanceMetrics, 'diffMs'> | null;
}

export interface DiffData {
  workbookArtifact?: WorkbookArtifactDescriptor;
  comparisonSessionId?: string;
  source?: ComparisonSourceDescriptor;
  baseName: string;
  mineName: string;
  basePath?: string;
  minePath?: string;
  svnUrl: string;
  fileName: string;
  sourceIdentity: string;
  compareContext: CompareContext;
  timelineTargetUrl: string | null;
  workingCopyAvailable: boolean;
  initialPair: RevisionSelectionPair | null;
  resetPair: RevisionSelectionPair | null;
  launchBaseName: string;
  launchMineName: string;
  baseContent: string | null;
  mineContent: string | null;
  analysisSnapshotsByMode: Partial<Record<WorkbookCompareMode, DiffAnalysisSnapshot | null>> | null;
  baseWorkbookMetadata: WorkbookMetadataMap | null;
  mineWorkbookMetadata: WorkbookMetadataMap | null;
  revisionOptions: SvnRevisionInfo[] | null;
  baseRevisionInfo: SvnRevisionInfo | null;
  mineRevisionInfo: SvnRevisionInfo | null;
  canSwitchRevisions: boolean;
  revisionSwitchableSides?: { base: boolean; mine: boolean };
  workbookArtifactDiff: WorkbookArtifactDiffSummary | null;
  sourceNoticeCode: 'unversioned-working-copy' | null;
  perf: DiffPerformanceMetrics | null;
}

export interface WindowFrameState {
  isMaximized: boolean;
}

export interface LaunchContextPayload {
  pendingDiffRequestCount?: number;
  hasDiffRequest: boolean;
  isDevMode: boolean;
  usesNativeWindowControls: boolean;
  windowFrameState: WindowFrameState;
  launchedAfterUpdate: boolean;
  updateState: AppUpdateState;
}

export interface BuildDiffDataOptions {
  baseRevisionId?: string | undefined;
  mineRevisionId?: string | undefined;
  workbookCompareMode?: WorkbookCompareMode;
  includeRevisionOptions?: boolean;
  revisionOptionsOverride?: SvnRevisionInfo[] | null;
}

export interface WorkbookCompareModePayload {
  compareMode: WorkbookCompareMode;
  workbookArtifact?: WorkbookArtifactDescriptor;
  perf: Pick<DiffPerformanceMetrics, 'rustDiffMs'> | null;
}

export interface WorkbookMetadataPayload {
  base: WorkbookMetadataMap | null;
  mine: WorkbookMetadataMap | null;
  perf: Pick<DiffPerformanceMetrics, 'metadataMs'> | null;
}

export interface TitleBarOverlayPayload {
  color?: unknown;
  symbolColor?: unknown;
  height?: unknown;
}

export interface WorkbookMergeRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export interface WorkbookSheetMetadata {
  name: string;
  hiddenColumns: number[];
  mergeRanges: WorkbookMergeRange[];
  rowCount?: number;
  maxColumns?: number;
}

export interface WorkbookMetadataMap {
  sheets: Record<string, WorkbookSheetMetadata>;
}

export interface DiffAnalysisSnapshot {
  compareMode: WorkbookCompareMode;
  textAnalysis: PreparedTextAnalysis | null;
}

export interface FilePayloadMetrics {
  readMs: number;
  byteLength: number;
}

export interface FilePayload {
  content: string | null;
  perf: FilePayloadMetrics;
}

export interface FilePayloadCacheEntry {
  mtimeMs: number;
  size: number;
  payload: FilePayload;
  memoryBytes: number;
}

export interface RevisionPayloadCacheEntry {
  payload: FilePayload;
  memoryBytes: number;
}

export type XmlNode = Record<string, unknown>;

export { type WorkbookArtifactDiffSummary } from '../workbookArtifactDiff.js';
export { type CliArgs } from '../cliArgs.js';
export { type SvnDiffViewerScope } from '../svnDiffViewerConfig.js';
export { type AppUpdateState } from '../updater/types.js';
