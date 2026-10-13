import { app, BrowserWindow } from 'electron';
import { EMPTY_CLI_ARGS, type CliArgs } from './cliArgs';
import { logMainError, logMainWarn } from './logging.js';
import { preserveExternalDiffTempInputsSync, resolveLaunchCliArgsFromArgv } from './externalDiffRequest';
import { readInstallerBootstrapSync } from './installerBootstrap';
import {
  getMaintenanceModeFromArgv,
  runMaintenance,
  runPendingPostInstallMaintenance,
  runStartupSvnDiffViewerMaintenance,
} from './maintenance';
import {
  cleanupManagedTempFilesOnExitSync,
  cleanupStaleManagedTempFilesSync,
  configureRuntimePaths,
  getRuntimePathState,
} from './runtimePaths';
import { DEV_PROFILE_ROOT } from './main/constants';
import { registerIpcHandlers } from './main/ipcHandlers';
import { writeExternalDiffDebugLog } from './main/logger';
import { abortWorkbookPreparations, hasWorkbookArtifactResources, releaseWorkbookArtifacts } from './main/workbookArtifactService';
import { cancelWorkbookArtifactSearch } from './main/workbookSearchService';
import {
  getMainWindow,
  initAppUpdater,
  createComparisonSession,
  setHasPendingLaunchDiffRequest,
} from './main/state';
import {
  createWindow,
  focusMainWindow,
  notifyAppUpdateState,
  notifyCliArgsUpdated,
} from './main/windowManager';

const POST_INSTALL_MAINTENANCE_DELAY_MS = 5000;
const DEFERRED_STARTUP_HOUSEKEEPING_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// Early startup — executed at module load time
// ---------------------------------------------------------------------------

const maintenanceMode = getMaintenanceModeFromArgv(process.argv);
const installerBootstrap = readInstallerBootstrapSync(process.execPath);
configureRuntimePaths(app, DEV_PROFILE_ROOT, installerBootstrap);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

let parsedStartupCliArgs: CliArgs | null = null;
let cliArgs: CliArgs = { ...EMPTY_CLI_ARGS };

const gotSingleInstanceLock = maintenanceMode ? true : app.requestSingleInstanceLock();

if (gotSingleInstanceLock) {
  parsedStartupCliArgs = resolveLaunchCliArgsFromArgv(process.argv);
  cliArgs = parsedStartupCliArgs ? preserveExternalDiffTempInputsSync(parsedStartupCliArgs) : { ...EMPTY_CLI_ARGS };
  createComparisonSession(cliArgs, parsedStartupCliArgs ?? undefined);
  setHasPendingLaunchDiffRequest(parsedStartupCliArgs !== null);
}

writeExternalDiffDebugLog('process-start', {
  execPath: process.execPath,
  argv: process.argv,
  cwd: process.cwd(),
  maintenanceMode,
  gotSingleInstanceLock,
  parsedStartupCliArgs,
  activeCliArgs: cliArgs,
  logsPath: getRuntimePathState().logsPath,
});

let hasCleanedManagedTempOnExit = false;
let pendingPostInstallMaintenanceTimer: NodeJS.Timeout | null = null;
let deferredStartupHousekeepingTimer: NodeJS.Timeout | null = null;
let deferredStartupHousekeepingScheduled = false;
let workbookShutdownStarted = false;
let workbookShutdownComplete = false;

function cleanupManagedTempOnExit(reason: string) {
  if (hasCleanedManagedTempOnExit) return;
  if (reason === 'process:exit' && hasWorkbookArtifactResources()) {
    abortWorkbookPreparations();
    return;
  }
  hasCleanedManagedTempOnExit = true;

  writeExternalDiffDebugLog('managed-temp:cleanup-on-exit', {
    reason,
    tempRootPath: getRuntimePathState().tempRootPath,
  });
  cleanupManagedTempFilesOnExitSync();
}

function clearPendingPostInstallMaintenanceTimer() {
  if (!pendingPostInstallMaintenanceTimer) return;
  clearTimeout(pendingPostInstallMaintenanceTimer);
  pendingPostInstallMaintenanceTimer = null;
}

function clearDeferredStartupHousekeepingTimer() {
  if (!deferredStartupHousekeepingTimer) return;
  clearTimeout(deferredStartupHousekeepingTimer);
  deferredStartupHousekeepingTimer = null;
}

