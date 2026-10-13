import { app, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logMainError } from '../logging.js';
import { electronT } from '../i18n.js';
import { wasLaunchedAfterUpdateFromArgv } from '../maintenance.js';
import { AUTO_EXIT_AFTER_LOAD_MS, USE_NATIVE_WINDOW_CONTROLS } from './constants.js';
import { logDebugTiming } from './logger.js';
import {
  consumePendingLaunchDiffRequest,
  getAppUpdater,
  getHasPendingLaunchDiffRequest,
  getMainWindow,
  clearMainSessionCaches,
  createComparisonSession,
  getCurrentComparisonSessionId,
  getPendingLaunchDiffRequestCount,
  getPendingLaunchDiffSessionId,
  releaseComparisonSession,
  runInComparisonSession,
  resolveComparisonInputPath,
  resolveComparisonSourcePath,
} from './state.js';
import { clearAnalysisSnapshotCache } from './analysisSnapshotService.js';
import { getWorkbookArtifactReader, readWorkbookArtifactSourceRows, releaseWorkbookArtifacts } from './workbookArtifactService.js';
import { cancelWorkbookArtifactSearch, searchWorkbookArtifact } from './workbookSearchService.js';
import type {
  WorkbookArtifactCellsRequest, WorkbookArtifactSearchRequest,
  WorkbookArtifactSourceRowsRequest, WorkbookArtifactViewRequest, WorkbookArtifactWindowRequest,
} from '../../shared/workbookArtifactProtocol.js';
import { getStartupPalette, readStartupAppearance, writeStartupAppearance } from './startupAppearance.js';
import {
  buildDiffData,
  buildTwoFileRevisionDiffData,
  loadWorkbookCompareModeData,
  loadWorkbookMetadataData,
} from './diffBuilder.js';
import { getRevisionOptions, loadSvnLineBlame, queryRevisionOptions } from './svnOperations.js';
import {
  configureSvnDiffViewer,
  getSvnDiffViewerStatus,
  normalizeSvnDiffViewerScope,
  restoreSvnDefaultDiffViewerConfiguration,
} from '../svnDiffViewerConfig.js';
import {
  launchInstalledUninstaller,
  showMainWindow,
} from './windowManager.js';
import {
  projectTransportDiffData,
} from './transportProjection.js';
import { loadWorkingCopyLineBlame } from './workingCopyLineBlame.js';
import {
  buildSmartLocalFileDiffData,
  buildTwoFileVersionDiffData,
  clearActiveTwoFileVersionSession,
  hasActiveTwoFileVersionSession,
  loadTwoFileVersionLineBlame,
  queryTwoFileRevisionOptions,
  swapTwoFileDiff,
} from './twoFileVersionOperations.js';
import {
  getLocalFileCompareValidationIssue,
  resolveLocalFileComparePaths,
} from './localFileCompare.js';
import {
  buildGitFileRevisionDiffData,
  buildSmartWorkingCopyDiffData,
} from './gitDiffBuilder.js';
import {
  clearActiveGitWorkingFileSession,
  getActiveGitWorkingFileSession,
  getGitRevisionOptions,
  loadGitLineBlame,
  queryGitRevisionOptions,
} from './gitOperations.js';
import type {
  DiffData,
  LaunchContextPayload,
  RevisionOptionsQuery,
  TitleBarOverlayPayload,
  WorkbookCompareMode,
} from './types.js';

// ---------------------------------------------------------------------------
// Safe IPC handler wrapper
// ---------------------------------------------------------------------------

type InvokeHandler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function safeHandle(
  channel: string,
  handler: InvokeHandler,
): void {
  const wrapped: InvokeHandler = async (event, ...args: unknown[]) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logMainError(`ipc:${channel}`, 'handler error:', message);
      throw new Error(message, { cause: error });
    }
  };
  ipcMain.handle(channel, wrapped);
}

