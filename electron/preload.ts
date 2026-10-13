import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  WorkbookArtifactCellsRequest, WorkbookArtifactSearchRequest,
  WorkbookArtifactSourceRowsRequest, WorkbookArtifactViewRequest, WorkbookArtifactWindowRequest,
} from '../shared/workbookArtifactProtocol.js';

const versoraApi = {
  getWorkbookArtifactView: (request: WorkbookArtifactViewRequest) => ipcRenderer.invoke('workbook-artifact-view', request),
  readWorkbookArtifactWindow: (request: WorkbookArtifactWindowRequest) => ipcRenderer.invoke('workbook-artifact-window', request),
  readWorkbookArtifactCells: (request: WorkbookArtifactCellsRequest) => ipcRenderer.invoke('workbook-artifact-cells', request),
  readWorkbookArtifactSourceRows: (request: WorkbookArtifactSourceRowsRequest) => ipcRenderer.invoke('workbook-artifact-source-rows', request),
  searchWorkbookArtifact: (request: WorkbookArtifactSearchRequest) => ipcRenderer.invoke('workbook-artifact-search', request),
  cancelWorkbookArtifactSearch: (artifactId: string, requestId?: string) => ipcRenderer.invoke('workbook-artifact-cancel-search', { artifactId, requestId }),
  notifyRendererReady: () => ipcRenderer.send('renderer-ready'),
  releaseSessionResources: (comparisonSessionId?: string) => ipcRenderer.invoke('release-session-resources', { comparisonSessionId }),
  saveStartupAppearance: (appearance: { themeKey?: 'dark' | 'light' | 'hc'; locale?: 'zh-CN' | 'en-US' }) => ipcRenderer.send('save-startup-appearance', appearance),
  getLaunchContext: () => ipcRenderer.invoke('get-launch-context'),
  getDiffData: (compareMode?: 'strict' | 'content', comparisonSessionId?: string) => ipcRenderer.invoke('get-diff-data', { compareMode, comparisonSessionId }),
  loadRevisionDiff: (baseRevisionId: string, mineRevisionId: string, compareMode?: 'strict' | 'content', comparisonSessionId?: string) => ipcRenderer.invoke('load-revision-diff', { baseRevisionId, mineRevisionId, compareMode, comparisonSessionId }),
  loadTwoFileRevisionDiff: (baseRevisionId: string, mineRevisionId: string, compareMode?: 'strict' | 'content', comparisonSessionId?: string) => ipcRenderer.invoke('load-two-file-revision-diff', { baseRevisionId, mineRevisionId, compareMode, comparisonSessionId }),
  swapTwoFileDiff: (baseRevisionId: string | null, mineRevisionId: string | null, compareMode?: 'strict' | 'content', comparisonSessionId?: string) => ipcRenderer.invoke('swap-two-file-diff', { baseRevisionId, mineRevisionId, compareMode, comparisonSessionId }),
  loadLineBlame: (baseRevisionId?: string, mineRevisionId?: string, comparisonSessionId?: string) => ipcRenderer.invoke('load-line-blame', { baseRevisionId, mineRevisionId, comparisonSessionId }),
  loadWorkingCopyLineBlame: (basePath: string, minePath: string, comparisonSessionId?: string) => ipcRenderer.invoke('load-working-copy-line-blame', { basePath, minePath, comparisonSessionId }),
  loadTwoFileVersionLineBlame: (baseRevisionId: string, mineRevisionId: string, comparisonSessionId?: string) => ipcRenderer.invoke('load-two-file-version-line-blame', { baseRevisionId, mineRevisionId, comparisonSessionId }),
  getRevisionOptions: (comparisonSessionId?: string) => ipcRenderer.invoke('get-revision-options', { comparisonSessionId }),
  queryRevisionOptions: (query?: {
    limit?: number;
    beforeRevisionId?: string;
    anchorDateTime?: string;
    includeSpecials?: boolean;
    targetSide?: 'base' | 'mine';
  }, comparisonSessionId?: string) => ipcRenderer.invoke('query-revision-options', { ...query, comparisonSessionId }),
  loadWorkbookCompareMode: (compareMode: 'strict' | 'content', baseRevisionId?: string, mineRevisionId?: string, comparisonSessionId?: string) => ipcRenderer.invoke('load-workbook-compare-mode', { compareMode, baseRevisionId, mineRevisionId, comparisonSessionId }),
  loadWorkbookMetadata: (baseRevisionId?: string, mineRevisionId?: string, comparisonSessionId?: string) => ipcRenderer.invoke('load-workbook-metadata', { baseRevisionId, mineRevisionId, comparisonSessionId }),
  onCliArgsUpdated: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on('cli-args-updated', wrapped);
    return () => {
      ipcRenderer.removeListener('cli-args-updated', wrapped);
    };
  },
  isDevMode: () => ipcRenderer.invoke('is-dev-mode'),
  pickDiffFile: () => ipcRenderer.invoke('pick-diff-file'),
  pickComparableFile: (side: 'base' | 'mine', requiredExtension?: string) => ipcRenderer.invoke('pick-comparable-file', { side, requiredExtension }),
  getPathForDroppedFile: (file: File) => webUtils.getPathForFile(file),
  loadDevWorkingCopyDiff: (filePath: string, compareMode?: 'strict' | 'content', comparisonSessionId?: string) => ipcRenderer.invoke('load-dev-working-copy-diff', { filePath, compareMode, comparisonSessionId }),
  loadLocalDiff: (basePath: string, minePath: string, compareMode?: 'strict' | 'content', comparisonSessionId?: string) => ipcRenderer.invoke('load-local-diff', { basePath, minePath, compareMode, comparisonSessionId }),
  loadLocalFileDiff: (basePath: string, minePath: string, compareMode?: 'strict' | 'content', comparisonSessionId?: string) => ipcRenderer.invoke('load-local-file-diff', { basePath, minePath, compareMode, comparisonSessionId }),
  getSvnDiffViewerStatus: () => ipcRenderer.invoke('get-svn-diff-viewer-status'),
  configureSvnDiffViewer: (scope: 'all-files' | 'text-only' | 'workbook-only') => ipcRenderer.invoke('configure-svn-diff-viewer', { scope }),
  restoreSvnDefaultDiffViewerConfiguration: () => ipcRenderer.invoke('restore-svn-default-diff-viewer-configuration'),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  usesNativeWindowControls: () => ipcRenderer.invoke('uses-native-window-controls'),
  getWindowFrameState: () => ipcRenderer.invoke('get-window-frame-state'),
  onWindowFrameStateChanged: (listener: (state: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on('window-frame-state-changed', wrapped);
    return () => {
      ipcRenderer.removeListener('window-frame-state-changed', wrapped);
    };
  },
  setTitleBarOverlay: (options: { color: string; symbolColor: string; height: number }) => ipcRenderer.send('set-title-bar-overlay', options),
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  checkForAppUpdate: (options?: { manual?: boolean }) => ipcRenderer.invoke('check-app-update', options),
  downloadAppUpdate: () => ipcRenderer.invoke('download-app-update'),
  installDownloadedUpdate: () => ipcRenderer.invoke('install-downloaded-update'),
  launchUninstaller: (options?: { silent?: boolean }) => ipcRenderer.invoke('launch-uninstaller', options),
  onAppUpdateState: (listener: (state: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on('app-update-state-changed', wrapped);
    return () => {
      ipcRenderer.removeListener('app-update-state-changed', wrapped);
    };
  },
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),
  writeClipboardText: (text: string) => ipcRenderer.send('clipboard-write-text', text),
  saveDiagnosticReport: (content: string, defaultFileName?: string) => ipcRenderer.invoke('save-diagnostic-report', { content, defaultFileName }),
  debugLog: (message: string, payload?: unknown) => ipcRenderer.send('debug-log', { message, payload }),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
};

contextBridge.exposeInMainWorld('versora', versoraApi);
