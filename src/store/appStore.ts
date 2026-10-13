// ─────────────────────────────────────────────────────────────────────────────
// src/store/appStore.ts — Centralized Zustand store for app-level state
//
// Replaces the ~48 useState declarations previously scattered across App.tsx.
// State is organized into domain slices for maintainability.
//
// Usage:
//   import { useAppStore } from '@/store/appStore';
//   const themeKey = useAppStore((s) => s.themeKey);
//   const setThemeKey = useAppStore((s) => s.setThemeKey);
// ─────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import type { SetStateAction } from 'react';

import type {
  AppUpdateState,
  CompareContext,
  DiffTypeFilter,
  DiffLine,
  DiffSourceNoticeCode,
  LayoutMode,
  RevisionSelectionPair,
  SvnDiffViewerScope,
  SvnDiffViewerStatus,
  SvnRevisionInfo,
  ThemeKey,
  WorkbookArtifactDiff,
  WorkbookCompareMode,
  WorkbookHiddenStateBySheet,
  WorkbookMetadataMap,
  WorkbookSelectionState,
} from '@/types';
import { getStoredAppSettings } from '@/utils/app/settings';
import { createWorkbookSelectionState } from '@/utils/workbook/workbookSelectionState';
import type { WorkbookColumnWidthBySheet } from '@/utils/workbook/workbookColumnWidths';
import type { WorkbookContextMenuState, WorkbookFreezeStateMap } from '@/hooks/app/types';


// ── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve React-style SetStateAction (value or updater function). */
function resolve<T>(prev: T, action: SetStateAction<T>): T {
  return typeof action === 'function' ? (action as (prevState: T) => T)(prev) : action;
}

/** Create a standard setter that supports both direct values and updater functions. */
function setter<K extends keyof AppState>(
  set: (fn: (state: AppState) => AppState | Partial<AppState>) => void,
  key: K,
): (value: SetStateAction<AppState[K]>) => void {
  return (value) => set((state) => {
    const nextValue = resolve(state[key], value);
    if (Object.is(nextValue, state[key])) return state;
    return { [key]: nextValue } as Partial<AppState>;
  });
}


// ── State & Actions ─────────────────────────────────────────────────────────

// ---- UI Settings (persisted) ----
interface UiSettingsSlice {
  themeKey: ThemeKey;
  layout: LayoutMode;
  collapseCtx: boolean;
  showOnlyDifferences: boolean;
  diffTypeFilter: DiffTypeFilter;
  showWhitespace: boolean;
  showHiddenColumns: boolean;
  botEnabled: boolean;
  fontSize: number;
  workbookCompareMode: WorkbookCompareMode;
  setThemeKey: (v: SetStateAction<ThemeKey>) => void;
  setLayout: (v: SetStateAction<LayoutMode>) => void;
  setCollapseCtx: (v: SetStateAction<boolean>) => void;
  setShowOnlyDifferences: (v: SetStateAction<boolean>) => void;
  setDiffTypeFilter: (v: SetStateAction<DiffTypeFilter>) => void;
  setShowWhitespace: (v: SetStateAction<boolean>) => void;
  setShowHiddenColumns: (v: SetStateAction<boolean>) => void;
  setBotEnabled: (v: SetStateAction<boolean>) => void;
  setFontSize: (v: SetStateAction<number>) => void;
  setWorkbookCompareMode: (v: SetStateAction<WorkbookCompareMode>) => void;
}

interface SplitHeaderUiSlice {
  textSplitHeaderRatio: number;
  setTextSplitHeaderRatio: (v: SetStateAction<number>) => void;
}

// ---- Diff Data ----
interface DiffDataSlice {
  diffLines: DiffLine[];
  diffSourceNoticeCode: DiffSourceNoticeCode | null;
  diffSourceNoticeDismissed: boolean;
  workbookArtifactDiff: WorkbookArtifactDiff | null;
  artifactNoticeDismissed: boolean;
  setDiffLines: (v: SetStateAction<DiffLine[]>) => void;
  setDiffSourceNoticeCode: (v: SetStateAction<DiffSourceNoticeCode | null>) => void;
  setDiffSourceNoticeDismissed: (v: SetStateAction<boolean>) => void;
  setWorkbookArtifactDiff: (v: SetStateAction<WorkbookArtifactDiff | null>) => void;
  setArtifactNoticeDismissed: (v: SetStateAction<boolean>) => void;
}

