import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  createManagedTempDirectory,
  removeManagedTempDirectory,
} from '../runtimePaths.js';
import {
  type WorkbookArtifactCompareMode,
  type WorkbookArtifactDescriptor,
  type WorkbookArtifactManifest,
  type WorkbookArtifactSourceRowsRequest,
  type WorkbookArtifactSourceRowsResult,
} from '../../shared/workbookArtifactProtocol.js';
import { BoundedCommandGate } from './commandGate.js';
import { resolveRustParserPath } from './rustBridge.js';
import { WorkbookArtifactReader } from './workbookArtifactReader.js';
import { logDebugTiming } from './logger.js';
import { logMainDebug } from '../logging.js';
import { RUST_COMMAND_TIMEOUT_MS } from './constants.js';
import { cancelWorkbookArtifactSearch } from './workbookSearchService.js';
import { getComparisonSessionTransactionCommit } from './state.js';

const preparationGate = new BoundedCommandGate(1, 16, 'Too many workbook preparations are queued.');
const artifacts = new Map<string, WorkbookArtifactReader>();
const currentArtifacts = new Map<string, { sourceKey: string; artifactId: string }>();
interface PreparationJob {
  comparisonSessionId: string;
  controller: AbortController;
  sourceKey: string;
  promise: Promise<WorkbookArtifactDescriptor>;
  commitContext: (() => void) | undefined;
}
const preparations = new Map<string, PreparationJob>();
const activePreparations = new Set<PreparationJob>();

export function hasWorkbookArtifactResources(): boolean {
  return artifacts.size > 0 || activePreparations.size > 0;
}
export function abortWorkbookPreparations(): void {
  for (const job of activePreparations) job.controller.abort();
}

function aborted(): Error {
  const error = new Error('Workbook preparation was cancelled.');
  error.name = 'AbortError';
  return error;
}
function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw aborted();
}

async function sourceFilesEqual(basePath: string, minePath: string, baseBytes: number, mineBytes: number, signal: AbortSignal): Promise<boolean> {
  if (baseBytes !== mineBytes) return false;
  if (basePath === minePath) return true;
  const files = [];
  try {
    files.push(await fs.open(basePath, 'r'));
    files.push(await fs.open(minePath, 'r'));
    const buffers = [Buffer.allocUnsafe(256 * 1024), Buffer.allocUnsafe(256 * 1024)];
    for (let position = 0; position < baseBytes; position += buffers[0]!.length) {
      checkCancelled(signal);
      const count = Math.min(buffers[0]!.length, baseBytes - position);
      const read = await Promise.all(files.map((file, side) => file.read(buffers[side]!, 0, count, position)));
      if (read.some(result => result.bytesRead !== count)) throw new Error('A workbook source changed during binary comparison.');
      if (!buffers[0]!.subarray(0, count).equals(buffers[1]!.subarray(0, count))) return false;
    }
    return true;
  } finally { await Promise.all(files.map(file => file.close())); }
}

async function runPreparation(basePath: string, minePath: string, artifactDir: string, signal: AbortSignal): Promise<WorkbookArtifactManifest> {
  const parserPath = resolveRustParserPath();
  if (!parserPath) throw new Error('The native workbook parser is unavailable.');
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(parserPath, ['--prepare-artifact', basePath, minePath, artifactDir], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const errorChunks: Buffer[] = [];
    let errorBytes = 0;
    let failure: Error | null = null;
    const stop = () => { failure ??= aborted(); child.kill(); };
    signal.addEventListener('abort', stop, { once: true });
    const timeout = setTimeout(() => {
      failure = new Error('Native workbook preparation timed out.');
      child.kill();
    }, RUST_COMMAND_TIMEOUT_MS);
    // The persisted manifest is authoritative. Drain stdout without retaining
    // it, so many merge records cannot accidentally turn stdout into a limit.
    child.stdout.resume();
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep diagnostics bounded without hiding the native exit status.
      const kept = chunk.subarray(0, Math.max(0, 256 * 1024 - errorBytes));
      if (kept.length) { errorChunks.push(kept); errorBytes += kept.length; }
    });
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      clearTimeout(timeout); signal.removeEventListener('abort', stop);
      if (signal.aborted) { reject(aborted()); return; }
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error(Buffer.concat(errorChunks).toString('utf8').trim() || `Native workbook preparation exited with code ${code}.`)); return; }
      void fs.readFile(path.join(artifactDir, 'manifest.json'), 'utf8').then(content => {
        try { resolve({ ...JSON.parse(content), artifactDir } as WorkbookArtifactManifest); }
        catch (error) { reject(new Error('Invalid native workbook artifact manifest.', { cause: error })); }
      }, reject);
    });
  });
}

