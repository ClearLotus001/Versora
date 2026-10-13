// src/components/UnifiedPanel.tsx  [v4 — typecheck clean]
import { memo, useCallback, useEffect, useRef, useState, useMemo, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import type {
  CollapseItem,
  DiffLine,
  Hunk,
  LineItem,
  RenderItem,
  SearchMatch,
  SplitRowDescriptor,
  SyntaxPresentation,
  TextDiffPresentation,
} from '@/types';
import { LN_W } from '@/constants/layout';
import { useI18n } from '@/context/i18n';
import { cssAlpha, cssVar } from '@/theme/cssUtils';
import { useVirtual, ROW_H } from '@/hooks/virtualization/useVirtual';
import { WORKBOOK_CELL_WIDTH } from '@/utils/workbook/workbookDisplay';
import type { TextUnifiedLayoutSnapshot } from '@/types';
import {
  findWorkbookSectionIndex,
  getWorkbookColumnLabels,
  getWorkbookSections,
} from '@/utils/workbook/workbookSections';
import {
  addManualCollapsedRange,
  areCollapseExpansionStatesEqual,
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
import { useResolvedTextLineNavigation } from '@/hooks/diff/useResolvedTextLineNavigation';
import { useLogicalTextSelectionState } from '@/hooks/diff/useLogicalTextSelectionState';
import { useTextSearchDecorations } from '@/hooks/diff/useTextSearchDecorations';
import { useTextSelectionContextMenu } from '@/hooks/diff/useTextSelectionContextMenu';
import { useTextLineRangeSelectionState } from '@/hooks/diff/useTextLineRangeSelectionState';
import {
  doesLogicalTextSelectionIntersectLineRange,
  getLogicalTextSelectionLineRange,
} from '@/utils/diff/logicalTextSelection';
import { getUnifiedLineSyntaxTokens } from '@/utils/diff/syntaxHighlighting';
import {
  buildTextRenderItemIndexes,
  findNearestTextRenderItemIndex,
} from '@/utils/diff/textRenderItemIndexes';
import DiffRow from '@/components/diff/DiffRow';
import CollapseBar from '@/components/diff/CollapseBar';
import CollapseJumpButton from '@/components/diff/CollapseJumpButton';
import MiniMap, { buildUnifiedMiniMapSegments } from '@/components/diff/MiniMap';
import DiffContextMenu from '@/components/diff/DiffContextMenu';

const CONTEXT_LINES = 3;

export interface UnifiedPanelProps {
  diffLines: DiffLine[];
  splitRowDescriptors?: SplitRowDescriptor[] | null;
  textDiffPresentation: TextDiffPresentation;
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
  onScrollerReady: (scrollToIndex: (idx: number, align?: 'start' | 'center') => void) => void;
  onCollapseNavigationReady?: ((navigate: CollapseNavigationHandler | null) => void) | undefined;
  layoutSnapshot?: TextUnifiedLayoutSnapshot | null;
  onLayoutSnapshotChange?: ((snapshot: TextUnifiedLayoutSnapshot) => void) | undefined;
  sharedExpandedBlocks?: CollapseExpansionState | null;
  onExpandedBlocksChange?: ((expandedBlocks: CollapseExpansionState) => void) | undefined;
}

const UnifiedPanel = memo(({
  diffLines, textDiffPresentation, syntaxPresentation = null, baseVersionLabel = '', mineVersionLabel = '', onLineSelectionChange, collapseCtx, activeHunkIdx, searchMatches, activeSearchIdx,
  searchJumpNonce,
  hunkPositions, showWhitespace, fontSize, onScrollerReady, onCollapseNavigationReady,
  guidedHunkRange: _guidedHunkRange = null,
  layoutSnapshot = null, onLayoutSnapshotChange, sharedExpandedBlocks = null, onExpandedBlocksChange,
}: UnifiedPanelProps) => {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScrollAdjustRef = useRef(0);
  const snapshotEmitRafRef = useRef(0);
  const [expandedBlocks, setExpandedBlocks] = useState<CollapseExpansionState>(() => (
    cloneCollapseExpansionState(layoutSnapshot?.expandedBlocks ?? EMPTY_COLLAPSE_EXPANSION_STATE)
  ));
  const [activeWorkbookSectionIdx, setActiveWorkbookSectionIdx] = useState(0);
  const workbookSections = useMemo(() => getWorkbookSections(diffLines), [diffLines]);
  const isWorkbookMode = workbookSections.length > 0;
  const activeWorkbookSection = workbookSections[activeWorkbookSectionIdx] ?? workbookSections[0];
  const visibleDiffLines = useMemo(() => {
    if (!activeWorkbookSection) return diffLines;
    return diffLines.slice(activeWorkbookSection.startLineIdx, activeWorkbookSection.endLineIdx + 1);
  }, [activeWorkbookSection, diffLines]);
  const visibleLineItems = useMemo(() => {
    if (isWorkbookMode) {
      const offset = activeWorkbookSection?.startLineIdx ?? 0;
      return visibleDiffLines.map((line, index) => ({ line, lineIdx: offset + index }));
    }
    return diffLines.map((line, index) => ({ line, lineIdx: index }));
  }, [activeWorkbookSection?.startLineIdx, diffLines, isWorkbookMode, visibleDiffLines]);
  const blockPrefix = isWorkbookMode
    ? `unified-${activeWorkbookSection?.name ?? activeWorkbookSection?.startLineIdx ?? 0}`
    : 'text';
  const rowBlocks = useMemo(
    () => buildCollapsibleRowBlocks(visibleLineItems, (item) => item.line.type === 'equal'),
    [visibleLineItems],
  );
  const baseItems = useMemo<RenderItem[]>(
    () => buildCollapsedItems(rowBlocks, collapseCtx, expandedBlocks, {
      contextLines: CONTEXT_LINES,
      blockPrefix,
      buildRowItem: (item): LineItem => ({ kind: 'line', line: item.line, lineIdx: item.lineIdx }),
      buildCollapseItem: ({ blockId, count, fromIdx, toIdx, hiddenStart, hiddenEnd, expandStep }): CollapseItem => ({
        kind: 'collapse',
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
  const items = useMemo<RenderItem[]>(
    () => overlayManualCollapsedItems(baseItems, manualCollapsedRanges, {
      isLineItem: (item): item is LineItem => item.kind === 'line',
      getLineIdxs: (item) => item.kind === 'line' ? [item.lineIdx] : [],
      getCollapsedItemRange: (item) => item.kind === 'collapse'
        ? {
          startLineIdx: item.fromIdx,
          endLineIdx: item.toIdx,
        }
        : null,
      buildCollapseItem: ({ startLineIdx, endLineIdx, count }): CollapseItem => ({
        kind: 'collapse',
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

  const { totalH, startIdx, endIdx, scrollToIndex } = useVirtual(
    items.length,
    scrollRef as RefObject<HTMLDivElement | null>,
    ROW_H,
    { overscanMin: 40, overscanFactor: 2 },
  );

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
    handleLineNumberSelection,
    handleFoldSelectedRange,
    handleClearSelectedRange,
    handleBlankAreaPointerDown,
  } = useTextLineRangeSelectionState({ onFoldRange: collapseLineRange });
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
  const {
    textSelection,
    textSelectionCopyText,
    getTextSelectionRangeForLine,
    clearTextSelection,
  } = useLogicalTextSelectionState({
    enabled: !isWorkbookMode,
    hostRef: scrollRef,
    diffLines,
    copyMode: 'display',
    onSelectionIntent: () => {
      setLineRangeSelection(null);
      closeContextMenu();
    },
  });
  const textSelectionLineRange = useMemo(
    () => getLogicalTextSelectionLineRange(textSelection),
    [textSelection],
  );
  const handleManagedLineNumberSelection = useCallback((lineIdx: number, extend: boolean) => {
    clearTextSelection();
    closeContextMenu();
    handleLineNumberSelection(lineIdx, extend);
  }, [clearTextSelection, closeContextMenu, handleLineNumberSelection]);
  const lineNumberTitle: string | undefined = undefined;

  const {
    searchMatchSet,
    activeSearchLineIdx,
    searchRangesByLineIdx,
  } = useTextSearchDecorations(searchMatches, activeSearchIdx);
  const renderItemIndexes = useMemo(
    () => buildTextRenderItemIndexes(items, {
      cacheKey: 'unified:render-items:v1',
      getLineIdxs: (item) => item.kind === 'line' ? [item.lineIdx] : null,
    }),
    [items],
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
  useEffect(() => {
    onLineSelectionChange?.(
      normalizedLineRangeSelection
        ? { count: selectedLineCount, rangeLabel: selectedLineRangeLabel }
        : null,
    );
    return () => onLineSelectionChange?.(null);
  }, [normalizedLineRangeSelection, onLineSelectionChange, selectedLineCount, selectedLineRangeLabel]);

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (isWorkbookMode) return;
    if (textSelectionLineRange && openTextSelectionContextMenu(event, {
      copyText: textSelectionCopyText,
      ...textSelectionLineRange,
      sideMode: 'both',
      onFoldSelectedRange: () => {
        collapseLineRange(textSelectionLineRange.startLineIdx, textSelectionLineRange.endLineIdx);
        clearTextSelection();
      },
      onClearSelectedRange: clearTextSelection,
    })) return;
    void openLineSelectionContextMenu(event, 'both');
  }, [
    clearTextSelection,
    collapseLineRange,
    isWorkbookMode,
    openLineSelectionContextMenu,
    openTextSelectionContextMenu,
    textSelectionCopyText,
    textSelectionLineRange,
  ]);
  useEffect(() => {
    const hasTextSelectionMenu = contextMenuSections.some((section) => (
      section.items.some((item) => item.id === 'copy-selected-text')
    ));
    if (hasTextSelectionMenu && !textSelectionCopyText) {
      closeContextMenu();
    }
  }, [closeContextMenu, contextMenuSections, textSelectionCopyText]);
  useEffect(() => {
    setLineRangeSelection(null);
    clearTextSelection();
  }, [clearTextSelection, diffLines, isWorkbookMode, setLineRangeSelection]);

  const miniMapSegments = useMemo(
    () => buildUnifiedMiniMapSegments(
      items,
      textDiffPresentation.replacementPairIndex,
      searchMatchSet,
    ),
    [items, searchMatchSet, textDiffPresentation.replacementPairIndex],
  );

  useEffect(() => {
    if (!isWorkbookMode || workbookSections.length === 0) return;
    setActiveWorkbookSectionIdx(prev => Math.min(prev, workbookSections.length - 1));
  }, [isWorkbookMode, workbookSections.length]);

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
    isCollapseItem: (item) => item.kind === 'collapse',
    scrollToIndex,
    onCollapseNavigationReady,
  });

  useEffect(() => {
    resetActiveCollapseNavigation();
  }, [activeWorkbookSection?.name, diffLines, resetActiveCollapseNavigation]);

  useEffect(() => {
    const scrollAdjust = pendingScrollAdjustRef.current;
    if (!scrollAdjust) return;
    pendingScrollAdjustRef.current = 0;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, el.scrollTop + scrollAdjust);
  }, [items]);

  const workbookHeaderHeight = isWorkbookMode ? ROW_H : 0;
  const columnLabels = getWorkbookColumnLabels(activeWorkbookSection?.maxColumns ?? 0);

  useEffect(() => {
    if (isWorkbookMode) return;
    const snapshotState = sharedExpandedBlocks
      ?? layoutSnapshot?.expandedBlocks
      ?? EMPTY_COLLAPSE_EXPANSION_STATE;
    setExpandedBlocks((previous) => (
      areCollapseExpansionStatesEqual(previous, snapshotState)
        ? previous
        : cloneCollapseExpansionState(snapshotState)
    ));

    const scroller = scrollRef.current;
    if (!scroller) return;
    const rafId = requestAnimationFrame(() => {
      scroller.scrollTop = layoutSnapshot?.scrollTop ?? 0;
      scroller.scrollLeft = layoutSnapshot?.scrollLeft ?? 0;
    });
    return () => cancelAnimationFrame(rafId);
  }, [diffLines, isWorkbookMode, layoutSnapshot, sharedExpandedBlocks]);

  const emitLayoutSnapshot = useCallback(() => {
    if (isWorkbookMode || !onLayoutSnapshotChange) return;
    const scroller = scrollRef.current;
    onLayoutSnapshotChange({
      layout: 'unified',
      scrollTop: scroller?.scrollTop ?? 0,
      scrollLeft: scroller?.scrollLeft ?? 0,
      expandedBlocks: cloneCollapseExpansionState(expandedBlocks),
    });
  }, [expandedBlocks, isWorkbookMode, onLayoutSnapshotChange]);

  useEffect(() => {
    if (isWorkbookMode || !onLayoutSnapshotChange) return;
    emitLayoutSnapshot();
  }, [emitLayoutSnapshot, expandedBlocks, isWorkbookMode, onLayoutSnapshotChange]);

  useEffect(() => {
    if (isWorkbookMode || !onExpandedBlocksChange) return;
    onExpandedBlocksChange(expandedBlocks);
  }, [expandedBlocks, isWorkbookMode, onExpandedBlocksChange]);

  useEffect(() => {
    if (isWorkbookMode || !onLayoutSnapshotChange) return undefined;
    const scroller = scrollRef.current;
    if (!scroller) return undefined;

    const handleScroll = () => {
      if (snapshotEmitRafRef.current) return;
      snapshotEmitRafRef.current = requestAnimationFrame(() => {
        snapshotEmitRafRef.current = 0;
        emitLayoutSnapshot();
      });
    };

    scroller.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', handleScroll);
      if (snapshotEmitRafRef.current) {
        cancelAnimationFrame(snapshotEmitRafRef.current);
        snapshotEmitRafRef.current = 0;
      }
      emitLayoutSnapshot();
    };
  }, [emitLayoutSnapshot, isWorkbookMode, onLayoutSnapshotChange]);

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
            <div style={{
              position: 'sticky',
              top: 0,
              zIndex: 30,
              isolation: 'isolate',
              display: 'flex',
              background: cssVar('bg1'),
              minWidth: LN_W + LN_W + 3 + (columnLabels.length * WORKBOOK_CELL_WIDTH),
            }}>
              <div style={{
                width: (LN_W * 2) + 3,
                minWidth: (LN_W * 2) + 3,
                background: cssVar('bg2'),
                borderBottom: `1px solid ${cssVar('border')}`,
              }} />
              {columnLabels.map(label => (
                <div
                  key={label}
                  style={{
                    width: WORKBOOK_CELL_WIDTH,
                    minWidth: WORKBOOK_CELL_WIDTH,
                    maxWidth: WORKBOOK_CELL_WIDTH,
                    borderLeft: `1px solid ${cssVar('border')}`,
                    borderBottom: `1px solid ${cssVar('border')}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: cssVar('acc2'),
                    background: cssVar('bg1'),
                    fontSize: 11,
                    fontWeight: 700,
                  }}>
                  {label}
                </div>
              ))}
            </div>
          )}

          <div
            onPointerDown={handleBlankAreaPointerDown}
            style={isWorkbookMode
              ? { position: 'absolute', top: workbookHeaderHeight + (startIdx * ROW_H), left: 0, minWidth: '100%' }
              : { position: 'absolute', top: workbookHeaderHeight + (startIdx * ROW_H), left: 0, width: 'max-content', minWidth: '100%' }}>
          {items.slice(startIdx, endIdx).map((item, visibleOffset) => {
            const itemIndex = startIdx + visibleOffset;
            const key = item.kind === 'collapse'
              ? `${item.blockId}-${item.hiddenStart}-${item.hiddenEnd}`
              : `line-${item.lineIdx}`;
            if (item.kind === 'collapse') {
              const ci = item as CollapseItem;
              const collapseLineSelected = doesSelectionIntersectLineRange(lineRangeSelection, ci.fromIdx, ci.toIdx);
              const collapseTextSelected = doesLogicalTextSelectionIntersectLineRange(textSelection, ci.fromIdx, ci.toIdx);
              const collapseSelected = collapseLineSelected || collapseTextSelected;
              return (
                <div
                  key={key}
                  data-collapse-range="true"
                  data-collapse-start={ci.fromIdx}
                  data-collapse-end={ci.toIdx}
                  data-selection-band={collapseSelected ? 'true' : undefined}
                  style={{ position: 'relative', zIndex: 12, pointerEvents: 'auto' }}>
                  <CollapseBar
                    count={ci.count}
                    expandCount={Math.min(ci.count, ci.expandStep)}
                    active={itemIndex === activeCollapseIndex}
                    leadingInset={LN_W * 2}
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
                    label={ci.source === 'manual' ? t('manualCollapseBarLines', { count: ci.count }) : undefined}
                    actionLabel={ci.source === 'manual' ? t('manualCollapseBarReveal') : undefined}
                    palette={collapseLineSelected
                      ? selectedCollapseSurfaces.palette
                      : collapseTextSelected
                        ? textSelectionCollapsePalette
                        : undefined}
                    onExpand={() => {
                      if (ci.source === 'manual') {
                        setExpandedBlocks((prev) => removeManualCollapsedRange(
                          prev,
                          ci.fromIdx,
                          ci.toIdx,
                        ));
                        return;
                      }

                      const revealCount = Math.min(ci.count, ci.expandStep);
                      pendingScrollAdjustRef.current += getCollapseLeadingRevealCount(ci.count, revealCount) * ROW_H;
                      setExpandedBlocks(prev => expandCollapseBlock(
                        prev,
                        ci.blockId,
                        ci.hiddenStart,
                        ci.hiddenEnd,
                        revealCount,
                      ));
                    }}
                    onExpandAll={ci.source === 'manual'
                      ? undefined
                      : () => {
                        setExpandedBlocks(prev => expandCollapseBlockFully(
                          prev,
                          ci.blockId,
                          ci.hiddenStart,
                          ci.hiddenEnd,
                        ));
                      }}
                  />
                </div>
              );
            }
            const li = item as LineItem;
            const unifiedCopySide = li.line.base != null && li.line.mine != null
              ? 'both'
              : li.line.base != null
                ? 'base'
                : 'mine';
            const unifiedLineText = li.line.type === 'add'
              ? (li.line.mine ?? '')
              : li.line.type === 'delete'
                ? (li.line.base ?? '')
                : (li.line.base ?? li.line.mine ?? '');
            return (
              <div
                key={key}
                data-line-idx={li.lineIdx}
                data-line-span-end={li.lineIdx}
                data-selection-band={isLineIdxWithinSelection(lineRangeSelection, li.lineIdx) ? 'true' : undefined}
                onPointerDown={handleBlankAreaPointerDown}
                style={{ minWidth: '100%' }}>
                <DiffRow line={li.line}
                  copySide={unifiedCopySide}
                  syntaxTokens={getUnifiedLineSyntaxTokens(syntaxPresentation, li.line)}
                  isReplacementPair={textDiffPresentation.replacementPairIndex.has(li.lineIdx)}
                  widthMode={isWorkbookMode ? 'fill' : 'content'}
                  isSearchMatch={searchMatchSet.has(li.lineIdx)}
                  isActiveSearch={activeSearchLineIdx === li.lineIdx}
                  isRangeSelected={isLineIdxWithinSelection(lineRangeSelection, li.lineIdx)}
                  isBaseLineSelected={isLineIdxWithinSelection(lineRangeSelection, li.lineIdx) && li.line.baseLineNo != null}
                  isMineLineSelected={isLineIdxWithinSelection(lineRangeSelection, li.lineIdx) && li.line.mineLineNo != null}
                  selectionAccentColor={selectionAccentColor}
                  lineNumberTitle={!isWorkbookMode ? lineNumberTitle : undefined}
                  onBaseLineNumberClick={!isWorkbookMode
                    ? (event) => handleManagedLineNumberSelection(li.lineIdx, event.shiftKey)
                    : undefined}
                  onMineLineNumberClick={!isWorkbookMode
                    ? (event) => handleManagedLineNumberSelection(li.lineIdx, event.shiftKey)
                    : undefined}
                  searchRanges={searchRangesByLineIdx.get(li.lineIdx) ?? []}
                  showWhitespace={showWhitespace}
                  fontSize={fontSize}
                  allowTextSelection={!isWorkbookMode}
                  textSelectionRange={!isWorkbookMode
                    ? getTextSelectionRangeForLine(li.lineIdx, unifiedCopySide, unifiedLineText.length)
                    : null}
                />
              </div>
            );
          })}
        </div>
        </div>
        <CollapseJumpButton
          onPrev={handleJumpToPreviousCollapse}
          onNext={handleJumpToNextCollapse}
          currentIndex={activeCollapsePosition >= 0 ? activeCollapsePosition + 1 : 0}
          totalCount={totalCollapseCount}
          storageKey="text-unified"
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

export default UnifiedPanel;
