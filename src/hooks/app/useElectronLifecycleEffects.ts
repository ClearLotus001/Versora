import { useEffect, type MutableRefObject } from 'react';

import type { LaunchContextPayload } from '@/types';
import { debugLog } from '@/hooks/app/helpers';
import type { DiffLoadController, RevisionQueryController } from '@/hooks/app/contracts';
import { useAppStore } from '@/store/appStore';

interface UseElectronLifecycleEffectsArgs {
  reloadCliDiffData: () => Promise<void>;
  onLaunchedAfterUpdate?: (version: string) => void;
  loadSeqRef: MutableRefObject<number>;
  revisionQuerySeqRef: MutableRefObject<number>;
  diffLoad: DiffLoadController;
  revisionQuery: RevisionQueryController;
}

export default function useElectronLifecycleEffects({
  reloadCliDiffData,
  onLaunchedAfterUpdate,
  loadSeqRef,
  revisionQuerySeqRef,
  diffLoad,
  revisionQuery,
}: UseElectronLifecycleEffectsArgs) {
  // ── Read setters directly from Zustand store ──────────────────────────
  const setIsElectron = useAppStore((s) => s.setIsElectron);
  const setRevisionOptions = useAppStore((s) => s.setRevisionOptions);
  const setDiffSourceNoticeCode = useAppStore((s) => s.setDiffSourceNoticeCode);
  const setCompareContext = useAppStore((s) => s.setCompareContext);
  const setResetPair = useAppStore((s) => s.setResetPair);
  const setLaunchBaseName = useAppStore((s) => s.setLaunchBaseName);
  const setLaunchMineName = useAppStore((s) => s.setLaunchMineName);
  const setIsDevMode = useAppStore((s) => s.setIsDevMode);
  const setUsesNativeWindowControls = useAppStore((s) => s.setUsesNativeWindowControls);
  const setIsWindowMaximized = useAppStore((s) => s.setIsWindowMaximized);
  const setAppUpdateState = useAppStore((s) => s.setAppUpdateState);

  const { actions: diffLoadActions } = diffLoad;
  const { actions: revisionQueryActions } = revisionQuery;

  useEffect(() => {
    let cancelled = false;

    const inferRendererDevMode = async () => {
      const isHttpDev = typeof window !== 'undefined'
        && (window.location.protocol === 'http:' || window.location.protocol === 'https:')
        && /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);
      if (isHttpDev) {
        setIsDevMode(true);
        return;
      }

      if (!window.versora?.isDevMode) return;
      try {
        const nextIsDevMode = await window.versora.isDevMode();
        if (!cancelled) {
          setIsDevMode(Boolean(nextIsDevMode));
        }
      } catch {
        // Ignore bridge dev-mode probe failures and keep the current state.
      }
    };

    void inferRendererDevMode();
    return () => {
      cancelled = true;
    };
  }, [setIsDevMode]);

  useEffect(() => {
    let cancelled = false;
    debugLog('electron-lifecycle:bootstrap-effect:start');

    const applyEmptyLaunchState = (seq: number) => {
      if (seq !== loadSeqRef.current) return;
      debugLog('electron-lifecycle:apply-empty-launch-state', { seq });
      diffLoadActions.setLoading(false);
      diffLoadActions.setLoaded(false);
      diffLoadActions.setPhase('idle');
      diffLoadActions.setError('');
      diffLoadActions.setMetrics(null);
      revisionQuerySeqRef.current += 1;
      setRevisionOptions([]);
      revisionQueryActions.setStatus('idle');
      revisionQueryActions.setHasMore(false);
      revisionQueryActions.setNextBeforeId(null);
      revisionQueryActions.setQueryDateTime('');
      revisionQueryActions.setQueryError('');
      revisionQueryActions.setLoadingMore(false);
      revisionQueryActions.setSearchingDateTime(false);
      setDiffSourceNoticeCode(null);
      setCompareContext('literal_two_file_compare');
      setResetPair(null);
      setLaunchBaseName('');
      setLaunchMineName('');
    };

    const applyLaunchContext = (launchContext: LaunchContextPayload) => {
      setIsDevMode(Boolean(launchContext.isDevMode));
      setUsesNativeWindowControls(Boolean(launchContext.usesNativeWindowControls));
      setIsWindowMaximized(Boolean(launchContext.windowFrameState?.isMaximized));
      setAppUpdateState(launchContext.updateState);
      if (launchContext.launchedAfterUpdate) {
        onLaunchedAfterUpdate?.(launchContext.updateState.currentVersion);
      }
    };

    const loadData = async () => {
      debugLog('electron-lifecycle:load-data:start');
      const bridge = window.versora;
      if (!bridge) {
        if (!cancelled) {
          debugLog('electron-lifecycle:bridge-missing');
          setIsElectron(false);
          diffLoadActions.setLoaded(false);
          diffLoadActions.setPhase('error');
          diffLoadActions.setError('Electron bridge is unavailable.');
          diffLoadActions.setMetrics(null);
        }
        return;
      }

      setIsElectron(true);

      let seq = 0;
      try {
        seq = loadSeqRef.current;
        debugLog('electron-lifecycle:get-launch-context:request', { seq });
        const launchContext = await bridge.getLaunchContext();
        debugLog('electron-lifecycle:get-launch-context:resolved', {
          seq,
          cancelled,
          currentSeq: loadSeqRef.current,
        });
        if (cancelled) return;

        applyLaunchContext(launchContext);

        if (!launchContext.hasDiffRequest) {
          applyEmptyLaunchState(seq);
          return;
        }

        // Startup and subsequent CLI events share the same request queue, so
        // neither path can consume or replace the other path's comparison.
        await reloadCliDiffData();
      } catch (error) {
        if (!cancelled && seq === loadSeqRef.current) {
          debugLog('electron-lifecycle:load-data:error', {
            seq,
            message: error instanceof Error ? error.message : String(error),
          });
          diffLoadActions.setLoading(false);
          diffLoadActions.setLoaded(false);
          diffLoadActions.setPhase('error');
          diffLoadActions.setError(error instanceof Error ? error.message : String(error));
          revisionQuerySeqRef.current += 1;
          revisionQueryActions.setStatus('error');
          revisionQueryActions.setQueryError(error instanceof Error ? error.message : String(error));
          setDiffSourceNoticeCode(null);
          setCompareContext('literal_two_file_compare');
          setResetPair(null);
          setLaunchBaseName('');
          setLaunchMineName('');
        }
      }

    };

    void loadData();
    return () => {
      cancelled = true;
      debugLog('electron-lifecycle:bootstrap-effect:cleanup');
    };
  }, [
    diffLoadActions,
    loadSeqRef,
    revisionQuerySeqRef,
    revisionQueryActions,
    reloadCliDiffData,
    setAppUpdateState,
    setCompareContext,
    setDiffSourceNoticeCode,
    setIsDevMode,
    setIsElectron,
    setIsWindowMaximized,
    setLaunchBaseName,
    setLaunchMineName,
    onLaunchedAfterUpdate,
    setResetPair,
    setRevisionOptions,
    setUsesNativeWindowControls,
  ]);

  useEffect(() => {
    if (!window.versora?.onCliArgsUpdated) return;
    return window.versora.onCliArgsUpdated(() => {
      void reloadCliDiffData();
    });
  }, [reloadCliDiffData]);

  useEffect(() => {
    if (!window.versora?.onWindowFrameStateChanged) return;

    let cancelled = false;
    const unsubscribe = window.versora.onWindowFrameStateChanged((nextState) => {
      if (cancelled) return;
      setIsWindowMaximized(Boolean(nextState?.isMaximized));
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [setIsWindowMaximized]);

  useEffect(() => {
    if (!window.versora?.onAppUpdateState) return;

    let cancelled = false;
    const unsubscribe = window.versora.onAppUpdateState((nextState) => {
      if (cancelled) return;
      setAppUpdateState(nextState);
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [setAppUpdateState]);

}
