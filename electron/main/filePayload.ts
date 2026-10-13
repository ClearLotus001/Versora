import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  FILE_PAYLOAD_CACHE_LIMIT,
  FILE_PAYLOAD_CACHE_MAX_BYTES,
  REVISION_PAYLOAD_CACHE_LIMIT,
  REVISION_PAYLOAD_CACHE_MAX_BYTES,
} from './constants.js';
import { electronT } from '../i18n.js';
import { estimatePayloadMemoryBytes, rememberCacheEntry } from './cache.js';
import { writeExternalDiffDebugLog } from './logger.js';
import { runSvnBuffer } from './rustBridge.js';
import { getPeggedSvnTarget, isWorkbookFile, normalizeRevisionNumber } from './svnHelpers.js';
import {
  filePayloadCache,
  getActiveCliArgs,
  getSessionCacheGeneration,
  revisionPayloadCache,
} from './state.js';
import { resolveWorkingCopyPathForTarget } from './svnOperations.js';
import type { FilePayload, SvnRevisionInfo } from './types.js';

function textPayload(content: string | null, readMs = 0, byteLength = 0): FilePayload {
  return { content, perf: { readMs, byteLength } };
}

/** Workbook files enter the native artifact pipeline before these text readers. */
function requireTextSource(fileName: string): void {
  if (isWorkbookFile(fileName)) throw new Error('Workbook files must be prepared through the native artifact pipeline.');
}

export async function readFilePayload(filePath: string): Promise<FilePayload> {
  requireTextSource(filePath);
  const cacheGeneration = getSessionCacheGeneration();
  if (!filePath || !fs.existsSync(filePath)) return textPayload(null);

  try {
    const stat = await fs.promises.stat(filePath);
    const cached = filePayloadCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return { ...cached.payload };

    const start = performance.now();
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const payload = textPayload(content, performance.now() - start, Buffer.byteLength(content, 'utf-8'));
    if (getSessionCacheGeneration() === cacheGeneration) rememberCacheEntry(filePayloadCache, filePath, {
      mtimeMs: stat.mtimeMs, size: stat.size, payload, memoryBytes: estimatePayloadMemoryBytes(payload),
    }, FILE_PAYLOAD_CACHE_LIMIT, FILE_PAYLOAD_CACHE_MAX_BYTES);
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(electronT('filePayloadReadError', { message }), { cause: error });
  }
}

export async function readRevisionPayload(source: SvnRevisionInfo, target: string, fileName: string): Promise<FilePayload> {
  requireTextSource(fileName);
  const cacheGeneration = getSessionCacheGeneration();
  const args = getActiveCliArgs();
  if (source.id === '__base_input__') {
    writeExternalDiffDebugLog('read-revision-payload', {
      mode: 'special-base', sourceId: source.id, fileName, filePath: args.basePath,
    });
    return readFilePayload(args.basePath);
  }
  if (source.id === '__mine_input__') {
    const workingCopyPath = await resolveWorkingCopyPathForTarget(args, target);
    const filePath = workingCopyPath || args.minePath;
    writeExternalDiffDebugLog('read-revision-payload', { mode: 'special-mine', sourceId: source.id, fileName, filePath });
    return readFilePayload(filePath);
  }

  const peggedTarget = getPeggedSvnTarget(target);
  const revisionCacheKey = `${peggedTarget}::${fileName}::${source.id}`;
  const cached = revisionPayloadCache.get(revisionCacheKey);
  if (cached) return cached.payload;

  if (!target) {
    writeExternalDiffDebugLog('read-revision-payload', { mode: 'missing-target', sourceId: source.id, revision: source.revision, fileName });
    throw new Error(electronT('filePayloadMissingRepositoryUrl'));
  }

  writeExternalDiffDebugLog('read-revision-payload', {
    mode: 'svn-cat', sourceId: source.id, revision: source.revision,
    normalizedRevision: normalizeRevisionNumber(source.revision), target, peggedTarget, fileName,
  });
  const result = await runSvnBuffer(['cat', '-r', normalizeRevisionNumber(source.revision), peggedTarget]);
  if (!result.ok) {
    const message = result.stderr.trim() || 'svn cat failed';
    writeExternalDiffDebugLog('read-revision-payload:error', {
      sourceId: source.id, revision: source.revision, target, peggedTarget, fileName, message,
    });
    throw new Error(electronT('filePayloadReadRevisionError', { revision: source.revision, message }));
  }

  const payload = textPayload(result.stdout.toString('utf-8'), 0, result.stdout.length);
  if (getSessionCacheGeneration() === cacheGeneration) rememberCacheEntry(revisionPayloadCache, revisionCacheKey, {
    payload, memoryBytes: estimatePayloadMemoryBytes(payload),
  }, REVISION_PAYLOAD_CACHE_LIMIT, REVISION_PAYLOAD_CACHE_MAX_BYTES);
  return payload;
}
