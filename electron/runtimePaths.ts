import type { App } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logMainDebug } from './logging.js';

import {
  getDefaultInstallerCacheRoot,
  isControlledCacheRoot,
  type InstallerBootstrapConfig,
} from './installerBootstrap';

const DISK_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const STALE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_TEMP_CLEANUP_MIN_INTERVAL_MS = 60 * 1000;
const TEMP_BUDGET_HARD_LIMIT_BYTES = 1024 * 1024 * 1024;
const TEMP_BUDGET_TARGET_BYTES = 512 * 1024 * 1024;

export interface RuntimePathState {
  cacheRoot: string | null;
  sessionDataPath: string | null;
  diskCachePath: string | null;
  tempRootPath: string | null;
  logsPath: string | null;
  userDataPath: string | null;
}

const trackedTempPaths = new Set<string>();
const trackedTempDirectories = new Set<string>();

function isTrackedTempPath(filePath: string): boolean {
  return trackedTempPaths.has(filePath)
    || [...trackedTempDirectories].some(root => isSafePathWithinRoot(root, filePath));
}

let runtimePathState: RuntimePathState = {
  cacheRoot: null,
  sessionDataPath: null,
  diskCachePath: null,
  tempRootPath: null,
  logsPath: null,
  userDataPath: null,
};
let lastManagedTempCleanupAt = Number.NEGATIVE_INFINITY;
let managedCleanupRootPath: string | null = null;

function ensureDirectorySync(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function createCacheSubpaths(cacheRoot: string) {
  return {
    cacheRoot,
    sessionDataPath: path.join(cacheRoot, 'session-data'),
    diskCachePath: path.join(cacheRoot, 'disk-cache'),
    tempRootPath: path.join(cacheRoot, 'temp'),
  };
}

function tryPrepareCacheRoot(cacheRoot: string) {
  if (!isSafeControlledCacheRootPath(cacheRoot)) return null;
  const nextPaths = createCacheSubpaths(cacheRoot);
  try {
    ensureDirectorySync(nextPaths.cacheRoot);
    ensureDirectorySync(nextPaths.sessionDataPath);
    ensureDirectorySync(nextPaths.diskCachePath);
    ensureDirectorySync(nextPaths.tempRootPath);
    if (
      !isSafePathWithinRoot(nextPaths.cacheRoot, nextPaths.sessionDataPath)
      || !isSafePathWithinRoot(nextPaths.cacheRoot, nextPaths.diskCachePath)
      || !isSafePathWithinRoot(nextPaths.cacheRoot, nextPaths.tempRootPath)
    ) {
      return null;
    }
    return nextPaths;
  } catch (error) {
    logMainDebug('runtime-paths', 'failed to prepare cache root:', cacheRoot, error instanceof Error ? error.message : String(error));
    return null;
  }
}

function resolveConfiguredCacheRoot(installerBootstrap: InstallerBootstrapConfig | null): string {
  if (installerBootstrap?.cacheRoot && isSafeControlledCacheRootPath(installerBootstrap.cacheRoot)) {
    return path.resolve(installerBootstrap.cacheRoot);
  }
  return getDefaultInstallerCacheRoot();
}

function cleanupEmptyDirectoriesSync(targetPath: string, stopAtPath: string) {
  let currentPath = targetPath;

  while (isSafePathWithinRoot(stopAtPath, currentPath)) {
    if (toComparablePath(currentPath) === toComparablePath(stopAtPath)) break;

    try {
      const entries = fs.readdirSync(currentPath);
      if (entries.length > 0) break;
      fs.rmdirSync(currentPath);
    } catch (error) {
      logMainDebug('runtime-paths', 'cleanup-empty-dir skipped:', currentPath, error instanceof Error ? error.message : String(error));
      break;
    }

    currentPath = path.dirname(currentPath);
  }
}

interface FileEntryInfo {
  filePath: string;
  size: number;
  mtimeMs: number;
}

function collectFileEntriesSync(rootPath: string): FileEntryInfo[] {
  const entries: FileEntryInfo[] = [];
  const visit = (currentPath: string) => {
    let currentEntries: fs.Dirent[];
    try {
      currentEntries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (error) {
      logMainDebug('runtime-paths', 'readdir skipped:', currentPath, error instanceof Error ? error.message : String(error));
      return;
    }

    currentEntries.forEach((entry) => {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        return;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(entryPath);
      } catch (error) {
        logMainDebug('runtime-paths', 'stat skipped:', entryPath, error instanceof Error ? error.message : String(error));
        return;
      }

      entries.push({
        filePath: entryPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    });
  };

  visit(rootPath);
  return entries;
}

function removeFileEntrySync(filePath: string, stopAtPath: string) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    logMainDebug('runtime-paths', 'remove-file skipped:', filePath, error instanceof Error ? error.message : String(error));
    return false;
  }

  cleanupEmptyDirectoriesSync(path.dirname(filePath), stopAtPath);
  return true;
}

function enforceTempBudgetSync() {
  const tempRootPath = runtimePathState.tempRootPath;
  if (!isManagedTempRootSafe(tempRootPath) || !fs.existsSync(tempRootPath)) return;

  const fileEntries = collectFileEntriesSync(tempRootPath)
    .filter((entry) => !isTrackedTempPath(entry.filePath))
    .sort((left, right) => left.mtimeMs - right.mtimeMs);

  let totalBytes = fileEntries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes <= TEMP_BUDGET_HARD_LIMIT_BYTES) return;

  for (const entry of fileEntries) {
    if (totalBytes <= TEMP_BUDGET_TARGET_BYTES) break;
    if (!removeFileEntrySync(entry.filePath, tempRootPath)) continue;
    totalBytes -= entry.size;
  }
}

