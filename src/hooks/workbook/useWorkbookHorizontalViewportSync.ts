import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from 'react';

import type {
  WorkbookHorizontalLayoutSnapshot,
  WorkbookSelectedCell,
} from '@/types';
import type { CollapseExpansionState } from '@/utils/collapse/collapseState';
import {
  scrollElementForNavigation,
} from '@/utils/navigation/animatedScroll';
import {
  buildWorkbookHorizontalLayoutSnapshot,
  shouldRestoreWorkbookLayoutSnapshot,
} from '@/utils/workbook/workbookLayoutSnapshot';
import { buildSelectionAutoScrollKey } from '@/utils/workbook/workbookPanelHelpers';

function getNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

interface UseWorkbookHorizontalViewportSyncParams {
  active: boolean;
  leftScrollRef: RefObject<HTMLDivElement | null>;
  rightScrollRef: RefObject<HTMLDivElement | null>;
  activeSheetName: string | null;
  activeRegionId: string | null;
  expandedBlocks: CollapseExpansionState;
  isExpandedBlocksContextSettled: boolean;
  onExpandedBlocksChange?: ((sheetName: string | null, activeRegionId: string | null, expandedBlocks: CollapseExpansionState) => void) | undefined;
  layoutSnapshot?: WorkbookHorizontalLayoutSnapshot | null;
  onLayoutSnapshotChange?: ((snapshot: WorkbookHorizontalLayoutSnapshot) => void) | undefined;
  splitRatio: number;
  defaultSplitRatio: number;
  restoreSplitRatio: (ratio: number) => number;
  selectedCell: WorkbookSelectedCell | null;
  diffIdentity: unknown;
  syncScrollPosition: (source: 'left' | 'right') => void;
  onResetViewportState?: (() => void) | undefined;
}

interface UseWorkbookHorizontalViewportSyncResult {
  userScrollPauseUntilRef: MutableRefObject<number>;
  programmaticScrollUntilRef: MutableRefObject<{ left: number; right: number }>;
  lastAutoRowKeyRef: MutableRefObject<string>;
  lastAutoCellKeyRef: MutableRefObject<string>;
  suppressAutoScrollUntilRef: MutableRefObject<number>;
  markProgrammaticScroll: (side: 'left' | 'right', duration?: number) => void;
  isUserScrollPaused: () => boolean;
  isAutoScrollSuppressed: () => boolean;
  handlePaneScroll: (source: 'left' | 'right') => void;
  restoreViewport: () => boolean;
}