// ---- File Names ----
interface FileNamesSlice {
  baseName: string;
  mineName: string;
  launchBaseName: string;
  launchMineName: string;
  fileName: string;
  setBaseName: (v: SetStateAction<string>) => void;
  setMineName: (v: SetStateAction<string>) => void;
  setLaunchBaseName: (v: SetStateAction<string>) => void;
  setLaunchMineName: (v: SetStateAction<string>) => void;
  setFileName: (v: SetStateAction<string>) => void;
}

// ---- Search ----
interface SearchSlice {
  searchQ: string;
  searchRx: boolean;
  searchCs: boolean;
  searchWorkbookScope: 'all' | 'sheet';
  activeSearchIdx: number;
  searchJumpNonce: number;
  setSearchQ: (v: SetStateAction<string>) => void;
  setSearchRx: (v: SetStateAction<boolean>) => void;
  setSearchCs: (v: SetStateAction<boolean>) => void;
  setSearchWorkbookScope: (v: SetStateAction<'all' | 'sheet'>) => void;
  setActiveSearchIdx: (v: SetStateAction<number>) => void;
  setSearchJumpNonce: (v: SetStateAction<number>) => void;
  resetSearchState: () => void;
}

// ---- Navigation ----
interface NavigationSlice {
  hunkIdx: number;
  guidedPulseNonce: number;
  setHunkIdx: (v: SetStateAction<number>) => void;
  setGuidedPulseNonce: (v: SetStateAction<number>) => void;
}

// ---- Electron Environment ----
interface ElectronEnvSlice {
  isElectron: boolean;
  isDevMode: boolean;
  usesNativeWindowControls: boolean;
  isWindowMaximized: boolean;
  setIsElectron: (v: SetStateAction<boolean>) => void;
  setIsDevMode: (v: SetStateAction<boolean>) => void;
  setUsesNativeWindowControls: (v: SetStateAction<boolean>) => void;
  setIsWindowMaximized: (v: SetStateAction<boolean>) => void;
}

// ---- SVN Revision ----
interface RevisionSlice {
  compareContext: CompareContext;
  resetPair: RevisionSelectionPair | null;
  revisionOptions: SvnRevisionInfo[];
  baseRevisionInfo: SvnRevisionInfo | null;
  mineRevisionInfo: SvnRevisionInfo | null;
  canSwitchRevisions: boolean;
  revisionSwitchableSides: { base: boolean; mine: boolean };
  setCompareContext: (v: SetStateAction<CompareContext>) => void;
  setResetPair: (v: SetStateAction<RevisionSelectionPair | null>) => void;
  setRevisionOptions: (v: SetStateAction<SvnRevisionInfo[]>) => void;
  setBaseRevisionInfo: (v: SetStateAction<SvnRevisionInfo | null>) => void;
  setMineRevisionInfo: (v: SetStateAction<SvnRevisionInfo | null>) => void;
  setCanSwitchRevisions: (v: SetStateAction<boolean>) => void;
  setRevisionSwitchableSides: (v: SetStateAction<{ base: boolean; mine: boolean }>) => void;
}

// ---- Workbook UI ----
interface WorkbookUiSlice {
  workbookSelection: WorkbookSelectionState;
  workbookHiddenStateBySheet: WorkbookHiddenStateBySheet;
  workbookContextMenu: WorkbookContextMenuState | null;
  workbookFreezeBySheet: WorkbookFreezeStateMap;
  workbookColumnWidthBySheet: WorkbookColumnWidthBySheet;
  activeWorkbookSheetName: string | null;
  baseWorkbookMetadata: WorkbookMetadataMap | null;
  mineWorkbookMetadata: WorkbookMetadataMap | null;
  setWorkbookSelection: (v: SetStateAction<WorkbookSelectionState>) => void;
  setWorkbookHiddenStateBySheet: (v: SetStateAction<WorkbookHiddenStateBySheet>) => void;
  setWorkbookContextMenu: (v: SetStateAction<WorkbookContextMenuState | null>) => void;
  setWorkbookFreezeBySheet: (v: SetStateAction<WorkbookFreezeStateMap>) => void;
  setWorkbookColumnWidthBySheet: (v: SetStateAction<WorkbookColumnWidthBySheet>) => void;
  setActiveWorkbookSheetName: (v: SetStateAction<string | null>) => void;
  setBaseWorkbookMetadata: (v: SetStateAction<WorkbookMetadataMap | null>) => void;
  setMineWorkbookMetadata: (v: SetStateAction<WorkbookMetadataMap | null>) => void;
}