export function cleanupStaleManagedTempFilesSync(
  now = Date.now(),
  options: { force?: boolean } = {},
) {
  const tempRootPath = runtimePathState.tempRootPath;
  if (!isManagedTempRootSafe(tempRootPath) || !fs.existsSync(tempRootPath)) return;
  if (
    !options.force
    && Number.isFinite(lastManagedTempCleanupAt)
    && (now - lastManagedTempCleanupAt) < STALE_TEMP_CLEANUP_MIN_INTERVAL_MS
  ) {
    return;
  }

  lastManagedTempCleanupAt = now;

  collectFileEntriesSync(tempRootPath).forEach((entry) => {
    if (isTrackedTempPath(entry.filePath)) return;
    if ((now - entry.mtimeMs) < STALE_TEMP_MAX_AGE_MS) return;
    void removeFileEntrySync(entry.filePath, tempRootPath);
  });

  enforceTempBudgetSync();
}

export function configureRuntimePaths(
  app: App,
  devProfileRoot: string,
  installerBootstrap: InstallerBootstrapConfig | null,
): RuntimePathState {
  lastManagedTempCleanupAt = Number.NEGATIVE_INFINITY;
  managedCleanupRootPath = null;

  if (devProfileRoot) {
    const userDataPath = path.join(devProfileRoot, 'user-data');
    const sessionDataPath = path.join(devProfileRoot, 'session-data');
    const logsPath = path.join(devProfileRoot, 'logs');
    const diskCachePath = path.join(sessionDataPath, 'cache');
    const tempRootPath = path.join(devProfileRoot, 'temp');

    [userDataPath, sessionDataPath, logsPath, diskCachePath, tempRootPath].forEach(ensureDirectorySync);
    if (isSafePathWithinRoot(devProfileRoot, tempRootPath)) {
      managedCleanupRootPath = devProfileRoot;
    }

    app.setPath('userData', userDataPath);
    app.setPath('sessionData', sessionDataPath);
    app.setPath('logs', logsPath);
    app.commandLine.appendSwitch('disk-cache-dir', diskCachePath);
    app.commandLine.appendSwitch('disk-cache-size', String(DISK_CACHE_MAX_BYTES));

    runtimePathState = {
      cacheRoot: path.join(devProfileRoot, 'cache'),
      sessionDataPath,
      diskCachePath,
      tempRootPath,
      logsPath,
      userDataPath,
    };
    return runtimePathState;
  }

  const preferredCacheRoot = resolveConfiguredCacheRoot(installerBootstrap);
  const preparedPaths = tryPrepareCacheRoot(preferredCacheRoot)
    ?? tryPrepareCacheRoot(getDefaultInstallerCacheRoot());

  if (!preparedPaths) {
    runtimePathState = {
      cacheRoot: null,
      sessionDataPath: null,
      diskCachePath: null,
      tempRootPath: null,
      logsPath: null,
      userDataPath: app.getPath('userData'),
    };
    return runtimePathState;
  }

  app.setPath('sessionData', preparedPaths.sessionDataPath);
  app.commandLine.appendSwitch('disk-cache-dir', preparedPaths.diskCachePath);
  app.commandLine.appendSwitch('disk-cache-size', String(DISK_CACHE_MAX_BYTES));

  runtimePathState = {
    cacheRoot: preparedPaths.cacheRoot,
    sessionDataPath: preparedPaths.sessionDataPath,
    diskCachePath: preparedPaths.diskCachePath,
    tempRootPath: preparedPaths.tempRootPath,
    logsPath: app.getPath('logs'),
    userDataPath: app.getPath('userData'),
  };
  managedCleanupRootPath = preparedPaths.cacheRoot;

  return runtimePathState;
}

