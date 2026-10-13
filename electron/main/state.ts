import type { BrowserWindow } from 'electron';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { EMPTY_CLI_ARGS } from '../cliArgs.js';
import { removeTrackedManagedTempFilesSync } from '../runtimePaths.js';
import { createPlatformUpdater } from '../updater/index.js';
import { writeExternalDiffDebugLog } from './logger.js';
import { clearSvnProbeCaches } from './svnProbeCache.js';
import type { GitWorkingFileSession } from './gitOperations.js';
import type { TwoFileVersionSession } from './twoFileVersionOperations.js';
import type {
  CliArgs,
  FilePayloadCacheEntry,
  RevisionOptionsPayload,
  RevisionPayloadCacheEntry,
} from './types.js';

// ---------------------------------------------------------------------------
// Mutable singletons — accessed via getter/setter pairs because CJS cannot
// re-export `let` bindings.
// ---------------------------------------------------------------------------

let _mainWindow: BrowserWindow | null = null;
let _sessionCacheGeneration = 0;

interface ComparisonSession {
  id: string;
  contextGeneration: number;
  cliArgs: CliArgs;
  inputSources: readonly { inputPath: string; sourcePath: string }[];
  tempInputPaths: Set<string>;
  cachedSvnTarget: string | null | undefined;
  cachedTimelineTarget: string | null | undefined;
  gitWorkingFileSession: GitWorkingFileSession | null;
  twoFileVersionSession: TwoFileVersionSession | null;
}

const comparisonSessionContext = new AsyncLocalStorage<ComparisonSession>();
const comparisonTransactionContext = new AsyncLocalStorage<{ commit: () => void }>();
const comparisonSessions = new Map<string, ComparisonSession>();
const pendingLaunchDiffRequests: string[] = [];
let activeComparisonSession: ComparisonSession = createSession(EMPTY_CLI_ARGS);

