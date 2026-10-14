import { useCallback, useRef, useState, type MutableRefObject } from 'react';

import type { DiffData, LineBlamePayload, SvnRevisionInfo, WorkbookCompareMode, WorkbookMetadataPayload } from '@/types';
import { captureDiffSessionState, useAppStore, type DiffSessionStoreSnapshot } from '@/store/appStore';
import type { DiffLoadController, DialogController, RevisionQueryController } from './contracts';
import type { CachedDiffResult } from './types';
import { createEmptyTextLayoutSnapshots, type TextLayoutSnapshotsByMode } from '@/utils/diff/textLayoutState';
import { createEmptyWorkbookLayoutSnapshots, type WorkbookLayoutSnapshotsByMode } from '@/utils/workbook/workbookLayoutState';
import { EMPTY_COLLAPSE_EXPANSION_STATE, type CollapseExpansionState } from '@/utils/collapse/collapseState';
import { attachLineBlameToDiffLines } from '@/utils/diff/lineBlame';
import { mergeWorkbookMetadataPayload } from '@/hooks/app/helpers';
import { buildDiffSessionKey } from '@/utils/diff/diffCacheKey';
import { clearActiveWorkbookArtifact, releaseWorkbookArtifactSession } from '@/utils/workbook/workbookArtifactProvider';

interface SessionRefs {
  currentDiffDataRef: MutableRefObject<DiffData | null>;
  diffResultCacheRef: MutableRefObject<Map<string, CachedDiffResult>>;
  textLayoutSnapshotsRef: MutableRefObject<TextLayoutSnapshotsByMode>;
  textSharedExpandedBlocksRef: MutableRefObject<CollapseExpansionState>;
  workbookLayoutSnapshotsRef: MutableRefObject<WorkbookLayoutSnapshotsByMode>;
  workbookSharedExpandedBlocksRef: MutableRefObject<Map<string, CollapseExpansionState>>;
  revisionOptionsRef: MutableRefObject<SvnRevisionInfo[]>;
  hasLoadedDiffRef: MutableRefObject<boolean>;
  workbookCompareModeRef: MutableRefObject<WorkbookCompareMode>;
  loadSeqRef: MutableRefObject<number>;
  revisionQuerySeqRef: MutableRefObject<number>;
}

interface SavedSession {
  state: DiffSessionStoreSnapshot;
  data: DiffData | null;
  cache: Map<string, CachedDiffResult>;
  textLayouts: TextLayoutSnapshotsByMode;
  textExpanded: CollapseExpansionState;
  workbookLayouts: WorkbookLayoutSnapshotsByMode;
  workbookExpanded: Map<string, CollapseExpansionState>;
  load: DiffLoadController['state'];
  revisions: RevisionQueryController['state'];
  showSearch: boolean;
}

interface SessionTab { id: string; title: string; description: string }
interface Args extends SessionRefs {
  diffLoad: DiffLoadController;
  revisionQuery: RevisionQueryController;
  dialogs: DialogController;
}

function matchesData(candidate: DiffData | null, data: DiffData): boolean {
  return Boolean(candidate
    && candidate.comparisonSessionId === data.comparisonSessionId
    && buildDiffSessionKey(candidate) === buildDiffSessionKey(data)
    && candidate.baseRevisionInfo?.id === data.baseRevisionInfo?.id
    && candidate.mineRevisionInfo?.id === data.mineRevisionInfo?.id);
}

