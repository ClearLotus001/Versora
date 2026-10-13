// src/components/SplitPanel.tsx  [v4 — typecheck clean]
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import type {
  DiffLine,
  Hunk,
  SearchMatch,
  SplitRow,
  SplitRowDescriptor,
  SyntaxPresentation,
  TextSplitLayoutSnapshot,
  WorkbookMoveDirection,
  WorkbookSelectedCell,
} from '@/types';
import { cssAlpha, cssVar } from '@/theme/cssUtils';
import { useI18n } from '@/context/i18n';
import {
  clampSplitRatio,
  useSplitPanelHorizontalState,
} from '@/hooks/diff/useSplitPanelHorizontalState';
import { useVariableVirtual } from '@/hooks/virtualization/useVariableVirtual';
import { useVirtual, ROW_H } from '@/hooks/virtualization/useVirtual';
import { LN_W } from '@/constants/layout';
import { parseWorkbookDisplayLine, WORKBOOK_CELL_WIDTH } from '@/utils/workbook/workbookDisplay';
import { extractVersionLabel } from '@/utils/diff/diffMeta';
import { getTextVerticalRenderMode } from '@/utils/diff/splitRowBehavior';
import {
  findWorkbookSectionIndex,
  getWorkbookColumnLabels,
  getWorkbookSections,
} from '@/utils/workbook/workbookSections';
import {
  findWorkbookSectionIndexByName,
  moveWorkbookSelection,
} from '@/utils/workbook/workbookNavigation';
import {
  buildWorkbookRowEntryMaps,
} from '@/utils/workbook/workbookPanelHelpers';
import {
  addManualCollapsedRange,
  cloneCollapseExpansionState,
  EMPTY_COLLAPSE_EXPANSION_STATE,
  getManualCollapsedRanges,
  type CollapseExpansionState,
  expandCollapseBlock,
  expandCollapseBlockFully,
  getCollapseLeadingRevealCount,
  removeManualCollapsedRange,
} from '@/utils/collapse/collapseState';
import {
  buildCollapsedItems,
  buildCollapsibleRowBlocks,
} from '@/utils/collapse/collapsibleRows';
import { overlayManualCollapsedItems } from '@/utils/collapse/manualCollapse';
import {
  doesSelectionIntersectLineRange,
  isLineIdxWithinSelection,
} from '@/utils/diff/lineRangeSelection';
import { buildCollapseSelectionSurfaces, getManualLineSelectionAccent } from '@/utils/diff/selectionVisuals';
import { useCollapseNavigationState, type CollapseNavigationHandler } from '@/hooks/diff/useCollapseNavigationState';
import { useLogicalTextSelectionState } from '@/hooks/diff/useLogicalTextSelectionState';
import { useResolvedTextLineNavigation } from '@/hooks/diff/useResolvedTextLineNavigation';
import { useTextSearchDecorations } from '@/hooks/diff/useTextSearchDecorations';
import {
  useTextSelectionContextMenu,
  type TextSelectionContextMenuSideMode,
} from '@/hooks/diff/useTextSelectionContextMenu';
import { useTextLineRangeSelectionState } from '@/hooks/diff/useTextLineRangeSelectionState';
import {
  doesLogicalTextSelectionIntersectLineRange,
  getLogicalTextSelectionLineRange,
  type LogicalTextSelection,
} from '@/utils/diff/logicalTextSelection';
import { useSplitPanelLayoutSnapshotEffects } from '@/hooks/diff/useSplitPanelLayoutSnapshotEffects';
import { useSplitPanelWorkbookNavigationRows } from '@/hooks/diff/useSplitPanelWorkbookNavigationRows';
import { materializeSplitRowsFromDescriptors, prepareTextDiffAnalysisFromDiffLines } from '@/utils/diff/preparedTextAnalysis';
import { buildVersionRangeCopyText, hasVersionContentInRange } from '@/utils/diff/textCopy';
import { copyText } from '@/utils/app/clipboard';
import {
  buildTextRenderItemIndexes,
  findNearestTextRenderItemIndex,
} from '@/utils/diff/textRenderItemIndexes';
import SplitWorkbookStickyRegion from '@/components/diff/SplitWorkbookStickyRegion';
import SplitHorizontalTextPane from '@/components/diff/SplitHorizontalTextPane';
import SplitMainBodyContent from '@/components/diff/SplitMainBodyContent';
import CollapseBar from '@/components/diff/CollapseBar';
import CollapseJumpButton from '@/components/diff/CollapseJumpButton';
import MiniMap, { buildSplitMiniMapSegments } from '@/components/diff/MiniMap';
import DiffContextMenu from '@/components/diff/DiffContextMenu';
import { buildWorkbookRenderItemIndexes } from '@/utils/workbook/workbookRenderItemIndexes';

const CONTEXT_LINES = 3;
const DOUBLE_ROW_H = (ROW_H * 2) + 1;
const EMPTY_ITEM_HEIGHTS: number[] = [];
const DEFAULT_SPLIT_RATIO = 0.5;
const MIN_SPLIT_RATIO = 0.2;
const MAX_SPLIT_RATIO = 0.8;
const SPLIT_DIVIDER_WIDTH = 12;

function resolveTextSelectionSideMode(
  selection: LogicalTextSelection | null,
): TextSelectionContextMenuSideMode {
  if (
    selection
    && selection.anchor.side === selection.focus.side
    && (selection.anchor.side === 'base' || selection.anchor.side === 'mine')
  ) {
    return selection.anchor.side;
  }
  return 'both';
}

// Fully typed — no `as any` casts
type SplitItem =
  | { kind: 'split-line';     row: SplitRow; lineIdx: number }
  | { kind: 'split-collapse'; source?: 'auto' | 'manual'; count: number; blockId: string; fromIdx: number; toIdx: number; hiddenStart: number; hiddenEnd: number; expandStep: number };

function isEqualSplitRow(row: SplitRow): boolean {
  return row.left?.type === 'equal' && row.right?.type === 'equal';
}