function comparisonPathKey(filePath: string): string {
  if (!filePath) return '';
  const resolvedPath = path.resolve(filePath);
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

function createSession(cliArgs: CliArgs, sourcePaths?: { basePath: string; minePath: string }): ComparisonSession {
  // Source identity stays tied to each input even when the ordered CLI pair changes.
  const inputSources = sourcePaths
    ? [
        { inputPath: cliArgs.basePath, sourcePath: sourcePaths.basePath },
        { inputPath: cliArgs.minePath, sourcePath: sourcePaths.minePath },
      ].filter(source => source.inputPath && source.sourcePath)
    : [];
  const session: ComparisonSession = {
    id: randomUUID(),
    contextGeneration: 0,
    cliArgs: { ...cliArgs },
    inputSources,
    tempInputPaths: new Set(inputSources
      .filter(source => comparisonPathKey(source.inputPath) !== comparisonPathKey(source.sourcePath))
      .map(source => source.inputPath)),
    cachedSvnTarget: undefined,
    cachedTimelineTarget: undefined,
    gitWorkingFileSession: null,
    twoFileVersionSession: null,
  };
  comparisonSessions.set(session.id, session);
  return session;
}

function getCurrentComparisonSession(): ComparisonSession {
  return comparisonSessionContext.getStore() ?? activeComparisonSession;
}

export function createComparisonSession(
  cliArgs: CliArgs = EMPTY_CLI_ARGS,
  sourcePaths?: { basePath: string; minePath: string },
): string {
  activeComparisonSession = createSession(cliArgs, sourcePaths);
  return activeComparisonSession.id;
}

export function runInComparisonSession<T>(sessionId: string | undefined, callback: () => T): T {
  const session = sessionId ? comparisonSessions.get(sessionId) : getCurrentComparisonSession();
  if (!session) throw new Error('Comparison session is unavailable.');
  return comparisonSessionContext.run(session, callback);
}

/** Keeps the ready source context intact until a replacement can be committed. */
export async function runInComparisonSessionTransaction<T>(callback: () => Promise<T>): Promise<T> {
  const current = getCurrentComparisonSession();
  const generation = ++current.contextGeneration;
  const candidate: ComparisonSession = { ...current, cliArgs: { ...current.cliArgs } };
  let committed = false;
  const transaction = {
    commit: () => {
      if (committed) return;
      if (comparisonSessions.get(current.id) !== current || current.contextGeneration !== generation) {
        const error = new Error('The comparison changed while its replacement was being prepared.');
        error.name = 'AbortError';
        throw error;
      }
      current.cliArgs = candidate.cliArgs;
      current.cachedSvnTarget = candidate.cachedSvnTarget;
      current.cachedTimelineTarget = candidate.cachedTimelineTarget;
      current.gitWorkingFileSession = candidate.gitWorkingFileSession;
      current.twoFileVersionSession = candidate.twoFileVersionSession;
      current.contextGeneration += 1;
      committed = true;
    },
  };
  return comparisonTransactionContext.run(transaction, () => comparisonSessionContext.run(candidate, async () => {
    const result = await callback();
    transaction.commit();
    return result;
  }));
}

/** Captured before queued work so native results and their source context commit together. */
export function getComparisonSessionTransactionCommit(): (() => void) | undefined {
  return comparisonTransactionContext.getStore()?.commit;
}

export function getCurrentComparisonSessionId(): string {
  return getCurrentComparisonSession().id;
}

export function resolveComparisonSourcePath(inputPath: string): string {
  const inputKey = comparisonPathKey(inputPath);
  return getCurrentComparisonSession().inputSources
    .find(source => comparisonPathKey(source.inputPath) === inputKey)?.sourcePath ?? inputPath;
}

export function resolveComparisonInputPath(filePath: string): string {
  const sourceKey = comparisonPathKey(filePath);
  return getCurrentComparisonSession().inputSources
    .find(source => comparisonPathKey(source.sourcePath) === sourceKey)?.inputPath ?? filePath;
}

export function getPendingLaunchDiffSessionId(): string | undefined {
  return pendingLaunchDiffRequests[0];
}

export function getPendingLaunchDiffRequestCount(): number {
  return pendingLaunchDiffRequests.length;
}

export function releaseComparisonSession(sessionId?: string): void {
  if (!sessionId) {
    removeTrackedManagedTempFilesSync([...comparisonSessions.values()].flatMap(session => [...session.tempInputPaths]));
    comparisonSessions.clear();
    pendingLaunchDiffRequests.length = 0;
    activeComparisonSession = createSession(EMPTY_CLI_ARGS);
    return;
  }
  const releasedSession = comparisonSessions.get(sessionId);
  comparisonSessions.delete(sessionId);
  if (releasedSession) {
    const removablePaths: string[] = [];
    for (const tempInputPath of releasedSession.tempInputPaths) {
      const referenceKey = comparisonPathKey(tempInputPath);
      const referencingSessions = [...comparisonSessions.values()].filter(session => [
        ...session.tempInputPaths,
        session.cliArgs.basePath,
        session.cliArgs.minePath,
        ...session.inputSources.flatMap(source => [source.inputPath, source.sourcePath]),
        session.gitWorkingFileSession?.workingFilePath ?? '',
        session.twoFileVersionSession?.base.path ?? '',
        session.twoFileVersionSession?.mine.path ?? '',
      ].some(filePath => Boolean(filePath)
        && comparisonPathKey(filePath) === referenceKey));
      if (referencingSessions.length === 0) {
        removablePaths.push(tempInputPath);
      } else {
        // Keep ownership until the last comparison using a shared snapshot closes.
        for (const session of referencingSessions) session.tempInputPaths.add(tempInputPath);
      }
    }
    removeTrackedManagedTempFilesSync(removablePaths);
  }
  const pendingIndex = pendingLaunchDiffRequests.indexOf(sessionId);
  if (pendingIndex >= 0) pendingLaunchDiffRequests.splice(pendingIndex, 1);
  if (activeComparisonSession.id === sessionId) {
    activeComparisonSession = [...comparisonSessions.values()].at(-1) ?? createSession(EMPTY_CLI_ARGS);
  }
}

export function getComparisonGitWorkingFileSession(): GitWorkingFileSession | null {
  return getCurrentComparisonSession().gitWorkingFileSession;
}

export function setComparisonGitWorkingFileSession(session: GitWorkingFileSession | null): void {
  const current = getCurrentComparisonSession();
  current.gitWorkingFileSession = session;
  current.contextGeneration += 1;
}

export function getComparisonTwoFileVersionSession(): TwoFileVersionSession | null {
  return getCurrentComparisonSession().twoFileVersionSession;
}

export function setComparisonTwoFileVersionSession(session: TwoFileVersionSession | null): void {
  const current = getCurrentComparisonSession();
  current.twoFileVersionSession = session;
  current.contextGeneration += 1;
}

export function getMainWindow(): BrowserWindow | null {
  return _mainWindow;
}

export function setMainWindow(win: BrowserWindow | null): void {
  _mainWindow = win;
}

export function getCachedSvnTarget(): string | null | undefined {
  return getCurrentComparisonSession().cachedSvnTarget;
}

export function setCachedSvnTarget(value: string | null | undefined): void {
  getCurrentComparisonSession().cachedSvnTarget = value;
}

export function getCachedTimelineTarget(): string | null | undefined {
  return getCurrentComparisonSession().cachedTimelineTarget;
}

export function setCachedTimelineTarget(value: string | null | undefined): void {
  getCurrentComparisonSession().cachedTimelineTarget = value;
}

export function getActiveCliArgs(): CliArgs {
  return getCurrentComparisonSession().cliArgs;
}

export function getSessionCacheGeneration(): number {
  return _sessionCacheGeneration;
}

export function clearMainSessionCaches(): void {
  _sessionCacheGeneration += 1;
  cachedRevisionOptionPages.clear();
  filePayloadCache.clear();
  revisionPayloadCache.clear();
  clearSvnProbeCaches();
}

export function setActiveCliArgs(nextArgs: CliArgs): void {
  clearMainSessionCaches();
  const session = getCurrentComparisonSession();
  session.cliArgs = { ...nextArgs };
  session.contextGeneration += 1;
  session.cachedSvnTarget = undefined;
  session.cachedTimelineTarget = undefined;
  writeExternalDiffDebugLog('active-cli-args-updated', session.cliArgs);
}

export function getHasPendingLaunchDiffRequest(): boolean {
  return pendingLaunchDiffRequests.length > 0;
}

export function setHasPendingLaunchDiffRequest(value: boolean): void {
  if (!value) {
    pendingLaunchDiffRequests.length = 0;
    return;
  }
  const sessionId = getCurrentComparisonSessionId();
  if (!pendingLaunchDiffRequests.includes(sessionId)) pendingLaunchDiffRequests.push(sessionId);
}

export function consumePendingLaunchDiffRequest(sessionId?: string): boolean {
  const pendingIndex = sessionId ? pendingLaunchDiffRequests.indexOf(sessionId) : 0;
  if (pendingIndex < 0 || pendingLaunchDiffRequests.length === 0) return false;
  pendingLaunchDiffRequests.splice(pendingIndex, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Map caches — exported directly; consumers use the Map API.
// ---------------------------------------------------------------------------

export const cachedRevisionOptionPages = new Map<string, RevisionOptionsPayload>();

export const filePayloadCache = new Map<string, FilePayloadCacheEntry>();

export const revisionPayloadCache = new Map<string, RevisionPayloadCacheEntry>();

// ---------------------------------------------------------------------------
// App updater singleton — must be initialised lazily after `app` is available.
// We accept the `app` reference at creation time via `initAppUpdater`.
// ---------------------------------------------------------------------------

let _appUpdater: ReturnType<typeof createPlatformUpdater> | null = null;

export function initAppUpdater(electronApp: Electron.App): ReturnType<typeof createPlatformUpdater> {
  if (!_appUpdater) {
    _appUpdater = createPlatformUpdater({ app: electronApp });
  }
  return _appUpdater;
}

export function getAppUpdater(): ReturnType<typeof createPlatformUpdater> {
  if (!_appUpdater) {
    throw new Error('appUpdater has not been initialised – call initAppUpdater(app) first');
  }
  return _appUpdater;
}