function schedulePendingPostInstallMaintenance() {
  if (maintenanceMode || pendingPostInstallMaintenanceTimer || !app.isPackaged) return;

  pendingPostInstallMaintenanceTimer = setTimeout(() => {
    pendingPostInstallMaintenanceTimer = null;
    void runStartupSvnDiffViewerMaintenance(app).catch((error) => {
      logMainWarn('maintenance', 'deferred startup maintenance failed', error);
    });
  }, POST_INSTALL_MAINTENANCE_DELAY_MS);
}

function runDeferredStartupHousekeeping() {
  clearDeferredStartupHousekeepingTimer();
  cleanupStaleManagedTempFilesSync(Date.now(), { force: true });
}

function scheduleDeferredStartupHousekeeping() {
  if (maintenanceMode || deferredStartupHousekeepingScheduled) return;
  deferredStartupHousekeepingScheduled = true;

  const startTimer = () => {
    if (deferredStartupHousekeepingTimer) return;
    deferredStartupHousekeepingTimer = setTimeout(() => {
      runDeferredStartupHousekeeping();
    }, DEFERRED_STARTUP_HOUSEKEEPING_DELAY_MS);
  };

  const win = getMainWindow();
  if (!win || win.isDestroyed()) {
    startTimer();
    return;
  }

  if (win.isVisible()) {
    startTimer();
    return;
  }

  win.once('show', startTimer);
}

app.on('before-quit', (_event) => {
  writeExternalDiffDebugLog('app:before-quit', {
    windowCount: BrowserWindow.getAllWindows().length,
  });
  clearPendingPostInstallMaintenanceTimer();
  clearDeferredStartupHousekeepingTimer();
  if (!workbookShutdownComplete) {
    _event.preventDefault();
    if (workbookShutdownStarted) return;
    workbookShutdownStarted = true;
    void cancelWorkbookArtifactSearch().then(() => releaseWorkbookArtifacts()).catch(error => {
      logMainError('workbook-shutdown', error instanceof Error ? error.message : String(error));
    }).finally(() => {
      workbookShutdownComplete = true;
      app.quit();
    });
    return;
  }
  cleanupManagedTempOnExit('app:before-quit');
});

app.on('will-quit', (_event) => {
  writeExternalDiffDebugLog('app:will-quit', {
    windowCount: BrowserWindow.getAllWindows().length,
  });
  clearPendingPostInstallMaintenanceTimer();
  clearDeferredStartupHousekeepingTimer();
  cleanupManagedTempOnExit('app:will-quit');
});

app.on('window-all-closed', () => {
  writeExternalDiffDebugLog('app:window-all-closed', {
    windowCount: BrowserWindow.getAllWindows().length,
  });
  app.quit();
});

// ---------------------------------------------------------------------------
// Register all IPC handlers (must happen before window creation)
// ---------------------------------------------------------------------------

registerIpcHandlers();

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

if (maintenanceMode) {
  void app.whenReady().then(async () => {
    try {
      await runMaintenance(app, maintenanceMode, process.argv);
      app.exit(0);
    } catch (error) {
      logMainError('maintenance', 'failed', error);
      app.exit(1);
    }
  });
} else if (!gotSingleInstanceLock) {
  logMainWarn('electron', 'single-instance lock denied; another Versora instance is already running');
  writeExternalDiffDebugLog('single-instance-lock-denied', {
    argv: process.argv,
    parsedStartupCliArgs,
  });
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const nextArgs = resolveLaunchCliArgsFromArgv(commandLine);
    writeExternalDiffDebugLog('second-instance', {
      commandLine,
      parsedCliArgs: nextArgs,
    });
    if (nextArgs) {
      createComparisonSession(preserveExternalDiffTempInputsSync(nextArgs), nextArgs);
      setHasPendingLaunchDiffRequest(true);
      notifyCliArgsUpdated();
    }
    focusMainWindow();
  });

  void app.whenReady().then(async () => {
    writeExternalDiffDebugLog('app-ready', {
      logsPath: getRuntimePathState().logsPath,
      userDataPath: getRuntimePathState().userDataPath,
    });

    let pendingMaintenanceFailed = false;
    try {
      await runPendingPostInstallMaintenance(app);
    } catch (error) {
      pendingMaintenanceFailed = true;
      logMainWarn('maintenance', 'pending startup maintenance failed', error);
    }

    const updater = initAppUpdater(app);
    updater.subscribe((state) => {
      notifyAppUpdateState(state);
    });
    updater.initialize();
    createWindow();
    void updater.checkForUpdates({ manual: false });
    if (!pendingMaintenanceFailed) {
      schedulePendingPostInstallMaintenance();
    }
    scheduleDeferredStartupHousekeeping();
  });
}

process.once('exit', () => {
  cleanupManagedTempOnExit('process:exit');
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
