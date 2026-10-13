import { getActiveWorkbookArtifactProvider } from '@/utils/workbook/workbookArtifactProvider';
import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

import type {
  DiffData,
  DiffPerformanceMetrics,
  LayoutMode,
  SearchMatch,
  TextLineSelectionSummary,
  WorkbookCompareMode,
  WorkbookDiffRegion,
} from '@/types';
import type { LoadPhase } from '@/hooks/app/types';
import { debugLog } from '@/hooks/app/helpers';
import {
  buildE2EDiffData,
  buildE2EWorkbookDiffData,
  shouldEnableE2EBridge,
} from '@/utils/app/e2eBridge';
import {
  clearPerfBridgeEvents,
  getPerfBridgeEvents,
  recordPerfBridgeEvent,
  shouldEnablePerfBridge,
} from '@/utils/app/perfBridge';
import { getWorkbookSideRowNumber } from '@/utils/workbook/workbookNavigation';
import type { WorkbookSectionRowIndex } from '@/utils/workbook/workbookSheetIndex';
import type { WorkbookSection } from '@/utils/workbook/workbookSections';
import {
  setWorkbookDebugEnabled,
  workbookDebugLog,
} from '@/utils/workbook/workbookDebug';

interface UseAppRuntimeEffectsArgs {
  restoredNavigation: { searchJumpNonce: number; activeSearchIdx: number } | null;
  onOpenComparison: (data: DiffData) => void;
  applyDiffData: (data: DiffData) => Promise<void>;
  displayFileName: string;
  hasLoadedDiff: boolean;
  isDevMode: boolean;
  isElectron: boolean;
  isLoadingDiff: boolean;
  isWorkbookMode: boolean;
  layout: LayoutMode;
  loadPhase: LoadPhase;
  loadPerfMetrics: DiffPerformanceMetrics | null;
  setCollapseCtx: Dispatch<SetStateAction<boolean>>;
  setShowOnlyDifferences: Dispatch<SetStateAction<boolean>>;
  setLayout: Dispatch<SetStateAction<LayoutMode>>;
  activeSearchIdx: number;
  searchJumpNonce: number;
  searchMatches: SearchMatch[];
  scrollToIndexRef: MutableRefObject<((idx: number, align?: 'start' | 'center') => void) | null>;
  setTextLineSelectionSummary: Dispatch<SetStateAction<TextLineSelectionSummary | null>>;
  activeWorkbookDiffRegion: WorkbookDiffRegion | null;
  activeWorkbookSheetName: string | null;
  workbookCompareMode: WorkbookCompareMode;
  workbookSectionRowIndex: WorkbookSectionRowIndex;
  workbookSections: WorkbookSection[];
}

