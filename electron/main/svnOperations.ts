import { performance } from 'node:perf_hooks';
import {
  REVISION_OPTION_PAGES_CACHE_LIMIT,
} from './constants.js';
import { rememberLimitedEntry } from './cache.js';
import { logMainWarn } from '../logging.js';
import { logDebugTiming, writeExternalDiffDebugLog } from './logger.js';
import { runSvnBuffer, runSvnUtf8 } from './rustBridge.js';
import {
  buildRevisionQueryCacheKey,
  createCliRevisionInfo,
  formatSvnDateQuery,
  getPeggedSvnTarget,
  getRevisionNumberValue,
  haveSameExplicitSvnUrl,
  isRemoteRepositoryTarget,
  isRevisionSelectionId,
  normalizeRevisionNumber,
  normalizeRevisionQuery,
  normalizeSvnUrlForCompare,
  parseBlameEntries,
  parseLogEntries,
} from './svnHelpers.js';
import {
  cachedRevisionOptionPages,
  getActiveCliArgs,
  getCachedSvnTarget,
  getCachedTimelineTarget,
  setCachedSvnTarget,
  setCachedTimelineTarget,
} from './state.js';
import {
  localSvnUrlCache,
  localVersioningStatusCache,
} from './svnProbeCache.js';
import type {
  RevisionOptionsPayload,
  RevisionOptionsQuery,
  LineBlameLine,
  LineBlamePayload,
  SvnRevisionInfo,
} from './types.js';

const SVN_BLAME_CACHE_LIMIT = 32;
const svnBlameCache = new Map<string, Promise<LineBlameLine[]>>();

function rememberProbePromise<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    try {
      return await factory();
    } catch (error) {
      cache.delete(key);
      throw error;
    }
  })();
  cache.set(key, pending);
  return pending;
}

function getCandidateLocalPaths(args: { basePath: string; minePath: string }): string[] {
  return Array.from(
    new Set([args.minePath, args.basePath].map(value => value.trim()).filter(Boolean)),
  );
}

