import type { CompactTextSplitRowDescriptors } from '../../shared/textSplitRowTransport';

// ─────────────────────────────────────────────────────────────────────────────
// Diff and text-processing types
// ─────────────────────────────────────────────────────────────────────────────

export type LineType = 'equal' | 'add' | 'delete';
export type DiffTypeFilter = 'all' | 'add' | 'modify' | 'delete';

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

export interface DiffLine {
  type: LineType;
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

export interface TextDiffStats {
  add: number;
  del: number;
  chg: number;
}

export interface TextDiffPresentation {
  replacementPairIndex: Map<number, number>;
  stats: TextDiffStats;
}

export interface PreparedTextAnalysis {
  diffLines: DiffLine[];
  compactDiffLines?: CompactTextDiffLines;
  compactSplitRowDescriptors?: CompactTextSplitRowDescriptors;
  stats: TextDiffStats;
  replacementPairs: TextReplacementPair[];
  splitRowDescriptors: SplitRowDescriptor[];
  perf?: Pick<DiffPerformanceMetrics, 'diffMs'> | null;
}

export interface Hunk {
  startIdx: number;
  endIdx: number;
  addCount: number;
  delCount: number;
}

export type OpType = 'equal' | 'insert' | 'delete';

export interface DiffOp {
  type: OpType;
  text: string;
}

export type TokenType = 'keyword' | 'string' | 'comment' | 'number' | 'punctuation' | 'plain';

export interface Token {
  type: TokenType;
  text: string;
  color?: string | null;
  fontStyle?: number | null;
}

export type SyntaxHighlightSource = 'shiki' | 'fallback' | 'none';

export interface SyntaxPresentation {
  languageId: string | null;
  source: SyntaxHighlightSource;
  baseLineTokens: Token[][];
  mineLineTokens: Token[][];
}

export interface SearchMatch {
  snippet?: string;
  lineIdx: number;
  start: number;
  end: number;
  workbookTarget: WorkbookSearchTarget | null;
}

export interface WorkbookSearchTarget {
  sheetName: string | null;
  side: 'base' | 'mine' | null;
  rowNumber: number | null;
  colIndex: number | null;
}

export interface SearchState {
  query: string;
  isRegex: boolean;
  isCaseSensitive: boolean;
  workbookScope: 'all' | 'sheet';
  matches: SearchMatch[];
  activeIdx: number;
}

export interface SearchResultItem {
  index: number;
  lineIdx: number;
  workbookTarget: WorkbookSearchTarget | null;
  scopeKey: string;
  sheetName: string | null;
  side: 'base' | 'mine' | null;
  sideLabel: string;
  rowNumber: number | null;
  colIndex: number | null;
  address: string;
  locationLabel: string;
  preview: string;
  detail: string;
}

export interface TextLineSelectionSummary {
  count: number;
  rangeLabel: string | null;
}

export interface DiffPerformanceMetrics {
  source: 'cli' | 'revision-switch' | 'local-dev';
  mainLoadMs?: number;
  baseReadMs?: number;
  mineReadMs?: number;
  baseBytes?: number;
  mineBytes?: number;
  textResolveMs?: number;
  metadataMs?: number;
  diffMs?: number;
  rustDiffMs?: number;
  rendererApplyMs?: number;
  requestToCommitMs?: number;
  diffLineCount?: number;
}

export interface DiffMeta {
  baseName: string;
  mineName: string;
  svnUrl: string;
  fileName: string;
}

export type DiffSourceNoticeCode = 'unversioned-working-copy';
