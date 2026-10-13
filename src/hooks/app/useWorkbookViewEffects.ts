import { useEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import type {
  DiffLine,
  Hunk,
  SearchMatch,
  WorkbookDiffRegion,
  WorkbookSelectedCell,
} from '@/types';
import { workbookDiffRegionContainsSelection } from '@/utils/workbook/workbookDiffRegion';
import { revealWorkbookSelection } from '@/utils/workbook/workbookManualVisibility';
import { createWorkbookSelectionState } from '@/utils/workbook/workbookSelectionState';
import {
  buildWorkbookLineSheetContextLookup,
  type WorkbookSection,
} from '@/utils/workbook/workbookSections';
import {
  resolveWorkbookNavigationSheetSyncRequest,
  resolveWorkbookSearchSheetSyncRequest,
} from '@/utils/workbook/workbookSheetSync';
import type { WorkbookUiController } from '@/hooks/app/contracts';

interface UseWorkbookViewEffectsArgs {
  restoredNavigation: { hunkIdx: number; searchJumpNonce: number; activeSearchIdx: number; guidedPulseNonce: number } | null;
  guidedPulseNonce: number;
  navigationCount: number;
  setHunkIdx: Dispatch<SetStateAction<number>>;
  workbookSections: WorkbookSection[];
  workbookUi: WorkbookUiController;
  isWorkbookMode: boolean;
  selectedCell: WorkbookSelectedCell | null;
  activeSearchIdx: number;
  searchJumpNonce: number;
  searchMatches: SearchMatch[];
  activeWorkbookDiffRegion: WorkbookDiffRegion | null;
  hunkPositions: number[];
  hunkIdx: number;
  activeWorkbookTargetCell: WorkbookSelectedCell | null;
  hunks: Hunk[];
  scrollToIndexRef: MutableRefObject<((idx: number, align?: 'start' | 'center') => void) | null>;
  diffLines: DiffLine[];
}

export default function useWorkbookViewEffects({
  restoredNavigation,
  guidedPulseNonce,
  navigationCount,
  setHunkIdx,
  workbookSections,
  workbookUi,
  isWorkbookMode,
  selectedCell,
  activeSearchIdx,
  searchJumpNonce,
  searchMatches,
  activeWorkbookDiffRegion,
  hunkPositions,
  hunkIdx,
  activeWorkbookTargetCell,
  hunks,
  scrollToIndexRef,
  diffLines,
}: UseWorkbookViewEffectsArgs) {
  const {
    actions: {
      setActiveSheetName: setActiveWorkbookSheetName,
      setSelection: setWorkbookSelection,
      setHiddenStateBySheet: setWorkbookHiddenStateBySheet,
      setContextMenu: setWorkbookContextMenu,
    },
  } = workbookUi;
  const lineSheetContextLookup = useMemo(
    () => buildWorkbookLineSheetContextLookup(diffLines),
    [diffLines],
  );
  const preferredSheetNameRef = useRef<string | null>(selectedCell?.sheetName ?? null);
  const lastSearchSheetSyncKeyRef = useRef('');
  const lastNavigationSheetSyncKeyRef = useRef('');
  const preserveRestoredNavigation = restoredNavigation?.hunkIdx === hunkIdx
    && restoredNavigation.searchJumpNonce === searchJumpNonce
    && restoredNavigation.activeSearchIdx === activeSearchIdx
    && restoredNavigation.guidedPulseNonce === guidedPulseNonce;

  useEffect(() => {
    preferredSheetNameRef.current = selectedCell?.sheetName ?? null;
  }, [selectedCell?.sheetName]);

  useEffect(() => {
    lastSearchSheetSyncKeyRef.current = '';
    lastNavigationSheetSyncKeyRef.current = '';
  }, [diffLines, workbookSections]);

  const activeSearchRevealSelection = useMemo<WorkbookSelectedCell | null>(() => {
    if (!isWorkbookMode || activeSearchIdx < 0) return null;
    const target = searchMatches[activeSearchIdx]?.workbookTarget;
    if (!target?.sheetName || (target.rowNumber == null && target.colIndex == null)) return null;

    return {
      kind: target.rowNumber != null
        ? (target.colIndex != null ? 'cell' : 'row')
        : 'column',
      sheetName: target.sheetName,
      side: target.side ?? selectedCell?.side ?? 'mine',
      versionLabel: '',
      rowNumber: target.rowNumber ?? 0,
      colIndex: target.colIndex ?? -1,
      colLabel: '',
      address: '',
      value: '',
      formula: '',
    };
  }, [activeSearchIdx, isWorkbookMode, searchMatches, selectedCell?.side]);

  useEffect(() => {
    setHunkIdx((prev) => {
      if (navigationCount <= 0) return 0;
      return Math.min(prev, navigationCount - 1);
    });
  }, [navigationCount, setHunkIdx]);

  useEffect(() => {
    if (workbookSections.length === 0) {
      setActiveWorkbookSheetName(null);
      return;
    }

    setActiveWorkbookSheetName((prev) => {
      if (prev && workbookSections.some((section) => section.name === prev)) {
        return prev;
      }
      return workbookSections[0]?.name ?? null;
    });
  }, [setActiveWorkbookSheetName, workbookSections]);

  useEffect(() => {
    if (!isWorkbookMode || !selectedCell?.sheetName) return;
    setActiveWorkbookSheetName((prev) => (prev === selectedCell.sheetName ? prev : selectedCell.sheetName));
  }, [isWorkbookMode, selectedCell?.sheetName, setActiveWorkbookSheetName]);

  useEffect(() => {
    if (preserveRestoredNavigation) return;
    const syncRequest = resolveWorkbookSearchSheetSyncRequest({
      isWorkbookMode,
      activeSearchIdx,
      searchJumpNonce,
      searchMatches,
      diffLines,
      lineSheetContextLookup,
      preferredSheetName: preferredSheetNameRef.current,
      fallbackSheetName: activeWorkbookDiffRegion?.sheetName ?? null,
    });
    if (!syncRequest) return;
    if (lastSearchSheetSyncKeyRef.current === syncRequest.eventKey) return;
    lastSearchSheetSyncKeyRef.current = syncRequest.eventKey;
    setActiveWorkbookSheetName((prev) => (prev === syncRequest.sheetName ? prev : syncRequest.sheetName));
  }, [activeSearchIdx, activeWorkbookDiffRegion?.sheetName, diffLines, isWorkbookMode, lineSheetContextLookup, preserveRestoredNavigation, searchJumpNonce, searchMatches, setActiveWorkbookSheetName]);

  useEffect(() => {
    if (preserveRestoredNavigation) return;
    if (!activeSearchRevealSelection) return;
    setWorkbookHiddenStateBySheet((prev) => revealWorkbookSelection(prev, activeSearchRevealSelection));
    setWorkbookContextMenu(null);
  }, [activeSearchRevealSelection, preserveRestoredNavigation, searchJumpNonce, setWorkbookContextMenu, setWorkbookHiddenStateBySheet]);

  useEffect(() => {
    if (preserveRestoredNavigation) return;
    const syncRequest = resolveWorkbookNavigationSheetSyncRequest({
      isWorkbookMode,
      activeSearchIdx,
      searchMatches,
      activeWorkbookDiffRegion,
      hunkIdx,
      hunkPositions,
      diffLines,
      lineSheetContextLookup,
      preferredSheetName: preferredSheetNameRef.current,
    });
    if (!syncRequest) return;
    if (lastNavigationSheetSyncKeyRef.current === syncRequest.eventKey) return;
    lastNavigationSheetSyncKeyRef.current = syncRequest.eventKey;
    setActiveWorkbookSheetName((prev) => (prev === syncRequest.sheetName ? prev : syncRequest.sheetName));
  }, [
    activeSearchIdx,
    activeWorkbookDiffRegion,
    diffLines,
    hunkIdx,
    hunkPositions,
    isWorkbookMode,
    lineSheetContextLookup,
    preserveRestoredNavigation,
    searchMatches,
    setActiveWorkbookSheetName,
  ]);

  useEffect(() => {
    if (preserveRestoredNavigation) return;
    if (isWorkbookMode) {
      if (activeWorkbookDiffRegion) {
        setWorkbookSelection((prev) => {
          if (workbookDiffRegionContainsSelection(activeWorkbookDiffRegion, prev.primary)) {
            return prev;
          }
          return prev.primary ? createWorkbookSelectionState(null) : prev;
        });
      }

      const targetCell = activeWorkbookTargetCell;
      if (targetCell) {
        setActiveWorkbookSheetName((prev) => (prev === targetCell.sheetName ? prev : targetCell.sheetName));
        setWorkbookHiddenStateBySheet((prev) => revealWorkbookSelection(prev, targetCell));
        setWorkbookContextMenu(null);
      }
      return;
    }

    let raf2 = 0;
    const targetHunk = hunks[hunkIdx];
    if (!targetHunk) return;
    const targetLineIdx = targetHunk.startIdx;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        scrollToIndexRef.current?.(targetLineIdx, 'center');
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [
    activeWorkbookDiffRegion,
    activeWorkbookTargetCell,
    hunkIdx,
    hunks,
    isWorkbookMode,
    preserveRestoredNavigation,
    scrollToIndexRef,
    setActiveWorkbookSheetName,
    setWorkbookContextMenu,
    setWorkbookHiddenStateBySheet,
    setWorkbookSelection,
  ]);

}