// ---- App Update ----
interface AppUpdateSlice {
  appUpdateState: AppUpdateState | null;
  setAppUpdateState: (v: SetStateAction<AppUpdateState | null>) => void;
}

// ---- SVN Diff Viewer Config ----
interface SvnDiffViewerSlice {
  svnDiffViewerStatus: SvnDiffViewerStatus | null;
  isLoadingSvnDiffViewerStatus: boolean;
  applyingSvnDiffViewerScope: SvnDiffViewerScope | null;
  isRestoringSvnDiffViewerDefault: boolean;
  svnDiffViewerError: string;
  setSvnDiffViewerStatus: (v: SetStateAction<SvnDiffViewerStatus | null>) => void;
  setIsLoadingSvnDiffViewerStatus: (v: SetStateAction<boolean>) => void;
  setApplyingSvnDiffViewerScope: (v: SetStateAction<SvnDiffViewerScope | null>) => void;
  setIsRestoringSvnDiffViewerDefault: (v: SetStateAction<boolean>) => void;
  setSvnDiffViewerError: (v: SetStateAction<string>) => void;
}

export interface LoadedDiffSessionPayload {
  baseName: string;
  mineName: string;
  launchBaseName: string;
  launchMineName: string;
  fileName: string;
  workbookCompareMode: WorkbookCompareMode;
  preservedWorkbookViewState?: {
    activeWorkbookSheetName: string | null;
    workbookHiddenStateBySheet: WorkbookHiddenStateBySheet;
    workbookFreezeBySheet: WorkbookFreezeStateMap;
    workbookColumnWidthBySheet: WorkbookColumnWidthBySheet;
  } | null;
  diffLines: DiffLine[];
  diffSourceNoticeCode: DiffSourceNoticeCode | null;
  workbookArtifactDiff: WorkbookArtifactDiff | null;
  baseWorkbookMetadata: WorkbookMetadataMap | null;
  mineWorkbookMetadata: WorkbookMetadataMap | null;
  revisionOptions: SvnRevisionInfo[];
  baseRevisionInfo: SvnRevisionInfo | null;
  mineRevisionInfo: SvnRevisionInfo | null;
  compareContext: CompareContext;
  resetPair: RevisionSelectionPair | null;
  canSwitchRevisions: boolean;
  revisionSwitchableSides?: { base: boolean; mine: boolean };
}

export interface WorkbookMetadataStatePayload {
  baseWorkbookMetadata: WorkbookMetadataMap | null;
  mineWorkbookMetadata: WorkbookMetadataMap | null;
}

interface DiffSessionHydrationSlice {
  hydrateLoadedDiffSession: (payload: LoadedDiffSessionPayload) => void;
  hydrateWorkbookMetadataState: (payload: WorkbookMetadataStatePayload) => void;
  restoreDiffSessionState: (snapshot: DiffSessionStoreSnapshot) => void;
  resetDiffSessionToHome: () => void;
}


// ── Combined Store Type ─────────────────────────────────────────────────────

export type AppState =
  & UiSettingsSlice
  & SplitHeaderUiSlice
  & DiffDataSlice
  & FileNamesSlice
  & SearchSlice
  & NavigationSlice
  & ElectronEnvSlice
  & RevisionSlice
  & WorkbookUiSlice
  & AppUpdateSlice
  & SvnDiffViewerSlice
  & DiffSessionHydrationSlice;