export default function useAppRuntimeEffects({
  restoredNavigation,
  onOpenComparison,
  applyDiffData,
  displayFileName,
  hasLoadedDiff,
  isDevMode,
  isElectron,
  isLoadingDiff,
  isWorkbookMode,
  layout,
  loadPhase,
  loadPerfMetrics,
  setCollapseCtx,
  setShowOnlyDifferences,
  setLayout,
  activeSearchIdx,
  searchJumpNonce,
  searchMatches,
  scrollToIndexRef,
  setTextLineSelectionSummary,
  activeWorkbookDiffRegion,
  activeWorkbookSheetName,
  workbookCompareMode,
  workbookSectionRowIndex,
  workbookSections,
}: UseAppRuntimeEffectsArgs) {
  const activeArtifactProvider = getActiveWorkbookArtifactProvider();
  const perfViewReadyTokenRef = useRef(0);
  const perfLastReadySignatureRef = useRef('');

  useEffect(() => {
    if (isWorkbookMode || !hasLoadedDiff) {
      setTextLineSelectionSummary(null);
    }
  }, [hasLoadedDiff, isWorkbookMode, setTextLineSelectionSummary]);

  useEffect(() => {
    debugLog('app-load-state', {
      loadPhase,
      hasLoadedDiff,
      isLoadingDiff,
      isElectron,
      isWorkbookMode,
      fileName: displayFileName,
    });
  }, [displayFileName, hasLoadedDiff, isElectron, isLoadingDiff, isWorkbookMode, loadPhase]);

  useEffect(() => {
    if (!shouldEnableE2EBridge()) return undefined;

    window.__SVN_DIFF_E2E__ = {
      loadTextDiff: async (payload) => {
        const data = buildE2EDiffData(payload);
        onOpenComparison(data);
        if (payload.layout) setLayout(payload.layout);
        if (typeof payload.collapseCtx === 'boolean') setCollapseCtx(payload.collapseCtx);
        await applyDiffData(data);
      },
      loadWorkbookDiff: async (payload) => {
        const data = buildE2EWorkbookDiffData(payload);
        onOpenComparison(data);
        if (payload.layout) setLayout(payload.layout);
        if (typeof payload.collapseCtx === 'boolean') setCollapseCtx(payload.collapseCtx);
        setShowOnlyDifferences(payload.showOnlyDifferences ?? false);
        await applyDiffData(data);
      },
      getSnapshot: () => ({
        hasLoadedDiff,
        layout,
        isWorkbookMode,
        fileName: displayFileName,
      }),
    };

    return () => {
      delete window.__SVN_DIFF_E2E__;
    };
  }, [
    applyDiffData,
    onOpenComparison,
    displayFileName,
    hasLoadedDiff,
    isWorkbookMode,
    layout,
    setCollapseCtx,
    setLayout,
    setShowOnlyDifferences,
  ]);

  useEffect(() => {
    if (!shouldEnablePerfBridge()) return undefined;

    window.__SVN_DIFF_PERF__ = {
      getSnapshot: () => ({
        hasLoadedDiff,
        isLoadingDiff,
        loadPhase,
        layout,
        isWorkbookMode,
        compareMode: workbookCompareMode,
        fileName: displayFileName,
        activeWorkbookSheetName,
        viewReadyToken: perfViewReadyTokenRef.current,
        loadPerfMetrics,
        ...(getActiveWorkbookArtifactProvider() ? { workbookArtifact: getActiveWorkbookArtifactProvider()!.getPerfSummary() } : {}),
      }),
      readCells: async (request) => {
        const provider = getActiveWorkbookArtifactProvider();
        if (!provider) throw new Error('No active workbook artifact');
        return provider.readCell(request);
      },
      getEvents: () => getPerfBridgeEvents(),
      clearEvents: () => clearPerfBridgeEvents(),
    };

    return () => {
      delete window.__SVN_DIFF_PERF__;
    };
  }, [
    activeWorkbookSheetName,
    displayFileName,
    hasLoadedDiff,
    isLoadingDiff,
    isWorkbookMode,
    layout,
    loadPerfMetrics,
    loadPhase,
    workbookCompareMode,
  ]);

  useEffect(() => {
    if (!shouldEnablePerfBridge()) return undefined;
    if (!hasLoadedDiff || isLoadingDiff || loadPhase !== 'ready') return undefined;
    const readySignature = JSON.stringify({
      artifactId: activeArtifactProvider?.descriptor.artifactId,
      fileName: displayFileName,
      layout,
      isWorkbookMode,
      compareMode: workbookCompareMode,
      activeWorkbookSheetName,
    });
    if (perfLastReadySignatureRef.current === readySignature) {
      return undefined;
    }

    let cancelled = false;
    let firstFrameId = 0;
    let secondFrameId = 0;
    const isArtifactReady = () => {
      if (!isWorkbookMode || !activeArtifactProvider || activeArtifactProvider.descriptor.rows.kinds.length === 0) return true;
      const cache = activeArtifactProvider.getCacheStats();
      return cache.windows > 0 && cache.pending === 0 && activeArtifactProvider.getErrorCount() === 0;
    };
    const scheduleReady = () => {
      cancelAnimationFrame(firstFrameId);
      cancelAnimationFrame(secondFrameId);
      if (cancelled || !isArtifactReady() || perfLastReadySignatureRef.current === readySignature) return;
      const revision = activeArtifactProvider?.getSnapshot();
      firstFrameId = requestAnimationFrame(() => {
        secondFrameId = requestAnimationFrame(() => {
        if (cancelled || !isArtifactReady() || activeArtifactProvider?.getSnapshot() !== revision) return;
        perfLastReadySignatureRef.current = readySignature;
        perfViewReadyTokenRef.current += 1;
        debugLog('view-ready', {
          fileName: displayFileName,
          layout,
          isWorkbookMode,
          compareMode: workbookCompareMode,
          activeWorkbookSheetName,
          viewReadyToken: perfViewReadyTokenRef.current,
        });
        recordPerfBridgeEvent('view-ready', {
          fileName: displayFileName,
          layout,
          isWorkbookMode,
          compareMode: workbookCompareMode,
          activeWorkbookSheetName,
          viewReadyToken: perfViewReadyTokenRef.current,
        });
        });
      });
    };
    // Cache notifications schedule readiness directly; they do not rerender the whole App.
    const unsubscribe = activeArtifactProvider?.subscribe(scheduleReady);
    scheduleReady();

    return () => {
      cancelled = true;
      cancelAnimationFrame(firstFrameId);
      cancelAnimationFrame(secondFrameId);
      unsubscribe?.();
    };
  }, [
    activeWorkbookSheetName,
    displayFileName,
    hasLoadedDiff,
    isLoadingDiff,
    isWorkbookMode,
    layout,
    loadPhase,
    workbookCompareMode,
    activeArtifactProvider,
  ]);

  useEffect(() => {
    if (isWorkbookMode) return;
    if (restoredNavigation?.searchJumpNonce === searchJumpNonce && restoredNavigation.activeSearchIdx === activeSearchIdx) return;
    if (activeSearchIdx < 0) return;
    const activeSearchMatch = searchMatches[activeSearchIdx] ?? null;
    if (!activeSearchMatch) return;

    const rafId = requestAnimationFrame(() => {
      scrollToIndexRef.current?.(activeSearchMatch.lineIdx, 'center');
    });

    return () => cancelAnimationFrame(rafId);
  }, [activeSearchIdx, isWorkbookMode, restoredNavigation, scrollToIndexRef, searchJumpNonce, searchMatches]);

  useEffect(() => {
    setWorkbookDebugEnabled(isDevMode);
  }, [isDevMode]);

  useEffect(() => {
    if (!isDevMode || !isWorkbookMode) return;
    const activeSheetName = activeWorkbookSheetName ?? workbookSections[0]?.name ?? null;
    if (!activeSheetName) return;

    const activeSectionRows = workbookSectionRowIndex.get(activeSheetName)?.rows ?? [];
    workbookDebugLog('app/workbook-sheet-state', {
      activeSheetName,
      compareMode: workbookCompareMode,
      sectionCount: workbookSections.length,
      activeSectionRowCount: activeSectionRows.length,
      activeSectionPreview: activeSectionRows.slice(0, 8).map((row) => ({
        lineIdx: row.lineIdx,
        lineIdxs: row.lineIdxs,
        leftRowNumber: getWorkbookSideRowNumber(row, 'base'),
        rightRowNumber: getWorkbookSideRowNumber(row, 'mine'),
        leftColumnCount: row.workbookArtifactRow?.provider.descriptor.rows.baseColumnCounts[row.lineIdx] ?? 0,
        rightColumnCount: row.workbookArtifactRow?.provider.descriptor.rows.mineColumnCounts[row.lineIdx] ?? 0,
        changedColumns: row.workbookRowDelta?.changedColumns ?? [],
      })),
      workbookSections: workbookSections.map((section) => ({
        name: section.name,
        changeType: section.changeType,
        startLineIdx: section.startLineIdx,
        endLineIdx: section.endLineIdx,
        maxColumns: section.maxColumns,
      })),
      activeDiffRegion: activeWorkbookDiffRegion
        ? {
            id: activeWorkbookDiffRegion.id,
            sheetName: activeWorkbookDiffRegion.sheetName,
            startRowIndex: activeWorkbookDiffRegion.startRowIndex,
            endRowIndex: activeWorkbookDiffRegion.endRowIndex,
            startCol: activeWorkbookDiffRegion.startCol,
            endCol: activeWorkbookDiffRegion.endCol,
          }
        : null,
    });
  }, [
    activeWorkbookDiffRegion,
    activeWorkbookSheetName,
    isDevMode,
    isWorkbookMode,
      workbookCompareMode,
    workbookSectionRowIndex,
    workbookSections,
  ]);
}