function comparisonHandle(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  mode: 'existing' | 'launch' | 'new' = 'existing',
): void {
  safeHandle(channel, async (event, ...args: unknown[]) => {
    const payload = args[0] as { comparisonSessionId?: unknown } | undefined;
    const requestedSessionId = typeof payload?.comparisonSessionId === 'string'
      ? payload.comparisonSessionId
      : undefined;
    const createdSessionId = mode === 'new' && !requestedSessionId
      ? createComparisonSession()
      : undefined;
    const sessionId = requestedSessionId
      ?? createdSessionId
      ?? (mode === 'launch' ? getPendingLaunchDiffSessionId() : undefined);
    return runInComparisonSession(sessionId, async () => {
      const currentSessionId = getCurrentComparisonSessionId();
      try {
        const result = await handler(event, ...args);
        if (result && typeof result === 'object' && 'sourceIdentity' in result) {
          const data = result as DiffData;
          return {
            ...data,
            basePath: data.basePath === undefined ? undefined : resolveComparisonSourcePath(data.basePath),
            minePath: data.minePath === undefined ? undefined : resolveComparisonSourcePath(data.minePath),
            comparisonSessionId: currentSessionId,
          };
        }
        return result;
      } catch (error) {
        if (createdSessionId) releaseComparisonSession(createdSessionId);
        throw error;
      } finally {
        if (mode === 'launch') consumePendingLaunchDiffRequest(currentSessionId);
      }
    });
  });
}

function getWindowFrameStateSnapshot() {
  return {
    isMaximized: Boolean(getMainWindow()?.isMaximized()),
  };
}

function buildLaunchContextPayload(): LaunchContextPayload {
  return {
    hasDiffRequest: getHasPendingLaunchDiffRequest(),
    pendingDiffRequestCount: getPendingLaunchDiffRequestCount(),
    isDevMode: process.env.NODE_ENV === 'development',
    usesNativeWindowControls: USE_NATIVE_WINDOW_CONTROLS,
    windowFrameState: getWindowFrameStateSnapshot(),
    launchedAfterUpdate: wasLaunchedAfterUpdateFromArgv(process.argv),
    updateState: getAppUpdater().getState(),
  };
}

function buildDiagnosticReportFileName(defaultFileName?: string): string {
  const fallbackName = `versora-renderer-error-${new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')}.log`;
  const rawName = typeof defaultFileName === 'string' && defaultFileName.trim()
    ? defaultFileName.trim()
    : fallbackName;

  return rawName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-');
}

// ---------------------------------------------------------------------------
// Register all IPC handlers
// ---------------------------------------------------------------------------