// Comparison tabs retain only their own data and view settings. The large diff
// and metadata objects stay shared by reference because store updates replace
// those values; copying them on every tab switch would duplicate entire files.
const DIFF_SESSION_STATE_KEYS = [
  'layout',
  'collapseCtx',
  'showOnlyDifferences',
  'diffTypeFilter',
  'showWhitespace',
  'showHiddenColumns',
  'workbookCompareMode',
  'textSplitHeaderRatio',
  'diffLines',
  'diffSourceNoticeCode',
  'diffSourceNoticeDismissed',
  'workbookArtifactDiff',
  'artifactNoticeDismissed',
  'baseName',
  'mineName',
  'launchBaseName',
  'launchMineName',
  'fileName',
  'searchQ',
  'searchRx',
  'searchCs',
  'searchWorkbookScope',
  'activeSearchIdx',
  'searchJumpNonce',
  'hunkIdx',
  'guidedPulseNonce',
  'compareContext',
  'resetPair',
  'revisionOptions',
  'baseRevisionInfo',
  'mineRevisionInfo',
  'canSwitchRevisions',
  'revisionSwitchableSides',
  'workbookSelection',
  'workbookHiddenStateBySheet',
  'workbookContextMenu',
  'workbookFreezeBySheet',
  'workbookColumnWidthBySheet',
  'activeWorkbookSheetName',
  'baseWorkbookMetadata',
  'mineWorkbookMetadata',
] as const satisfies ReadonlyArray<keyof AppState>;

export type DiffSessionStoreSnapshot = Pick<AppState, (typeof DIFF_SESSION_STATE_KEYS)[number]>;

function pickDiffSessionState(state: DiffSessionStoreSnapshot): DiffSessionStoreSnapshot {
  return Object.fromEntries(DIFF_SESSION_STATE_KEYS.map((key) => [key, state[key]])) as DiffSessionStoreSnapshot;
}

/** Capture a comparison without retaining global settings or store actions. */
export function captureDiffSessionState(state: AppState): DiffSessionStoreSnapshot {
  return pickDiffSessionState(state);
}


// ── Store Creation ──────────────────────────────────────────────────────────

const initialSettings = getStoredAppSettings();

