import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';

import type {
  SearchMatch,
  WorkbookDiffRegion,
  WorkbookSelectionFocusIntent,
  WorkbookSelectedCell,
} from '@/types';
import type { CompareMode, WorkbookStackedScrollTarget } from '@/hooks/workbook/useWorkbookCompareDerivedState';
import type { WorkbookSection } from '@/utils/workbook/workbookSections';
import type { SplitRow } from '@/types/view';
import { workbookDiffRegionContainsSelection } from '@/utils/workbook/workbookDiffRegion';
import { buildSelectionAutoScrollKey } from '@/utils/workbook/workbookPanelHelpers';
import { getWorkbookSideRowNumber } from '@/utils/workbook/workbookNavigation';
import { useWorkbookFocusTransaction } from '@/hooks/workbook/useWorkbookFocusTransaction';

function getNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

interface SearchScrollResult {
  didScroll: boolean;
  isExact: boolean;
}

interface UseWorkbookCompareNavigationEffectsParams {
  active: boolean;
  activeSearchMatch: SearchMatch | null;
  activeSearchTargetCell: WorkbookSelectedCell | null;
  activeWorkbookSection: WorkbookSection | undefined;
  activeHiddenRows: number[];
  activeHiddenColumns: number[];
  showHiddenColumns: boolean;
  itemsCount: number;
  searchJumpNonce: number;
  onSelectionRequest: (request: { target: WorkbookSelectedCell; reason: 'search' }) => void;
  onRevealHiddenRows: (sheetName: string, rowNumbers: number[]) => void;
  onRevealHiddenColumns: (sheetName: string, columns: number[]) => void;
  scrollToSearchTarget: (target: WorkbookSelectedCell | null, fallbackLineIdx: number) => SearchScrollResult;
  focusWorkbookCell: (cell: WorkbookSelectedCell, mode: 'focus' | 'ensure-visible') => boolean;
  activeDiffRegion: WorkbookDiffRegion | null;
  navigationTargetCell: WorkbookSelectedCell | null;
  selectedCell: WorkbookSelectedCell | null;
  selectionFocusIntent: WorkbookSelectionFocusIntent | null;
  onSelectionFocusIntentHandled: (intentId: number) => void;
  activeHunkIdx: number;
  guidedPulseNonce: number;
  navigationLayoutKey: string;
  mode: CompareMode;
  frozenRows: SplitRow[];
  rowItemIndexBySide: {
    base: Map<number, number>;
    mine: Map<number, number>;
  };
  stackedRowScrollTargetsBySide: {
    base: Map<number, WorkbookStackedScrollTarget>;
    mine: Map<number, WorkbookStackedScrollTarget>;
  };
  scrollToFrozenRowIndex: (idx: number, align?: 'start' | 'center', behavior?: 'auto' | 'smooth' | 'smart') => void;
  scrollToStackedTarget: (
    target: WorkbookStackedScrollTarget,
    align?: 'start' | 'center',
    behavior?: 'auto' | 'smooth' | 'smart',
  ) => boolean;
  scrollToResolvedLine: (
    lineIdx: number,
    align?: 'start' | 'center',
    behavior?: 'auto' | 'smooth' | 'smart',
  ) => boolean;
  scrollToIndex: (idx: number, align?: 'start' | 'center', behavior?: 'auto' | 'smooth' | 'smart') => void;
  focusWorkbookDiffRegion: (region: WorkbookDiffRegion) => void;
  markProgrammaticScroll: (duration?: number) => void;
  isAutoScrollSuppressed: () => boolean;
  isUserScrollPaused: () => boolean;
  isSelectionAutoScrollLocked: (selectionKey: string, target: 'row' | 'cell') => boolean;
  lastAutoRowKeyRef: MutableRefObject<string>;
  lastAutoCellKeyRef: MutableRefObject<string>;
  lastForcedRevealHunkIdxRef: MutableRefObject<number>;
  suppressGuidedNavigationUntilRef: MutableRefObject<number>;
}

interface UseWorkbookCompareNavigationEffectsResult {
  markViewportRestored: () => void;
}

