import { TextAnalysisClient } from './text/analysisClient.js';
import { getSessionCacheGeneration } from './state.js';
import type {
  DiffAnalysisSnapshot,
  FilePayload,
  WorkbookCompareMode,
} from './types.js';

const ANALYSIS_SNAPSHOT_CACHE_LIMIT = 8;
const ANALYSIS_SNAPSHOT_CACHE_MAX_BYTES = 160 * 1024 * 1024;

interface AnalysisSnapshotCacheEntry {
  snapshot: DiffAnalysisSnapshot;
  memoryBytes: number;
}

const analysisSnapshotCache = new Map<string, AnalysisSnapshotCacheEntry>();
const analysisSnapshotInFlight = new Map<string, Promise<DiffAnalysisSnapshot>>();
const textAnalysisClient = new TextAnalysisClient();
const analysisSnapshotMemoryEstimateCache = new WeakMap<DiffAnalysisSnapshot, number>();
let analysisSnapshotCacheGeneration = getSessionCacheGeneration();
export interface ResolveAnalysisSnapshotInput {
  sourceIdentity: string;
  compareMode: WorkbookCompareMode;
  baseRevisionId?: string | undefined;
  mineRevisionId?: string | undefined;
  basePayload: FilePayload;
  minePayload: FilePayload;
}

function syncAnalysisSnapshotCacheGeneration(): number {
  const currentGeneration = getSessionCacheGeneration();
  if (analysisSnapshotCacheGeneration !== currentGeneration) {
    analysisSnapshotCache.clear();
    analysisSnapshotInFlight.clear();
    analysisSnapshotCacheGeneration = currentGeneration;
  }
  return currentGeneration;
}

export function buildAnalysisSnapshotCacheKey({
  sourceIdentity,
  compareMode,
  baseRevisionId,
  mineRevisionId,
}: Pick<ResolveAnalysisSnapshotInput, 'sourceIdentity' | 'compareMode' | 'baseRevisionId' | 'mineRevisionId'>): string {
  return [
    sourceIdentity.trim(),
    baseRevisionId ?? '',
    mineRevisionId ?? '',
    compareMode,
  ].join('::');
}

function estimateStringBytes(value: string | null | undefined): number {
  return value ? Buffer.byteLength(value, 'utf-8') : 0;
}

export function estimateAnalysisSnapshotMemoryBytes(snapshot: DiffAnalysisSnapshot): number {
  const cachedEstimate = analysisSnapshotMemoryEstimateCache.get(snapshot);
  if (cachedEstimate != null) return cachedEstimate;

  const textAnalysis = snapshot.textAnalysis;
  if (textAnalysis) {
    const diffBytes = textAnalysis.diffLines.reduce((total, line) => (
      total + estimateStringBytes(line.base) + estimateStringBytes(line.mine) + 64
    ), 0);
    const descriptorBytes = textAnalysis.splitRowDescriptors.reduce((total, descriptor) => (
      total + 48 + (descriptor.lineIdxs.length * 8)
    ), 0);
    const estimatedBytes = diffBytes
      + descriptorBytes
      + (textAnalysis.replacementPairs.length * 24)
      + 128;
    analysisSnapshotMemoryEstimateCache.set(snapshot, estimatedBytes);
    return estimatedBytes;
  }

  analysisSnapshotMemoryEstimateCache.set(snapshot, 128);
  return 128;
}

function touchAnalysisSnapshot(
  key: string,
  entry: AnalysisSnapshotCacheEntry,
): DiffAnalysisSnapshot {
  if (analysisSnapshotCache.has(key)) {
    analysisSnapshotCache.delete(key);
  }
  analysisSnapshotCache.set(key, entry);
  return entry.snapshot;
}

function rememberAnalysisSnapshot(key: string, snapshot: DiffAnalysisSnapshot) {
  const memoryBytes = estimateAnalysisSnapshotMemoryBytes(snapshot);
  if (memoryBytes > ANALYSIS_SNAPSHOT_CACHE_MAX_BYTES) {
    return;
  }
  touchAnalysisSnapshot(key, { snapshot, memoryBytes });

  let totalBytes = 0;
  analysisSnapshotCache.forEach((entry) => {
    totalBytes += entry.memoryBytes;
  });
  while (
    analysisSnapshotCache.size > ANALYSIS_SNAPSHOT_CACHE_LIMIT
    || totalBytes > ANALYSIS_SNAPSHOT_CACHE_MAX_BYTES
  ) {
    const oldestKey = analysisSnapshotCache.keys().next().value;
    if (!oldestKey) break;
    const oldestEntry = analysisSnapshotCache.get(oldestKey);
    if (oldestEntry) totalBytes -= oldestEntry.memoryBytes;
    analysisSnapshotCache.delete(oldestKey);
  }
}

async function buildTextSnapshot(
  input: ResolveAnalysisSnapshotInput,
  requestKey: string,
): Promise<DiffAnalysisSnapshot> {
  const analysis = await textAnalysisClient.analyze(
    requestKey,
    input.basePayload.content ?? '',
    input.minePayload.content ?? '',
  );
  return {
    compareMode: input.compareMode,
    textAnalysis: analysis,
  };
}

export async function resolveAnalysisSnapshot(
  input: ResolveAnalysisSnapshotInput,
): Promise<DiffAnalysisSnapshot> {
  const cacheGeneration = syncAnalysisSnapshotCacheGeneration();
  const key = buildAnalysisSnapshotCacheKey(input);
  const cached = analysisSnapshotCache.get(key);
  if (cached) {
    return touchAnalysisSnapshot(key, cached);
  }

  const inFlight = analysisSnapshotInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const resolver = (async () => {
    const snapshot = await buildTextSnapshot(input, `${cacheGeneration}::${key}`);
    if (getSessionCacheGeneration() === cacheGeneration) {
      rememberAnalysisSnapshot(key, snapshot);
    }
    return snapshot;
  })();

  analysisSnapshotInFlight.set(key, resolver);
  try {
    return await resolver;
  } finally {
    if (analysisSnapshotInFlight.get(key) === resolver) {
      analysisSnapshotInFlight.delete(key);
    }
  }
}

export function clearAnalysisSnapshotCache() {
  textAnalysisClient.clear();
  analysisSnapshotCache.clear();
  analysisSnapshotInFlight.clear();
  analysisSnapshotCacheGeneration = getSessionCacheGeneration();
}
