import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';

import type {
  DiffData,
  LocalFilePickSide,
  RevisionOptionsPayload,
  RevisionOptionsQuery,
  SvnRevisionInfo,
  WorkbookCompareMode,
} from '@/types';
import { debugLog, mergeRevisionOptions } from '@/hooks/app/helpers';
import type { RevisionQueryController } from '@/hooks/app/contracts';
import { useAppStore } from '@/store/appStore';
import { shouldSkipSameRevisionCompare } from '@/utils/navigation/revisionCompareSelection';

interface UseRevisionCompareArgs {
  currentDiffDataRef: MutableRefObject<DiffData | null>;
  activeComparisonId: string | null;
  revisionOptionsRef: MutableRefObject<SvnRevisionInfo[]>;
  revisionQuerySeqRef: MutableRefObject<number>;
  loadSeqRef: MutableRefObject<number>;
  workbookCompareModeRef: MutableRefObject<WorkbookCompareMode>;
  revisionQuery: RevisionQueryController;
  applyDiffData: (
    data: DiffData,
    options?: { seq?: number; loadingAlreadyStarted?: boolean; compareMode?: WorkbookCompareMode },
  ) => Promise<void>;
  beginDiffLoad: () => Promise<number>;
  failDiffLoad: (seq: number, error: unknown) => void;
}