// Only the active viewer is mounted. Loaded data, caches and view snapshots
// stay in memory for the other tabs, without reparsing files when selected.
export default function useComparisonSessions(args: Args) {
  const latest = useRef(args);
  latest.current = args;
  const saved = useRef(new Map<string, SavedSession>());
  const activeIdRef = useRef<string | null>(null);
  const nextId = useRef(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<SessionTab[]>([]);
  const [restoredNavigation, setRestoredNavigation] = useState<{
    hunkIdx: number; searchJumpNonce: number; activeSearchIdx: number; guidedPulseNonce: number;
  } | null>(null);

  const saveActive = useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    const a = latest.current;
    saved.current.set(id, {
      state: captureDiffSessionState(useAppStore.getState()),
      data: a.currentDiffDataRef.current,
      cache: a.diffResultCacheRef.current,
      textLayouts: a.textLayoutSnapshotsRef.current,
      textExpanded: a.textSharedExpandedBlocksRef.current,
      workbookLayouts: a.workbookLayoutSnapshotsRef.current,
      workbookExpanded: a.workbookSharedExpandedBlocksRef.current,
      load: { ...a.diffLoad.state, hasLoadedDiff: a.hasLoadedDiffRef.current, isLoadingDiff: false, loadPhase: a.hasLoadedDiffRef.current ? 'ready' : 'error' },
      revisions: {
        ...a.revisionQuery.state,
        revisionOptionsStatus: a.revisionQuery.state.revisionOptionsStatus === 'loading' ? 'idle' : a.revisionQuery.state.revisionOptionsStatus,
        isLoadingMoreRevisions: false, isSearchingRevisionDateTime: false, isSwitchingRevisions: false,
      },
      showSearch: a.dialogs.state.showSearch,
    });
  }, []);

  const clearActive = useCallback(() => {
    const a = latest.current;
    a.currentDiffDataRef.current = null;
    clearActiveWorkbookArtifact();
    a.diffLoad.actions.setLoaded(false);
    a.diffResultCacheRef.current = new Map();
    a.textLayoutSnapshotsRef.current = createEmptyTextLayoutSnapshots();
    a.textSharedExpandedBlocksRef.current = EMPTY_COLLAPSE_EXPANSION_STATE;
    a.workbookLayoutSnapshotsRef.current = createEmptyWorkbookLayoutSnapshots();
    a.workbookSharedExpandedBlocksRef.current = new Map();
    a.revisionOptionsRef.current = [];
    useAppStore.getState().resetDiffSessionToHome();
    a.dialogs.actions.closeAll();
  }, []);

  const openComparison = useCallback((data: DiffData) => {
    saveActive();
    clearActive();
    latest.current.currentDiffDataRef.current = data;
    const id = `comparison-${++nextId.current}`;
    activeIdRef.current = id;
    setActiveId(id);
    setRestoredNavigation(null);
    setTabs(previous => [...previous, {
      id,
      title: data.fileName || data.mineName || data.baseName,
      description: [data.baseName, data.mineName].filter(Boolean).join(' ↔ '),
    }]);
  }, [clearActive, saveActive]);

  const selectComparison = useCallback((id: string | null) => {
    const a = latest.current;
    if (id === activeIdRef.current || a.diffLoad.state.isLoadingDiff) return;
    const session = id ? saved.current.get(id) : null;
    if (id && !session) return;
    saveActive();
    a.loadSeqRef.current += 1;
    a.revisionQuerySeqRef.current += 1;
    activeIdRef.current = id;
    setActiveId(id);
    setRestoredNavigation(session ? {
      hunkIdx: session.state.hunkIdx, searchJumpNonce: session.state.searchJumpNonce,
      activeSearchIdx: session.state.activeSearchIdx, guidedPulseNonce: session.state.guidedPulseNonce,
    } : null);
    a.dialogs.actions.closeAll();
    if (!session) {
      clearActive();
      a.diffLoad.actions.setLoading(false);
      a.diffLoad.actions.setPhase('idle');
      a.diffLoad.actions.setError('');
      a.diffLoad.actions.setMetrics(null);
      a.revisionQuery.actions.setStatus('idle');
    } else {
      a.currentDiffDataRef.current = session.data;
      a.diffResultCacheRef.current = session.cache;
      a.textLayoutSnapshotsRef.current = session.textLayouts;
      a.textSharedExpandedBlocksRef.current = session.textExpanded;
      a.workbookLayoutSnapshotsRef.current = session.workbookLayouts;
      a.workbookSharedExpandedBlocksRef.current = session.workbookExpanded;
      a.revisionOptionsRef.current = session.state.revisionOptions;
      a.workbookCompareModeRef.current = session.state.workbookCompareMode;
      useAppStore.getState().restoreDiffSessionState(session.state);
      a.diffLoad.actions.setLoaded(session.load.hasLoadedDiff);
      a.diffLoad.actions.setLoading(false);
      a.diffLoad.actions.setPhase(session.load.loadPhase);
      a.diffLoad.actions.setError(session.load.loadError);
      a.diffLoad.actions.setMetrics(session.load.loadPerfMetrics);
      const r = session.revisions;
      a.revisionQuery.actions.setStatus(r.revisionOptionsStatus);
      a.revisionQuery.actions.setHasMore(r.revisionHasMore);
      a.revisionQuery.actions.setNextBeforeId(r.revisionNextBeforeId);
      a.revisionQuery.actions.setQueryDateTime(r.revisionQueryDateTime);
      a.revisionQuery.actions.setQueryError(r.revisionQueryError);
      a.dialogs.actions.set('search', session.showSearch);
    }
    a.revisionQuery.actions.setLoadingMore(false);
    a.revisionQuery.actions.setSearchingDateTime(false);
    a.revisionQuery.actions.setSwitching(false);
  }, [clearActive, saveActive]);

  const closeComparison = useCallback((id: string) => {
    const a = latest.current;
    if (a.diffLoad.state.isLoadingDiff) return;
    const data = id === activeIdRef.current ? a.currentDiffDataRef.current : saved.current.get(id)?.data;
    if (id === activeIdRef.current) {
      const index = tabs.findIndex(tab => tab.id === id);
      const neighbor = tabs[index + 1] ?? tabs[index - 1];
      selectComparison(neighbor?.id ?? null);
    }
    saved.current.delete(id);
    setTabs(previous => previous.filter(tab => tab.id !== id));
    const artifactSessionId = data?.comparisonSessionId ?? data?.workbookArtifact?.comparisonSessionId;
    if (artifactSessionId) releaseWorkbookArtifactSession(artifactSessionId);
    if (data?.comparisonSessionId) {
      void window.versora?.releaseSessionResources?.(data.comparisonSessionId);
    }
  }, [selectComparison, tabs]);

  const applyBackgroundLineBlame = useCallback((data: DiffData, payload: LineBlamePayload) => {
    const a = latest.current;
    if (matchesData(a.currentDiffDataRef.current, data)) {
      useAppStore.getState().setDiffLines(lines => attachLineBlameToDiffLines(lines, payload));
      return;
    }
    for (const session of saved.current.values()) {
      if (matchesData(session.data, data)) {
        session.state.diffLines = attachLineBlameToDiffLines(session.state.diffLines, payload);
      }
    }
  }, []);

  const applyBackgroundMetadata = useCallback((data: DiffData, payload: WorkbookMetadataPayload) => {
    const a = latest.current;
    if (matchesData(a.currentDiffDataRef.current, data)) {
      a.currentDiffDataRef.current = mergeWorkbookMetadataPayload(a.currentDiffDataRef.current!, payload);
      useAppStore.getState().hydrateWorkbookMetadataState({ baseWorkbookMetadata: payload.base, mineWorkbookMetadata: payload.mine });
      return;
    }
    for (const session of saved.current.values()) {
      if (matchesData(session.data, data)) {
        session.data = mergeWorkbookMetadataPayload(session.data!, payload);
        session.state.baseWorkbookMetadata = payload.base;
        session.state.mineWorkbookMetadata = payload.mine;
      }
    }
  }, []);

  return { tabs, activeId, activeIdRef, restoredNavigation, openComparison, selectComparison, closeComparison, applyBackgroundLineBlame, applyBackgroundMetadata };
}