function splitRowHasLineIdx(row: SplitRow, lineIdx: number): boolean {
  return row.lineIdxs.includes(lineIdx);
}

export interface SplitPanelProps {
  diffLines: DiffLine[];
  splitRowDescriptors?: SplitRowDescriptor[] | null;
  syntaxPresentation?: SyntaxPresentation | null;
  baseVersionLabel?: string;
  mineVersionLabel?: string;
  onLineSelectionChange?: ((selection: import('@/types').TextLineSelectionSummary | null) => void) | undefined;
  collapseCtx: boolean;
  activeHunkIdx: number;
  searchMatches: SearchMatch[];
  activeSearchIdx: number;
  searchJumpNonce: number;
  hunkPositions: number[];
  showWhitespace: boolean;
  fontSize: number;
  guidedHunkRange?: Hunk | null;
  vertical: boolean;
  onScrollerReady: (scrollToIndex: (idx: number, align?: 'start' | 'center') => void) => void;
  onCollapseNavigationReady?: ((navigate: CollapseNavigationHandler | null) => void) | undefined;
  baseName?: string;
  mineName?: string;
  selectedCell?: WorkbookSelectedCell | null;
  onSelectCell?: (cell: WorkbookSelectedCell | null) => void;
  onWorkbookNavigationReady?: ((navigate: ((direction: WorkbookMoveDirection) => void) | null) => void) | undefined;
  layoutSnapshot?: TextSplitLayoutSnapshot | null;
  onLayoutSnapshotChange?: ((snapshot: TextSplitLayoutSnapshot) => void) | undefined;
  sharedExpandedBlocks?: CollapseExpansionState | null;
  onExpandedBlocksChange?: ((expandedBlocks: CollapseExpansionState) => void) | undefined;
}

