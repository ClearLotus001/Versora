// ─────────────────────────────────────────────────────────────────────────────
// Render and viewport types
// ─────────────────────────────────────────────────────────────────────────────

import type { DiffLine } from '@/types/diff';
import type { WorkbookRowDelta } from '@/types/workbook';
import type { CollapseExpansionState } from '@/utils/collapse/collapseState';

export interface VirtualState {
  totalH: number;
  startIdx: number;
  endIdx: number;
}

export interface LineItem {
  kind: 'line';
  line: DiffLine;
  lineIdx: number;
}

export interface CollapseItem {
  kind: 'collapse';
  source?: 'auto' | 'manual';
  count: number;
  blockId: string;
  hiddenStart: number;
  hiddenEnd: number;
  expandStep: number;
  fromIdx: number;
  toIdx: number;
}

export type RenderItem = LineItem | CollapseItem;

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
  isReplacementPair?: boolean;
  lineIdx: number;
  lineIdxs: number[];
  workbookRowDelta?: WorkbookRowDelta;
  workbookArtifactRow?: import('@/utils/workbook/workbookArtifactProvider').WorkbookArtifactRowReference;
}

export interface SplitLineItem {
  kind: 'split-line';
  row: SplitRow;
  lineIdx: number;
}

export interface SplitCollapseItem {
  kind: 'split-collapse';
  source?: 'auto' | 'manual';
  count: number;
  blockId: string;
  hiddenStart: number;
  hiddenEnd: number;
  expandStep: number;
  fromIdx: number;
  toIdx: number;
}

export type SplitRenderItem = SplitLineItem | SplitCollapseItem;

export type LayoutMode = 'unified' | 'split-h' | 'split-v';

export interface TextUnifiedLayoutSnapshot {
  layout: 'unified';
  scrollTop: number;
  scrollLeft: number;
  expandedBlocks: CollapseExpansionState;
}

export interface TextHorizontalLayoutSnapshot {
  layout: 'split-h';
  leftScrollTop: number;
  leftScrollLeft: number;
  rightScrollTop: number;
  rightScrollLeft: number;
  splitRatio: number;
  expandedBlocks: CollapseExpansionState;
}

export interface TextVerticalLayoutSnapshot {
  layout: 'split-v';
  scrollTop: number;
  scrollLeft: number;
  expandedBlocks: CollapseExpansionState;
}

export type TextSplitLayoutSnapshot = TextHorizontalLayoutSnapshot | TextVerticalLayoutSnapshot;
export type TextLayoutSnapshot = TextUnifiedLayoutSnapshot | TextSplitLayoutSnapshot;
