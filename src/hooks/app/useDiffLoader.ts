import { activateWorkbookArtifact, clearActiveWorkbookArtifact, resolveWorkbookArtifactView } from '@/utils/workbook/workbookArtifactProvider';
import { useCallback, useRef, type MutableRefObject } from 'react';

import type {
  DiffData,
  DiffLine,
  LocalDiffFilePickResult,
  LocalFilePickSide,
  SvnDiffViewerScope,
  WorkbookCompareMode,
} from '@/types';
import { EMPTY_COLLAPSE_EXPANSION_STATE, type CollapseExpansionState } from '@/utils/collapse/collapseState';
import { buildDiffCacheKey, buildDiffSessionKey } from '@/utils/diff/diffCacheKey';
import { attachLineBlameToDiffLines } from '@/utils/diff/lineBlame';
import { materializeCompactTransportDiffData } from '@/utils/diff/compactTextDiffLines';
import { createEmptyTextLayoutSnapshots, type TextLayoutSnapshotsByMode } from '@/utils/diff/textLayoutState';
import { isWorkbookFileName, resolveDiffTexts } from '@/utils/diff/diffSource';
import { computeTextDiffAsync, warmTextDiffWorker } from '@/utils/diff/computeTextDiffAsync';
import { disposeTextSearchWorker } from '@/utils/diff/computeSearchMatchesAsync';
import { createEmptyWorkbookLayoutSnapshots, type WorkbookLayoutSnapshotsByMode } from '@/utils/workbook/workbookLayoutState';
import { clearWorkbookCanvasBitmapCache } from '@/utils/workbook/workbookCanvasBitmapCache';
import { isWorkbookTextPair } from '@/engine/workbook/workbookDiff';
import { recordPerfBridgeEvent } from '@/utils/app/perfBridge';
import {
  debugLog,
  getNow,
  getPreparedDiffLinesForMode,
  getRevisionOptionsStatus,
  waitForNextPaint,
} from '@/hooks/app/helpers';
import type {
  CachedDiffResult,
} from '@/hooks/app/types';
import { buildCachedDiffResult, rememberCachedDiffResult } from '@/hooks/app/diffResultCache';
import type { DialogController, DiffLoadController, RevisionQueryController, WorkbookUiController } from '@/hooks/app/contracts';
import { useAppStore } from '@/store/appStore';

interface UseDiffLoaderArgs {
  onOpenComparison: (data: DiffData) => void;
  onBackgroundLineBlame: (data: DiffData, payload: import('@/types').LineBlamePayload) => void;
  loadSeqRef: MutableRefObject<number>;
  hasLoadedDiffRef: MutableRefObject<boolean>;
  workbookCompareModeRef: MutableRefObject<WorkbookCompareMode>;
  currentDiffDataRef: MutableRefObject<DiffData | null>;
  diffResultCacheRef: MutableRefObject<Map<string, CachedDiffResult>>;
  textLayoutSnapshotsRef: MutableRefObject<TextLayoutSnapshotsByMode>;
  textSharedExpandedBlocksRef: MutableRefObject<CollapseExpansionState>;
  workbookLayoutSnapshotsRef: MutableRefObject<WorkbookLayoutSnapshotsByMode>;
  workbookSharedExpandedBlocksRef: MutableRefObject<Map<string, CollapseExpansionState>>;
  revisionQuerySeqRef: MutableRefObject<number>;
  dialogs: DialogController;
  diffLoad: DiffLoadController;
  revisionQuery: RevisionQueryController;
  workbookUi: WorkbookUiController;
}