const SplitPanel = memo(({
  diffLines, splitRowDescriptors = null, syntaxPresentation = null, baseVersionLabel = '', mineVersionLabel = '', onLineSelectionChange, collapseCtx, activeHunkIdx, searchMatches, activeSearchIdx,
  searchJumpNonce,
  hunkPositions, showWhitespace, fontSize, guidedHunkRange: _guidedHunkRange = null, vertical, onScrollerReady, onCollapseNavigationReady,
  baseName = '', mineName = '', selectedCell = null, onSelectCell, onWorkbookNavigationReady,
  layoutSnapshot = null, onLayoutSnapshotChange, sharedExpandedBlocks = null, onExpandedBlocksChange,
}: SplitPanelProps) => {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialSplitRatio = layoutSnapshot?.layout === 'split-h'
    ? clampSplitRatio(layoutSnapshot.splitRatio, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO, DEFAULT_SPLIT_RATIO)
    : DEFAULT_SPLIT_RATIO;
  const {
    paneContainerRef,
    leftPaneScrollRef,
    rightPaneScrollRef,
    splitRatio,
    splitRatioRef,
    isResizingSplitter,
    horizontalPaneGridTemplateColumns,
    syncPaneScrollPosition,
    handleHorizontalPaneScroll,
    handleSplitterPointerDown,
    handleSplitterKeyDown,
    resetSplitRatio,
    restoreSplitRatio,
  } = useSplitPanelHorizontalState({
    enabled: !vertical,
    initialSplitRatio,
    defaultSplitRatio: DEFAULT_SPLIT_RATIO,
    minSplitRatio: MIN_SPLIT_RATIO,
    maxSplitRatio: MAX_SPLIT_RATIO,
    dividerWidth: SPLIT_DIVIDER_WIDTH,
  });
  const pendingScrollAdjustRef = useRef(0);
  const [expandedBlocks, setExpandedBlocks] = useState<CollapseExpansionState>(() => (
    cloneCollapseExpansionState(layoutSnapshot?.expandedBlocks ?? EMPTY_COLLAPSE_EXPANSION_STATE)
  ));
  const [selectionAnchorSide, setSelectionAnchorSide] = useState<'left' | 'right'>('left');
  const [activeWorkbookSectionIdx, setActiveWorkbookSectionIdx] = useState(0);
  const baseVersion = useMemo(() => extractVersionLabel(baseName) || baseName, [baseName]);
  const mineVersion = useMemo(() => extractVersionLabel(mineName) || mineName, [mineName]);

  const preparedAnalysis = useMemo(
    () => splitRowDescriptors
      ? null
      : (diffLines.length > 0 ? prepareTextDiffAnalysisFromDiffLines(diffLines) : null),
    [diffLines, splitRowDescriptors],
  );
  const effectiveSplitRowDescriptors = splitRowDescriptors ?? preparedAnalysis?.splitRowDescriptors ?? null;
  const splitRows = useMemo(
    () => effectiveSplitRowDescriptors
      ? materializeSplitRowsFromDescriptors(diffLines, effectiveSplitRowDescriptors)
      : [],
    [diffLines, effectiveSplitRowDescriptors],
  );
  const workbookSections = useMemo(() => getWorkbookSections(diffLines), [diffLines]);
  const isWorkbookMode = workbookSections.length > 0;
  const horizontalSplitEnabled = !vertical && !isWorkbookMode;
  const activeWorkbookSection = workbookSections[activeWorkbookSectionIdx] ?? workbookSections[0];
  const hiddenLineIdxSet = useMemo(() => {
    const next = new Set<number>();
    if (!activeWorkbookSection) return next;
    next.add(activeWorkbookSection.startLineIdx);
    if (activeWorkbookSection.firstDataLineIdx != null) next.add(activeWorkbookSection.firstDataLineIdx);
    return next;
  }, [activeWorkbookSection]);
  const frozenRow = useMemo(() => {
    if (!activeWorkbookSection || activeWorkbookSection.firstDataLineIdx == null) return null;
    return splitRows.find(row => splitRowHasLineIdx(row, activeWorkbookSection.firstDataLineIdx!)) ?? null;
  }, [activeWorkbookSection, splitRows]);
  const visibleSplitRows = useMemo(() => {
    if (!activeWorkbookSection) return splitRows;
    return splitRows.filter(row => (
      row.lineIdxs.some(idx => idx >= activeWorkbookSection.startLineIdx && idx <= activeWorkbookSection.endLineIdx)
      && !row.lineIdxs.some(idx => hiddenLineIdxSet.has(idx))
      && parseWorkbookDisplayLine(row.left?.base ?? row.right?.mine ?? '')?.kind !== 'sheet'
    ));
  }, [activeWorkbookSection, hiddenLineIdxSet, splitRows]);
  const collapsedSourceRows = isWorkbookMode ? visibleSplitRows : splitRows;
  const blockPrefix = isWorkbookMode
    ? `split-${activeWorkbookSection?.name ?? 'workbook'}`
    : 'text';
  const rowBlocks = useMemo(
    () => buildCollapsibleRowBlocks(collapsedSourceRows, isEqualSplitRow),
    [collapsedSourceRows],
  );
  const baseItems = useMemo<SplitItem[]>(
    () => buildCollapsedItems(rowBlocks, collapseCtx, expandedBlocks, {
      contextLines: CONTEXT_LINES,
      blockPrefix,
      buildRowItem: (row): SplitItem => ({ kind: 'split-line', row, lineIdx: row.lineIdx }),
      buildCollapseItem: ({ blockId, count, fromIdx, toIdx, hiddenStart, hiddenEnd, expandStep }): SplitItem => ({
        kind: 'split-collapse',
        source: 'auto',
        count,
        blockId,
        fromIdx,
        toIdx,
        hiddenStart,
        hiddenEnd,
        expandStep,
      }),
    }),
    [blockPrefix, collapseCtx, expandedBlocks, rowBlocks],
  );
  const manualCollapsedRanges = useMemo(
    () => getManualCollapsedRanges(expandedBlocks),
    [expandedBlocks],
  );
  const items = useMemo<SplitItem[]>(
    () => overlayManualCollapsedItems(baseItems, manualCollapsedRanges, {
      isLineItem: (item): item is SplitItem & { kind: 'split-line' } => item.kind === 'split-line',
      getLineIdxs: (item) => item.kind === 'split-line' ? item.row.lineIdxs : [],
      getCollapsedItemRange: (item) => item.kind === 'split-collapse'
        ? {
          startLineIdx: item.fromIdx,
          endLineIdx: item.toIdx,
        }
        : null,
      buildCollapseItem: ({ startLineIdx, endLineIdx, count }): SplitItem => ({
        kind: 'split-collapse',
        source: 'manual',
        count,
        blockId: `manual:${startLineIdx}:${endLineIdx}`,
        fromIdx: startLineIdx,
        toIdx: endLineIdx,
        hiddenStart: 0,
        hiddenEnd: Math.max(0, count - 1),
        expandStep: count,
      }),
    }),
    [baseItems, manualCollapsedRanges],
  );
  const itemHeights = useMemo(
    () => !vertical ? EMPTY_ITEM_HEIGHTS : items.map((item) => {
      if (item.kind === 'split-collapse') return ROW_H;
      return getTextVerticalRenderMode(item.row) === 'double' ? DOUBLE_ROW_H : ROW_H;
    }),
    [items, vertical],
  );
  const activeScrollRef = horizontalSplitEnabled
    ? (leftPaneScrollRef as RefObject<HTMLDivElement | null>)
    : (scrollRef as RefObject<HTMLDivElement | null>);
  const constantVirtual = useVirtual(
    items.length,
    activeScrollRef,
    vertical ? DOUBLE_ROW_H : ROW_H,
    { overscanMin: 40, overscanFactor: 2 },
  );
  const variableVirtual = useVariableVirtual(
    itemHeights,
    activeScrollRef,
    { enabled: vertical, overscanMin: 40, overscanFactor: 2 },
  );
  const activeVirtual = vertical ? variableVirtual : constantVirtual;
  const { totalH, startIdx, endIdx, scrollToIndex } = activeVirtual;
  const rowWindowOffsetTop = vertical ? variableVirtual.offsetTop : startIdx * ROW_H;
  const textRowLayoutStyle = isWorkbookMode
    ? { width: 'max-content' as const, minWidth: '100%' as const }
    : { width: 'max-content' as const, minWidth: '100%' as const };

  const collapseLineRange = useCallback((startLineIdx: number, endLineIdx: number) => {
    setExpandedBlocks((prev) => addManualCollapsedRange(
      prev,
      startLineIdx,
      endLineIdx,
    ));
  }, []);
  const {
    lineRangeSelection,
    setLineRangeSelection,
    normalizedLineRangeSelection,
    selectedLineCount,
    selectedLineRangeLabel,
    handleLineNumberSelection: handleCoreLineNumberSelection,
    handleFoldSelectedRange,
    handleClearSelectedRange,
    handleBlankAreaPointerDown,
  } = useTextLineRangeSelectionState({
    onFoldRange: (startLineIdx, endLineIdx) => {
      setExpandedBlocks((prev) => addManualCollapsedRange(
        prev,
        startLineIdx,
        endLineIdx,
      ));
    },
  });
  const {
    contextMenuPoint,
    contextMenuSections,
    closeContextMenu,
    openTextSelectionContextMenu,
    openLineSelectionContextMenu,
  } = useTextSelectionContextMenu({
    diffLines,
    normalizedLineRangeSelection,
    selectedLineCount,
    baseVersionLabel,
    mineVersionLabel,
    onFoldSelectedRange: handleFoldSelectedRange,
    onClearSelectedRange: handleClearSelectedRange,
  });
  const lineNumberTitle: string | undefined = undefined;

  const {
    textSelection: leftTextSelection,
    textSelectionCopyText: leftTextSelectionCopyText,
    getTextSelectionRangeForLine: getLeftTextSelectionRangeForLine,
    clearTextSelection: clearLeftTextSelection,
  } = useLogicalTextSelectionState({
    enabled: horizontalSplitEnabled,
    hostRef: leftPaneScrollRef,
    diffLines,
    copyMode: 'base',
    onSelectionIntent: () => {
      setLineRangeSelection(null);
      closeContextMenu();
    },
  });
  const {
    textSelection: rightTextSelection,
    textSelectionCopyText: rightTextSelectionCopyText,
    getTextSelectionRangeForLine: getRightTextSelectionRangeForLine,
    clearTextSelection: clearRightTextSelection,
  } = useLogicalTextSelectionState({
    enabled: horizontalSplitEnabled,
    hostRef: rightPaneScrollRef,
    diffLines,
    copyMode: 'mine',
    onSelectionIntent: () => {
      setLineRangeSelection(null);
      closeContextMenu();
    },
  });
  const {
    textSelection: combinedTextSelection,
    textSelectionCopyText: combinedTextSelectionCopyText,
    getTextSelectionRangeForLine: getCombinedTextSelectionRangeForLine,
    clearTextSelection: clearCombinedTextSelection,
  } = useLogicalTextSelectionState({
    enabled: !horizontalSplitEnabled && !isWorkbookMode,
    hostRef: scrollRef,
    diffLines,
    copyMode: 'auto',
    onSelectionIntent: () => {
      setLineRangeSelection(null);
      closeContextMenu();
    },
  });

  const handleLineNumberSelection = useCallback((lineIdx: number, extend: boolean, side: 'left' | 'right' = 'left') => {
    clearLeftTextSelection();
    clearRightTextSelection();
    clearCombinedTextSelection();
    closeContextMenu();
    setSelectionAnchorSide(side);
    handleCoreLineNumberSelection(lineIdx, extend);
  }, [clearCombinedTextSelection, clearLeftTextSelection, clearRightTextSelection, closeContextMenu, handleCoreLineNumberSelection]);

  const {
    searchMatchSet,
    activeSearchLineIdx,
    searchRangesByLineIdx,
  } = useTextSearchDecorations(searchMatches, activeSearchIdx);
  const renderItemIndexes = useMemo(
    () => buildTextRenderItemIndexes(items, {
      cacheKey: `split:render-items:${vertical ? 'vertical' : 'horizontal'}:v1`,
      getLineIdxs: (item) => item.kind === 'split-line' ? item.row.lineIdxs : null,
    }),
    [items, vertical],
  );
  useResolvedTextLineNavigation({
    itemsDependency: items,
    rowBlocks,
    expandedBlocks,
    setExpandedBlocks,
    contextLines: CONTEXT_LINES,
    blockPrefix,
    scrollToIndex,
    findExactItemIndex: (lineIdx) => renderItemIndexes.visibleItemIndexByLineIdx.get(lineIdx) ?? -1,
    findNearestItemIndex: (lineIdx) => findNearestTextRenderItemIndex(renderItemIndexes, lineIdx),
    rowHasLineIdx: splitRowHasLineIdx,
    onAfterScrollToIndex: horizontalSplitEnabled
      ? () => { requestAnimationFrame(() => syncPaneScrollPosition('left')); }
      : undefined,
    onScrollerReady,
    activeSearchLineIdx,
    searchJumpNonce,
    initialSearchJumpNonce: layoutSnapshot ? searchJumpNonce : undefined,
  });
  const selectionAccentColor = getManualLineSelectionAccent();
  const selectedCollapseSurfaces = useMemo(
    () => buildCollapseSelectionSurfaces(selectionAccentColor),
    [selectionAccentColor],
  );
  const textSelectionCollapsePalette = useMemo(() => ({
    background: `linear-gradient(90deg,
      color-mix(in srgb, var(--text-selection-bg) 82%, var(--bg1) 18%) 0%,
      color-mix(in srgb, var(--text-selection-bg) 24%, transparent) 100%)`,
    border: 'color-mix(in srgb, var(--text-selection-bg) 64%, transparent)',
    accent: cssVar('acc2'),
    buttonBorder: 'color-mix(in srgb, var(--text-selection-bg) 42%, transparent)',
    buttonText: cssVar('acc2'),
    labelText: cssVar('t1'),
    subduedText: cssVar('t2'),
  }), []);
  const activeTextSelection = horizontalSplitEnabled
    ? (selectionAnchorSide === 'left' ? leftTextSelection : rightTextSelection)
    : combinedTextSelection;
  useEffect(() => {
    onLineSelectionChange?.(
      normalizedLineRangeSelection
        ? { count: selectedLineCount, rangeLabel: selectedLineRangeLabel }
        : null,
    );
    return () => onLineSelectionChange?.(null);
  }, [normalizedLineRangeSelection, onLineSelectionChange, selectedLineCount, selectedLineRangeLabel]);
  useEffect(() => {
    setLineRangeSelection(null);
    clearLeftTextSelection();
    clearRightTextSelection();
    clearCombinedTextSelection();
  }, [clearCombinedTextSelection, clearLeftTextSelection, clearRightTextSelection, diffLines, isWorkbookMode, setLineRangeSelection, vertical]);

  const miniMapSegments = useMemo(
    () => buildSplitMiniMapSegments(items, itemHeights, searchMatchSet),
    [itemHeights, items, searchMatchSet],
  );
  const isSplitRowSelected = useCallback((row: SplitRow) => (
    row.lineIdxs.some((lineIdx) => isLineIdxWithinSelection(lineRangeSelection, lineIdx))
  ), [lineRangeSelection]);
  const getSplitRowSideLineIdx = useCallback((row: SplitRow, side: 'left' | 'right'): number | null => {
    if (side === 'left') {
      return row.left ? (row.lineIdxs[0] ?? null) : null;
    }
    if (!row.right) return null;
    if (!row.left) return row.lineIdxs[0] ?? null;
    // Both sides present. Equal rows share a single lineIdx; aligned change rows have [deleteIdx, addIdx].
    return row.lineIdxs[1] ?? row.lineIdxs[0] ?? null;
  }, []);

  useEffect(() => {
    if (!isWorkbookMode || workbookSections.length === 0) return;
    setActiveWorkbookSectionIdx(prev => Math.min(prev, workbookSections.length - 1));
  }, [isWorkbookMode, workbookSections.length]);

  useEffect(() => {
    if (!isWorkbookMode || !selectedCell || workbookSections.length === 0) return;
    const nextSectionIdx = findWorkbookSectionIndexByName(workbookSections, selectedCell.sheetName);
    setActiveWorkbookSectionIdx(prev => (prev === nextSectionIdx ? prev : nextSectionIdx));
  }, [isWorkbookMode, selectedCell, workbookSections]);

  useEffect(() => {
    if (!isWorkbookMode || activeSearchLineIdx < 0) return;
    const nextSectionIdx = findWorkbookSectionIndex(workbookSections, activeSearchLineIdx);
    setActiveWorkbookSectionIdx(prev => (prev === nextSectionIdx ? prev : nextSectionIdx));
  }, [activeSearchLineIdx, isWorkbookMode, workbookSections]);

  useEffect(() => {
    if (!isWorkbookMode) return;
    const targetLineIdx = hunkPositions[activeHunkIdx];
    if (targetLineIdx === undefined) return;
    const nextSectionIdx = findWorkbookSectionIndex(workbookSections, targetLineIdx);
    setActiveWorkbookSectionIdx(prev => (prev === nextSectionIdx ? prev : nextSectionIdx));
  }, [activeHunkIdx, hunkPositions, isWorkbookMode, workbookSections]);

  useEffect(() => {
    if (horizontalSplitEnabled) {
      const left = leftPaneScrollRef.current;
      const right = rightPaneScrollRef.current;
      if (!left || !right) return;
      const scrollAdjust = pendingScrollAdjustRef.current;
      if (!scrollAdjust) return;
      pendingScrollAdjustRef.current = 0;
      const nextTop = Math.max(0, left.scrollTop + scrollAdjust);
      left.scrollTop = nextTop;
      right.scrollTop = nextTop;
      return;
    }
    const scrollAdjust = pendingScrollAdjustRef.current;
    if (!scrollAdjust) return;
    pendingScrollAdjustRef.current = 0;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, el.scrollTop + scrollAdjust);
  }, [horizontalSplitEnabled, items, leftPaneScrollRef, rightPaneScrollRef, scrollRef]);

  const workbookFrozenRowHeight = frozenRow
    ? (vertical ? DOUBLE_ROW_H : ROW_H)
    : 0;
  const workbookHeaderHeight = isWorkbookMode
    ? (vertical ? DOUBLE_ROW_H : ROW_H) + workbookFrozenRowHeight
    : 0;
  const {
    activeCollapseIndex,
    activeCollapsePosition,
    totalCollapseCount,
    handleJumpToNextCollapse,
    handleJumpToPreviousCollapse,
    resetActiveCollapseNavigation,
  } = useCollapseNavigationState({
    items,
    startIdx,
    endIdx,
    isCollapseItem: (item) => item.kind === 'split-collapse',
    scrollToIndex,
    onCollapseNavigationReady,
  });
  useEffect(() => {
    resetActiveCollapseNavigation();
  }, [activeWorkbookSection?.name, diffLines, resetActiveCollapseNavigation]);
  const columnLabels = getWorkbookColumnLabels(activeWorkbookSection?.maxColumns ?? 0);
  const singleGridWidth = (LN_W + 3) + (columnLabels.length * WORKBOOK_CELL_WIDTH);
  const splitWorkbookNavigationSourceRows = useMemo(
    () => frozenRow ? [frozenRow, ...visibleSplitRows] : visibleSplitRows,
    [frozenRow, visibleSplitRows],
  );
  const splitWorkbookRenderItemIndexes = useMemo(
    () => isWorkbookMode
      ? buildWorkbookRenderItemIndexes(items, {
        cacheKey: 'split-panel:workbook-render-items:v1',
        getRow: (item) => item.kind === 'split-line' ? item.row : null,
      })
      : null,
    [isWorkbookMode, items],
  );
  const splitWorkbookRowEntryByRowNumber = useMemo(
    () => activeWorkbookSection
      ? buildWorkbookRowEntryMaps(
        splitWorkbookNavigationSourceRows,
        activeWorkbookSection.name,
        baseVersion,
        mineVersion,
        [],
      )
      : null,
    [activeWorkbookSection, baseVersion, mineVersion, splitWorkbookNavigationSourceRows],
  );
  const workbookNavigationRows = useSplitPanelWorkbookNavigationRows({
    activeSheetName: activeWorkbookSection?.name ?? null,
    selectedCell,
    frozenRow,
    items,
    baseVersion,
    mineVersion,
    rowEntryByRowNumber: splitWorkbookRowEntryByRowNumber,
  });

  const handleWorkbookMove = useCallback((direction: WorkbookMoveDirection) => {
    if (!onSelectCell) return;
    const nextSelection = moveWorkbookSelection(workbookNavigationRows, selectedCell, direction);
    if (nextSelection) onSelectCell(nextSelection);
  }, [onSelectCell, selectedCell, workbookNavigationRows]);

  const handlePaneContextMenu = useCallback((side: 'left' | 'right', event: ReactMouseEvent<HTMLElement>) => {
    const selection = side === 'left' ? leftTextSelection : rightTextSelection;
    const copyText = side === 'left' ? leftTextSelectionCopyText : rightTextSelectionCopyText;
    const clearSelection = side === 'left' ? clearLeftTextSelection : clearRightTextSelection;
    const selectionLineRange = getLogicalTextSelectionLineRange(selection);

    if (selectionLineRange && openTextSelectionContextMenu(event, {
      copyText,
      ...selectionLineRange,
      sideMode: side === 'left' ? 'base' : 'mine',
      onFoldSelectedRange: () => {
        collapseLineRange(selectionLineRange.startLineIdx, selectionLineRange.endLineIdx);
        clearSelection();
      },
      onClearSelectedRange: clearSelection,
    })) return;

    void openLineSelectionContextMenu(event, side === 'left' ? 'base' : 'mine');
  }, [
    clearLeftTextSelection,
    clearRightTextSelection,
    collapseLineRange,
    leftTextSelection,
    leftTextSelectionCopyText,
    openLineSelectionContextMenu,
    openTextSelectionContextMenu,
    rightTextSelection,
    rightTextSelectionCopyText,
  ]);

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (isWorkbookMode) return;
    const selectionLineRange = getLogicalTextSelectionLineRange(combinedTextSelection);
    if (selectionLineRange && openTextSelectionContextMenu(event, {
      copyText: combinedTextSelectionCopyText,
      ...selectionLineRange,
      sideMode: resolveTextSelectionSideMode(combinedTextSelection),
      onFoldSelectedRange: () => {
        collapseLineRange(selectionLineRange.startLineIdx, selectionLineRange.endLineIdx);
        clearCombinedTextSelection();
      },
      onClearSelectedRange: clearCombinedTextSelection,
    })) return;
    void openLineSelectionContextMenu(event, 'both');
  }, [
    clearCombinedTextSelection,
    collapseLineRange,
    combinedTextSelection,
    combinedTextSelectionCopyText,
    isWorkbookMode,
    openLineSelectionContextMenu,
    openTextSelectionContextMenu,
  ]);

  const lastHoveredPaneSideRef = useRef<'left' | 'right' | null>(null);
  useEffect(() => {
    if (!horizontalSplitEnabled) {
      lastHoveredPaneSideRef.current = null;
      return undefined;
    }
    const left = leftPaneScrollRef.current;
    const right = rightPaneScrollRef.current;
    const handleLeft = () => { lastHoveredPaneSideRef.current = 'left'; };
    const handleRight = () => { lastHoveredPaneSideRef.current = 'right'; };
    left?.addEventListener('pointerenter', handleLeft);
    left?.addEventListener('pointerdown', handleLeft, true);
    right?.addEventListener('pointerenter', handleRight);
    right?.addEventListener('pointerdown', handleRight, true);
    return () => {
      left?.removeEventListener('pointerenter', handleLeft);
      left?.removeEventListener('pointerdown', handleLeft, true);
      right?.removeEventListener('pointerenter', handleRight);
      right?.removeEventListener('pointerdown', handleRight, true);
    };
  }, [horizontalSplitEnabled, leftPaneScrollRef, rightPaneScrollRef]);

  useEffect(() => {
    if (isWorkbookMode || !normalizedLineRangeSelection) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'c') return;
      // text selections own Ctrl+C when active in their host pane
      if (leftTextSelectionCopyText || rightTextSelectionCopyText || combinedTextSelectionCopyText) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement
        && (active.matches('input, textarea, select') || active.isContentEditable)) {
        return;
      }
      const { startLineIdx, endLineIdx } = normalizedLineRangeSelection;
      let side: 'base' | 'mine';
      if (horizontalSplitEnabled) {
        const hovered = lastHoveredPaneSideRef.current;
        if (hovered === 'right') side = 'mine';
        else if (hovered === 'left') side = 'base';
        else side = selectionAnchorSide === 'right' ? 'mine' : 'base';
      } else {
        // unified/vertical: prefer mine (working copy) when it has content, else base
        side = hasVersionContentInRange(diffLines, 'mine', startLineIdx, endLineIdx)
          ? 'mine'
          : 'base';
      }
      const text = buildVersionRangeCopyText(diffLines, side, startLineIdx, endLineIdx);
      if (!text) return;
      event.preventDefault();
      void copyText(text);
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [
    combinedTextSelectionCopyText,
    diffLines,
    horizontalSplitEnabled,
    isWorkbookMode,
    leftTextSelectionCopyText,
    normalizedLineRangeSelection,
    rightTextSelectionCopyText,
    selectionAnchorSide,
  ]);

  useEffect(() => {
    const hasTextSelectionMenu = contextMenuSections.some((section) => (
      section.items.some((item) => item.id === 'copy-selected-text')
    ));
    const hasAnyTextSelection = Boolean(
      leftTextSelectionCopyText
      || rightTextSelectionCopyText
      || combinedTextSelectionCopyText,
    );
    if (hasTextSelectionMenu && !hasAnyTextSelection) {
      closeContextMenu();
    }
  }, [
    closeContextMenu,
    combinedTextSelectionCopyText,
    contextMenuSections,
    leftTextSelectionCopyText,
    rightTextSelectionCopyText,
  ]);

  useEffect(() => {
    onWorkbookNavigationReady?.(handleWorkbookMove);
    return () => onWorkbookNavigationReady?.(null);
  }, [handleWorkbookMove, onWorkbookNavigationReady]);

  useEffect(() => {
    if (!isWorkbookMode || !selectedCell || !activeWorkbookSection) return;
    if (selectedCell.sheetName !== activeWorkbookSection.name) return;
    const idx = splitWorkbookRenderItemIndexes?.rowItemIndexBySide[selectedCell.side].get(selectedCell.rowNumber) ?? -1;
    if (idx >= 0) scrollToIndex(idx, 'center');
  }, [activeWorkbookSection, isWorkbookMode, scrollToIndex, selectedCell, splitWorkbookRenderItemIndexes]);

  useSplitPanelLayoutSnapshotEffects({
    diffIdentity: diffLines,
    isWorkbookMode,
    horizontalSplitEnabled,
    layoutSnapshot,
    sharedExpandedBlocks,
    expandedBlocks,
    setExpandedBlocks,
    onLayoutSnapshotChange,
    onExpandedBlocksChange,
    scrollRef,
    leftPaneScrollRef,
    rightPaneScrollRef,
    restoreSplitRatio,
    splitRatio,
    splitRatioRef,
    defaultSplitRatio: DEFAULT_SPLIT_RATIO,
  });

  const renderTextCollapseBar = useCallback((
    item: Extract<SplitItem, { kind: 'split-collapse' }>,
    active = false,
  ) => {
    const collapseLineSelected = doesSelectionIntersectLineRange(lineRangeSelection, item.fromIdx, item.toIdx);
    const collapseTextSelected = doesLogicalTextSelectionIntersectLineRange(activeTextSelection, item.fromIdx, item.toIdx);
    return (
    <CollapseBar
      count={item.count}
      expandCount={Math.min(item.count, item.expandStep)}
      active={active}
      leadingInset={horizontalSplitEnabled ? LN_W : LN_W * 2}
      leadingSurface={collapseLineSelected
        ? selectedCollapseSurfaces.gutterBackground
        : collapseTextSelected
          ? `color-mix(in srgb, var(--text-selection-bg) 34%, ${cssVar('lnBg')} 66%)`
          : cssVar('lnBg')}
      leadingShadow={collapseLineSelected
        ? selectedCollapseSurfaces.gutterShadow
        : collapseTextSelected
          ? '8px 0 14px -14px color-mix(in srgb, var(--text-selection-bg) 46%, transparent)'
          : `8px 0 12px -12px ${cssAlpha('border2', '52')}`}
      label={item.source === 'manual' ? t('manualCollapseBarLines', { count: item.count }) : undefined}
      actionLabel={item.source === 'manual' ? t('manualCollapseBarReveal') : undefined}
      palette={collapseLineSelected
        ? selectedCollapseSurfaces.palette
        : collapseTextSelected
          ? textSelectionCollapsePalette
          : undefined}
      onExpand={() => {
        if (item.source === 'manual') {
          setExpandedBlocks((prev) => removeManualCollapsedRange(
            prev,
            item.fromIdx,
            item.toIdx,
          ));
          return;
        }

        const revealCount = Math.min(item.count, item.expandStep);
        pendingScrollAdjustRef.current += getCollapseLeadingRevealCount(item.count, revealCount) * ROW_H;
        setExpandedBlocks((prev) => expandCollapseBlock(
          prev,
          item.blockId,
          item.hiddenStart,
          item.hiddenEnd,
          revealCount,
        ));
      }}
      onExpandAll={item.source === 'manual'
        ? undefined
        : () => {
          setExpandedBlocks((prev) => expandCollapseBlockFully(
            prev,
            item.blockId,
            item.hiddenStart,
            item.hiddenEnd,
          ));
        }}
    />
    );
  }, [activeTextSelection, horizontalSplitEnabled, lineRangeSelection, selectedCollapseSurfaces, t, textSelectionCollapsePalette]);

  if (horizontalSplitEnabled) {
    return (
      <div className="flex-1 flex overflow-hidden min-w-0 min-h-0">
        <div className="relative flex-1 flex flex-col min-w-0 min-h-0">
          <div
            ref={paneContainerRef}
            className="flex-1 min-w-0 min-h-0"
            style={{
              display: 'grid',
              gridTemplateColumns: horizontalPaneGridTemplateColumns,
              alignItems: 'stretch',
            }}>
            <SplitHorizontalTextPane
              side="left"
              paneRef={leftPaneScrollRef}
              onContextMenu={(event) => handlePaneContextMenu('left', event)}
              onScroll={() => handleHorizontalPaneScroll('left')}
              onPointerDown={handleBlankAreaPointerDown}
              totalHeight={totalH}
              rowWindowOffsetTop={rowWindowOffsetTop}
              visibleItems={items.slice(startIdx, endIdx)}
              startIdx={startIdx}
              activeCollapseIndex={activeCollapseIndex}
              renderTextCollapseBar={renderTextCollapseBar}
              isCollapseTextSelected={(item) => doesLogicalTextSelectionIntersectLineRange(leftTextSelection, item.fromIdx, item.toIdx)}
              isSplitRowSelected={isSplitRowSelected}
              getSplitRowSideLineIdx={getSplitRowSideLineIdx}
              searchMatchSet={searchMatchSet}
              activeSearchLineIdx={activeSearchLineIdx}
              searchRangesByLineIdx={searchRangesByLineIdx}
              getTextSelectionRangeForLine={(lineIdx, lineLength) => (
                getLeftTextSelectionRangeForLine(lineIdx, 'base', lineLength)
              )}
              syntaxPresentation={syntaxPresentation}
              showWhitespace={showWhitespace}
              fontSize={fontSize}
              selectionAccentColor={selectionAccentColor}
              lineNumberTitle={lineNumberTitle}
              onLineNumberClick={handleLineNumberSelection}
              versionLabel={baseVersion}
            />
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('toolbarSplitPaneResizeText')}
              aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
              aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
              aria-valuenow={Math.round(splitRatio * 100)}
              tabIndex={0}
              onPointerDown={handleSplitterPointerDown}
              onKeyDown={handleSplitterKeyDown}
              onDoubleClick={resetSplitRatio}
              style={{
                position: 'relative',
                cursor: 'col-resize',
                touchAction: 'none',
                background: isResizingSplitter ? cssAlpha('acc', '12') : 'transparent',
                outline: 'none',
              }}>
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: 0,
                  bottom: 0,
                  width: 1,
                  transform: 'translateX(-50%)',
                  background: isResizingSplitter ? cssVar('acc') : cssVar('border'),
                  boxShadow: `0 0 0 1px ${isResizingSplitter ? cssVar('acc') : cssVar('border')}`,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  width: 4,
                  height: 56,
                  transform: 'translate(-50%, -50%)',
                  borderRadius: 999,
                  background: isResizingSplitter ? cssAlpha('acc', '44') : cssAlpha('border', '66'),
                }}
              />
            </div>
            <SplitHorizontalTextPane
              side="right"
              paneRef={rightPaneScrollRef}
              onContextMenu={(event) => handlePaneContextMenu('right', event)}
              onScroll={() => handleHorizontalPaneScroll('right')}
              onPointerDown={handleBlankAreaPointerDown}
              totalHeight={totalH}
              rowWindowOffsetTop={rowWindowOffsetTop}
              visibleItems={items.slice(startIdx, endIdx)}
              startIdx={startIdx}
              activeCollapseIndex={activeCollapseIndex}
              renderTextCollapseBar={renderTextCollapseBar}
              isCollapseTextSelected={(item) => doesLogicalTextSelectionIntersectLineRange(rightTextSelection, item.fromIdx, item.toIdx)}
              isSplitRowSelected={isSplitRowSelected}
              getSplitRowSideLineIdx={getSplitRowSideLineIdx}
              searchMatchSet={searchMatchSet}
              activeSearchLineIdx={activeSearchLineIdx}
              searchRangesByLineIdx={searchRangesByLineIdx}
              getTextSelectionRangeForLine={(lineIdx, lineLength) => (
                getRightTextSelectionRangeForLine(lineIdx, 'mine', lineLength)
              )}
              syntaxPresentation={syntaxPresentation}
              showWhitespace={showWhitespace}
              fontSize={fontSize}
              selectionAccentColor={selectionAccentColor}
              lineNumberTitle={lineNumberTitle}
              onLineNumberClick={handleLineNumberSelection}
              versionLabel={mineVersion}
            />
          </div>
          <CollapseJumpButton
            onPrev={handleJumpToPreviousCollapse}
            onNext={handleJumpToNextCollapse}
            currentIndex={activeCollapsePosition >= 0 ? activeCollapsePosition + 1 : 0}
            totalCount={totalCollapseCount}
            storageKey="text-split-h"
          />
          <DiffContextMenu
            anchorPoint={contextMenuPoint}
            sections={contextMenuSections}
            onClose={closeContextMenu}
          />
        </div>
        <MiniMap
          segments={miniMapSegments}
          scrollRef={leftPaneScrollRef as RefObject<HTMLDivElement | null>}
          contentHeight={totalH}
        />
      </div>
    );
  }

  return (
    <div className="flex-1 flex overflow-hidden min-w-0 min-h-0">
        <div className="relative flex-1 flex flex-col min-w-0 min-h-0">
        {isWorkbookMode && activeWorkbookSection && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 12px 6px',
            background: `linear-gradient(180deg, ${cssVar('bg1')} 0%, ${cssVar('bg0')} 100%)`,
            borderBottom: `1px solid ${cssVar('border')}`,
            flexWrap: 'wrap',
            flexShrink: 0,
          }}>
            {workbookSections.map((section, index) => (
              <button
                key={`${section.name}-${section.startLineIdx}`}
                onClick={() => setActiveWorkbookSectionIdx(index)}
                style={{
                  height: 28,
                  padding: '0 12px',
                  borderRadius: 999,
                  border: `1px solid ${index === activeWorkbookSectionIdx ? cssAlpha('acc2', '66') : cssVar('border')}`,
                  background: index === activeWorkbookSectionIdx ? cssAlpha('acc2', '20') : cssVar('bg2'),
                  color: index === activeWorkbookSectionIdx ? cssVar('acc2') : cssVar('t1'),
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 700,
                }}>
                {section.name}
              </button>
            ))}
          </div>
        )}

        <div
          ref={scrollRef}
          onContextMenu={handleContextMenu}
          onPointerDown={handleBlankAreaPointerDown}
          className="flex-1 overflow-y-auto overflow-x-auto relative min-w-0 min-h-0"
          style={{ overflowAnchor: 'none' }}>
          <div style={{ height: totalH + workbookHeaderHeight, pointerEvents: 'none' }} />
          {isWorkbookMode && (
            <SplitWorkbookStickyRegion
              vertical={vertical}
              columnLabels={columnLabels}
              singleGridWidth={singleGridWidth}
              frozenRow={frozenRow}
              syntaxPresentation={syntaxPresentation}
              showWhitespace={showWhitespace}
              fontSize={fontSize}
              sheetName={activeWorkbookSection?.name ?? ''}
              baseVersion={baseVersion}
              mineVersion={mineVersion}
              selectedCell={selectedCell}
              onSelectCell={onSelectCell}
            />
          )}

          <SplitMainBodyContent
            isWorkbookMode={isWorkbookMode}
            vertical={vertical}
            activeWorkbookSectionName={activeWorkbookSection?.name ?? ''}
            selectedCell={selectedCell}
            onSelectCell={onSelectCell}
            baseVersion={baseVersion}
            mineVersion={mineVersion}
            syntaxPresentation={syntaxPresentation}
            showWhitespace={showWhitespace}
            fontSize={fontSize}
            items={items.slice(startIdx, endIdx)}
            startIdx={startIdx}
            activeCollapseIndex={activeCollapseIndex}
            searchMatchSet={searchMatchSet}
            activeSearchLineIdx={activeSearchLineIdx}
            searchRangesByLineIdx={searchRangesByLineIdx}
            selectionAccentColor={selectionAccentColor}
            lineNumberTitle={lineNumberTitle}
            textRowLayoutStyle={textRowLayoutStyle}
            bodyContainerStyle={isWorkbookMode
              ? { position: 'absolute', top: workbookHeaderHeight + rowWindowOffsetTop, left: 0, minWidth: '100%' }
              : { position: 'absolute', top: workbookHeaderHeight + rowWindowOffsetTop, left: 0, width: 'max-content', minWidth: '100%' }}
            onPointerDown={handleBlankAreaPointerDown}
            isSplitRowSelected={isSplitRowSelected}
            getSplitRowSideLineIdx={getSplitRowSideLineIdx}
            getCombinedTextSelectionRangeForLine={getCombinedTextSelectionRangeForLine}
            onLineNumberClick={handleLineNumberSelection}
            renderTextCollapseBar={renderTextCollapseBar}
            singleGridWidth={singleGridWidth}
          />
        </div>
        <CollapseJumpButton
          onPrev={handleJumpToPreviousCollapse}
          onNext={handleJumpToNextCollapse}
          currentIndex={activeCollapsePosition >= 0 ? activeCollapsePosition + 1 : 0}
          totalCount={totalCollapseCount}
          storageKey={vertical ? 'text-split-v' : 'text-split-h'}
        />
        <DiffContextMenu
          anchorPoint={contextMenuPoint}
          sections={contextMenuSections}
          onClose={closeContextMenu}
        />
      </div>
      <MiniMap
        segments={miniMapSegments}
        scrollRef={scrollRef as RefObject<HTMLDivElement | null>}
        contentHeight={totalH} />
    </div>
  );
});

export default SplitPanel;