export function useWorkbookHorizontalViewportSync({
  active,
  leftScrollRef,
  rightScrollRef,
  activeSheetName,
  activeRegionId,
  expandedBlocks,
  isExpandedBlocksContextSettled,
  onExpandedBlocksChange,
  layoutSnapshot = null,
  onLayoutSnapshotChange,
  splitRatio,
  defaultSplitRatio,
  restoreSplitRatio,
  selectedCell,
  diffIdentity,
  syncScrollPosition,
  onResetViewportState,
}: UseWorkbookHorizontalViewportSyncParams): UseWorkbookHorizontalViewportSyncResult {
  const snapshotEmitRafRef = useRef(0);
  const snapshotEmitTimeoutRef = useRef<number | null>(null);
  const lastRestoredSnapshotKeyRef = useRef('');
  const lastViewportSheetNameRef = useRef<string | null>(activeSheetName);
  const userScrollPauseUntilRef = useRef(0);
  const programmaticScrollUntilRef = useRef<{ left: number; right: number }>({ left: 0, right: 0 });
  const lastAutoRowKeyRef = useRef('');
  const lastAutoCellKeyRef = useRef('');
  const suppressAutoScrollUntilRef = useRef(0);

  const markProgrammaticScroll = useCallback((side: 'left' | 'right', duration = 320) => {
    programmaticScrollUntilRef.current[side] = Math.max(programmaticScrollUntilRef.current[side], getNow() + duration);
  }, []);

  const isUserScrollPaused = useCallback(
    () => getNow() < userScrollPauseUntilRef.current,
    [],
  );

  const isAutoScrollSuppressed = useCallback(
    () => getNow() < suppressAutoScrollUntilRef.current,
    [],
  );

  const readSnapshotScrollState = useCallback(() => ({
    leftScrollTop: leftScrollRef.current?.scrollTop ?? 0,
    leftScrollLeft: leftScrollRef.current?.scrollLeft ?? 0,
    rightScrollTop: rightScrollRef.current?.scrollTop ?? 0,
    rightScrollLeft: rightScrollRef.current?.scrollLeft ?? 0,
  }), [leftScrollRef, rightScrollRef]);

  const emitLayoutSnapshot = useCallback(() => {
    if (!active || !isExpandedBlocksContextSettled || !onLayoutSnapshotChange) return;
    const scrollState = readSnapshotScrollState();
    const snapshot = buildWorkbookHorizontalLayoutSnapshot(
      activeSheetName,
      activeRegionId,
      scrollState.leftScrollTop,
      scrollState.leftScrollLeft,
      scrollState.rightScrollTop,
      scrollState.rightScrollLeft,
      splitRatio,
      expandedBlocks,
    );
    lastRestoredSnapshotKeyRef.current = [
      snapshot.layout,
      snapshot.activeRegionId,
      snapshot.sheetName,
      snapshot.leftScrollTop,
      snapshot.leftScrollLeft,
      snapshot.rightScrollTop,
      snapshot.rightScrollLeft,
      snapshot.splitRatio ?? '',
    ].join(':');
    onLayoutSnapshotChange(snapshot);
  }, [
    active,
    activeRegionId,
    activeSheetName,
    expandedBlocks,
    isExpandedBlocksContextSettled,
    onLayoutSnapshotChange,
    readSnapshotScrollState,
    splitRatio,
  ]);

  const emitLayoutSnapshotRef = useRef(emitLayoutSnapshot);
  emitLayoutSnapshotRef.current = emitLayoutSnapshot;

  const scheduleLayoutSnapshot = useCallback((priority: 'frame' | 'deferred' = 'frame') => {
    if (priority === 'deferred') {
      if (snapshotEmitRafRef.current) return;
      if (snapshotEmitTimeoutRef.current != null) {
        window.clearTimeout(snapshotEmitTimeoutRef.current);
      }
      snapshotEmitTimeoutRef.current = window.setTimeout(() => {
        snapshotEmitTimeoutRef.current = null;
        emitLayoutSnapshotRef.current();
      }, 120);
      return;
    }

    if (snapshotEmitTimeoutRef.current != null) {
      window.clearTimeout(snapshotEmitTimeoutRef.current);
      snapshotEmitTimeoutRef.current = null;
    }
    if (snapshotEmitRafRef.current) return;
    snapshotEmitRafRef.current = requestAnimationFrame(() => {
      snapshotEmitRafRef.current = 0;
      emitLayoutSnapshotRef.current();
    });
  }, []);

  const handlePaneScroll = useCallback((source: 'left' | 'right') => {
    const now = getNow();
    const isProgrammaticTargetScroll = now < programmaticScrollUntilRef.current[source];
    if (!isProgrammaticTargetScroll) {
      userScrollPauseUntilRef.current = now + 260;
    }
    syncScrollPosition(source);
    if (isProgrammaticTargetScroll) return;
    scheduleLayoutSnapshot('deferred');
  }, [scheduleLayoutSnapshot, syncScrollPosition]);

  useEffect(() => {
    const left = leftScrollRef.current;
    const right = rightScrollRef.current;
    if (!left || !right) return;
    const handleScrollEnd = () => scheduleLayoutSnapshot('frame');
    left.addEventListener('scrollend', handleScrollEnd);
    right.addEventListener('scrollend', handleScrollEnd);
    return () => {
      left.removeEventListener('scrollend', handleScrollEnd);
      right.removeEventListener('scrollend', handleScrollEnd);
    };
  }, [leftScrollRef, rightScrollRef, scheduleLayoutSnapshot]);

  useEffect(() => {
    scheduleLayoutSnapshot();
  }, [scheduleLayoutSnapshot, splitRatio]);

  useLayoutEffect(() => {
    const previousSheetName = lastViewportSheetNameRef.current;
    lastViewportSheetNameRef.current = activeSheetName;

    if (!previousSheetName || !activeSheetName || previousSheetName === activeSheetName) return;

    if (snapshotEmitRafRef.current) {
      cancelAnimationFrame(snapshotEmitRafRef.current);
      snapshotEmitRafRef.current = 0;
    }
    if (snapshotEmitTimeoutRef.current != null) {
      window.clearTimeout(snapshotEmitTimeoutRef.current);
      snapshotEmitTimeoutRef.current = null;
    }

    lastRestoredSnapshotKeyRef.current = '';
    suppressAutoScrollUntilRef.current = Math.max(suppressAutoScrollUntilRef.current, getNow() + 520);
    userScrollPauseUntilRef.current = Math.max(userScrollPauseUntilRef.current, getNow() + 520);
    markProgrammaticScroll('left', 520);
    markProgrammaticScroll('right', 520);
    onResetViewportState?.();
    if (leftScrollRef.current) scrollElementForNavigation(leftScrollRef.current, { top: 0, left: 0, behavior: 'auto' });
    if (rightScrollRef.current) scrollElementForNavigation(rightScrollRef.current, { top: 0, left: 0, behavior: 'auto' });
  }, [activeSheetName, leftScrollRef, markProgrammaticScroll, onResetViewportState, rightScrollRef]);

  useEffect(() => {
    if (!isExpandedBlocksContextSettled) return;
    scheduleLayoutSnapshot();
  }, [activeRegionId, activeSheetName, expandedBlocks, isExpandedBlocksContextSettled, scheduleLayoutSnapshot]);

  useEffect(() => {
    if (!active || !onExpandedBlocksChange) return;
    if (!isExpandedBlocksContextSettled) return;
    onExpandedBlocksChange(
      activeSheetName,
      activeRegionId,
      expandedBlocks,
    );
  }, [active, activeRegionId, activeSheetName, expandedBlocks, isExpandedBlocksContextSettled, onExpandedBlocksChange]);

  const restoreViewport = useCallback(() => {
    if (!active || !isExpandedBlocksContextSettled) return false;
    if (!layoutSnapshot || !shouldRestoreWorkbookLayoutSnapshot(
      layoutSnapshot,
      activeRegionId,
      activeSheetName,
    )) {
      lastRestoredSnapshotKeyRef.current = '';
      return false;
    }

    const left = leftScrollRef.current;
    const right = rightScrollRef.current;
    if (!left || !right) return false;
    const snapshot = layoutSnapshot;

    const restoreKey = [
      snapshot.layout,
      snapshot.activeRegionId,
      snapshot.sheetName,
      snapshot.leftScrollTop,
      snapshot.leftScrollLeft,
      snapshot.rightScrollTop,
      snapshot.rightScrollLeft,
      snapshot.splitRatio ?? '',
    ].join(':');
    if (lastRestoredSnapshotKeyRef.current === restoreKey) return false;
    const targetSplitRatio = restoreSplitRatio(snapshot.splitRatio ?? defaultSplitRatio);
    if (Math.abs(splitRatio - targetSplitRatio) >= 0.001) return false;
    if (snapshotEmitTimeoutRef.current != null) {
      window.clearTimeout(snapshotEmitTimeoutRef.current);
      snapshotEmitTimeoutRef.current = null;
    }
    suppressAutoScrollUntilRef.current = getNow() + 520;
    if (selectedCell && selectedCell.sheetName === activeSheetName && activeSheetName) {
      const selectionKey = buildSelectionAutoScrollKey(activeSheetName, selectedCell);
      if (selectedCell.kind !== 'column') lastAutoRowKeyRef.current = selectionKey;
      if (selectedCell.kind !== 'row') lastAutoCellKeyRef.current = selectionKey;
    }
    markProgrammaticScroll('left', 420);
    markProgrammaticScroll('right', 420);
    scrollElementForNavigation(left, { top: snapshot.leftScrollTop, left: snapshot.leftScrollLeft, behavior: 'auto' });
    scrollElementForNavigation(right, { top: snapshot.rightScrollTop, left: snapshot.rightScrollLeft, behavior: 'auto' });
    lastRestoredSnapshotKeyRef.current = restoreKey;
    return true;
  }, [
    active,
    activeRegionId,
    activeSheetName,
    isExpandedBlocksContextSettled,
    layoutSnapshot,
    leftScrollRef,
    markProgrammaticScroll,
    defaultSplitRatio,
    restoreSplitRatio,
    rightScrollRef,
    selectedCell,
    splitRatio,
  ]);

  useEffect(() => () => {
    if (snapshotEmitRafRef.current) cancelAnimationFrame(snapshotEmitRafRef.current);
    if (snapshotEmitTimeoutRef.current != null) window.clearTimeout(snapshotEmitTimeoutRef.current);
  }, []);

  useLayoutEffect(() => {
    lastAutoRowKeyRef.current = '';
    lastAutoCellKeyRef.current = '';
  }, [activeSheetName, diffIdentity]);

  return {
    userScrollPauseUntilRef,
    programmaticScrollUntilRef,
    lastAutoRowKeyRef,
    lastAutoCellKeyRef,
    suppressAutoScrollUntilRef,
    markProgrammaticScroll,
    isUserScrollPaused,
    isAutoScrollSuppressed,
    handlePaneScroll,
    restoreViewport,
  };
}