export interface UseDiffLoaderResult {
  beginDiffLoad: () => Promise<number>;
  failDiffLoad: (seq: number, error: unknown) => void;
  applyDiffData: (
    transportData: DiffData,
    options?: {
      seq?: number;
      loadingAlreadyStarted?: boolean;
      compareMode?: WorkbookCompareMode;
      preserveWorkbookViewState?: boolean;
      newComparison?: boolean;
    },
  ) => Promise<void>;
  handleWorkbookCompareModeChange: (nextMode: WorkbookCompareMode) => Promise<void>;
  handlePickWorkingCopyFile: () => Promise<void>;
  pickComparableFile: (
    side: LocalFilePickSide,
    requiredExtension?: string,
  ) => Promise<LocalDiffFilePickResult | null>;
  handleCompareLocalFiles: (basePath: string, minePath: string, newComparison?: boolean) => Promise<boolean>;
  handleSwapTwoFileDiff: () => Promise<void>;
  loadSvnDiffViewerStatus: () => Promise<void>;
  handleOpenSvnConfig: () => void;
  handleApplySvnDiffViewerScope: (scope: SvnDiffViewerScope) => Promise<void>;
  handleRestoreSvnDiffViewerDefault: () => Promise<void>;
  reloadCliDiffData: () => Promise<void>;
}

