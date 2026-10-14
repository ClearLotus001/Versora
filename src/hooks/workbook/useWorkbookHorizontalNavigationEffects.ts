import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react';

import type {
  SearchMatch,
  WorkbookDiffRegion,
  WorkbookSelectionFocusIntent,
  WorkbookSelectedCell,
} from '@/types';
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

interface UseWorkbookHorizontalNavigationEffectsParams {
  active: boolean;
  activeHunkIdx: number;
  activeSearchMatch: SearchMatch | null;
  activeSearchTargetCell: WorkbookSelectedCell | null;
  activeWorkbookSection: WorkbookSection | undefined;
  activeHiddenRows: number[];
  activeHiddenColumns: number[];
  showHiddenColumns: boolean;
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
  guidedPulseNonce: number;
  navigationLayoutKey: string;
  frozenRows: SplitRow[];
  rowItemIndexBySide: {
    base: Map<number, number>;
    mine: Map<number, number>;
  };
  scrollFrozenRowsToIndex: (idx: number, align?: 'start' | 'center', behavior?: 'auto' | 'smooth' | 'smart') => void;
  scrollToResolvedLine: (
    lineIdx: number,
    align?: 'start' | 'center',
    behavior?: 'auto' | 'smooth' | 'smart',
  ) => boolean;
  scrollToIndex: (idx: number, align?: 'start' | 'center', behavior?: 'auto' | 'smooth' | 'smart') => void;
  syncScrollPosition: (source: 'left' | 'right') => void;
  syncFrozenRowsPaneScrollPosition: (source: 'left' | 'right') => void;
  focusWorkbookDiffRegion: (region: WorkbookDiffRegion) => void;
  markProgrammaticScroll: (side: 'left' | 'right', duration?: number) => void;
  isAutoScrollSuppressed: () => boolean;
  isUserScrollPaused: () => boolean;
  lastAutoRowKeyRef: MutableRefObject<string>;
  lastAutoCellKeyRef: MutableRefObject<string>;
  suppressGuidedNavigationUntilRef: MutableRefObject<number>;
}

interface UseWorkbookHorizontalNavigationEffectsResult {
  markViewportRestored: () => void;
}