export interface PrepareWorkbookArtifactRequest {
  comparisonSessionId: string;
  sourceKey: string;
  compareMode: WorkbookArtifactCompareMode;
  resolveSources: (artifactDir: string, signal: AbortSignal) => Promise<{ basePath: string; minePath: string }>;
}

/** Stages a complete replacement; a failed preparation never destroys the ready artifact. */
export async function prepareWorkbookArtifact(request: PrepareWorkbookArtifactRequest): Promise<WorkbookArtifactDescriptor> {
  const commitContext = getComparisonSessionTransactionCommit();
  const current = currentArtifacts.get(request.comparisonSessionId);
  const previous = preparations.get(request.comparisonSessionId);
  if (current?.sourceKey === request.sourceKey) {
    if (previous?.sourceKey !== request.sourceKey) previous?.controller.abort();
    return getWorkbookArtifactReader(current.artifactId).getView(request.compareMode);
  }
  if (previous?.sourceKey === request.sourceKey) {
    // Identical work may be shared, but only the latest source transaction owns its commit.
    if (commitContext) previous.commitContext = commitContext;
    const descriptor = await previous.promise;
    return getWorkbookArtifactReader(descriptor.artifactId).getView(request.compareMode);
  }
  previous?.controller.abort();
  const controller = new AbortController();
  let lease: string | null = null;
  const promise: Promise<WorkbookArtifactDescriptor> = preparationGate.run(async () => {
    checkCancelled(controller.signal);
    const start = performance.now();
    lease = await createManagedTempDirectory('workbook');
    const artifactId = randomUUID();
    let reader: WorkbookArtifactReader | null = null;
    try {
      const sources = await request.resolveSources(lease, controller.signal);
      checkCancelled(controller.signal);
      const before = await Promise.all([fs.stat(sources.basePath), fs.stat(sources.minePath)]);
      const manifest = await runPreparation(sources.basePath, sources.minePath, lease, controller.signal);
      const after = await Promise.all([fs.stat(sources.basePath), fs.stat(sources.minePath)]);
      if (before.some((stat, i) => stat.size !== after[i]!.size || stat.mtimeMs !== after[i]!.mtimeMs)) {
        throw new Error('A workbook source changed while it was being prepared. Please reload the comparison.');
      }
      checkCancelled(controller.signal);
      reader = await WorkbookArtifactReader.open(manifest, artifactId, request.comparisonSessionId, lease);
      reader.sourceByteLengths = { base: before[0]!.size, mine: before[1]!.size };
      const equalityNeeded = manifest.sheets.every(sheet => sheet.hasBaseSide && sheet.hasMineSide)
        && Object.values(manifest.modes).some(mode => mode.changedCellCount === 0
          && mode.sheets.every(sheet => sheet.addedRows === 0 && sheet.deletedRows === 0 && sheet.modifiedRows === 0));
      if (equalityNeeded) reader.contentsEqual = await sourceFilesEqual(sources.basePath, sources.minePath, before[0]!.size, before[1]!.size, controller.signal);
      const descriptor = await reader.getView(request.compareMode);
      const firstSheet = descriptor.sheets.find(sheet => sheet.pairCount > 0);
      if (firstSheet) {
        const end = Math.min(64, firstSheet.pairCount);
        let cursor = 0;
        while (cursor < end) {
          const window = await reader.readWindow({ artifactId, compareMode: request.compareMode, sheetId: firstSheet.id, startRow: cursor, rowCount: end - cursor, columnRanges: [{ start: 0, end: Math.min(16, firstSheet.maxColumnCount) }] });
          if (!window.rows.length) throw new Error('Native workbook first window is incomplete.');
          cursor += window.rows.length;
        }
      }
      checkCancelled(controller.signal);
      job.commitContext?.();
      artifacts.set(artifactId, reader);
      const old = currentArtifacts.get(request.comparisonSessionId);
      currentArtifacts.set(request.comparisonSessionId, { artifactId, sourceKey: request.sourceKey });
      reader = null;
      if (old) await releaseWorkbookArtifact(old.artifactId).catch(error => {
        // A committed replacement remains usable even if retiring the previous
        // lease fails; tracked leftovers are cleaned on a later app exit.
        logMainDebug('workbook-artifact', 'Previous artifact cleanup failed:', error instanceof Error ? error.message : String(error));
      });
      logDebugTiming('workbook-artifact:ready', { durationMs: performance.now() - start, sourceCounts: descriptor.sourceCounts, pairCount: descriptor.rows.kinds.length });
      return descriptor;
    } catch (error) {
      await reader?.close();
      await removeManagedTempDirectory(lease);
      throw error;
    }
  }, controller.signal);
  const job: PreparationJob = { comparisonSessionId: request.comparisonSessionId, controller, sourceKey: request.sourceKey, promise, commitContext };
  preparations.set(request.comparisonSessionId, job);
  activePreparations.add(job);
  try { return await promise; }
  finally {
    if (preparations.get(request.comparisonSessionId)?.controller === controller) preparations.delete(request.comparisonSessionId);
    activePreparations.delete(job);
  }
}

