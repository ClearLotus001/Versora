import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import useDiffLoader from '../src/hooks/app/useDiffLoader';
import { buildE2EWorkbookDiffData, buildE2EDiffData } from '../src/utils/app/e2eBridge';
import { activateWorkbookArtifact, getActiveWorkbookArtifactProvider, releaseWorkbookArtifactSession } from '../src/utils/workbook/workbookArtifactProvider';
import { useAppStore } from '../src/store/appStore';
import { createEmptyTextLayoutSnapshots } from '../src/utils/diff/textLayoutState';
import { createEmptyWorkbookLayoutSnapshots } from '../src/utils/workbook/workbookLayoutState';
import { createWorkbookSelectionState } from '../src/utils/workbook/workbookSelectionState';
import type { DiffData, DiffLine } from '../src/types';

type LoaderArgs = Parameters<typeof useDiffLoader>[0];

test('text reloads retain the active workbook on failure or supersession and clear it only on commit', async (context) => {
  // Run the real loader and store; scheduling is separate from the artifact ownership contract.
  context.mock.method(React, 'useCallback', <T>(callback: T) => callback);
  context.mock.method(React, 'useRef', <T>(current: T) => ({ current }));
  context.mock.method(React, 'useSyncExternalStore', (_subscribe: unknown, snapshot: () => unknown) => snapshot());
  context.mock.method(React, 'useDebugValue', () => {});
  class ControlledWorker {
    static instances: ControlledWorker[] = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    request: { requestId: number } | null = null;
    constructor() { ControlledWorker.instances.push(this); }
    postMessage(request: { requestId: number }) { this.request = request; }
    terminate() {}
    respond(diffLines: DiffLine[]) {
      this.onmessage!({ data: { requestId: this.request!.requestId, ok: true, diffLines } });
    }
  }
  const previousWindow = globalThis.window;
  const previousWorker = globalThis.Worker;
  Object.assign(globalThis, { window: { location: { search: '' } }, Worker: ControlledWorker });
  const workbook = buildE2EWorkbookDiffData({ baseContent: '@@sheet\tSheet\n@@row\t1\tBefore', mineContent: '@@sheet\tSheet\n@@row\t1\tAfter' });
  const descriptor = workbook.workbookArtifact!;
  const provider = activateWorkbookArtifact(descriptor);
  const currentDiffDataRef = { current: workbook as DiffData | null };
  const loadSeqRef = { current: 0 };
  const errors: string[] = [];
  const noop = () => {};
  const args: LoaderArgs = {
    onOpenComparison: noop, onBackgroundLineBlame: noop,
    currentDiffDataRef, loadSeqRef, hasLoadedDiffRef: { current: true }, workbookCompareModeRef: { current: 'strict' },
    diffResultCacheRef: { current: new Map() }, textLayoutSnapshotsRef: { current: createEmptyTextLayoutSnapshots() },
    textSharedExpandedBlocksRef: { current: {} },
    workbookLayoutSnapshotsRef: { current: createEmptyWorkbookLayoutSnapshots() },
    workbookSharedExpandedBlocksRef: { current: new Map() }, revisionQuerySeqRef: { current: 0 },
    dialogs: { state: { showSearch: false, showGoto: false, showHelp: false, showAbout: false, showSvnConfig: false, showLocalFileCompare: false },
      actions: { set: noop, open: noop, close: noop, toggle: noop, closeAll: noop } },
    diffLoad: { state: { isLoadingDiff: false, hasLoadedDiff: true, loadPhase: 'ready', loadError: '', loadPerfMetrics: null },
      actions: { setLoading: noop, setLoaded: noop, setPhase: noop, setError: (value) => { if (typeof value === 'string') errors.push(value); }, setMetrics: noop } },
    revisionQuery: { state: { revisionOptionsStatus: 'idle', revisionHasMore: false, revisionNextBeforeId: null, revisionQueryDateTime: '', revisionQueryError: '', isLoadingMoreRevisions: false, isSearchingRevisionDateTime: false, isSwitchingRevisions: false },
      actions: { setStatus: noop, setHasMore: noop, setNextBeforeId: noop, setQueryDateTime: noop, setQueryError: noop, setLoadingMore: noop, setSearchingDateTime: noop, setSwitching: noop } },
    workbookUi: { state: { selection: createWorkbookSelectionState(null), hiddenStateBySheet: {}, contextMenu: null, freezeBySheet: {}, columnWidthBySheet: {}, activeSheetName: 'Sheet', showHiddenColumns: false, showOnlyDifferences: false },
      actions: { setSelection: noop, setHiddenStateBySheet: noop, setContextMenu: noop, setFreezeBySheet: noop, setColumnWidthBySheet: noop, setActiveSheetName: noop, setShowHiddenColumns: noop, setShowOnlyDifferences: noop } },
  };
  const loader = useDiffLoader(args);
  const text = { ...buildE2EDiffData({ fileName: 'text.txt', baseContent: 'before', mineContent: 'after' }), analysisSnapshotsByMode: null };
  try {
    const failed = loader.applyDiffData(text, { loadingAlreadyStarted: true });
    assert.equal(getActiveWorkbookArtifactProvider(), provider);
    ControlledWorker.instances.at(-1)!.onerror!({ message: 'Injected text failure' });
    await failed;
    assert.equal(errors.at(-1), 'Injected text failure');
    assert.equal(currentDiffDataRef.current, workbook);
    assert.equal(getActiveWorkbookArtifactProvider(), provider);

    const superseded = loader.applyDiffData(text, { loadingAlreadyStarted: true });
    loadSeqRef.current += 1;
    ControlledWorker.instances.at(-1)!.respond([]);
    await superseded;
    assert.equal(currentDiffDataRef.current, workbook);
    assert.equal(getActiveWorkbookArtifactProvider(), provider);

    const loaded = loader.applyDiffData(text, { loadingAlreadyStarted: true });
    assert.equal(getActiveWorkbookArtifactProvider(), provider);
    ControlledWorker.instances.at(-1)!.respond([]);
    await loaded;
    assert.equal(currentDiffDataRef.current?.fileName, 'text.txt');
    assert.equal(useAppStore.getState().fileName, 'text.txt');
    assert.equal(getActiveWorkbookArtifactProvider(), null);

    activateWorkbookArtifact(descriptor);
    await loader.applyDiffData(text, { loadingAlreadyStarted: true });
    assert.equal(getActiveWorkbookArtifactProvider(), null, 'a cached text commit also clears the active workbook');

    activateWorkbookArtifact(descriptor);
    await loader.applyDiffData(buildE2EDiffData({ fileName: 'prepared.txt', baseContent: 'before', mineContent: 'after' }), { loadingAlreadyStarted: true });
    assert.equal(getActiveWorkbookArtifactProvider(), null, 'a prepared text commit also clears the active workbook');
  } finally {
    ControlledWorker.instances.at(-1)?.onerror?.({ message: 'Test teardown' });
    releaseWorkbookArtifactSession(descriptor.comparisonSessionId);
    Object.assign(globalThis, { window: previousWindow, Worker: previousWorker });
  }
});