export function useWorkbookHorizontalNavigationEffects({
  active,
  activeHunkIdx,
  activeSearchMatch,
  activeSearchTargetCell,
  activeWorkbookSection,
  activeHiddenRows,
  activeHiddenColumns,
  showHiddenColumns,
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
  guidedPulseNonce,
  navigationLayoutKey,
  frozenRows,
  rowItemIndexBySide,
  scrollFrozenRowsToIndex,
  scrollToResolvedLine,
  scrollToIndex,
  syncScrollPosition,
  syncFrozenRowsPaneScrollPosition,
  focusWorkbookDiffRegion,
  markProgrammaticScroll,
  isAutoScrollSuppressed,
  isUserScrollPaused,
  lastAutoRowKeyRef,
  lastAutoCellKeyRef,
  suppressGuidedNavigationUntilRef,
}: UseWorkbookHorizontalNavigationEffectsParams): UseWorkbookHorizontalNavigationEffectsResult {
  const lastGuidedNavigationKeyRef = useRef('');
  const lastAppliedSearchKeyRef = useRef('');
  const guidedNavigationKey = activeDiffRegion
    ? `${guidedPulseNonce}:${activeDiffRegion.id}:${navigationLayoutKey}`
    : '';
  const markViewportRestored = useCallback(() => {
    lastGuidedNavigationKeyRef.current = guidedNavigationKey;
  }, [guidedNavigationKey]);

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
    onRevealHiddenColumns,
    onRevealHiddenRows,
    onSelectionRequest,
    scrollToSearchTarget,
    searchJumpNonce,
    showHiddenColumns,
    suppressGuidedNavigationUntilRef,
  ]);

  useLayoutEffect(() => {
    lastGuidedNavigationKeyRef.current = '';
  }, [activeDiffRegion?.id, activeWorkbookSection?.name]);

  useEffect(() => {
    if (!active) return;
    if (!activeDiffRegion || !activeWorkbookSection) return;
    if (activeDiffRegion.sheetName !== activeWorkbookSection.name) return;
    if (getNow() < suppressGuidedNavigationUntilRef.current) return;
    const navigationKey = guidedNavigationKey;
    if (lastGuidedNavigationKeyRef.current === navigationKey) return;

    const anchorPatch = activeDiffRegion.patches[0] ?? null;
    const anchorSide: 'base' | 'mine' = anchorPatch?.hasBaseSide ? 'base' : 'mine';
    const anchorRowNumber = anchorSide === 'base'
      ? (anchorPatch?.baseRowStart ?? anchorPatch?.baseRowEnd ?? null)
      : (anchorPatch?.mineRowStart ?? anchorPatch?.mineRowEnd ?? null);
    const targetRowIndex = anchorRowNumber != null
      ? (rowItemIndexBySide[anchorSide].get(anchorRowNumber) ?? -1)
      : -1;
    let followUpRafId = 0;
    let settleRafId = 0;
    const rafId = requestAnimationFrame(() => {
      if (lastGuidedNavigationKeyRef.current === navigationKey) return;
      if (targetRowIndex >= 0) {
        markProgrammaticScroll('left', 640);
        markProgrammaticScroll('right', 640);
        scrollToIndex(targetRowIndex, 'start', 'smooth');
        requestAnimationFrame(() => syncScrollPosition('left'));
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
    activeWorkbookSection,
    focusWorkbookDiffRegion,
    guidedNavigationKey,
    markProgrammaticScroll,
    rowItemIndexBySide,
    scrollToIndex,
    scrollToResolvedLine,
    syncScrollPosition,
    suppressGuidedNavigationUntilRef,
  ]);

  useEffect(() => {
    if (!active) return;
    if (!selectedCell || !activeWorkbookSection || selectedCell.sheetName !== activeWorkbookSection.name) return;
    if (selectedCell.kind === 'column') return;
    if (selectionFocusIntent) return;
    if (navigationTargetCell && activeDiffRegion && !workbookDiffRegionContainsSelection(activeDiffRegion, selectedCell)) return;
    if (isAutoScrollSuppressed()) return;
    if (isUserScrollPaused()) return;
    const selectionKey = buildSelectionAutoScrollKey(activeWorkbookSection.name, selectedCell);
    if (lastAutoRowKeyRef.current === selectionKey) return;
    const frozenRowIndex = frozenRows.findIndex((row) => getWorkbookSideRowNumber(row, selectedCell.side) === selectedCell.rowNumber);
    if (frozenRowIndex >= 0) {
      lastAutoRowKeyRef.current = selectionKey;
      scrollFrozenRowsToIndex(frozenRowIndex, 'center', 'smart');
      requestAnimationFrame(() => syncFrozenRowsPaneScrollPosition('left'));
      return;
    }
    const idx = rowItemIndexBySide[selectedCell.side].get(selectedCell.rowNumber) ?? -1;
    if (idx >= 0) {
      lastAutoRowKeyRef.current = selectionKey;
      markProgrammaticScroll('left', 640);
      markProgrammaticScroll('right', 640);
      scrollToIndex(idx, 'center', 'smart');
      requestAnimationFrame(() => syncScrollPosition('left'));
    }
  }, [
    active,
    activeDiffRegion,
    activeWorkbookSection,
    frozenRows,
    isAutoScrollSuppressed,
    isUserScrollPaused,
    lastAutoRowKeyRef,
    markProgrammaticScroll,
    navigationTargetCell,
    rowItemIndexBySide,
    scrollFrozenRowsToIndex,
    scrollToIndex,
    selectedCell,
    selectionFocusIntent,
    syncFrozenRowsPaneScrollPosition,
    syncScrollPosition,
  ]);

  const focusExplicitSelection = useCallback((target: WorkbookSelectedCell) => {
    lastAutoCellKeyRef.current = buildSelectionAutoScrollKey(activeWorkbookSection?.name ?? '', target);
    const didFocusColumn = focusWorkbookCell(target, 'ensure-visible');
    if (target.kind === 'column') return didFocusColumn;

    const selectionKey = buildSelectionAutoScrollKey(activeWorkbookSection?.name ?? '', target);
    lastAutoRowKeyRef.current = selectionKey;
    const sourceSide = target.side === 'base' ? 'left' : 'right';
    const frozenRowIndex = frozenRows.findIndex((row) => (
      getWorkbookSideRowNumber(row, target.side) === target.rowNumber
    ));
    const rowIndex = rowItemIndexBySide[target.side].get(target.rowNumber) ?? -1;

    if (frozenRowIndex >= 0) {
      scrollFrozenRowsToIndex(frozenRowIndex, 'center', 'smart');
      requestAnimationFrame(() => syncFrozenRowsPaneScrollPosition(sourceSide));
      return didFocusColumn;
    }
    if (rowIndex < 0) return false;

    markProgrammaticScroll('left', 640);
    markProgrammaticScroll('right', 640);
    scrollToIndex(rowIndex, 'center', 'smart');
    requestAnimationFrame(() => syncScrollPosition('left'));
    return didFocusColumn;
  }, [
    activeWorkbookSection?.name,
    focusWorkbookCell,
    frozenRows,
    lastAutoCellKeyRef,
    lastAutoRowKeyRef,
    markProgrammaticScroll,
    rowItemIndexBySide,
    scrollFrozenRowsToIndex,
    scrollToIndex,
    syncFrozenRowsPaneScrollPosition,
    syncScrollPosition,
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
    if (navigationTargetCell && activeDiffRegion && !workbookDiffRegionContainsSelection(activeDiffRegion, selectedCell)) return;
    if (isAutoScrollSuppressed()) return;
    const selectionKey = buildSelectionAutoScrollKey(activeWorkbookSection.name, selectedCell);
    if (lastAutoCellKeyRef.current === selectionKey) return;

    const rafId = requestAnimationFrame(() => {
      lastAutoCellKeyRef.current = selectionKey;
      focusWorkbookCell(selectedCell, 'ensure-visible');
    });

    return () => cancelAnimationFrame(rafId);
  }, [
    active,
    activeDiffRegion,
    activeWorkbookSection,
    focusWorkbookCell,
    isAutoScrollSuppressed,
    lastAutoCellKeyRef,
    navigationTargetCell,
    selectedCell,
    selectionFocusIntent,
  ]);

  return { markViewportRestored };
}