export function getWorkbookArtifactReader(artifactId: string): WorkbookArtifactReader {
  const reader = artifacts.get(artifactId);
  if (!reader) throw new Error('Workbook artifact is unavailable or has been replaced.');
  return reader;
}
export function getCurrentWorkbookArtifact(comparisonSessionId: string): WorkbookArtifactReader | null {
  const current = currentArtifacts.get(comparisonSessionId);
  return current ? artifacts.get(current.artifactId) ?? null : null;
}
async function releaseWorkbookArtifact(artifactId: string): Promise<void> {
  const reader = artifacts.get(artifactId);
  if (!reader) return;
  artifacts.delete(artifactId);
  await cancelWorkbookArtifactSearch(artifactId);
  await reader.close();
  await removeManagedTempDirectory(reader.manifest.artifactDir);
}
export async function releaseWorkbookArtifacts(comparisonSessionId?: string): Promise<void> {
  const pending = [...activePreparations].filter(job => !comparisonSessionId || job.comparisonSessionId === comparisonSessionId);
  for (const job of pending) job.controller.abort();
  await Promise.allSettled(pending.map(job => job.promise));
  const ids = [...artifacts.values()].filter(reader => !comparisonSessionId || reader.comparisonSessionId === comparisonSessionId).map(reader => reader.artifactId);
  if (comparisonSessionId) currentArtifacts.delete(comparisonSessionId); else currentArtifacts.clear();
  await Promise.all(ids.map(id => releaseWorkbookArtifact(id)));
}

/** Full canonical row pages also serve precise auto-fit; no XLSX bytes enter IPC. */
export async function readWorkbookArtifactSourceRows(request: WorkbookArtifactSourceRowsRequest): Promise<WorkbookArtifactSourceRowsResult> {
  const reader = getWorkbookArtifactReader(request.artifactId);
  const view = await reader.getView(request.compareMode);
  const sheet = view.sheets.find(item => item.id === request.sheetId);
  if (!sheet) throw new Error('Workbook sheet is unavailable.');
  const ranges = request.columns ? [] : [{ start: 0, end: sheet.maxColumnCount }];
  if (request.columns) {
    if (request.columns.length > 16_384) throw new Error('Workbook column scan exceeds its column budget.');
    for (const column of [...new Set(request.columns)].sort((a, b) => a - b)) {
      if (!Number.isInteger(column) || column < 0 || column >= 16_384) throw new Error('Invalid workbook column scan.');
      const previous = ranges[ranges.length - 1];
      if (previous?.end === column) previous.end = column + 1;
      else ranges.push({ start: column, end: column + 1 });
    }
  }
  const window = await reader.readWindow({ ...request, rowCount: Math.min(256, request.rowCount), columnRanges: ranges });
  const nextRow = window.nextRow ?? (request.startRow + window.rows.length < sheet.pairCount ? request.startRow + window.rows.length : null);
  return { ...window, nextRow };
}

/** Source callbacks stream revision snapshots into the native artifact's lease. */
export function artifactSourcePath(artifactDir: string, side: 'base' | 'mine', extension: string): string {
  return path.join(artifactDir, `source-${side}${extension || '.xlsx'}`);
}