export const useAppStore = create<AppState>()((set) => ({
  // ── UI Settings ───────────────────────────────────────────────────────
  themeKey: initialSettings.themeKey,
  layout: initialSettings.layout,
  collapseCtx: initialSettings.collapseCtx,
  showOnlyDifferences: initialSettings.showOnlyDifferences,
  diffTypeFilter: 'all',
  showWhitespace: initialSettings.showWhitespace,
  showHiddenColumns: initialSettings.showHiddenColumns,
  botEnabled: initialSettings.botEnabled,
  fontSize: initialSettings.fontSize,
  workbookCompareMode: initialSettings.workbookCompareMode,
  setThemeKey: setter(set, 'themeKey'),
  setLayout: setter(set, 'layout'),
  setCollapseCtx: setter(set, 'collapseCtx'),
  setShowOnlyDifferences: (value) => set((state) => {
    const nextValue = resolve(state.showOnlyDifferences, value);
    if (Object.is(nextValue, state.showOnlyDifferences)) return state;
    return {
      showOnlyDifferences: nextValue,
      ...(nextValue ? {
        workbookSelection: createWorkbookSelectionState(null),
        workbookContextMenu: null,
      } : {}),
    };
  }),
  setDiffTypeFilter: setter(set, 'diffTypeFilter'),
  setShowWhitespace: setter(set, 'showWhitespace'),
  setShowHiddenColumns: setter(set, 'showHiddenColumns'),
  setBotEnabled: setter(set, 'botEnabled'),
  setFontSize: setter(set, 'fontSize'),
  setWorkbookCompareMode: setter(set, 'workbookCompareMode'),
  textSplitHeaderRatio: 0.5,
  setTextSplitHeaderRatio: setter(set, 'textSplitHeaderRatio'),

  // ── Diff Data ─────────────────────────────────────────────────────────
  diffLines: [],
  diffSourceNoticeCode: null,
  diffSourceNoticeDismissed: false,
  workbookArtifactDiff: null,
  artifactNoticeDismissed: false,
  setDiffLines: setter(set, 'diffLines'),
  setDiffSourceNoticeCode: setter(set, 'diffSourceNoticeCode'),
  setDiffSourceNoticeDismissed: setter(set, 'diffSourceNoticeDismissed'),
  setWorkbookArtifactDiff: setter(set, 'workbookArtifactDiff'),
  setArtifactNoticeDismissed: setter(set, 'artifactNoticeDismissed'),

  // ── File Names ────────────────────────────────────────────────────────
  baseName: '',
  mineName: '',
  launchBaseName: '',
  launchMineName: '',
  fileName: '',
  setBaseName: setter(set, 'baseName'),
  setMineName: setter(set, 'mineName'),
  setLaunchBaseName: setter(set, 'launchBaseName'),
  setLaunchMineName: setter(set, 'launchMineName'),
  setFileName: setter(set, 'fileName'),

  // ── Search ────────────────────────────────────────────────────────────
  searchQ: '',
  searchRx: false,
  searchCs: false,
  searchWorkbookScope: 'sheet',
  activeSearchIdx: -1,
  searchJumpNonce: 0,
  setSearchQ: setter(set, 'searchQ'),
  setSearchRx: setter(set, 'searchRx'),
  setSearchCs: setter(set, 'searchCs'),
  setSearchWorkbookScope: setter(set, 'searchWorkbookScope'),
  setActiveSearchIdx: setter(set, 'activeSearchIdx'),
  setSearchJumpNonce: setter(set, 'searchJumpNonce'),
  resetSearchState: () => set((state) => ({
    searchQ: '',
    searchRx: false,
    searchCs: false,
    searchWorkbookScope: 'sheet',
    activeSearchIdx: -1,
    searchJumpNonce: state.searchJumpNonce + 1,
  })),

  // ── Navigation ────────────────────────────────────────────────────────
  hunkIdx: 0,
  guidedPulseNonce: 0,
  setHunkIdx: setter(set, 'hunkIdx'),
  setGuidedPulseNonce: setter(set, 'guidedPulseNonce'),

  // ── Electron Environment ──────────────────────────────────────────────
  isElectron: false,
  isDevMode: false,
  usesNativeWindowControls: false,
  isWindowMaximized: false,
  setIsElectron: setter(set, 'isElectron'),
  setIsDevMode: setter(set, 'isDevMode'),
  setUsesNativeWindowControls: setter(set, 'usesNativeWindowControls'),
  setIsWindowMaximized: setter(set, 'isWindowMaximized'),

  // ── SVN Revision ──────────────────────────────────────────────────────
  compareContext: 'literal_two_file_compare',
  resetPair: null,
  revisionOptions: [],
  baseRevisionInfo: null,
  mineRevisionInfo: null,
  canSwitchRevisions: false,
  revisionSwitchableSides: { base: false, mine: false },
  setCompareContext: setter(set, 'compareContext'),
  setResetPair: setter(set, 'resetPair'),
  setRevisionOptions: setter(set, 'revisionOptions'),
  setBaseRevisionInfo: setter(set, 'baseRevisionInfo'),
  setMineRevisionInfo: setter(set, 'mineRevisionInfo'),
  setCanSwitchRevisions: setter(set, 'canSwitchRevisions'),
  setRevisionSwitchableSides: setter(set, 'revisionSwitchableSides'),

  // ── Workbook UI ───────────────────────────────────────────────────────
  workbookSelection: createWorkbookSelectionState(null),
  workbookHiddenStateBySheet: {},
  workbookContextMenu: null,
  workbookFreezeBySheet: {},
  workbookColumnWidthBySheet: {},
  activeWorkbookSheetName: null,
  baseWorkbookMetadata: null,
  mineWorkbookMetadata: null,
  setWorkbookSelection: setter(set, 'workbookSelection'),
  setWorkbookHiddenStateBySheet: setter(set, 'workbookHiddenStateBySheet'),
  setWorkbookContextMenu: setter(set, 'workbookContextMenu'),
  setWorkbookFreezeBySheet: setter(set, 'workbookFreezeBySheet'),
  setWorkbookColumnWidthBySheet: setter(set, 'workbookColumnWidthBySheet'),
  setActiveWorkbookSheetName: setter(set, 'activeWorkbookSheetName'),
  setBaseWorkbookMetadata: setter(set, 'baseWorkbookMetadata'),
  setMineWorkbookMetadata: setter(set, 'mineWorkbookMetadata'),

  // ── App Update ────────────────────────────────────────────────────────
  appUpdateState: null,
  setAppUpdateState: setter(set, 'appUpdateState'),

  // ── SVN Diff Viewer Config ────────────────────────────────────────────
  svnDiffViewerStatus: null,
  isLoadingSvnDiffViewerStatus: false,
  applyingSvnDiffViewerScope: null,
  isRestoringSvnDiffViewerDefault: false,
  svnDiffViewerError: '',
  setSvnDiffViewerStatus: setter(set, 'svnDiffViewerStatus'),
  setIsLoadingSvnDiffViewerStatus: setter(set, 'isLoadingSvnDiffViewerStatus'),
  setApplyingSvnDiffViewerScope: setter(set, 'applyingSvnDiffViewerScope'),
  setIsRestoringSvnDiffViewerDefault: setter(set, 'isRestoringSvnDiffViewerDefault'),
  setSvnDiffViewerError: setter(set, 'svnDiffViewerError'),
  hydrateLoadedDiffSession: (payload) => set(() => ({
    baseName: payload.baseName,
    mineName: payload.mineName,
    launchBaseName: payload.launchBaseName,
    launchMineName: payload.launchMineName,
    fileName: payload.fileName,
    workbookCompareMode: payload.workbookCompareMode,
    diffLines: payload.diffLines,
    diffSourceNoticeCode: payload.diffSourceNoticeCode,
    diffSourceNoticeDismissed: false,
    workbookArtifactDiff: payload.workbookArtifactDiff,
    artifactNoticeDismissed: false,
    baseWorkbookMetadata: payload.baseWorkbookMetadata,
    mineWorkbookMetadata: payload.mineWorkbookMetadata,
    revisionOptions: payload.revisionOptions,
    baseRevisionInfo: payload.baseRevisionInfo,
    mineRevisionInfo: payload.mineRevisionInfo,
    compareContext: payload.compareContext,
    resetPair: payload.resetPair,
    canSwitchRevisions: payload.canSwitchRevisions,
    revisionSwitchableSides: payload.revisionSwitchableSides ?? {
      base: payload.canSwitchRevisions,
      mine: payload.canSwitchRevisions,
    },
    hunkIdx: 0,
    workbookSelection: createWorkbookSelectionState(null),
    workbookHiddenStateBySheet: payload.preservedWorkbookViewState?.workbookHiddenStateBySheet ?? {},
    workbookContextMenu: null,
    workbookFreezeBySheet: payload.preservedWorkbookViewState?.workbookFreezeBySheet ?? {},
    workbookColumnWidthBySheet: payload.preservedWorkbookViewState?.workbookColumnWidthBySheet ?? {},
    activeWorkbookSheetName: payload.preservedWorkbookViewState?.activeWorkbookSheetName ?? null,
  })),
  hydrateWorkbookMetadataState: (payload) => set(() => ({
    baseWorkbookMetadata: payload.baseWorkbookMetadata,
    mineWorkbookMetadata: payload.mineWorkbookMetadata,
  })),
  restoreDiffSessionState: (snapshot) => set(() => pickDiffSessionState(snapshot)),
  resetDiffSessionToHome: () => set((state) => ({
    diffTypeFilter: 'all',
    diffLines: [],
    diffSourceNoticeCode: null,
    diffSourceNoticeDismissed: false,
    workbookArtifactDiff: null,
    artifactNoticeDismissed: false,
    baseName: '',
    mineName: '',
    launchBaseName: '',
    launchMineName: '',
    fileName: '',
    searchQ: '',
    searchRx: false,
    searchCs: false,
    searchWorkbookScope: 'sheet',
    activeSearchIdx: -1,
    searchJumpNonce: state.searchJumpNonce + 1,
    hunkIdx: 0,
    guidedPulseNonce: state.guidedPulseNonce + 1,
    compareContext: 'literal_two_file_compare',
    resetPair: null,
    revisionOptions: [],
    baseRevisionInfo: null,
    mineRevisionInfo: null,
    canSwitchRevisions: false,
    revisionSwitchableSides: { base: false, mine: false },
    workbookSelection: createWorkbookSelectionState(null),
    workbookHiddenStateBySheet: {},
    workbookContextMenu: null,
    workbookFreezeBySheet: {},
    workbookColumnWidthBySheet: {},
    activeWorkbookSheetName: null,
    baseWorkbookMetadata: null,
    mineWorkbookMetadata: null,
  })),
}));