export function useWorkbookCompareNavigationEffects({
  active,
  activeSearchMatch,
  activeSearchTargetCell,
  activeWorkbookSection,
  activeHiddenRows,
  activeHiddenColumns,
  showHiddenColumns,
  itemsCount,
  searchJumpNonce,
  onSelectionRequest,
  onRevealHiddenRows,
  onRevealHiddenColumns,
  scrollToSearchTarget,
  focusWorkbookCell,
  activeDiffRegion,
  navigationTargetCell,
  selectedCell,
  selectionFocusIntent,
  onSelectionFocusIntentHandled,
  activeHunkIdx,
  guidedPulseNonce,
  navigationLayoutKey,
  mode,
  frozenRows,
  rowItemIndexBySide,
  stackedRowScrollTargetsBySide,
  scrollToFrozenRowIndex,
  scrollToStackedTarget,
  scrollToResolvedLine,
  scrollToIndex,
  focusWorkbookDiffRegion,
  markProgrammaticScroll,
  isAutoScrollSuppressed,
  isUserScrollPaused,
  isSelectionAutoScrollLocked,
  lastAutoRowKeyRef,
  lastAutoCellKeyRef,
  lastForcedRevealHunkIdxRef,
  suppressGuidedNavigationUntilRef,
}: UseWorkbookCompareNavigationEffectsParams): UseWorkbookCompareNavigationEffectsResult {
  const lastGuidedNavigationKeyRef = useRef('');
  const lastAppliedSearchKeyRef = useRef('');
  const guidedNavigationKey = activeDiffRegion
    ? `${guidedPulseNonce}:${activeHunkIdx}:${activeDiffRegion.id}:${navigationLayoutKey}`
    : '';
  const markViewportRestored = useCallback(() => {
    lastGuidedNavigationKeyRef.current = guidedNavigationKey;
    lastForcedRevealHunkIdxRef.current = activeHunkIdx;
  }, [activeHunkIdx, guidedNavigationKey, lastForcedRevealHunkIdxRef]);

  useEffect(() => {
    if (!activeSearchMatch) {
      lastAppliedSearchKeyRef.current = '';
      return;
    }
    if (!active) return;
    if (!activeWorkbookSection) return;
    if (
      activeSearchMatch.lineIdx < activeWorkbookSection.startLineIdx
      || activeSearchMatch.lineIdx > activeWorkbookSection.endLineIdx
    ) {
      return;
    }
    if (
      activeSearchMatch.workbookTarget?.sheetName
      && activeSearchMatch.workbookTarget.sheetName !== activeWorkbookSection.name
    ) {
      return;
    }

    const targetRowNumber = activeSearchMatch.workbookTarget?.rowNumber ?? null;
    if (targetRowNumber != null && activeHiddenRows.includes(targetRowNumber)) {
      onRevealHiddenRows(activeWorkbookSection.name, [targetRowNumber]);
      return;
    }

    const targetColIndex = activeSearchMatch.workbookTarget?.colIndex ?? null;
    if (
      targetColIndex != null
      && !showHiddenColumns
      && activeHiddenColumns.includes(targetColIndex)
    ) {
      onRevealHiddenColumns(activeWorkbookSection.name, [targetColIndex]);
      return;
    }

    const searchKey = [
      activeWorkbookSection.name,
      activeSearchMatch.lineIdx,
      activeSearchMatch.start,
      activeSearchMatch.end,
      activeSearchMatch.workbookTarget?.sheetName ?? '',
      activeSearchMatch.workbookTarget?.side ?? '',
      activeSearchMatch.workbookTarget?.rowNumber ?? '',
      activeSearchMatch.workbookTarget?.colIndex ?? '',
      searchJumpNonce,
    ].join(':');
    if (lastAppliedSearchKeyRef.current === searchKey) return;

    if (activeSearchTargetCell) {
      suppressGuidedNavigationUntilRef.current = getNow() + 900;
      onSelectionRequest({
        target: activeSearchTargetCell,
        reason: 'search',
      });
    }

    const scrollResult = scrollToSearchTarget(activeSearchTargetCell, activeSearchMatch.lineIdx);
    if (!scrollResult.didScroll) return;

    const didFocus = activeSearchTargetCell
      ? focusWorkbookCell(activeSearchTargetCell, 'focus')
      : true;
    if (!scrollResult.isExact || !didFocus) return;

    lastAppliedSearchKeyRef.current = searchKey;
  }, [
    active,
    activeHiddenColumns,
    activeHiddenRows,
    activeSearchMatch,
    activeSearchTargetCell,
    activeWorkbookSection,
    focusWorkbookCell,
    itemsCount,
    onRevealHiddenColumns,
    onRevealHiddenRows,
    onSelectionRequest,
    scrollToSearchTarget,
    searchJumpNonce,
    showHiddenColumns,
    suppressGuidedNavigationUntilRef,
  ]);

  useEffect(() => {
    if (!active) return;
    if (!activeDiffRegion || !activeWorkbookSection) return;
    if (activeDiffRegion.sheetName !== activeWorkbookSection.name) return;
    if (getNow() < suppressGuidedNavigationUntilRef.current) return;
    const navigationKey = guidedNavigationKey;
    if (lastGuidedNavigationKeyRef.current === navigationKey) return;

    lastForcedRevealHunkIdxRef.current = activeHunkIdx;
    const preferredNavigationTarget = (
      navigationTargetCell
      && navigationTargetCell.sheetName === activeWorkbookSection.name
      && navigationTargetCell.kind !== 'column'
      && navigationTargetCell.rowNumber > 0
    ) ? navigationTargetCell : null;
    const anchorPatch = activeDiffRegion.patches[0] ?? null;
    const anchorSide: 'base' | 'mine' = preferredNavigationTarget?.side
      ?? (anchorPatch?.hasBaseSide ? 'base' : 'mine');
    const anchorRowNumber = preferredNavigationTarget?.rowNumber
      ?? (anchorSide === 'base'
        ? (anchorPatch?.baseRowStart ?? anchorPatch?.baseRowEnd ?? null)
        : (anchorPatch?.mineRowStart ?? anchorPatch?.mineRowEnd ?? null));
    const stackedTarget = mode === 'stacked' && anchorRowNumber != null
      ? (stackedRowScrollTargetsBySide[anchorSide].get(anchorRowNumber) ?? null)
      : null;
    const targetRowIndex = anchorRowNumber != null
      ? (rowItemIndexBySide[anchorSide].get(anchorRowNumber) ?? -1)
      : -1;
    let followUpRafId = 0;
    let settleRafId = 0;
    const rafId = requestAnimationFrame(() => {
      if (lastGuidedNavigationKeyRef.current === navigationKey) return;
      if (stackedTarget) {
        scrollToStackedTarget(stackedTarget, 'start', 'smooth');
      } else if (targetRowIndex >= 0) {
        markProgrammaticScroll(640);
        scrollToIndex(targetRowIndex, 'start', 'smooth');
      } else {
        scrollToResolvedLine(activeDiffRegion.lineStartIdx, 'start', 'smooth');
      }
      focusWorkbookDiffRegion(activeDiffRegion);
      followUpRafId = requestAnimationFrame(() => {
        if (lastGuidedNavigationKeyRef.current === navigationKey) return;
        focusWorkbookDiffRegion(activeDiffRegion);
        settleRafId = requestAnimationFrame(() => {
          if (lastGuidedNavigationKeyRef.current === navigationKey) return;
          focusWorkbookDiffRegion(activeDiffRegion);
          lastGuidedNavigationKeyRef.current = navigationKey;
        });
      });
    });

    return () => {
      cancelAnimationFrame(rafId);
      if (followUpRafId) cancelAnimationFrame(followUpRafId);
      if (settleRafId) cancelAnimationFrame(settleRafId);
    };
  }, [
    active,
    activeDiffRegion,
    activeHunkIdx,
    activeWorkbookSection,
    focusWorkbookDiffRegion,
    guidedNavigationKey,
    lastForcedRevealHunkIdxRef,
    markProgrammaticScroll,
    mode,
    navigationTargetCell,
    rowItemIndexBySide,
    scrollToIndex,
    scrollToResolvedLine,
    scrollToStackedTarget,
    stackedRowScrollTargetsBySide,
    suppressGuidedNavigationUntilRef,
  ]);

  useEffect(() => {
    if (!active) return;
    if (!selectedCell || !activeWorkbookSection || selectedCell.sheetName !== activeWorkbookSection.name) return;
    if (selectedCell.kind === 'column') return;
    if (selectionFocusIntent) return;
    if (navigationTargetCell && activeDiffRegion && !workbookDiffRegionContainsSelection(activeDiffRegion, selectedCell)) return;
    if (isAutoScrollSuppressed()) return;
    const shouldForceReveal = activeHunkIdx !== lastForcedRevealHunkIdxRef.current;
    if (!shouldForceReveal && isUserScrollPaused()) return;
    const selectionKey = buildSelectionAutoScrollKey(activeWorkbookSection.name, selectedCell);
    if (!shouldForceReveal && isSelectionAutoScrollLocked(selectionKey, 'row')) return;
    if (!shouldForceReveal && lastAutoRowKeyRef.current === selectionKey) return;
    const frozenRowIndex = mode === 'columns'
      ? frozenRows.findIndex((row) => getWorkbookSideRowNumber(row, selectedCell.side) === selectedCell.rowNumber)
      : -1;
    if (frozenRowIndex >= 0) {
      if (shouldForceReveal) lastForcedRevealHunkIdxRef.current = activeHunkIdx;
      lastAutoRowKeyRef.current = selectionKey;
      scrollToFrozenRowIndex(frozenRowIndex, 'center', 'smart');
      return;
    }
    const stackedTarget = mode === 'stacked'
      ? (stackedRowScrollTargetsBySide[selectedCell.side].get(selectedCell.rowNumber) ?? null)
      : null;
    const idx = rowItemIndexBySide[selectedCell.side].get(selectedCell.rowNumber) ?? -1;
    if (stackedTarget) {
      if (shouldForceReveal) lastForcedRevealHunkIdxRef.current = activeHunkIdx;
      lastAutoRowKeyRef.current = selectionKey;
      scrollToStackedTarget(stackedTarget, 'center', 'smart');
    } else if (idx >= 0) {
      if (shouldForceReveal) lastForcedRevealHunkIdxRef.current = activeHunkIdx;
      lastAutoRowKeyRef.current = selectionKey;
      markProgrammaticScroll(640);
      scrollToIndex(idx, 'center', 'smart');
    }
  }, [
    active,
    activeDiffRegion,
    activeHunkIdx,
    activeWorkbookSection,
    frozenRows,
    isAutoScrollSuppressed,
    isSelectionAutoScrollLocked,
    isUserScrollPaused,
    lastAutoRowKeyRef,
    lastForcedRevealHunkIdxRef,
    markProgrammaticScroll,
    mode,
    navigationTargetCell,
    rowItemIndexBySide,
    scrollToFrozenRowIndex,
    scrollToIndex,
    scrollToStackedTarget,
    selectedCell,
    selectionFocusIntent,
    stackedRowScrollTargetsBySide,
  ]);

  const focusExplicitSelection = useCallback((target: WorkbookSelectedCell) => {
    lastAutoCellKeyRef.current = buildSelectionAutoScrollKey(activeWorkbookSection?.name ?? '', target);
    const didFocusColumn = focusWorkbookCell(target, 'ensure-visible');
    if (target.kind === 'column') return didFocusColumn;

    lastAutoRowKeyRef.current = buildSelectionAutoScrollKey(activeWorkbookSection?.name ?? '', target);
    const frozenRowIndex = mode === 'columns'
      ? frozenRows.findIndex((row) => getWorkbookSideRowNumber(row, target.side) === target.rowNumber)
      : -1;
    const stackedTarget = mode === 'stacked'
      ? (stackedRowScrollTargetsBySide[target.side].get(target.rowNumber) ?? null)
      : null;
    const rowIndex = rowItemIndexBySide[target.side].get(target.rowNumber) ?? -1;

    if (frozenRowIndex >= 0) {
      scrollToFrozenRowIndex(frozenRowIndex, 'center', 'smart');
      return didFocusColumn;
    }
    if (stackedTarget) {
      return scrollToStackedTarget(stackedTarget, 'center', 'smart') && didFocusColumn;
    }
    if (rowIndex < 0) return false;

    markProgrammaticScroll(640);
    scrollToIndex(rowIndex, 'center', 'smart');
    return didFocusColumn;
  }, [
    activeWorkbookSection?.name,
    focusWorkbookCell,
    frozenRows,
    lastAutoCellKeyRef,
    lastAutoRowKeyRef,
    markProgrammaticScroll,
    mode,
    rowItemIndexBySide,
    scrollToFrozenRowIndex,
    scrollToIndex,
    scrollToStackedTarget,
    stackedRowScrollTargetsBySide,
  ]);
  useWorkbookFocusTransaction({
    active,
    activeSheetName: activeWorkbookSection?.name ?? null,
    navigationContext: activeHunkIdx,
    intent: selectionFocusIntent,
    executeFocus: focusExplicitSelection,
    onIntentHandled: onSelectionFocusIntentHandled,
  });

  useEffect(() => {
    if (!active) return;
    if (!selectedCell || !activeWorkbookSection || selectedCell.sheetName !== activeWorkbookSection.name) return;
    if (selectedCell.kind === 'row') return;
    if (selectionFocusIntent) return;
    const shouldForceReveal = activeHunkIdx !== lastForcedRevealHunkIdxRef.current;
    if (
      shouldForceReveal
      && navigationTargetCell
      && activeDiffRegion
      && !workbookDiffRegionContainsSelection(activeDiffRegion, selectedCell)
    ) return;
    if (isAutoScrollSuppressed()) return;
    const selectionKey = buildSelectionAutoScrollKey(activeWorkbookSection.name, selectedCell);
    if (!shouldForceReveal && isSelectionAutoScrollLocked(selectionKey, 'cell')) return;
    if (!shouldForceReveal && lastAutoCellKeyRef.current === selectionKey) return;

    const rafId = requestAnimationFrame(() => {
      if (shouldForceReveal) lastForcedRevealHunkIdxRef.current = activeHunkIdx;
      lastAutoCellKeyRef.current = selectionKey;
      focusWorkbookCell(selectedCell, 'ensure-visible');
    });

    return () => cancelAnimationFrame(rafId);
  }, [
    active,
    activeDiffRegion,
    activeHunkIdx,
    activeWorkbookSection,
    focusWorkbookCell,
    isAutoScrollSuppressed,
    isSelectionAutoScrollLocked,
    lastAutoCellKeyRef,
    lastForcedRevealHunkIdxRef,
    navigationTargetCell,
    selectedCell,
    selectionFocusIntent,
  ]);

  return { markViewportRestored };
}
