import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  WorkbookArtifactManifest, WorkbookArtifactSearchRequest, WorkbookArtifactSearchResult,
} from '../../shared/workbookArtifactProtocol.js';
import { getWorkbookArtifactReader } from './workbookArtifactService.js';
import { RUST_COMMAND_TIMEOUT_MS } from './constants.js';
import { createWorkbookSearchManifest } from './workbookSearchSource.js';

interface SearchJob { requestId: string; worker: Worker; cancel: () => Promise<void> }
const jobs = new Map<string, SearchJob>();
const pending = new Map<string, { requestId: string; token: object }>();

function createWorker(request: WorkbookArtifactSearchRequest, manifest: WorkbookArtifactManifest): Worker {
  const compiled = path.join(__dirname, 'workbookSearchWorker.js');
  const options = { workerData: { request, manifest: createWorkbookSearchManifest(manifest), root: manifest.artifactDir }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } };
  if (existsSync(compiled)) return new Worker(compiled, options);
  const source = path.join(__dirname, 'workbookSearchWorker.ts');
  const loader = require.resolve('tsx/cjs');
  return new Worker(`require(${JSON.stringify(loader)}); require(${JSON.stringify(source)});`, { ...options, eval: true });
}

export async function cancelWorkbookArtifactSearch(artifactId?: string, requestId?: string): Promise<void> {
  for (const [id, job] of pending) {
    if ((!artifactId || id === artifactId) && (!requestId || requestId === job.requestId)) pending.delete(id);
  }
  const selected = [...jobs].filter(([id, job]) => (!artifactId || id === artifactId) && (!requestId || requestId === job.requestId));
  await Promise.all(selected.map(([, job]) => job.cancel()));
}

export async function searchWorkbookArtifact(request: WorkbookArtifactSearchRequest): Promise<WorkbookArtifactSearchResult> {
  if (request.compareMode !== 'strict' && request.compareMode !== 'content') throw new Error('Invalid workbook comparison mode.');
  const reader = getWorkbookArtifactReader(request.artifactId);
  const prior = [...jobs].filter(([id]) => id === request.artifactId);
  const token = {};
  pending.set(request.artifactId, { requestId: request.requestId, token });
  await Promise.all(prior.map(([, job]) => job.cancel()));
  if (pending.get(request.artifactId)?.token !== token) {
    const error = new Error('Workbook search was cancelled.'); error.name = 'AbortError'; throw error;
  }
  let worker: Worker;
  try { worker = createWorker(request, reader.manifest); }
  finally { pending.delete(request.artifactId); }
  return new Promise((resolve, reject) => {
    let settled = false;
    let finishing: Promise<void> | undefined;
    const timer = setTimeout(() => { void finish(new Error('Workbook search timed out.')); }, RUST_COMMAND_TIMEOUT_MS);
    const finish = (error: Error | null, result?: WorkbookArtifactSearchResult): Promise<void> => {
      if (finishing) return finishing;
      settled = true; clearTimeout(timer);
      finishing = (async () => {
        await worker.terminate();
        if (jobs.get(request.artifactId)?.worker === worker) jobs.delete(request.artifactId);
        if (error) reject(error); else resolve(result!);
      })();
      return finishing;
    };
    jobs.set(request.artifactId, { requestId: request.requestId, worker, cancel: async () => {
      const error = new Error('Workbook search was cancelled.'); error.name = 'AbortError';
      await finish(error);
    } });
    worker.on('message', (message: { type: string; error?: string; matches?: WorkbookArtifactSearchResult['matches']; totalCount?: number; truncated?: boolean }) => {
      if (settled) return;
      if (message.type === 'error') { void finish(new Error(message.error ?? 'Workbook search failed.')); return; }
      if (message.type === 'result') { void finish(null, { artifactId: request.artifactId, requestId: request.requestId, matches: message.matches ?? [], totalCount: message.totalCount ?? 0, truncated: Boolean(message.truncated) }); return; }
    });
    worker.once('error', error => { void finish(error instanceof Error ? error : new Error(String(error))); });
    worker.once('exit', code => { if (!settled) void finish(new Error(`Workbook search worker exited before completion (${code}).`)); });
  });
}
