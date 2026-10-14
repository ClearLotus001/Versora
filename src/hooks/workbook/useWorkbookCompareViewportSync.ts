import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from 'react';

import type {
  WorkbookCompareLayoutSnapshot,
  WorkbookSelectedCell,
} from '@/types';
import type { CollapseExpansionState } from '@/utils/collapse/collapseState';
import {
  scrollElementForNavigation,
} from '@/utils/navigation/animatedScroll';
import {
  buildWorkbookCompareLayoutSnapshot,
  shouldRestoreWorkbookLayoutSnapshot,
} from '@/utils/workbook/workbookLayoutSnapshot';
import {
  buildSelectionAutoScrollKey,
  type SelectionAutoScrollLock,
} from '@/utils/workbook/workbookPanelHelpers';

function getNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

interface UseWorkbookCompareViewportSyncParams {
  active: boolean;
  mode: 'stacked' | 'columns';
  scrollRef: RefObject<HTMLDivElement | null>;
  activeSheetName: string | null;
  activeRegionId: string | null;
  expandedBlocks: CollapseExpansionState;
  isExpandedBlocksContextSettled: boolean;
  onExpandedBlocksChange?: ((sheetName: string | null, activeRegionId: string | null, expandedBlocks: CollapseExpansionState) => void) | undefined;
  layoutSnapshot?: WorkbookCompareLayoutSnapshot | null;
  onLayoutSnapshotChange?: ((snapshot: WorkbookCompareLayoutSnapshot) => void) | undefined;
  activeHunkIdx: number;
  selectedCell: WorkbookSelectedCell | null;
  diffIdentity: unknown;
  onResetViewportState?: (() => void) | undefined;
}

interface UseWorkbookCompareViewportSyncResult {
  selectionAutoScrollLockRef: MutableRefObject<SelectionAutoScrollLock | null>;
  userScrollPauseUntilRef: MutableRefObject<number>;
  programmaticScrollUntilRef: MutableRefObject<number>;
  lastAutoRowKeyRef: MutableRefObject<string>;
  lastAutoCellKeyRef: MutableRefObject<string>;
  lastForcedRevealHunkIdxRef: MutableRefObject<number>;
  suppressAutoScrollUntilRef: MutableRefObject<number>;
  markProgrammaticScroll: (duration?: number) => void;
  isUserScrollPaused: () => boolean;
  isAutoScrollSuppressed: () => boolean;
  isSelectionAutoScrollLocked: (selectionKey: string, target: 'row' | 'cell') => boolean;
  restoreViewport: () => boolean;
}