export function registerIpcHandlers(): void {
  safeHandle('workbook-artifact-view', (_, request) => {
    const payload = request as WorkbookArtifactViewRequest;
    return getWorkbookArtifactReader(payload.artifactId).getView(payload.compareMode);
  });
  safeHandle('workbook-artifact-window', (_, request) => {
    const payload = request as WorkbookArtifactWindowRequest;
    return getWorkbookArtifactReader(payload.artifactId).readWindow(payload);
  });
  safeHandle('workbook-artifact-cells', (_, request) => {
    const payload = request as WorkbookArtifactCellsRequest;
    return getWorkbookArtifactReader(payload.artifactId).readCells(payload);
  });
  safeHandle('workbook-artifact-source-rows', (_, request) => readWorkbookArtifactSourceRows(request as WorkbookArtifactSourceRowsRequest));
  safeHandle('workbook-artifact-search', (_, request) => searchWorkbookArtifact(request as WorkbookArtifactSearchRequest));
  safeHandle('workbook-artifact-cancel-search', (_, request) => {
    const payload = request as { artifactId: string; requestId?: string };
    return cancelWorkbookArtifactSearch(payload.artifactId, payload.requestId);
  });
  safeHandle('release-session-resources', async (_, ...args: unknown[]) => {
    const payload = args[0] as { comparisonSessionId?: string } | undefined;
    await releaseWorkbookArtifacts(payload?.comparisonSessionId);
    if (payload?.comparisonSessionId) {
      releaseComparisonSession(payload.comparisonSessionId);
      return;
    }
    clearMainSessionCaches();
    clearAnalysisSnapshotCache();
    clearActiveGitWorkingFileSession();
    clearActiveTwoFileVersionSession();
    releaseComparisonSession();
  });

  safeHandle('get-launch-context', async (): Promise<LaunchContextPayload> => (
    buildLaunchContextPayload()
  ));

  comparisonHandle('get-diff-data', async (_, ...args: unknown[]) => {
    const payload = args[0] as { compareMode?: WorkbookCompareMode } | undefined;
    clearActiveGitWorkingFileSession();
    clearActiveTwoFileVersionSession();
    const data = await buildDiffData({
      workbookCompareMode: payload?.compareMode ?? 'strict',
    });
    return projectTransportDiffData(data);
  }, 'launch');

  comparisonHandle('load-revision-diff', async (_, ...args: unknown[]) => {
    const payload = args[0] as {
      baseRevisionId?: string;
      mineRevisionId?: string;
      compareMode?: WorkbookCompareMode;
    } | undefined;
    const data = getActiveGitWorkingFileSession()
      ? await buildGitFileRevisionDiffData(
          payload?.baseRevisionId,
          payload?.mineRevisionId,
          payload?.compareMode ?? 'strict',
        )
      : await buildDiffData({
          baseRevisionId: payload?.baseRevisionId,
          mineRevisionId: payload?.mineRevisionId,
          workbookCompareMode: payload?.compareMode ?? 'strict',
        });
    return projectTransportDiffData(data);
  });

  comparisonHandle('load-line-blame', async (_, ...args: unknown[]) => {
    const payload = args[0] as {
      baseRevisionId?: string;
      mineRevisionId?: string;
    } | undefined;
    return getActiveGitWorkingFileSession()
      ? loadGitLineBlame(payload?.baseRevisionId, payload?.mineRevisionId)
      : loadSvnLineBlame(payload?.baseRevisionId, payload?.mineRevisionId);
  });

  comparisonHandle('load-working-copy-line-blame', async (_, ...args: unknown[]) => {
    const payload = args[0] as { basePath?: string; minePath?: string } | undefined;
    return loadWorkingCopyLineBlame(payload?.basePath ?? '', payload?.minePath ?? '');
  });

  comparisonHandle('load-two-file-version-line-blame', async (_, ...args: unknown[]) => {
    const payload = args[0] as { baseRevisionId?: string; mineRevisionId?: string } | undefined;
    return loadTwoFileVersionLineBlame(
      payload?.baseRevisionId ?? '',
      payload?.mineRevisionId ?? '',
    );
  });

  comparisonHandle('get-revision-options', async () => (
    getActiveGitWorkingFileSession()
      ? getGitRevisionOptions()
      : getRevisionOptions()
  ));

  comparisonHandle('query-revision-options', async (_, ...args: unknown[]) => {
    const payload = args[0] as RevisionOptionsQuery | undefined;
    return hasActiveTwoFileVersionSession()
      ? queryTwoFileRevisionOptions(payload)
      : getActiveGitWorkingFileSession()
      ? queryGitRevisionOptions(payload)
      : queryRevisionOptions(payload);
  });

  comparisonHandle('load-workbook-compare-mode', async (_, ...args: unknown[]) => {
    const payload = args[0] as {
      compareMode?: WorkbookCompareMode;
      baseRevisionId?: string;
      mineRevisionId?: string;
    } | undefined;
    const isGitFileSession = Boolean(getActiveGitWorkingFileSession());
    return loadWorkbookCompareModeData(
      payload?.compareMode ?? 'strict',
      isGitFileSession ? undefined : payload?.baseRevisionId,
      isGitFileSession ? undefined : payload?.mineRevisionId,
    );
  });

  comparisonHandle('load-workbook-metadata', async (_, ...args: unknown[]) => {
    const payload = args[0] as {
      baseRevisionId?: string;
      mineRevisionId?: string;
    } | undefined;
    const isGitFileSession = Boolean(getActiveGitWorkingFileSession());
    return loadWorkbookMetadataData(
      isGitFileSession ? undefined : payload?.baseRevisionId,
      isGitFileSession ? undefined : payload?.mineRevisionId,
    );
  });

  safeHandle('is-dev-mode', () => process.env.NODE_ENV === 'development');

  safeHandle('pick-diff-file', async () => {
    const win = getMainWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: electronT('dialogPickWorkingCopyTitle'),
      properties: ['openFile'],
    });

    const selectedPath = result.canceled ? '' : (result.filePaths[0] ?? '');
    if (!selectedPath) return null;
    return {
      path: selectedPath,
      name: path.basename(selectedPath),
    };
  });

  comparisonHandle('load-two-file-revision-diff', async (_, ...args: unknown[]) => {
    const payload = args[0] as {
      baseRevisionId?: string;
      mineRevisionId?: string;
      compareMode?: WorkbookCompareMode;
    } | undefined;
    if (hasActiveTwoFileVersionSession()) {
      return projectTransportDiffData(await buildTwoFileVersionDiffData(
        payload?.baseRevisionId ?? '',
        payload?.mineRevisionId ?? '',
        payload?.compareMode ?? 'strict',
      ));
    }
    clearActiveGitWorkingFileSession();
    return projectTransportDiffData(await buildTwoFileRevisionDiffData(
      payload?.baseRevisionId ?? '',
      payload?.mineRevisionId ?? '',
      payload?.compareMode ?? 'strict',
    ));
  });

  comparisonHandle('swap-two-file-diff', async (_, ...args: unknown[]) => {
    const payload = args[0] as {
      baseRevisionId?: string | null;
      mineRevisionId?: string | null;
      compareMode?: WorkbookCompareMode;
    } | undefined;
    return projectTransportDiffData(await swapTwoFileDiff(
      payload?.baseRevisionId,
      payload?.mineRevisionId,
      payload?.compareMode ?? 'strict',
    ));
  });

  safeHandle('pick-comparable-file', async (_, ...args: unknown[]) => {
    const win = getMainWindow();
    if (!win) return null;
    const payload = args[0] as { side?: string; requiredExtension?: string } | undefined;
    const side = payload?.side === 'mine' ? 'mine' : 'base';
    const requiredExtension = (payload?.requiredExtension ?? '')
      .trim()
      .replace(/^\./, '')
      .toLocaleLowerCase('en-US');
    const filters = /^[a-z0-9][a-z0-9+_-]*$/i.test(requiredExtension)
      ? [{ name: electronT('dialogMatchingFileTypeFilterName'), extensions: [requiredExtension] }]
      : undefined;
    const result = await dialog.showOpenDialog(win, {
      title: electronT(side === 'base' ? 'dialogPickBaseCompareFileTitle' : 'dialogPickMineCompareFileTitle'),
      properties: ['openFile'],
      ...(filters ? { filters } : {}),
    });

    const selectedPath = result.canceled ? '' : (result.filePaths[0] ?? '');
    if (!selectedPath) return null;
    return {
      path: selectedPath,
      name: path.basename(selectedPath),
    };
  });

  comparisonHandle('load-dev-working-copy-diff', async (_, ...args: unknown[]) => {
    const payload = args[0] as {
      filePath?: string;
      compareMode?: WorkbookCompareMode;
    } | undefined;
    clearActiveTwoFileVersionSession();
    return projectTransportDiffData(await buildSmartWorkingCopyDiffData(
      payload?.filePath ?? '',
      payload?.compareMode ?? 'strict',
    ));
  }, 'new');

  comparisonHandle('load-local-diff', async (_, ...args: unknown[]) => {
    const payload = args[0] as {
      basePath?: string;
      minePath?: string;
      compareMode?: WorkbookCompareMode;
    } | undefined;
    clearActiveGitWorkingFileSession();
    return projectTransportDiffData(await buildSmartLocalFileDiffData(
      resolveComparisonInputPath(payload?.basePath ?? ''),
      resolveComparisonInputPath(payload?.minePath ?? ''),
      payload?.compareMode ?? 'strict',
    ));
  }, 'new');

  comparisonHandle('load-local-file-diff', async (_, ...args: unknown[]) => {
    const payload = args[0] as {
      basePath?: string;
      minePath?: string;
      compareMode?: WorkbookCompareMode;
    } | undefined;
    const paths = resolveLocalFileComparePaths(
      resolveComparisonInputPath(payload?.basePath ?? ''),
      resolveComparisonInputPath(payload?.minePath ?? ''),
    );
    const issue = getLocalFileCompareValidationIssue(paths);
    if (issue === 'missing-files') {
      throw new Error(electronT('localFileCompareMissingFiles'));
    }
    if (issue === 'same-file') {
      throw new Error(electronT('localFileCompareSameFile'));
    }
    if (issue === 'type-mismatch') {
      throw new Error(electronT('localFileCompareTypeMismatch'));
    }
    clearActiveGitWorkingFileSession();
    return projectTransportDiffData(await buildSmartLocalFileDiffData(
      paths.basePath,
      paths.minePath,
      payload?.compareMode ?? 'strict',
    ));
  }, 'new');

  safeHandle('get-svn-diff-viewer-status', async () => getSvnDiffViewerStatus());

  safeHandle('configure-svn-diff-viewer', async (_, ...args: unknown[]) => {
    const payload = args[0] as { scope?: string } | undefined;
    return configureSvnDiffViewer(normalizeSvnDiffViewerScope(payload?.scope) ?? 'workbook-only');
  });

  safeHandle('restore-svn-default-diff-viewer-configuration', async () => (
    restoreSvnDefaultDiffViewerConfiguration()
  ));

  safeHandle('get-theme', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
  safeHandle('uses-native-window-controls', () => USE_NATIVE_WINDOW_CONTROLS);

  safeHandle('get-window-frame-state', () => getWindowFrameStateSnapshot());

  safeHandle('get-update-state', () => getAppUpdater().getState());

  safeHandle('check-app-update', async (_, ...args: unknown[]) => {
    const payload = args[0] as { manual?: boolean } | undefined;
    return getAppUpdater().checkForUpdates({ manual: payload?.manual ?? false });
  });

  safeHandle('download-app-update', async () => getAppUpdater().downloadUpdate());
  safeHandle('install-downloaded-update', async () => getAppUpdater().installUpdate());

  safeHandle('launch-uninstaller', async (_, ...args: unknown[]) => {
    const payload = args[0] as { silent?: boolean } | undefined;
    return launchInstalledUninstaller(app, payload?.silent);
  });

  safeHandle('save-diagnostic-report', async (_, ...args: unknown[]) => {
    const payload = args[0] as {
      content?: string;
      defaultFileName?: string;
    } | undefined;
    const content = typeof payload?.content === 'string' ? payload.content : '';
    if (!content.trim()) {
      throw new Error('Diagnostic report is empty.');
    }

    const suggestedFileName = buildDiagnosticReportFileName(payload?.defaultFileName);
    const targetWindow = getMainWindow();
    const pickDirectoryOptions: Electron.OpenDialogOptions = {
      title: electronT('dialogExportDirectoryTitle'),
      defaultPath: app.getPath('desktop'),
      properties: ['openDirectory', 'createDirectory'],
    };
    const directoryResult = targetWindow
      ? await dialog.showOpenDialog(targetWindow, pickDirectoryOptions)
      : await dialog.showOpenDialog(pickDirectoryOptions);

    const targetDirectory = directoryResult.canceled ? '' : (directoryResult.filePaths[0] ?? '');
    if (!targetDirectory) {
      return null;
    }

    const targetPath = path.join(targetDirectory, suggestedFileName);
    await fs.writeFile(targetPath, content, 'utf-8');
    return targetPath;
  });

  // ---------------------------------------------------------------------------
  // Fire-and-forget IPC (ipcMain.on)
  // ---------------------------------------------------------------------------

  ipcMain.on('clipboard-write-text', (_, text: unknown) => {
    if (typeof text === 'string') {
      clipboard.writeText(text);
    }
  });

  ipcMain.on('renderer-ready', () => {
    showMainWindow();
  });

  ipcMain.on('save-startup-appearance', (_, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const appearance = payload as { themeKey?: 'dark' | 'light' | 'hc'; locale?: 'zh-CN' | 'en-US' };
    const nextAppearance: {
      themeKey?: 'dark' | 'light' | 'hc';
      locale?: 'zh-CN' | 'en-US';
    } = {};
    if (appearance.themeKey) {
      nextAppearance.themeKey = appearance.themeKey;
    }
    if (appearance.locale) {
      nextAppearance.locale = appearance.locale;
    }
    writeStartupAppearance(nextAppearance);

    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;

    const resolvedAppearance = readStartupAppearance();
    const palette = getStartupPalette(resolvedAppearance.themeKey);
    win.setBackgroundColor(palette.backgroundColor);

    if (USE_NATIVE_WINDOW_CONTROLS) {
      win.setTitleBarOverlay({
        color: palette.titleBarColor,
        symbolColor: palette.titleBarSymbolColor,
        height: 44,
      });
    }
  });

  ipcMain.on('set-title-bar-overlay', (_, payload: TitleBarOverlayPayload | undefined) => {
    const win = getMainWindow();
    if (!USE_NATIVE_WINDOW_CONTROLS || !win || win.isDestroyed()) return;
    const color = typeof payload?.color === 'string' ? payload.color : '#f2efe6';
    const symbolColor = typeof payload?.symbolColor === 'string' ? payload.symbolColor : '#141413';
    const rawHeight = typeof payload?.height === 'number' ? payload.height : Number(payload?.height);
    const height = Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : 44;
    win.setTitleBarOverlay({
      color,
      symbolColor,
      height,
    });
  });

  ipcMain.on('debug-log', (_, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const message = typeof (payload as { message?: unknown }).message === 'string'
      ? (payload as { message: string }).message
      : '';
    if (!message) return;
    logDebugTiming(`renderer:${message}`, (payload as { payload?: unknown }).payload);
    if (AUTO_EXIT_AFTER_LOAD_MS > 0 && message === 'apply-diff-data:done') {
      setTimeout(() => {
        app.quit();
      }, AUTO_EXIT_AFTER_LOAD_MS);
    }
  });

  ipcMain.on('window-minimize', () => getMainWindow()?.minimize());
  ipcMain.on('window-maximize', () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
      return;
    }
    win.maximize();
  });
  ipcMain.on('window-close', () => getMainWindow()?.close());

  ipcMain.on('open-external', (_, url: unknown) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      void shell.openExternal(url);
    }
  });
}