export default function useDiffLoader({
  onOpenComparison,
  onBackgroundLineBlame,
  loadSeqRef,
  hasLoadedDiffRef,
  workbookCompareModeRef,
  currentDiffDataRef,
  diffResultCacheRef,
  textLayoutSnapshotsRef,
  textSharedExpandedBlocksRef,
  workbookLayoutSnapshotsRef,
  workbookSharedExpandedBlocksRef,
  revisionQuerySeqRef,
  dialogs,
  diffLoad,
  revisionQuery,
  workbookUi,
}: UseDiffLoaderArgs): UseDiffLoaderResult {
  // ── Read setters directly from Zustand store ──────────────────────────
  const setWorkbookArtifactDiff = useAppStore((s) => s.setWorkbookArtifactDiff);
  const setBaseWorkbookMetadata = useAppStore((s) => s.setBaseWorkbookMetadata);
  const setMineWorkbookMetadata = useAppStore((s) => s.setMineWorkbookMetadata);
  const setDiffLines = useAppStore((s) => s.setDiffLines);
  const setDiffSourceNoticeCode = useAppStore((s) => s.setDiffSourceNoticeCode);
  const setWorkbookCompareMode = useAppStore((s) => s.setWorkbookCompareMode);
  const setIsLoadingSvnDiffViewerStatus = useAppStore((s) => s.setIsLoadingSvnDiffViewerStatus);
  const setSvnDiffViewerError = useAppStore((s) => s.setSvnDiffViewerError);
  const setSvnDiffViewerStatus = useAppStore((s) => s.setSvnDiffViewerStatus);
  const setApplyingSvnDiffViewerScope = useAppStore((s) => s.setApplyingSvnDiffViewerScope);
  const setIsRestoringSvnDiffViewerDefault = useAppStore((s) => s.setIsRestoringSvnDiffViewerDefault);
  const hydrateLoadedDiffSession = useAppStore((s) => s.hydrateLoadedDiffSession);

  const { actions: dialogActions } = dialogs;
  const { actions: diffLoadActions } = diffLoad;
  const { actions: revisionActions } = revisionQuery;
  const workbookUiStateRef = useRef(workbookUi.state);
  const loadStartedAtBySeqRef = useRef(new Map<number, number>());
  const cliReloadChainRef = useRef<Promise<void>>(Promise.resolve());
  workbookUiStateRef.current = workbookUi.state;

  const beginDiffLoad = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    loadStartedAtBySeqRef.current.set(seq, getNow());
    warmTextDiffWorker();
    recordPerfBridgeEvent('diff-payload:request', {
      reason: 'begin-diff-load',
      seq,
      compareMode: workbookCompareModeRef.current,
    });
    diffLoadActions.setError('');
    diffLoadActions.setLoading(true);
    diffLoadActions.setPhase('loading');
    await waitForNextPaint();
    return seq;
  }, [diffLoadActions, loadSeqRef, workbookCompareModeRef]);

  const failDiffLoad = useCallback((seq: number, error: unknown) => {
    loadStartedAtBySeqRef.current.delete(seq);
    if (seq !== loadSeqRef.current) return;
    diffLoadActions.setLoading(false);
    diffLoadActions.setError(error instanceof Error ? error.message : String(error));
    diffLoadActions.setPhase(hasLoadedDiffRef.current ? 'ready' : 'error');
    if (!hasLoadedDiffRef.current) {
      diffLoadActions.setMetrics(null);
    }
  }, [diffLoadActions, hasLoadedDiffRef, loadSeqRef]);

  const resetViewStateRefsForDiff = useCallback(() => {
    textLayoutSnapshotsRef.current = createEmptyTextLayoutSnapshots();
    textSharedExpandedBlocksRef.current = EMPTY_COLLAPSE_EXPANSION_STATE;
    workbookLayoutSnapshotsRef.current = createEmptyWorkbookLayoutSnapshots();
    workbookSharedExpandedBlocksRef.current = new Map();
  }, [
    textLayoutSnapshotsRef,
    textSharedExpandedBlocksRef,
    workbookLayoutSnapshotsRef,
    workbookSharedExpandedBlocksRef,
  ]);

  const resetRevisionUiStateForDiff = useCallback((data: DiffData | null = null) => {
    revisionQuerySeqRef.current += 1;
    revisionActions.setStatus(data ? getRevisionOptionsStatus(data) : 'idle');
    revisionActions.setHasMore(false);
    revisionActions.setNextBeforeId(null);
    revisionActions.setQueryDateTime('');
    revisionActions.setQueryError('');
    revisionActions.setLoadingMore(false);
    revisionActions.setSearchingDateTime(false);
  }, [
    revisionActions,
    revisionQuerySeqRef,
  ]);

  const applyDiffData = useCallback(async (
    transportData: DiffData,
    options?: {
      seq?: number;
      loadingAlreadyStarted?: boolean;
      compareMode?: WorkbookCompareMode;
      preserveWorkbookViewState?: boolean;
      newComparison?: boolean;
    },
  ) => {
    if (options?.newComparison) onOpenComparison(transportData);
    const seq = options?.seq ?? ++loadSeqRef.current;
    const applyStart = getNow();
    const compareMode = options?.compareMode ?? workbookCompareModeRef.current;
    recordPerfBridgeEvent('apply-diff-data:start', {
      seq,
      compareMode,
      fileName: transportData.fileName,
      hasPreparedDiff: Boolean(getPreparedDiffLinesForMode(transportData, compareMode)),
      source: transportData.perf?.source ?? 'local-dev',
    });
    const data = materializeCompactTransportDiffData(transportData);
    const previousData = currentDiffDataRef.current;
    if (previousData && buildDiffSessionKey(previousData) !== buildDiffSessionKey(data)) {
      diffResultCacheRef.current.clear();
      clearWorkbookCanvasBitmapCache();
      disposeTextSearchWorker();
    }
    const transportHydrateMs = getNow() - applyStart;
    const preservedWorkbookViewState = options?.preserveWorkbookViewState
      ? {
          activeWorkbookSheetName: workbookUiStateRef.current.activeSheetName,
          workbookHiddenStateBySheet: workbookUiStateRef.current.hiddenStateBySheet,
          workbookFreezeBySheet: workbookUiStateRef.current.freezeBySheet,
          workbookColumnWidthBySheet: workbookUiStateRef.current.columnWidthBySheet,
        }
      : null;
    const cacheKey = buildDiffCacheKey(data, compareMode);
    const preparedDiffLines = getPreparedDiffLinesForMode(data, compareMode);
    debugLog('apply-diff-data:start', {
      seq,
      compareMode,
      cacheKey,
      hasPreparedDiff: Boolean(preparedDiffLines),
      fileName: data.fileName,
      transportHydrateMs: Number(transportHydrateMs.toFixed(1)),
    });
    if (!options?.loadingAlreadyStarted) {
      diffLoadActions.setError('');
      diffLoadActions.setLoading(true);
      diffLoadActions.setPhase('loading');
      await waitForNextPaint();
    }

    try {
      const shouldUsePreparedDiff = Boolean(preparedDiffLines);
      const preparedDiffDuration = isWorkbookFileName(data.fileName || data.baseName || data.mineName)
        ? (data.perf?.rustDiffMs ?? data.perf?.diffMs ?? 0)
        : (data.perf?.diffMs ?? data.perf?.rustDiffMs ?? 0);
      let textResolveMs = 0;
      const cachedResult = diffResultCacheRef.current.get(cacheKey);
      const hydrateDiffSession = (
        nextData: DiffData,
        nextDiffLines: DiffLine[],
        nextBaseWorkbookMetadata: DiffData['baseWorkbookMetadata'],
        nextMineWorkbookMetadata: DiffData['mineWorkbookMetadata'],
      ) => {
        currentDiffDataRef.current = nextData;
        resetViewStateRefsForDiff();
        resetRevisionUiStateForDiff(nextData);
        hydrateLoadedDiffSession({
          baseName: nextData.baseName || nextData.fileName || '',
          mineName: nextData.mineName || nextData.fileName || '',
          launchBaseName: nextData.launchBaseName || nextData.baseName || nextData.fileName || '',
          launchMineName: nextData.launchMineName || nextData.mineName || nextData.fileName || '',
          fileName: nextData.fileName || '',
          workbookCompareMode: compareMode,
          preservedWorkbookViewState,
          diffLines: nextDiffLines,
          diffSourceNoticeCode: nextData.sourceNoticeCode ?? null,
          workbookArtifactDiff: nextData.workbookArtifactDiff ?? null,
          baseWorkbookMetadata: nextBaseWorkbookMetadata ?? null,
          mineWorkbookMetadata: nextMineWorkbookMetadata ?? null,
          revisionOptions: nextData.revisionOptions ?? [],
          baseRevisionInfo: nextData.baseRevisionInfo ?? null,
          mineRevisionInfo: nextData.mineRevisionInfo ?? null,
          compareContext: nextData.compareContext ?? 'literal_two_file_compare',
          resetPair: nextData.resetPair ?? null,
          canSwitchRevisions: Boolean(nextData.canSwitchRevisions),
          ...(nextData.revisionSwitchableSides
            ? { revisionSwitchableSides: nextData.revisionSwitchableSides }
            : {}),
        });
        if (!nextData.workbookArtifact) clearActiveWorkbookArtifact();
        diffLoadActions.setLoaded(true);
        diffLoadActions.setPhase('ready');
      };

      const scheduleLineBlameTask = () => {
        const bridge = window.versora;
        const isLocalFilePair = data.source?.kind === 'local';
        const isVersionedTwoFilePair = Boolean(data.revisionSwitchableSides);
        if (
          !bridge
          || isWorkbookFileName(data.fileName || data.baseName || data.mineName)
          || (
            isVersionedTwoFilePair
              ? !bridge.loadTwoFileVersionLineBlame
              : isLocalFilePair
              ? (!bridge.loadWorkingCopyLineBlame || !data.basePath || !data.minePath)
              : !bridge.loadLineBlame
          )
        ) {
          return;
        }

        const blameTask = isVersionedTwoFilePair
          ? bridge.loadTwoFileVersionLineBlame(
              data.baseRevisionInfo?.id ?? '',
              data.mineRevisionInfo?.id ?? '',
              data.comparisonSessionId,
            )
          : isLocalFilePair
          ? bridge.loadWorkingCopyLineBlame(data.basePath!, data.minePath!, data.comparisonSessionId)
          : bridge.loadLineBlame(
              data.baseRevisionInfo?.id,
              data.mineRevisionInfo?.id,
              data.comparisonSessionId,
            );
        void blameTask.then((payload) => {
          if (seq !== loadSeqRef.current) {
            onBackgroundLineBlame(data, payload);
            return;
          }
          setDiffLines(current => attachLineBlameToDiffLines(current, payload));
          debugLog('line-blame:loaded', {
            fileName: data.fileName,
            baseLineCount: payload.base.length,
            mineLineCount: payload.mine.length,
          });
        }).catch((error: unknown) => {
          if (seq !== loadSeqRef.current) return;
          debugLog('line-blame:failed', {
            fileName: data.fileName,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      };

      if (data.workbookArtifact) {
        const descriptor = data.workbookArtifact.compareMode === compareMode ? data.workbookArtifact
          : await resolveWorkbookArtifactView({ artifactId: data.workbookArtifact.artifactId, compareMode });
        if (seq !== loadSeqRef.current) return;
        const nextData = { ...data, workbookArtifact: descriptor,
          baseWorkbookMetadata: descriptor.baseMetadata, mineWorkbookMetadata: descriptor.mineMetadata };
        activateWorkbookArtifact(descriptor);
        hydrateDiffSession(nextData, [], descriptor.baseMetadata, descriptor.mineMetadata);
        const rendererApplyMs = getNow() - applyStart;
        const requestStartedAt = loadStartedAtBySeqRef.current.get(seq);
        const requestToCommitMs = requestStartedAt == null ? null : getNow() - requestStartedAt;
        diffLoadActions.setMetrics({ source: data.perf?.source ?? 'cli', ...data.perf,
          rendererApplyMs, diffLineCount: descriptor.rows.kinds.length,
          ...(requestToCommitMs != null ? { requestToCommitMs } : {}) });
        recordPerfBridgeEvent('apply-diff-data:commit', { seq, compareMode, fileName: data.fileName,
          artifactId: descriptor.artifactId, displayRows: descriptor.rows.kinds.length, rendererApplyMs, requestToCommitMs });
        return;
      }
      if (isWorkbookFileName(data.fileName || data.baseName || data.mineName)
        || (typeof data.baseContent === 'string' && typeof data.mineContent === 'string' && isWorkbookTextPair(data.baseContent, data.mineContent))) {
        throw new Error('Workbook comparison artifact is missing. Please reload the comparison.');
      }
      const cachedDiffLines = shouldUsePreparedDiff
        ? preparedDiffLines
        : (cachedResult?.diffLines ?? null);
      const canUseCachedResult = Boolean(cachedResult && cachedDiffLines);

      if (canUseCachedResult) {
        diffResultCacheRef.current.delete(cacheKey);
        diffResultCacheRef.current.set(cacheKey, cachedResult!);
        hydrateDiffSession(
          data,
          cachedDiffLines ?? [],
          cachedResult?.baseWorkbookMetadata ?? data.baseWorkbookMetadata ?? null,
          cachedResult?.mineWorkbookMetadata ?? data.mineWorkbookMetadata ?? null,
        );
        const rendererApplyMs = getNow() - applyStart;
        const requestStartedAt = loadStartedAtBySeqRef.current.get(seq);
        const requestToCommitMs = requestStartedAt == null ? null : getNow() - requestStartedAt;
        diffLoadActions.setMetrics({
          source: data.perf?.source ?? 'local-dev',
          ...data.perf,
          textResolveMs,
          metadataMs: 0,
          diffMs: data.perf?.diffMs ?? 0,
          rendererApplyMs,
          ...(requestToCommitMs != null ? { requestToCommitMs } : {}),
          diffLineCount: cachedDiffLines?.length ?? 0,
        });
        recordPerfBridgeEvent('apply-diff-data:commit', {
          seq,
          compareMode,
          cached: true,
          fileName: data.fileName,
          diffLineCount: cachedDiffLines?.length ?? 0,
          rendererApplyMs,
          requestToCommitMs,
        });
        debugLog('apply-diff-data:done', {
          seq,
          compareMode,
          cached: true,
          diffLineCount: cachedDiffLines?.length ?? 0,
          rendererApplyMs: Number(rendererApplyMs.toFixed(1)),
          requestToCommitMs: requestToCommitMs == null ? null : Number(requestToCommitMs.toFixed(1)),
          perf: data.perf ?? null,
        });
        scheduleLineBlameTask();
        return;
      }

      let nextDiffLines: DiffLine[];
      let diffDuration: number;
      if (shouldUsePreparedDiff) {
        nextDiffLines = preparedDiffLines!;
        diffDuration = preparedDiffDuration;
      } else {
        const textStart = getNow();
        const { baseText, mineText } = resolveDiffTexts(data);
        textResolveMs = getNow() - textStart;
        const diffStart = getNow();
        nextDiffLines = await computeTextDiffAsync(baseText, mineText);
        diffDuration = getNow() - diffStart;
      }
      if (seq !== loadSeqRef.current) return;
      hydrateDiffSession(
        data,
        nextDiffLines,
        data.baseWorkbookMetadata ?? null,
        data.mineWorkbookMetadata ?? null,
      );
      const rendererApplyMs = getNow() - applyStart;
      const requestStartedAt = loadStartedAtBySeqRef.current.get(seq);
      const requestToCommitMs = requestStartedAt == null ? null : getNow() - requestStartedAt;
      diffLoadActions.setMetrics({
        source: data.perf?.source ?? 'local-dev',
        ...data.perf,
        textResolveMs,
        diffMs: shouldUsePreparedDiff ? preparedDiffDuration : diffDuration,
        rendererApplyMs,
        ...(requestToCommitMs != null ? { requestToCommitMs } : {}),
        diffLineCount: nextDiffLines.length,
      });
      recordPerfBridgeEvent('apply-diff-data:commit', {
        seq,
        compareMode,
        cached: false,
        fileName: data.fileName,
        diffLineCount: nextDiffLines.length,
        rendererApplyMs,
        requestToCommitMs,
        textResolveMs,
        diffMs: shouldUsePreparedDiff ? preparedDiffDuration : diffDuration,
      });
      debugLog('apply-diff-data:done', {
        seq,
        compareMode,
        cached: false,
        diffLineCount: nextDiffLines.length,
        textResolveMs: Number(textResolveMs.toFixed(1)),
        diffMs: Number(diffDuration.toFixed(1)),
        rendererApplyMs: Number(rendererApplyMs.toFixed(1)),
        requestToCommitMs: requestToCommitMs == null ? null : Number(requestToCommitMs.toFixed(1)),
        source: data.perf?.source ?? 'local-dev',
      });
      rememberCachedDiffResult(diffResultCacheRef.current, cacheKey, buildCachedDiffResult({
        diffLines: shouldUsePreparedDiff ? null : nextDiffLines,
        baseWorkbookMetadata: data.baseWorkbookMetadata ?? null,
        mineWorkbookMetadata: data.mineWorkbookMetadata ?? null,
      }));
      scheduleLineBlameTask();
    } catch (error) {
      if (seq !== loadSeqRef.current) return;
      if (!hasLoadedDiffRef.current) {
        setDiffLines([]);
        setWorkbookArtifactDiff(null);
        setBaseWorkbookMetadata(null);
        setMineWorkbookMetadata(null);
        resetRevisionUiStateForDiff(null);
        setDiffSourceNoticeCode(null);
        diffLoadActions.setLoaded(false);
        diffLoadActions.setPhase('error');
        diffLoadActions.setMetrics(null);
      } else {
        diffLoadActions.setPhase('ready');
      }
      diffLoadActions.setError(error instanceof Error ? error.message : String(error));
    } finally {
      loadStartedAtBySeqRef.current.delete(seq);
      if (seq === loadSeqRef.current) {
        diffLoadActions.setLoading(false);
      }
    }
  }, [
    currentDiffDataRef,
    onOpenComparison,
    onBackgroundLineBlame,
    diffLoadActions,
    diffResultCacheRef,
    hydrateLoadedDiffSession,
    hasLoadedDiffRef,
    loadSeqRef,
    resetRevisionUiStateForDiff,
    resetViewStateRefsForDiff,
    setBaseWorkbookMetadata,
    setDiffLines,
    setDiffSourceNoticeCode,
    setMineWorkbookMetadata,
    setWorkbookArtifactDiff,
    workbookCompareModeRef,
  ]);

  const handleWorkbookCompareModeChange = useCallback(async (nextMode: WorkbookCompareMode) => {
    if (nextMode === workbookCompareModeRef.current) return;

    const currentData = currentDiffDataRef.current;
    if (!currentData) {
      setWorkbookCompareMode(nextMode);
      return;
    }
    const isCurrentWorkbook = isWorkbookFileName(currentData.fileName || currentData.baseName || currentData.mineName);
    recordPerfBridgeEvent('workbook-compare-mode:start', {
      fileName: currentData.fileName,
      fromCompareMode: workbookCompareModeRef.current,
      toCompareMode: nextMode,
      isWorkbookMode: isCurrentWorkbook,
      hasPreparedDiff: Boolean(getPreparedDiffLinesForMode(currentData, nextMode)),
    });

    await applyDiffData(currentData, {
      compareMode: nextMode,
      loadingAlreadyStarted: true,
      preserveWorkbookViewState: isCurrentWorkbook,
    });
  }, [applyDiffData, currentDiffDataRef, setWorkbookCompareMode, workbookCompareModeRef]);
  const loadElectronWorkingCopyDiff = useCallback(async (filePath: string) => {
    if (!window.versora?.loadDevWorkingCopyDiff) return;
    const seq = await beginDiffLoad();
    try {
      const nextData = await window.versora.loadDevWorkingCopyDiff(filePath, workbookCompareModeRef.current);
      if (seq !== loadSeqRef.current) return;
      await applyDiffData(nextData, {
        seq,
        loadingAlreadyStarted: true,
        newComparison: true,
      });
    } catch (error) {
      failDiffLoad(seq, error);
      throw error;
    }
  }, [applyDiffData, beginDiffLoad, failDiffLoad, loadSeqRef, workbookCompareModeRef]);

  const handlePickWorkingCopyFile = useCallback(async () => {
    if (!window.versora?.pickDiffFile) return;
    const nextFile = await window.versora.pickDiffFile();
    if (!nextFile?.path) return;
    try {
      await loadElectronWorkingCopyDiff(nextFile.path);
    } catch {
      // loadElectronWorkingCopyDiff already updates the UI error state.
    }
  }, [loadElectronWorkingCopyDiff]);

  const pickComparableFile = useCallback(async (
    side: LocalFilePickSide,
    requiredExtension?: string,
  ) => {
    if (!window.versora?.pickComparableFile) return null;
    return window.versora.pickComparableFile(side, requiredExtension);
  }, []);

  const handleCompareLocalFiles = useCallback(async (
    basePath: string,
    minePath: string,
    newComparison = true,
  ) => {
    if (!window.versora?.loadLocalFileDiff) return false;
    const comparisonSessionId = newComparison ? undefined : currentDiffDataRef.current?.comparisonSessionId;
    const compareMode = workbookCompareModeRef.current;
    const seq = await beginDiffLoad();
    if (seq !== loadSeqRef.current) return false;
    try {
      const nextData = await window.versora.loadLocalFileDiff(
        basePath,
        minePath,
        compareMode,
        comparisonSessionId,
      );
      if (seq !== loadSeqRef.current) return false;
      await applyDiffData(nextData, {
        seq,
        loadingAlreadyStarted: true,
        newComparison,
      });
      return true;
    } catch (error) {
      failDiffLoad(seq, error);
      return false;
    }
  }, [applyDiffData, beginDiffLoad, currentDiffDataRef, failDiffLoad, loadSeqRef, workbookCompareModeRef]);

  const handleSwapTwoFileDiff = useCallback(async () => {
    const currentData = currentDiffDataRef.current;
    const bridge = window.versora;
    if (!currentData || !bridge) return;
    const seq = await beginDiffLoad();
    if (seq !== loadSeqRef.current) return;
    try {
      const nextData = await bridge.swapTwoFileDiff(
        currentData.baseRevisionInfo?.id ?? null,
        currentData.mineRevisionInfo?.id ?? null,
        workbookCompareModeRef.current,
        currentData.comparisonSessionId,
      );
      if (seq !== loadSeqRef.current) return;
      await applyDiffData(nextData, { seq, loadingAlreadyStarted: true });
    } catch (error) {
      failDiffLoad(seq, error);
    }
  }, [applyDiffData, beginDiffLoad, currentDiffDataRef, failDiffLoad, loadSeqRef, workbookCompareModeRef]);

  const loadSvnDiffViewerStatus = useCallback(async () => {
    if (!window.versora?.getSvnDiffViewerStatus) return;
    setIsLoadingSvnDiffViewerStatus(true);
    setSvnDiffViewerError('');
    try {
      const nextStatus = await window.versora.getSvnDiffViewerStatus();
      setSvnDiffViewerStatus(nextStatus);
    } catch (error) {
      setSvnDiffViewerError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoadingSvnDiffViewerStatus(false);
    }
  }, [setIsLoadingSvnDiffViewerStatus, setSvnDiffViewerError, setSvnDiffViewerStatus]);

  const handleOpenSvnConfig = useCallback(() => {
    dialogActions.open('svnConfig');
    void loadSvnDiffViewerStatus();
  }, [dialogActions, loadSvnDiffViewerStatus]);

  const handleApplySvnDiffViewerScope = useCallback(async (scope: SvnDiffViewerScope) => {
    if (!window.versora?.configureSvnDiffViewer) return;
    setApplyingSvnDiffViewerScope(scope);
    setSvnDiffViewerError('');
    try {
      const nextStatus = await window.versora.configureSvnDiffViewer(scope);
      setSvnDiffViewerStatus(nextStatus);
    } catch (error) {
      setSvnDiffViewerError(error instanceof Error ? error.message : String(error));
    } finally {
      setApplyingSvnDiffViewerScope(null);
    }
  }, [setApplyingSvnDiffViewerScope, setSvnDiffViewerError, setSvnDiffViewerStatus]);

  const handleRestoreSvnDiffViewerDefault = useCallback(async () => {
    if (!window.versora?.restoreSvnDefaultDiffViewerConfiguration) return;
    setIsRestoringSvnDiffViewerDefault(true);
    setSvnDiffViewerError('');
    try {
      const nextStatus = await window.versora.restoreSvnDefaultDiffViewerConfiguration();
      setSvnDiffViewerStatus(nextStatus);
    } catch (error) {
      setSvnDiffViewerError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRestoringSvnDiffViewerDefault(false);
    }
  }, [setIsRestoringSvnDiffViewerDefault, setSvnDiffViewerError, setSvnDiffViewerStatus]);

  const reloadCliDiffData = useCallback(() => {
    const task = cliReloadChainRef.current.then(async () => {
      const rawBridge = window.versora;
      if (!rawBridge?.getDiffData) return;
      const bridge = rawBridge;
      while (true) {
        const context = await bridge.getLaunchContext();
        if (!context.hasDiffRequest || context.pendingDiffRequestCount === 0) return;
        const seq = await beginDiffLoad();
        try {
          const data = await bridge.getDiffData(workbookCompareModeRef.current);
          if (seq !== loadSeqRef.current) return;
          await applyDiffData(data, { seq, loadingAlreadyStarted: true, newComparison: true });
        } catch (error) {
          failDiffLoad(seq, error);
        }
        // Commit the active tab before taking the next session snapshot.
        await waitForNextPaint();
        if (context.pendingDiffRequestCount == null) return;
      }
    });
    cliReloadChainRef.current = task.catch(() => undefined);
    return task;
  }, [applyDiffData, beginDiffLoad, failDiffLoad, loadSeqRef, workbookCompareModeRef]);

  return {
    beginDiffLoad,
    failDiffLoad,
    applyDiffData,
    handleWorkbookCompareModeChange,
    handlePickWorkingCopyFile,
    pickComparableFile,
    handleCompareLocalFiles,
    handleSwapTwoFileDiff,
    loadSvnDiffViewerStatus,
    handleOpenSvnConfig,
    handleApplySvnDiffViewerScope,
    handleRestoreSvnDiffViewerDefault,
    reloadCliDiffData,
  };
}