export function getRuntimePathState(): RuntimePathState {
  return runtimePathState;
}

function normalizeExtension(extension: string): string {
  if (!extension) return '.tmp';
  return extension.startsWith('.') ? extension : `.${extension}`;
}

function createManagedTempFilePath(prefix: string, extension: string): string {
  const tempRootPath = runtimePathState.tempRootPath;
  if (!tempRootPath) {
    throw new Error('Managed temp root is not configured.');
  }
  if (!isManagedTempRootSafe(tempRootPath)) {
    throw new Error('Managed temp root failed its path safety check.');
  }

  ensureDirectorySync(tempRootPath);
  cleanupStaleManagedTempFilesSync();
  return path.join(
    tempRootPath,
    `versora-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}${normalizeExtension(extension)}`,
  );
}

export function copyToManagedTempFileSync(prefix: string, sourcePath: string): string {
  const tempFilePath = createManagedTempFilePath(prefix, path.extname(sourcePath));
  fs.copyFileSync(sourcePath, tempFilePath);
  trackedTempPaths.add(tempFilePath);
  return tempFilePath;
}

export async function writeManagedTempFile(
  prefix: string,
  extension: string,
  contents: Buffer | Uint8Array,
): Promise<string> {
  const tempFilePath = createManagedTempFilePath(prefix, extension);
  await fs.promises.writeFile(tempFilePath, Buffer.from(contents));
  trackedTempPaths.add(tempFilePath);
  return tempFilePath;
}

/** The whole directory is a lease, including files a native child creates later. */
export async function createManagedTempDirectory(prefix: string): Promise<string> {
  const tempPath = createManagedTempFilePath(prefix, '.artifact');
  trackedTempDirectories.add(tempPath);
  try {
    await fs.promises.mkdir(tempPath);
    return tempPath;
  } catch (error) {
    trackedTempDirectories.delete(tempPath);
    throw error;
  }
}