export function useWorkbookCompareViewportSync({
  active,
  mode,
  scrollRef,
  activeSheetName,
  activeRegionId,
  expandedBlocks,
  isExpandedBlocksContextSettled,
  onExpandedBlocksChange,
  layoutSnapshot = null,
  onLayoutSnapshotChange,
  activeHunkIdx,
  selectedCell,
  diffIdentity,
  onResetViewportState,
}: UseWorkbookCompareViewportSyncParams): UseWorkbookCompareViewportSyncResult {
  const selectionAutoScrollLockRef = useRef<SelectionAutoScrollLock | null>(null);
  const snapshotEmitRafRef = useRef(0);
  const snapshotEmitTimeoutRef = useRef<number | null>(null);
  const lastRestoredSnapshotKeyRef = useRef('');
  const lastViewportSheetNameRef = useRef<string | null>(activeSheetName);
  const userScrollPauseUntilRef = useRef(0);
  const programmaticScrollUntilRef = useRef(0);
  const lastAutoRowKeyRef = useRef('');
  const lastAutoCellKeyRef = useRef('');
  const lastForcedRevealHunkIdxRef = useRef(-1);
  const suppressAutoScrollUntilRef = useRef(0);

  const markProgrammaticScroll = useCallback((duration = 320) => {
    programmaticScrollUntilRef.current = Math.max(programmaticScrollUntilRef.current, getNow() + duration);
  }, []);

  const isUserScrollPaused = useCallback(
    () => getNow() < userScrollPauseUntilRef.current,
    [],
  );

  const isAutoScrollSuppressed = useCallback(
    () => getNow() < suppressAutoScrollUntilRef.current,
    [],
  );

  const emitLayoutSnapshot = useCallback(() => {
    if (!active || !isExpandedBlocksContextSettled || !onLayoutSnapshotChange) return;
    const container = scrollRef.current;
    const snapshot = buildWorkbookCompareLayoutSnapshot(
      mode === 'stacked' ? 'unified' : 'split-v',
      activeSheetName,
      activeRegionId,
      container?.scrollTop ?? 0,
      container?.scrollLeft ?? 0,
      expandedBlocks,
    );
    lastRestoredSnapshotKeyRef.current = [
      snapshot.layout,
      snapshot.activeRegionId,
      snapshot.sheetName,
      snapshot.scrollTop,
      snapshot.scrollLeft,
    ].join(':');
    onLayoutSnapshotChange(snapshot);
  }, [active, activeRegionId, activeSheetName, expandedBlocks, isExpandedBlocksContextSettled, mode, onLayoutSnapshotChange, scrollRef]);

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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      scheduleLayoutSnapshot('deferred');
      const now = getNow();
      if (now < programmaticScrollUntilRef.current) return;
      userScrollPauseUntilRef.current = now + 260;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (snapshotEmitRafRef.current) cancelAnimationFrame(snapshotEmitRafRef.current);
      if (snapshotEmitTimeoutRef.current != null) window.clearTimeout(snapshotEmitTimeoutRef.current);
    };
  }, [scheduleLayoutSnapshot, scrollRef]);

  useLayoutEffect(() => {
    const previousSheetName = lastViewportSheetNameRef.current;
    lastViewportSheetNameRef.current = activeSheetName;

    if (!previousSheetName || !activeSheetName || previousSheetName === activeSheetName) return;

    const container = scrollRef.current;
    if (!container) return;

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
    markProgrammaticScroll(520);
    onResetViewportState?.();
    scrollElementForNavigation(container, { top: 0, left: 0, behavior: 'auto' });
  }, [activeSheetName, markProgrammaticScroll, onResetViewportState, scrollRef]);

  useEffect(() => {
    if (!isExpandedBlocksContextSettled) return;
    scheduleLayoutSnapshot();
  }, [expandedBlocks, isExpandedBlocksContextSettled, scheduleLayoutSnapshot]);

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
    scheduleLayoutSnapshot();
  }, [activeRegionId, activeSheetName, scheduleLayoutSnapshot]);

  const restoreViewport = useCallback(() => {
    const container = scrollRef.current;
    if (!active || !container || !isExpandedBlocksContextSettled) return false;
    if (!layoutSnapshot || !shouldRestoreWorkbookLayoutSnapshot(
      layoutSnapshot,
      activeRegionId,
      activeSheetName,
    )) {
      lastRestoredSnapshotKeyRef.current = '';
      return false;
    }
    const snapshot = layoutSnapshot;

    const restoreKey = [
      snapshot.layout,
      snapshot.activeRegionId,
      snapshot.sheetName,
      snapshot.scrollTop,
      snapshot.scrollLeft,
    ].join(':');
    if (lastRestoredSnapshotKeyRef.current === restoreKey) return false;
    if (snapshotEmitTimeoutRef.current != null) {
      window.clearTimeout(snapshotEmitTimeoutRef.current);
      snapshotEmitTimeoutRef.current = null;
    }
    suppressAutoScrollUntilRef.current = getNow() + 520;
    lastForcedRevealHunkIdxRef.current = activeHunkIdx;
    if (selectedCell && selectedCell.sheetName === activeSheetName && activeSheetName) {
      const selectionKey = buildSelectionAutoScrollKey(activeSheetName, selectedCell);
      selectionAutoScrollLockRef.current = {
        sheetName: activeSheetName,
        hunkIdx: activeHunkIdx,
        rowKey: selectedCell.kind !== 'column' ? selectionKey : '',
        cellKey: selectedCell.kind !== 'row' ? selectionKey : '',
      };
      if (selectedCell.kind !== 'column') lastAutoRowKeyRef.current = selectionKey;
      if (selectedCell.kind !== 'row') lastAutoCellKeyRef.current = selectionKey;
    }
    markProgrammaticScroll(420);
    scrollElementForNavigation(container, { top: snapshot.scrollTop, left: snapshot.scrollLeft, behavior: 'auto' });
    lastRestoredSnapshotKeyRef.current = restoreKey;
    return true;
  }, [
    active,
    activeHunkIdx,
    activeRegionId,
    activeSheetName,
    isExpandedBlocksContextSettled,
    layoutSnapshot,
    markProgrammaticScroll,
    scrollRef,
    selectedCell,
  ]);

  useLayoutEffect(() => {
    lastAutoRowKeyRef.current = '';
    lastAutoCellKeyRef.current = '';
    lastForcedRevealHunkIdxRef.current = -1;
    selectionAutoScrollLockRef.current = null;
  }, [activeSheetName, diffIdentity]);

  const isSelectionAutoScrollLocked = useCallback((selectionKey: string, target: 'row' | 'cell') => {
    const lock = selectionAutoScrollLockRef.current;
    if (!lock) return false;
    if (lock.sheetName !== (activeSheetName ?? '')) return false;
    if (lock.hunkIdx !== activeHunkIdx) return false;
    return target === 'row' ? lock.rowKey === selectionKey : lock.cellKey === selectionKey;
  }, [activeHunkIdx, activeSheetName]);

  return {
    selectionAutoScrollLockRef,
    userScrollPauseUntilRef,
    programmaticScrollUntilRef,
    lastAutoRowKeyRef,
    lastAutoCellKeyRef,
    lastForcedRevealHunkIdxRef,
    suppressAutoScrollUntilRef,
    markProgrammaticScroll,
    isUserScrollPaused,
    isAutoScrollSuppressed,
    isSelectionAutoScrollLocked,
    restoreViewport,
  };
}