export async function resolveLocalSvnUrl(filePath: string): Promise<string> {
  const candidate = filePath.trim();
  if (!candidate) return '';

  const resolved = await rememberProbePromise(localSvnUrlCache, candidate, async () => {
    const result = await runSvnUtf8(['info', '--show-item', 'url', candidate]);
    return result.ok ? result.stdout.trim() : '';
  });

  if (resolved) {
    localVersioningStatusCache.set(candidate, Promise.resolve('versioned'));
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// SVN target resolution
// ---------------------------------------------------------------------------

export async function resolveSvnTarget(): Promise<string> {
  if (getCachedSvnTarget() !== undefined) return getCachedSvnTarget() ?? '';

  const args = getActiveCliArgs();
  const explicitBase = isRemoteRepositoryTarget(args.baseUrl) ? args.baseUrl.trim() : '';
  const explicitMine = isRemoteRepositoryTarget(args.mineUrl) ? args.mineUrl.trim() : '';
  if (explicitBase && explicitMine) {
    if (haveSameExplicitSvnUrl(args)) {
      setCachedSvnTarget(explicitMine);
      setCachedTimelineTarget(explicitMine);
      writeExternalDiffDebugLog('resolve-svn-target', {
        mode: 'explicit-both',
        result: explicitMine,
      });
      return explicitMine;
    }
    setCachedSvnTarget(null);
    setCachedTimelineTarget(null);
    writeExternalDiffDebugLog('resolve-svn-target', {
      mode: 'explicit-conflict',
      baseUrl: explicitBase,
      mineUrl: explicitMine,
      result: '',
    });
    return '';
  }

  const explicit = explicitMine || explicitBase;
  if (explicit) {
    setCachedSvnTarget(explicit);
    setCachedTimelineTarget(explicit);
    writeExternalDiffDebugLog('resolve-svn-target', {
      mode: explicitMine ? 'explicit-mine' : 'explicit-base',
      result: explicit,
    });
    return explicit;
  }

  const candidatePaths = getCandidateLocalPaths(args);
  if (candidatePaths.length === 0) {
    setCachedSvnTarget(null);
    setCachedTimelineTarget(null);
    writeExternalDiffDebugLog('resolve-svn-target', {
      mode: 'no-candidates',
      result: '',
    });
    return '';
  }

  const resolvedTargets = Array.from(new Set((await Promise.all(
    candidatePaths.map(candidatePath => resolveLocalSvnUrl(candidatePath)),
  )).filter(Boolean)));

  if (resolvedTargets.length !== 1) {
    setCachedSvnTarget(null);
    writeExternalDiffDebugLog('resolve-svn-target', {
      mode: 'path-probe-mismatch',
      candidatePaths,
      resolvedTargets,
      result: '',
    });
    return '';
  }

  const target = resolvedTargets[0] ?? '';
  setCachedSvnTarget(target || null);
  if (target) {
    setCachedTimelineTarget(target);
  }
  writeExternalDiffDebugLog('resolve-svn-target', {
    mode: 'path-probe',
    candidatePaths,
    resolvedTargets,
    result: target,
  });
  return target;
}

export async function resolveTimelineTargetUrl(): Promise<string> {
  if (getCachedTimelineTarget() !== undefined) return getCachedTimelineTarget() ?? '';

  const cachedSvnTarget = getCachedSvnTarget();
  if (cachedSvnTarget) {
    setCachedTimelineTarget(cachedSvnTarget);
    return cachedSvnTarget;
  }

  const args = getActiveCliArgs();
  const candidatePaths = getCandidateLocalPaths(args);

  for (const candidatePath of candidatePaths) {
    const resolved = await resolveLocalSvnUrl(candidatePath);
    if (!resolved) continue;

    setCachedTimelineTarget(resolved);
    writeExternalDiffDebugLog('resolve-timeline-target', {
      mode: 'working-copy-path',
      candidatePath,
      result: resolved,
    });
    return resolved;
  }

  const explicitBase = isRemoteRepositoryTarget(args.baseUrl) ? normalizeSvnUrlForCompare(args.baseUrl) : '';
  const explicitMine = isRemoteRepositoryTarget(args.mineUrl) ? normalizeSvnUrlForCompare(args.mineUrl) : '';
  const fallback = explicitMine || explicitBase;
  if (explicitBase && explicitMine && explicitBase !== explicitMine) {
    setCachedTimelineTarget(null);
    writeExternalDiffDebugLog('resolve-timeline-target', {
      mode: 'explicit-conflict',
      baseUrl: explicitBase,
      mineUrl: explicitMine,
      result: '',
    });
    return '';
  }

  setCachedTimelineTarget(fallback || null);
  writeExternalDiffDebugLog('resolve-timeline-target', {
    mode: 'fallback',
    result: fallback,
  });
  return fallback;
}

export async function detectLocalSvnVersioningStatus(
  filePath: string,
): Promise<'versioned' | 'unversioned' | 'unknown'> {
  const candidate = filePath.trim();
  if (!candidate) return 'unknown';

  const cached = localVersioningStatusCache.get(candidate);
  if (cached) {
    return cached;
  }

  return rememberProbePromise(localVersioningStatusCache, candidate, async () => {
    const cachedUrl = localSvnUrlCache.get(candidate);
    if (cachedUrl) {
      const resolvedUrl = await cachedUrl;
      if (resolvedUrl) {
        return 'versioned';
      }
    }

    const result = await runSvnUtf8(['status', candidate]);
    if (!result.ok) return 'unknown';

    const firstLine = result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean);

    if (!firstLine) return 'versioned';
    if (firstLine.startsWith('?') || firstLine.startsWith('I')) return 'unversioned';
    return 'versioned';
  });
}

interface ResolvedBlameSource {
  target: string;
  revision: string;
  cacheable: boolean;
}

function getSideValue(
  side: 'base' | 'mine',
  values: { base: string; mine: string },
): string {
  return side === 'base' ? values.base : values.mine;
}

function escapeLocalSvnTarget(filePath: string): string {
  return filePath.includes('@') ? `${filePath}@` : filePath;
}

async function resolveBlameSource(
  side: 'base' | 'mine',
  requestedRevisionId: string | undefined,
): Promise<ResolvedBlameSource | null> {
  const args = getActiveCliArgs();
  const sidePath = getSideValue(side, { base: args.basePath, mine: args.minePath }).trim();
  const sideUrl = getSideValue(side, { base: args.baseUrl, mine: args.mineUrl }).trim();
  const revisionInfo = createCliRevisionInfo(side);
  const revisionId = requestedRevisionId?.trim() || revisionInfo?.id.trim() || '';

  if (isRevisionSelectionId(revisionId)) {
    const remoteTarget = isRemoteRepositoryTarget(sideUrl)
      ? sideUrl
      : (sidePath ? await resolveLocalSvnUrl(sidePath) : '') || await resolveSvnTarget();
    if (!remoteTarget) return null;

    return {
      target: getPeggedSvnTarget(remoteTarget),
      revision: normalizeRevisionNumber(revisionId),
      cacheable: true,
    };
  }

  if (!sidePath || await detectLocalSvnVersioningStatus(sidePath) !== 'versioned') {
    return null;
  }

  return {
    target: escapeLocalSvnTarget(sidePath),
    revision: side === 'base' ? 'BASE' : '',
    cacheable: side === 'base',
  };
}

async function queryBlameSource(source: ResolvedBlameSource | null): Promise<LineBlameLine[]> {
  if (!source) return [];

  const cacheKey = `${source.target}::${source.revision || 'WORKING'}`;
  if (source.cacheable) {
    const cached = svnBlameCache.get(cacheKey);
    if (cached) return cached;
  }

  const pending = (async () => {
    const svnArgs = ['blame', '--xml'];
    if (source.revision) svnArgs.push('-r', source.revision);
    svnArgs.push(source.target);

    const result = await runSvnUtf8(svnArgs);
    if (!result.ok) {
      const message = result.stderr.trim();
      if (message) logMainWarn('svn-blame', message);
      return [];
    }
    return parseBlameEntries(result.stdout);
  })();

  if (source.cacheable) {
    void rememberLimitedEntry(svnBlameCache, cacheKey, pending, SVN_BLAME_CACHE_LIMIT);
    void pending.catch(() => svnBlameCache.delete(cacheKey));
  }
  return pending;
}

export async function loadSvnLineBlame(
  baseRevisionId?: string,
  mineRevisionId?: string,
): Promise<LineBlamePayload> {
  const [baseSource, mineSource] = await Promise.all([
    resolveBlameSource('base', baseRevisionId),
    resolveBlameSource('mine', mineRevisionId),
  ]);
  const sameSource = baseSource != null
    && mineSource != null
    && baseSource.target === mineSource.target
    && baseSource.revision === mineSource.revision;
  const basePromise = queryBlameSource(baseSource);
  const [base, mine] = sameSource
    ? await Promise.all([basePromise, basePromise])
    : await Promise.all([basePromise, queryBlameSource(mineSource)]);

  return { base, mine };
}

export async function loadSvnWorkingFileLineBlame(
  filePath: string,
): Promise<LineBlameLine[]> {
  const candidate = filePath.trim();
  if (!candidate || !await resolveLocalSvnUrl(candidate)) return [];
  return queryBlameSource({
    target: escapeLocalSvnTarget(candidate),
    revision: '',
    cacheable: false,
  });
}

export function loadSvnTargetLineBlame(
  target: string,
  revisionId: string,
): Promise<LineBlameLine[]> {
  return queryBlameSource({
    target: getPeggedSvnTarget(target),
    revision: normalizeRevisionNumber(revisionId),
    cacheable: true,
  });
}

export async function readSvnFileRevision(
  target: string,
  revisionId: string,
): Promise<Buffer> {
  const result = await runSvnBuffer([
    'cat',
    '-r',
    normalizeRevisionNumber(revisionId),
    getPeggedSvnTarget(target),
  ]);
  if (!result.ok) {
    throw new Error(result.stderr.trim() || `Unable to read SVN revision ${revisionId}.`);
  }
  return result.stdout;
}

export async function querySvnRevisionInfoForTarget(
  target: string,
  revisionId: string,
): Promise<SvnRevisionInfo | null> {
  const revision = normalizeRevisionNumber(revisionId);
  if (!target || !revision) return null;
  const result = await runSvnUtf8([
    'log',
    '--xml',
    '--limit',
    '1',
    '-r',
    revision,
    getPeggedSvnTarget(target),
  ]);
  return result.ok ? (parseLogEntries(result.stdout)[0] ?? null) : null;
}

export async function resolveWorkingCopyPathForTarget(
  args: { basePath: string; minePath: string },
  target: string,
): Promise<string> {
  const normalizedTarget = normalizeSvnUrlForCompare(target);
  if (!normalizedTarget) return '';

  const candidates = getCandidateLocalPaths(args);

  for (const candidatePath of candidates) {
    const resolved = await resolveLocalSvnUrl(candidatePath);
    if (!resolved) continue;
    if (normalizeSvnUrlForCompare(resolved) === normalizedTarget) {
      return candidatePath;
    }
  }

  return '';
}

// ---------------------------------------------------------------------------
// Revision options query
// ---------------------------------------------------------------------------

export async function queryRevisionOptionsForTarget(
  target: string,
  query: RevisionOptionsQuery | undefined,
): Promise<RevisionOptionsPayload> {
  const start = performance.now();
  const normalized = normalizeRevisionQuery(query);
  const normalizedTarget = normalizeSvnUrlForCompare(target);
  const peggedTarget = getPeggedSvnTarget(normalizedTarget);
  const cacheKey = `${peggedTarget}::${buildRevisionQueryCacheKey(normalized)}`;
  const shouldBypassCache = !normalized.beforeRevisionId && !normalized.anchorDateTime;
  const cached = shouldBypassCache ? null : cachedRevisionOptionPages.get(cacheKey);
  if (cached) return cached;

  const specials: SvnRevisionInfo[] = [];
  if (!normalizedTarget) {
    const payload: RevisionOptionsPayload = {
      items: specials,
      hasMore: false,
      nextBeforeRevisionId: null,
      anchorRevisionId: null,
      queryDateTime: normalized.anchorDateTime || null,
    };
    if (!shouldBypassCache) {
      rememberLimitedEntry(cachedRevisionOptionPages, cacheKey, payload, REVISION_OPTION_PAGES_CACHE_LIMIT);
    }
    logDebugTiming('revision-options:skip', {
      ms: Number((performance.now() - start).toFixed(1)),
      count: payload.items.length,
    });
    return payload;
  }

  if (normalized.beforeRevisionId) {
    const beforeNumber = getRevisionNumberValue(normalized.beforeRevisionId);
    if (beforeNumber != null && beforeNumber <= 1) {
      const payload: RevisionOptionsPayload = {
        items: specials,
        hasMore: false,
        nextBeforeRevisionId: null,
        anchorRevisionId: null,
        queryDateTime: normalized.anchorDateTime || null,
      };
      if (!shouldBypassCache) {
        rememberLimitedEntry(cachedRevisionOptionPages, cacheKey, payload, REVISION_OPTION_PAGES_CACHE_LIMIT);
      }
      return payload;
    }
  }

  const svnArgs = ['log', '--xml', '--limit', String(normalized.limit + 1)];
  if (normalized.beforeRevisionId) {
    const beforeNumber = getRevisionNumberValue(normalized.beforeRevisionId);
    if (beforeNumber != null) {
      svnArgs.push('-r', `${Math.max(1, beforeNumber - 1)}:1`);
    }
  } else if (normalized.anchorDateTime) {
    svnArgs.push('-r', `{${formatSvnDateQuery(normalized.anchorDateTime)}}:1`);
  }
  svnArgs.push(peggedTarget);

  const result = await runSvnUtf8(svnArgs);
  if (!result.ok) {
    if (result.stderr.trim()) logMainWarn('svn-log', result.stderr.trim());
    const payload: RevisionOptionsPayload = {
      items: specials,
      hasMore: false,
      nextBeforeRevisionId: null,
      anchorRevisionId: null,
      queryDateTime: normalized.anchorDateTime || null,
    };
    if (!shouldBypassCache) {
      rememberLimitedEntry(cachedRevisionOptionPages, cacheKey, payload, REVISION_OPTION_PAGES_CACHE_LIMIT);
    }
    logDebugTiming('revision-options:fallback', {
      ms: Number((performance.now() - start).toFixed(1)),
      count: payload.items.length,
    });
    return payload;
  }

  const revisions = parseLogEntries(result.stdout);
  const hasMore = revisions.length > normalized.limit;
  const pageRevisions = revisions.slice(0, normalized.limit);
  const lastVisibleRevision = pageRevisions[pageRevisions.length - 1] ?? null;
  const payload: RevisionOptionsPayload = {
    items: [...specials, ...pageRevisions],
    hasMore,
    nextBeforeRevisionId: hasMore ? lastVisibleRevision?.id ?? null : null,
    anchorRevisionId: normalized.anchorDateTime ? (pageRevisions[0]?.id ?? null) : null,
    queryDateTime: normalized.anchorDateTime || null,
  };
  if (!shouldBypassCache) {
    rememberLimitedEntry(cachedRevisionOptionPages, cacheKey, payload, REVISION_OPTION_PAGES_CACHE_LIMIT);
  }
  logDebugTiming('revision-options:loaded', {
    ms: Number((performance.now() - start).toFixed(1)),
    count: payload.items.length,
    hasMore,
    nextBeforeRevisionId: payload.nextBeforeRevisionId,
    queryDateTime: payload.queryDateTime,
  });
  return payload;
}

export async function queryRevisionOptions(
  query: RevisionOptionsQuery | undefined,
): Promise<RevisionOptionsPayload> {
  const targetSide = query?.targetSide;
  const args = getActiveCliArgs();
  const sideTarget = targetSide === 'base'
    ? args.baseUrl.trim()
    : targetSide === 'mine'
      ? args.mineUrl.trim()
      : '';
  const target = isRemoteRepositoryTarget(sideTarget)
    ? sideTarget
    : await resolveTimelineTargetUrl();
  return queryRevisionOptionsForTarget(target, query);
}

export async function getRevisionOptions(): Promise<SvnRevisionInfo[]> {
  const payload = await queryRevisionOptions({
    limit: 60,
    includeSpecials: false,
  });
  return payload.items;
}

// ---------------------------------------------------------------------------
// File equality checks
// ---------------------------------------------------------------------------