export async function removeManagedTempDirectory(tempPath: string): Promise<void> {
  const tempRootPath = runtimePathState.tempRootPath;
  if (!trackedTempDirectories.has(tempPath)
    || !isManagedTempRootSafe(tempRootPath)
    || !isSafePathWithinRoot(tempRootPath, tempPath)) return;
  await fs.promises.rm(tempPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  trackedTempDirectories.delete(tempPath);
}

export function removeTrackedManagedTempFilesSync(tempFilePaths: Iterable<string>): void {
  const tempRootPath = runtimePathState.tempRootPath;
  if (!isManagedTempRootSafe(tempRootPath)) return;

  for (const tempFilePath of new Set(tempFilePaths)) {
    if (!trackedTempPaths.has(tempFilePath) || !isSafePathWithinRoot(tempRootPath, tempFilePath)) continue;
    try {
      fs.rmSync(tempFilePath, { force: true });
      trackedTempPaths.delete(tempFilePath);
      cleanupEmptyDirectoriesSync(path.dirname(tempFilePath), tempRootPath);
    } catch (error) {
      logMainDebug('runtime-paths', 'remove tracked temp skipped:', tempFilePath, error instanceof Error ? error.message : String(error));
    }
  }
}

export function cleanupManagedTempFilesOnExitSync() {
  const tempRootPath = runtimePathState.tempRootPath;
  if (
    !isManagedTempRootSafe(tempRootPath)
    || !fs.existsSync(tempRootPath)
  ) {
    trackedTempPaths.clear();
    trackedTempDirectories.clear();
    return;
  }

  try {
    fs.rmSync(tempRootPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  } catch (error) {
    logMainDebug(
      'runtime-paths',
      'cleanup managed temp root skipped:',
      tempRootPath,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    trackedTempPaths.clear();
    trackedTempDirectories.clear();
  }
}

function hasSymbolicLinkPathSegment(targetPath: string): boolean {
  const rootPath = path.parse(targetPath).root;
  const segments = path.relative(rootPath, targetPath).split(path.sep).filter(Boolean);
  let currentPath = rootPath;

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    try {
      if (fs.lstatSync(currentPath).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return true;
    }
  }
  return false;
}

function toComparablePath(targetPath: string): string {
  const resolvedPath = path.resolve(targetPath);
  const missingSegments: string[] = [];
  let existingAncestor = resolvedPath;
  let canonicalPath = resolvedPath;

  while (true) {
    try {
      canonicalPath = path.join(fs.realpathSync.native(existingAncestor), ...missingSegments);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') break;
      const parentPath = path.dirname(existingAncestor);
      if (parentPath === existingAncestor) break;
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parentPath;
    }
  }

  const normalizedPath = path.normalize(canonicalPath);
  return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
}

function isSameOrInsidePath(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath)
  );
}

export function isSafePathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedCandidate = path.resolve(candidatePath);
  if (!isSameOrInsidePath(toComparablePath(normalizedRoot), toComparablePath(normalizedCandidate))) return false;
  return !hasSymbolicLinkPathSegment(normalizedRoot)
    && !hasSymbolicLinkPathSegment(normalizedCandidate);
}

function isManagedTempRootSafe(tempRootPath: string | null): tempRootPath is string {
  return Boolean(
    tempRootPath
    && managedCleanupRootPath
    && isSafePathWithinRoot(managedCleanupRootPath, tempRootPath),
  );
}

export function isSafeControlledCacheRootPath(targetPath: string | null | undefined): boolean {
  const normalized = targetPath?.trim() ? path.resolve(targetPath) : '';
  if (!normalized || !isControlledCacheRoot(normalized)) return false;
  if (hasSymbolicLinkPathSegment(normalized)) return false;

  try {
    return isControlledCacheRoot(fs.realpathSync.native(normalized));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export function removeControlledDirectorySync(targetPath: string | null | undefined): boolean {
  const normalized = targetPath?.trim() ? path.resolve(targetPath) : '';
  if (!isSafeControlledCacheRootPath(normalized)) return false;

  try {
    fs.rmSync(normalized, { recursive: true, force: true });
    return true;
  } catch (error) {
    logMainDebug('runtime-paths', 'remove-controlled-dir skipped:', normalized, error instanceof Error ? error.message : String(error));
    return false;
  }
}
