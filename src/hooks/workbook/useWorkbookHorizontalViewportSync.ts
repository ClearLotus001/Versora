import {
  useCallback,
  useEffect,
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
  const restoreRafRef = useRef(0);
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
    if (!active || !onLayoutSnapshotChange) return;
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

  useEffect(() => {
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
    leftScrollRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    rightScrollRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [activeSheetName, leftScrollRef, markProgrammaticScroll, onResetViewportState, rightScrollRef]);

  useEffect(() => {
    const left = leftScrollRef.current;
    const right = rightScrollRef.current;
    if (!left || !right) return;

    let guardActive = true;
    let timerId: number | null = null;

    const guardScrollLeft = (element: HTMLDivElement) => {
      if (!guardActive) return;
      if (element.scrollLeft !== 0) {
        element.scrollLeft = 0;
      }
    };

    const onLeftScroll = () => guardScrollLeft(left);
    const onRightScroll = () => guardScrollLeft(right);

    const finishGuard = () => {
      guardActive = false;
      left.removeEventListener('scroll', onLeftScroll);
      right.removeEventListener('scroll', onRightScroll);
      window.removeEventListener('pointerdown', onUserInput, true);
      window.removeEventListener('keydown', onUserInput, true);
      window.removeEventListener('wheel', onUserInput, true);
      if (timerId != null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    const onUserInput = (event: Event) => {
      if (event.isTrusted) finishGuard();
    };

    left.addEventListener('scroll', onLeftScroll);
    right.addEventListener('scroll', onRightScroll);
    // Keep the initial viewport stable until the user acts. Capture input before
    // React handles toolbar navigation so its programmatic scroll is preserved.
    window.addEventListener('pointerdown', onUserInput, { capture: true, passive: true });
    window.addEventListener('keydown', onUserInput, true);
    window.addEventListener('wheel', onUserInput, { capture: true, passive: true });
    timerId = window.setTimeout(finishGuard, 500);

    return finishGuard;
  }, [leftScrollRef, rightScrollRef]);

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

  useEffect(() => {
    if (!active) return;
    if (!layoutSnapshot || !shouldRestoreWorkbookLayoutSnapshot(
      layoutSnapshot,
      activeRegionId,
      activeSheetName,
    )) {
      lastRestoredSnapshotKeyRef.current = '';
      return;
    }

    const left = leftScrollRef.current;
    const right = rightScrollRef.current;
    if (!left || !right) return;
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
    if (lastRestoredSnapshotKeyRef.current === restoreKey) return;
    lastRestoredSnapshotKeyRef.current = restoreKey;
    suppressAutoScrollUntilRef.current = getNow() + 520;
    restoreSplitRatio(snapshot.splitRatio ?? defaultSplitRatio);
    if (selectedCell && selectedCell.sheetName === activeSheetName && activeSheetName) {
      const selectionKey = buildSelectionAutoScrollKey(activeSheetName, selectedCell);
      if (selectedCell.kind !== 'column') lastAutoRowKeyRef.current = selectionKey;
      if (selectedCell.kind !== 'row') lastAutoCellKeyRef.current = selectionKey;
    }
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        markProgrammaticScroll('left', 420);
        markProgrammaticScroll('right', 420);
        left.scrollTop = snapshot.leftScrollTop;
        right.scrollTop = snapshot.rightScrollTop;
        left.scrollLeft = snapshot.leftScrollLeft;
        right.scrollLeft = snapshot.rightScrollLeft;
      });
      restoreRafRef.current = raf2;
    });

    return () => {
      cancelAnimationFrame(raf1);
      if (restoreRafRef.current) cancelAnimationFrame(restoreRafRef.current);
    };
  }, [
    active,
    activeRegionId,
    activeSheetName,
    layoutSnapshot,
    leftScrollRef,
    markProgrammaticScroll,
    defaultSplitRatio,
    restoreSplitRatio,
    rightScrollRef,
    selectedCell,
  ]);

  useEffect(() => () => {
    if (snapshotEmitRafRef.current) cancelAnimationFrame(snapshotEmitRafRef.current);
    if (snapshotEmitTimeoutRef.current != null) window.clearTimeout(snapshotEmitTimeoutRef.current);
    if (restoreRafRef.current) cancelAnimationFrame(restoreRafRef.current);
  }, []);

  useEffect(() => {
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
  };
}