export default function useRevisionCompare({
  currentDiffDataRef,
  activeComparisonId,
  revisionOptionsRef,
  revisionQuerySeqRef,
  loadSeqRef,
  workbookCompareModeRef,
  revisionQuery,
  applyDiffData,
  beginDiffLoad,
  failDiffLoad,
}: UseRevisionCompareArgs) {
  // ── Read state/setters directly from Zustand store ────────────────────
  const resetPair = useAppStore((s) => s.resetPair);
  const compareContext = useAppStore((s) => s.compareContext);
  const revisionOptions = useAppStore((s) => s.revisionOptions);
  const setRevisionOptions = useAppStore((s) => s.setRevisionOptions);
  const setBaseRevisionInfo = useAppStore((s) => s.setBaseRevisionInfo);
  const setMineRevisionInfo = useAppStore((s) => s.setMineRevisionInfo);

  const { state: revisionState, actions: revisionActions } = revisionQuery;
  const revisionOptionsScopeRef = useRef<'shared' | LocalFilePickSide | null>(null);
  useEffect(() => {
    revisionOptionsScopeRef.current = null;
  }, [activeComparisonId]);

  const applyRevisionOptionsPayload = useCallback((
    payload: RevisionOptionsPayload,
    mode: 'replace' | 'append' = 'replace',
    targetSide?: LocalFilePickSide,
  ) => {
    const nextOptions = mode === 'append'
      ? mergeRevisionOptions(revisionOptionsRef.current, payload.items)
      : payload.items;

    revisionOptionsRef.current = nextOptions;
    setRevisionOptions(nextOptions);
    revisionActions.setStatus('loaded');
    revisionActions.setHasMore(payload.hasMore);
    revisionActions.setNextBeforeId(payload.nextBeforeRevisionId);
    revisionActions.setQueryDateTime(payload.queryDateTime ?? '');
    revisionActions.setQueryError('');
    if (!targetSide || targetSide === 'base') {
      setBaseRevisionInfo((prev) => (
        prev ? (nextOptions.find((option) => option.id === prev.id) ?? prev) : prev
      ));
    }
    if (!targetSide || targetSide === 'mine') {
      setMineRevisionInfo((prev) => (
        prev ? (nextOptions.find((option) => option.id === prev.id) ?? prev) : prev
      ));
    }
  }, [
    revisionOptionsRef,
    revisionActions,
    setBaseRevisionInfo,
    setMineRevisionInfo,
    setRevisionOptions,
  ]);

  const queryRevisionOptionsPage = useCallback(async (
    query: RevisionOptionsQuery,
    options?: {
      append?: boolean;
      showInitialLoading?: boolean;
      showSearchLoading?: boolean;
      targetSide?: LocalFilePickSide;
    },
  ) => {
    if (!window.versora?.queryRevisionOptions) return;
    const seq = ++revisionQuerySeqRef.current;
    const append = Boolean(options?.append);

    if (options?.showInitialLoading) {
      revisionActions.setStatus('loading');
    }
    if (append) {
      revisionActions.setLoadingMore(true);
    }
    if (options?.showSearchLoading) {
      revisionActions.setSearchingDateTime(true);
    }
    if (!append) {
      revisionActions.setQueryError('');
    }

    try {
      const targetSide = compareContext === 'literal_two_file_compare'
        ? options?.targetSide
        : undefined;
      const payload = await window.versora.queryRevisionOptions({
        ...query,
        ...(targetSide ? { targetSide } : {}),
      }, currentDiffDataRef.current?.comparisonSessionId);
      if (seq !== revisionQuerySeqRef.current) return;
      applyRevisionOptionsPayload(payload, append ? 'append' : 'replace', targetSide);
      debugLog('revision-options:loaded', {
        count: payload.items.length,
        hasMore: payload.hasMore,
        nextBeforeRevisionId: payload.nextBeforeRevisionId,
        queryDateTime: payload.queryDateTime,
      });
    } catch (error) {
      if (seq !== revisionQuerySeqRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      revisionActions.setQueryError(message);
      if (options?.showInitialLoading) {
        revisionActions.setStatus('error');
      }
      debugLog('revision-options:error', { message });
    } finally {
      if (seq === revisionQuerySeqRef.current) {
        if (append) {
          revisionActions.setLoadingMore(false);
        }
        if (options?.showSearchLoading) {
          revisionActions.setSearchingDateTime(false);
        }
      }
    }
  }, [
    applyRevisionOptionsPayload,
    compareContext,
    currentDiffDataRef,
    revisionQuerySeqRef,
    revisionActions,
  ]);

  const handleLoadMoreRevisionOptions = useCallback((targetSide: LocalFilePickSide) => {
    if (!window.versora?.queryRevisionOptions) return;
    if (revisionState.isLoadingMoreRevisions || !revisionState.revisionHasMore || !revisionState.revisionNextBeforeId) return;
    void queryRevisionOptionsPage(
      {
        limit: 50,
        beforeRevisionId: revisionState.revisionNextBeforeId,
        includeSpecials: false,
      },
      {
        append: true,
        targetSide,
      },
    );
  }, [
    queryRevisionOptionsPage,
    revisionState.isLoadingMoreRevisions,
    revisionState.revisionHasMore,
    revisionState.revisionNextBeforeId,
  ]);

  const handleEnsureRevisionOptionsLoaded = useCallback((targetSide: LocalFilePickSide) => {
    if (!window.versora?.queryRevisionOptions) return;
    const nextScope = compareContext === 'literal_two_file_compare' ? targetSide : 'shared';
    if (revisionOptionsScopeRef.current === nextScope && revisionOptions.length > 0) return;
    if (revisionState.revisionOptionsStatus === 'loading') return;

    if (revisionOptionsScopeRef.current !== nextScope) {
      revisionOptionsScopeRef.current = nextScope;
      revisionOptionsRef.current = [];
      setRevisionOptions([]);
      revisionActions.setHasMore(false);
      revisionActions.setNextBeforeId(null);
      revisionActions.setQueryDateTime('');
      revisionActions.setQueryError('');
    }

    debugLog('revision-options:request');

    void queryRevisionOptionsPage(
      {
        limit: 50,
        includeSpecials: compareContext === 'git_compare' || compareContext === 'literal_two_file_compare',
      },
      {
        showInitialLoading: true,
        targetSide,
      },
    );
  }, [
    compareContext,
    queryRevisionOptionsPage,
    revisionActions,
    revisionOptions,
    revisionOptionsRef,
    setRevisionOptions,
    revisionState.revisionOptionsStatus,
  ]);

  const handleRevisionDateTimeQuery = useCallback((targetSide: LocalFilePickSide, nextDateTime: string) => {
    if (!window.versora?.queryRevisionOptions) return;
    const trimmed = nextDateTime.trim();
    void queryRevisionOptionsPage(
      trimmed
          ? {
            limit: 50,
            anchorDateTime: trimmed,
            includeSpecials: compareContext === 'git_compare' || compareContext === 'literal_two_file_compare',
          }
        : {
            limit: 50,
            includeSpecials: compareContext === 'git_compare' || compareContext === 'literal_two_file_compare',
          },
      {
        showSearchLoading: true,
        targetSide,
      },
    );
  }, [compareContext, queryRevisionOptionsPage]);

  const handleRevisionCompareChange = useCallback(async (
    nextBaseRevisionId: string,
    nextMineRevisionId: string,
  ) => {
    if (shouldSkipSameRevisionCompare(
      compareContext === 'literal_two_file_compare',
      nextBaseRevisionId,
      nextMineRevisionId,
    )) {
      revisionActions.setSwitching(false);
      debugLog('revision-compare:skipped-same-revision', {
        revisionId: nextBaseRevisionId.trim(),
      });
      return;
    }
    const rawBridge = window.versora;
    if (!rawBridge) return;
    const bridge = rawBridge;
    const comparisonSessionId = currentDiffDataRef.current?.comparisonSessionId;
    const compareMode = workbookCompareModeRef.current;
    revisionActions.setSwitching(true);
    const seq = await beginDiffLoad();
    if (seq !== loadSeqRef.current) return;
    try {
      const nextData = compareContext === 'literal_two_file_compare'
        ? await bridge.loadTwoFileRevisionDiff(
            nextBaseRevisionId,
            nextMineRevisionId,
            compareMode,
            comparisonSessionId,
          )
        : await bridge.loadRevisionDiff(
            nextBaseRevisionId,
            nextMineRevisionId,
            compareMode,
            comparisonSessionId,
          );
      if (seq !== loadSeqRef.current) return;
      await applyDiffData(nextData, {
        seq,
        loadingAlreadyStarted: true,
      });
    } catch (error) {
      failDiffLoad(seq, error);
    } finally {
      if (seq === loadSeqRef.current) revisionActions.setSwitching(false);
    }
  }, [
    applyDiffData,
    beginDiffLoad,
    compareContext,
    currentDiffDataRef,
    failDiffLoad,
    loadSeqRef,
    revisionActions,
    workbookCompareModeRef,
  ]);

  const handleResetRevisionCompare = useCallback(async () => {
    const rawBridge = window.versora;
    if (!rawBridge || !resetPair) return;
    const bridge = rawBridge;
    if (!resetPair.baseRevisionId && !resetPair.mineRevisionId) return;

    const comparisonSessionId = currentDiffDataRef.current?.comparisonSessionId;
    const compareMode = workbookCompareModeRef.current;
    revisionActions.setSwitching(true);
    const seq = await beginDiffLoad();
    if (seq !== loadSeqRef.current) return;
    try {
      const nextData = compareContext === 'literal_two_file_compare'
        ? await bridge.loadTwoFileRevisionDiff(
            resetPair.baseRevisionId ?? '',
            resetPair.mineRevisionId ?? '',
            compareMode,
            comparisonSessionId,
          )
        : await bridge.loadRevisionDiff(
            resetPair.baseRevisionId ?? '',
            resetPair.mineRevisionId ?? '',
            compareMode,
            comparisonSessionId,
          );
      if (seq !== loadSeqRef.current) return;
      await applyDiffData(nextData, {
        seq,
        loadingAlreadyStarted: true,
      });
    } catch (error) {
      failDiffLoad(seq, error);
    } finally {
      if (seq === loadSeqRef.current) revisionActions.setSwitching(false);
    }
  }, [
    applyDiffData,
    beginDiffLoad,
    compareContext,
    currentDiffDataRef,
    failDiffLoad,
    loadSeqRef,
    resetPair,
    revisionActions,
    workbookCompareModeRef,
  ]);

  return {
    handleEnsureRevisionOptionsLoaded,
    queryRevisionOptionsPage,
    handleLoadMoreRevisionOptions,
    handleRevisionDateTimeQuery,
    handleRevisionCompareChange,
    handleResetRevisionCompare,
  };
}
