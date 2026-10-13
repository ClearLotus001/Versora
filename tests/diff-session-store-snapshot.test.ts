import test from 'node:test';
import assert from 'node:assert/strict';

import { captureDiffSessionState, useAppStore } from '../src/store/appStore';
import { createWorkbookSelectionState } from '../src/utils/workbook/workbookSelectionState';

test('comparison snapshots restore independent file, revision, search, and workbook views', () => {
  const originalState = useAppStore.getState();
  try {
    const revision = {
      id: 'r42', revision: '42', title: 'r42', author: 'Alice',
      date: '2026-10-13', message: 'Update inventory', kind: 'revision' as const,
    };
    const selection = createWorkbookSelectionState({
      kind: 'cell', sheetName: 'Inventory', side: 'mine', versionLabel: 'r42',
      rowNumber: 7, colIndex: 2, colLabel: 'C', address: 'C7', value: '12', formula: '',
    });
    useAppStore.setState({
      layout: 'split-v', collapseCtx: true, showOnlyDifferences: true,
      diffTypeFilter: 'modify', showWhitespace: true, showHiddenColumns: false,
      workbookCompareMode: 'content', textSplitHeaderRatio: 0.65,
      fileName: 'inventory.xlsx', baseName: 'inventory@r41.xlsx', mineName: 'inventory@r42.xlsx',
      launchBaseName: 'inventory@r41.xlsx', launchMineName: 'inventory@r42.xlsx',
      diffLines: [{
        type: 'add', base: null, mine: '12', baseLineNo: null, mineLineNo: 7,
        baseCharSpans: null, mineCharSpans: null,
      }],
      artifactNoticeDismissed: true,
      workbookArtifactDiff: { hasArtifactOnlyDiff: true, kind: 'binary-only', baseBytes: 10, mineBytes: 12 },
      diffSourceNoticeDismissed: true,
      searchQ: '12', searchRx: true, searchCs: true, searchWorkbookScope: 'all',
      activeSearchIdx: 3, searchJumpNonce: 8, hunkIdx: 2, guidedPulseNonce: 5,
      compareContext: 'revision_vs_revision_compare',
      resetPair: { baseRevisionId: 'r41', mineRevisionId: 'r42' },
      revisionOptions: [revision], baseRevisionInfo: revision, mineRevisionInfo: revision,
      canSwitchRevisions: true, revisionSwitchableSides: { base: true, mine: false },
      activeWorkbookSheetName: 'Inventory', workbookSelection: selection,
      workbookHiddenStateBySheet: { Inventory: { hiddenRows: [8], hiddenColumns: [3] } },
      workbookFreezeBySheet: { Inventory: { rowNumber: 2, colCount: 1 } },
      workbookColumnWidthBySheet: { Inventory: { 2: 220 } },
      workbookContextMenu: { anchorPoint: { x: 80, y: 120 }, selection },
      baseWorkbookMetadata: { sheets: { Inventory: { name: 'Inventory', hiddenColumns: [3], mergeRanges: [] } } },
      mineWorkbookMetadata: { sheets: { Inventory: { name: 'Inventory', hiddenColumns: [4], mergeRanges: [] } } },
    });
    const inventory = captureDiffSessionState(useAppStore.getState());

    useAppStore.getState().resetDiffSessionToHome();
    useAppStore.setState({
      fileName: 'notes.txt', baseName: 'notes@r1.txt', mineName: 'notes@r2.txt',
      diffLines: [{
        type: 'delete', base: 'obsolete', mine: null, baseLineNo: 1, mineLineNo: null,
        baseCharSpans: null, mineCharSpans: null,
      }],
      layout: 'unified', collapseCtx: false, showOnlyDifferences: false,
      showWhitespace: false, showHiddenColumns: true, workbookCompareMode: 'strict',
      textSplitHeaderRatio: 0.5, searchQ: 'obsolete', hunkIdx: 0,
    });
    const notes = captureDiffSessionState(useAppStore.getState());

    useAppStore.getState().restoreDiffSessionState(inventory);
    assert.deepEqual(captureDiffSessionState(useAppStore.getState()), inventory);
    assert.equal(useAppStore.getState().diffLines, inventory.diffLines, 'switching keeps the cached diff without copying it');

    useAppStore.getState().setSearchQ('changed after restore');
    useAppStore.getState().setWorkbookHiddenStateBySheet({ Inventory: { hiddenRows: [99], hiddenColumns: [] } });
    assert.equal(inventory.searchQ, '12');
    assert.deepEqual(inventory.workbookHiddenStateBySheet.Inventory?.hiddenRows, [8]);
    assert.equal(notes.searchQ, 'obsolete');

    useAppStore.getState().restoreDiffSessionState(notes);
    assert.deepEqual(captureDiffSessionState(useAppStore.getState()), notes);
    assert.equal(useAppStore.getState().workbookSelection.primary, null);
    assert.deepEqual(useAppStore.getState().revisionOptions, []);

    useAppStore.getState().restoreDiffSessionState(inventory);
    assert.deepEqual(captureDiffSessionState(useAppStore.getState()), inventory);
  } finally {
    useAppStore.setState(originalState, true);
  }
});

test('comparison snapshot capture and restore exclude global settings, environment, and actions', () => {
  const originalState = useAppStore.getState();
  try {
    const snapshot = captureDiffSessionState(originalState);
    const excludedKeys = [
      'themeKey', 'fontSize', 'botEnabled', 'isElectron', 'isDevMode',
      'usesNativeWindowControls', 'isWindowMaximized', 'appUpdateState',
      'svnDiffViewerStatus', 'isLoadingSvnDiffViewerStatus', 'applyingSvnDiffViewerScope',
      'isRestoringSvnDiffViewerDefault', 'svnDiffViewerError',
    ];
    for (const key of excludedKeys) assert.equal(key in snapshot, false, key);
    assert.ok(Object.values(snapshot).every((value) => typeof value !== 'function'));

    useAppStore.setState({
      themeKey: 'hc', fontSize: 19, botEnabled: !originalState.botEnabled,
      isElectron: true, isDevMode: true, usesNativeWindowControls: true,
      isWindowMaximized: true, svnDiffViewerError: 'Keep global configuration',
      isLoadingSvnDiffViewerStatus: true,
    });
    const globalState = useAppStore.getState();
    // Runtime callers may pass a wider object. Restore still applies only the
    // session fields instead of overwriting a global preference or action.
    const widerSnapshot = { ...snapshot, themeKey: 'dark' as const, setThemeKey: () => {} };
    globalState.restoreDiffSessionState(widerSnapshot);
    const restored = useAppStore.getState();
    for (const key of excludedKeys) {
      assert.equal(restored[key as keyof typeof restored], globalState[key as keyof typeof globalState], key);
    }
    assert.equal(restored.setThemeKey, originalState.setThemeKey);
    assert.equal(restored.restoreDiffSessionState, originalState.restoreDiffSessionState);
  } finally {
    useAppStore.setState(originalState, true);
  }
});
