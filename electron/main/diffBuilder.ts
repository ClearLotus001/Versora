import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  REMOTE_HEAD_ID,
  SPECIAL_BASE_ID,
  SPECIAL_MINE_ID,
} from './constants.js';
import {
  resolveAnalysisSnapshot,
} from './analysisSnapshotService.js';
import { writeExternalDiffDebugLog } from './logger.js';
import {
  buildInitialPairFromCli,
  buildLaunchDisplayName,
  buildResetPair,
  buildSourceIdentity,
  createCliRevisionInfo,
  createCurrentPairInfo,
  createRequestedRevisionInfo,
  getLatestRemoteRevisionId,
  isRemoteRepositoryTarget,
  isRemoteHeadSelectionId,
  isRevisionSelectionId,
  isSameWorkbookSource,
  isWorkbookFile,
  getPeggedSvnTarget,
  normalizeRevisionNumber,
  makeSideDisplayName,
  resolveCliSourceIdentityKind,
  resolveCurrentCompareContext,
  resolveSideName,
  shouldResolveSvnRuntimeContext,
} from './svnHelpers.js';
import {
  getActiveCliArgs,
  setActiveCliArgs,
  getCurrentComparisonSessionId,
} from './state.js';
import {
  detectLocalSvnVersioningStatus,
  getRevisionOptions,
  queryRevisionOptionsForTarget,
  querySvnRevisionInfoForTarget,
  resolveLocalSvnUrl,
  resolveSvnTarget,
  resolveTimelineTargetUrl,
  resolveWorkingCopyPathForTarget,
} from './svnOperations.js';
import {
  readFilePayload,
  readRevisionPayload,
} from './filePayload.js';
import { runSvnToFile } from './rustBridge.js';
import { artifactSourcePath, getCurrentWorkbookArtifact, getWorkbookArtifactReader, prepareWorkbookArtifact } from './workbookArtifactService.js';
import type { WorkbookArtifactReader } from './workbookArtifactReader.js';
import type {
  BuildDiffDataOptions,
  CliArgs,
  DiffData,
  SvnRevisionInfo,
  WorkbookCompareMode,
  WorkbookCompareModePayload,
  WorkbookMetadataPayload,
} from './types.js';

interface WorkbookRequestContext {
  args: CliArgs;
  target: string;
  resolvedFileName: string;
  sourceIdentity: string;
  baseRevisionId: string | undefined;
  mineRevisionId: string | undefined;
  baseSourceInfo: SvnRevisionInfo;
  mineSourceInfo: SvnRevisionInfo;
  workingCopyPath: string;
  baseTarget: string;
  mineTarget: string;
  baseLocalPath: string;
  mineLocalPath: string;
  sameSource: boolean;
}

export type ArtifactWorkbookDiffMeta = Omit<DiffData,
  'baseContent' | 'mineContent' | 'analysisSnapshotsByMode'
  | 'baseWorkbookMetadata' | 'mineWorkbookMetadata' | 'workbookArtifactDiff' | 'perf' | 'workbookArtifact'>;

const artifactContexts = new WeakMap<WorkbookArtifactReader, { args: string; baseRevisionId: string | undefined; mineRevisionId: string | undefined }>();

export async function buildArtifactWorkbookDiffData(
  meta: ArtifactWorkbookDiffMeta,
  compareMode: WorkbookCompareMode,
  resolveSources: (artifactDir: string, signal: AbortSignal) => Promise<{ basePath: string; minePath: string }>,
  sourceKey = meta.sourceIdentity,
): Promise<DiffData> {
  const start = performance.now();
  const workbookArtifact = await prepareWorkbookArtifact({ comparisonSessionId: getCurrentComparisonSessionId(), sourceKey, compareMode, resolveSources });
  const reader = getWorkbookArtifactReader(workbookArtifact.artifactId);
  artifactContexts.set(reader, { args: JSON.stringify(getActiveCliArgs()), baseRevisionId: meta.baseRevisionInfo?.id, mineRevisionId: meta.mineRevisionInfo?.id });
  const workbookArtifactDiff = reader.contentsEqual === false
    && workbookArtifact.stats.changedCells === 0 && workbookArtifact.stats.addedRows === 0 && workbookArtifact.stats.deletedRows === 0
    && workbookArtifact.sheets.every(sheet => sheet.hasBaseSide && sheet.hasMineSide)
    ? { hasArtifactOnlyDiff: true as const, kind: 'binary-only' as const, baseBytes: reader.sourceByteLengths.base, mineBytes: reader.sourceByteLengths.mine } : null;
  return {
    ...meta, workbookArtifact,
    baseContent: null, mineContent: null,
    analysisSnapshotsByMode: null,
    baseWorkbookMetadata: workbookArtifact.baseMetadata,
    mineWorkbookMetadata: workbookArtifact.mineMetadata,
    workbookArtifactDiff,
    perf: { source: 'cli', mainLoadMs: performance.now() - start, rustDiffMs: workbookArtifact.perf.totalMs,
      baseBytes: reader.sourceByteLengths.base, mineBytes: reader.sourceByteLengths.mine },
  };
}

async function buildContextArtifactWorkbookDiffData(
  context: WorkbookRequestContext,
  compareMode: WorkbookCompareMode,
  meta: ArtifactWorkbookDiffMeta,
): Promise<DiffData> {
  const stats = await Promise.all([context.baseLocalPath, context.mineLocalPath].map(async sourcePath => {
    if (!sourcePath) return '';
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) throw new Error('A workbook source is not a regular file.');
    return `${sourcePath}:${stat.size}:${stat.mtimeMs}`;
  }));
  return buildArtifactWorkbookDiffData(meta, compareMode, async (artifactDir, signal) => {
    const resolveSide = async (side: 'base' | 'mine'): Promise<string> => {
      const localPath = side === 'base' ? context.baseLocalPath : context.mineLocalPath;
      if (localPath) return localPath;
      const target = side === 'base' ? context.baseTarget : context.mineTarget;
      const info = side === 'base' ? context.baseSourceInfo : context.mineSourceInfo;
      if (!target) throw new Error('The workbook revision has no repository URL.');
      const destination = artifactSourcePath(artifactDir, side, path.extname(context.resolvedFileName));
      await runSvnToFile(['cat', '-r', normalizeRevisionNumber(info.revision), getPeggedSvnTarget(target)], destination, signal);
      return destination;
    };
    const sources = await Promise.allSettled([resolveSide('base'), resolveSide('mine')]);
    const failure = sources.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return { basePath: (sources[0] as PromiseFulfilledResult<string>).value, minePath: (sources[1] as PromiseFulfilledResult<string>).value };
  }, `${context.sourceIdentity}:${stats.join('|')}`);
}

async function hydrateRevisionLogInfo(
  info: SvnRevisionInfo | null,
  target: string,
): Promise<SvnRevisionInfo | null> {
  if (
    !info
    || info.kind !== 'revision'
    || !target.trim()
    || info.message.trim()
    || info.author.trim()
    || info.date.trim()
  ) {
    return info;
  }

  return await querySvnRevisionInfoForTarget(target, info.id) ?? info;
}

function resolveLocalWorkbookSourcePath(
  side: 'base' | 'mine',
  revisionId: string | undefined,
  args: CliArgs,
  workingCopyPath: string,
): string {
  if (!revisionId) {
    return side === 'base' ? args.basePath : args.minePath;
  }
  if (revisionId === SPECIAL_BASE_ID) {
    return args.basePath;
  }
  if (revisionId === SPECIAL_MINE_ID) {
    return workingCopyPath || args.minePath;
  }
  return '';
}

function createWorkbookRequestContext(params: {
  args: CliArgs;
  target: string;
  resolvedFileName: string;
  baseRevisionId: string | undefined;
  mineRevisionId: string | undefined;
  baseSourceInfo: SvnRevisionInfo;
  mineSourceInfo: SvnRevisionInfo;
  workingCopyPath: string;
  baseTarget?: string;
  mineTarget?: string;
  sourceIdentityKind?: 'cli' | 'revision-switch' | 'local-dev';
}): WorkbookRequestContext {
  const {
    args,
    target,
    resolvedFileName,
    baseRevisionId,
    mineRevisionId,
    baseSourceInfo,
    mineSourceInfo,
    workingCopyPath,
    baseTarget = target,
    mineTarget = target,
    sourceIdentityKind = resolveCliSourceIdentityKind(baseRevisionId, mineRevisionId),
  } = params;

  return {
    args,
    target,
    resolvedFileName,
    sourceIdentity: buildSourceIdentity({
      kind: sourceIdentityKind,
      fileName: resolvedFileName,
      baseUrl: isRevisionSelectionId(baseRevisionId) ? baseTarget : args.baseUrl,
      mineUrl: isRevisionSelectionId(mineRevisionId) ? mineTarget : args.mineUrl,
      baseRevision: baseRevisionId ?? args.baseRevision,
      mineRevision: mineRevisionId ?? args.mineRevision,
      pegRevision: args.pegRevision,
      basePath: baseRevisionId ? '' : args.basePath,
      minePath: mineRevisionId ? '' : args.minePath,
      baseName: args.baseName,
      mineName: args.mineName,
    }),
    baseRevisionId,
    mineRevisionId,
    baseSourceInfo,
    mineSourceInfo,
    workingCopyPath,
    baseTarget,
    mineTarget,
    baseLocalPath: resolveLocalWorkbookSourcePath('base', baseRevisionId, args, workingCopyPath),
    mineLocalPath: resolveLocalWorkbookSourcePath('mine', mineRevisionId, args, workingCopyPath),
    sameSource: baseTarget.trim() === mineTarget.trim()
      && isSameWorkbookSource(args, baseRevisionId, mineRevisionId),
  };
}

export async function buildDiffData(options: BuildDiffDataOptions = {}): Promise<DiffData> {
  const buildStart = performance.now();
  const {
    baseRevisionId,
    mineRevisionId,
    workbookCompareMode = 'strict',
    includeRevisionOptions = false,
    revisionOptionsOverride = null,
  } = options;
  const args = getActiveCliArgs();
  const shouldResolveSvnContext = shouldResolveSvnRuntimeContext(baseRevisionId, mineRevisionId)
    || includeRevisionOptions;
  const target = shouldResolveSvnContext
    ? await resolveSvnTarget()
    : '';
  const timelineTargetUrl = shouldResolveSvnContext
    ? await resolveTimelineTargetUrl()
    : '';
  const workingCopyPath = shouldResolveSvnContext && target
    ? await resolveWorkingCopyPathForTarget(args, target)
    : '';
  const workingCopyAvailable = Boolean(workingCopyPath);
  const resolvedFileName = args.fileName.trim()
    || path.basename(args.minePath || args.basePath || '');
  const shouldLoadRevisionOptions = shouldResolveSvnContext
    && Boolean(includeRevisionOptions || baseRevisionId || mineRevisionId);
  const revisionOptions = shouldLoadRevisionOptions
    ? (revisionOptionsOverride ?? await getRevisionOptions())
    : null;
  const latestRemoteRevisionId = getLatestRemoteRevisionId(revisionOptions);
  const resolvedBaseRevisionId = isRemoteHeadSelectionId(baseRevisionId)
    ? (latestRemoteRevisionId ?? undefined)
    : baseRevisionId;
  const resolvedMineRevisionId = isRemoteHeadSelectionId(mineRevisionId)
    ? (latestRemoteRevisionId ?? undefined)
    : mineRevisionId;
  const sourceIdentityKind = resolveCliSourceIdentityKind(
    resolvedBaseRevisionId,
    resolvedMineRevisionId,
  );
  const isLaunchView = !resolvedBaseRevisionId && !resolvedMineRevisionId;
  const compareContext = resolveCurrentCompareContext({
    target,
    workingCopyAvailable,
    requestedBaseRevisionId: resolvedBaseRevisionId,
    requestedMineRevisionId: resolvedMineRevisionId,
    args,
  });
  const initialPair = buildInitialPairFromCli(compareContext);
  const resetPair = buildResetPair(compareContext, initialPair, workingCopyAvailable);
  const isWorkbook = isWorkbookFile(resolvedFileName);

  const pairInfo = createCurrentPairInfo({
    compareContext,
    requestedBaseRevisionId: resolvedBaseRevisionId,
    requestedMineRevisionId: resolvedMineRevisionId,
    revisionOptions,
  });
  const baseLogTarget = isRemoteRepositoryTarget(args.baseUrl) ? args.baseUrl : target;
  const mineLogTarget = isRemoteRepositoryTarget(args.mineUrl) ? args.mineUrl : target;
  const [baseRevisionInfo, mineRevisionInfo] = await Promise.all([
    hydrateRevisionLogInfo(pairInfo.base, baseLogTarget),
    hydrateRevisionLogInfo(pairInfo.mine, mineLogTarget),
  ]);
  const resolvedBasePayloadInfo = baseRevisionInfo ?? createRequestedRevisionInfo('base', resolvedBaseRevisionId);
  const resolvedMinePayloadInfo = mineRevisionInfo ?? createRequestedRevisionInfo('mine', resolvedMineRevisionId);
  const workbookRequestContext = isWorkbook
    ? createWorkbookRequestContext({
        args,
        target,
        resolvedFileName,
        baseRevisionId: resolvedBaseRevisionId,
        mineRevisionId: resolvedMineRevisionId,
        baseSourceInfo: resolvedBasePayloadInfo,
        mineSourceInfo: resolvedMinePayloadInfo,
        workingCopyPath,
        sourceIdentityKind,
      })
    : null;
  const baseLocalPath = workbookRequestContext?.baseLocalPath
    ?? resolveLocalWorkbookSourcePath('base', resolvedBaseRevisionId, args, workingCopyPath);
  const mineLocalPath = workbookRequestContext?.mineLocalPath
    ?? resolveLocalWorkbookSourcePath('mine', resolvedMineRevisionId, args, workingCopyPath);
  const sameSource = workbookRequestContext?.sameSource
    ?? isSameWorkbookSource(args, resolvedBaseRevisionId, resolvedMineRevisionId);
  const sourceIdentity = workbookRequestContext?.sourceIdentity
    ?? buildSourceIdentity({
      kind: sourceIdentityKind,
      fileName: resolvedFileName,
      baseUrl: isRevisionSelectionId(resolvedBaseRevisionId) ? target : args.baseUrl,
      mineUrl: isRevisionSelectionId(resolvedMineRevisionId) ? target : args.mineUrl,
      baseRevision: resolvedBaseRevisionId ?? args.baseRevision,
      mineRevision: resolvedMineRevisionId ?? args.mineRevision,
      pegRevision: args.pegRevision,
      basePath: resolvedBaseRevisionId ? '' : args.basePath,
      minePath: resolvedMineRevisionId ? '' : args.minePath,
      baseName: args.baseName,
      mineName: args.mineName,
    });
  const launchBaseName = buildLaunchDisplayName(resolvedFileName, args.baseName, args.basePath);
  const launchMineName = buildLaunchDisplayName(resolvedFileName, args.mineName, args.minePath);
  const displayBaseName = isLaunchView
    ? launchBaseName
    : makeSideDisplayName(
        resolvedFileName,
        baseRevisionInfo ?? createCliRevisionInfo('base') ?? createRequestedRevisionInfo('base', resolvedBaseRevisionId),
        resolveSideName(args.baseName, args.basePath),
      );
  const displayMineName = isLaunchView
    ? launchMineName
    : makeSideDisplayName(
        resolvedFileName,
        mineRevisionInfo ?? createCliRevisionInfo('mine') ?? createRequestedRevisionInfo('mine', resolvedMineRevisionId),
        resolveSideName(args.mineName, args.minePath),
      );

  writeExternalDiffDebugLog('build-diff-data:start', {
    requestedBaseRevisionId: resolvedBaseRevisionId ?? null,
    requestedMineRevisionId: resolvedMineRevisionId ?? null,
    compareMode: workbookCompareMode,
    fileName: resolvedFileName,
    target,
    timelineTargetUrl,
    workingCopyAvailable,
    compareContext,
    sameSource,
    initialPair,
    resetPair,
    activeCliArgs: args,
    resolvedBaseRevisionInfo: baseRevisionInfo,
    resolvedMineRevisionInfo: mineRevisionInfo,
  });

  if (workbookRequestContext) {
    return buildContextArtifactWorkbookDiffData(workbookRequestContext, workbookCompareMode, {
      ...(target ? { source: { kind: 'svn' as const, label: target, repositoryPath: target, baseKind: 'svn' as const, targetKind: 'svn' as const,
        baseVersion: baseRevisionInfo?.id ?? resolvedBaseRevisionId ?? null, targetVersion: mineRevisionInfo?.id ?? resolvedMineRevisionId ?? null } } : {}),
      svnUrl: target, fileName: resolvedFileName, basePath: args.basePath, minePath: args.minePath,
      sourceIdentity, compareContext, timelineTargetUrl, workingCopyAvailable, initialPair, resetPair,
      launchBaseName, launchMineName, baseName: displayBaseName, mineName: displayMineName,
      revisionOptions, baseRevisionInfo, mineRevisionInfo,
      canSwitchRevisions: compareContext !== 'literal_two_file_compare' && Boolean(timelineTargetUrl), sourceNoticeCode: null,
    });
  }
  const basePayloadPromise = resolvedBaseRevisionId
    ? readRevisionPayload(resolvedBasePayloadInfo, target, resolvedFileName)
    : readFilePayload(baseLocalPath);
  const [basePayload, minePayload] = await Promise.all([
    basePayloadPromise,
    sameSource ? basePayloadPromise : resolvedMineRevisionId
      ? readRevisionPayload(resolvedMinePayloadInfo, target, resolvedFileName)
      : readFilePayload(mineLocalPath),
  ]);
  const analysisSnapshot = await resolveAnalysisSnapshot({
    sourceIdentity, compareMode: workbookCompareMode, baseRevisionId: resolvedBaseRevisionId,
    mineRevisionId: resolvedMineRevisionId, basePayload, minePayload,
  });
  const preparedTextAnalysis = analysisSnapshot.textAnalysis;
  return {
    ...(target ? {
      source: {
        kind: 'svn' as const,
        label: target,
        repositoryPath: target,
        baseKind: 'svn' as const,
        targetKind: 'svn' as const,
        baseVersion: baseRevisionInfo?.id ?? resolvedBaseRevisionId ?? null,
        targetVersion: mineRevisionInfo?.id ?? resolvedMineRevisionId ?? null,
      },
    } : {}),
    svnUrl: target,
    fileName: resolvedFileName,
    basePath: args.basePath,
    minePath: args.minePath,
    sourceIdentity,
    compareContext,
    timelineTargetUrl,
    workingCopyAvailable,
    initialPair,
    resetPair,
    launchBaseName,
    launchMineName,
    baseName: displayBaseName,
    mineName: displayMineName,
    baseContent: basePayload.content,
    mineContent: minePayload.content,
    analysisSnapshotsByMode: {
      [workbookCompareMode]: analysisSnapshot,
    },
    baseWorkbookMetadata: null,
    mineWorkbookMetadata: null,
    revisionOptions,
    baseRevisionInfo,
    mineRevisionInfo,
    canSwitchRevisions: compareContext !== 'literal_two_file_compare' && Boolean(timelineTargetUrl),
    workbookArtifactDiff: null,
    sourceNoticeCode: null,
    perf: {
      source: resolvedBaseRevisionId || resolvedMineRevisionId ? 'revision-switch' : 'cli',
      mainLoadMs: performance.now() - buildStart,
      baseReadMs: basePayload.perf.readMs,
      mineReadMs: minePayload.perf.readMs,
      diffMs: preparedTextAnalysis?.perf?.diffMs ?? 0,
      baseBytes: basePayload.perf.byteLength,
      mineBytes: minePayload.perf.byteLength,
    },
  };
}

// ---------------------------------------------------------------------------
// Dev / local diff builders
// ---------------------------------------------------------------------------

function buildDevWorkingCopyCliArgs(filePath: string): CliArgs {
  const resolvedPath = filePath.trim();
  const fileName = path.basename(resolvedPath);

  return {
    basePath: resolvedPath,
    minePath: resolvedPath,
    baseName: fileName,
    mineName: fileName,
    baseUrl: '',
    mineUrl: '',
    baseRevision: '',
    mineRevision: '',
    pegRevision: '',
    fileName,
  };
}

function buildLocalDiffCliArgs(basePath: string, minePath: string): CliArgs {
  const resolvedBasePath = basePath.trim();
  const resolvedMinePath = minePath.trim();
  const fileName = path.basename(resolvedMinePath || resolvedBasePath || 'local-diff');

  return {
    basePath: resolvedBasePath,
    minePath: resolvedMinePath,
    baseName: path.basename(resolvedBasePath || fileName),
    mineName: path.basename(resolvedMinePath || fileName),
    baseUrl: '',
    mineUrl: '',
    baseRevision: '',
    mineRevision: '',
    pegRevision: '',
    fileName,
  };
}

export async function buildDevWorkingCopyDiffData(
  filePath: string,
  workbookCompareMode: WorkbookCompareMode = 'strict',
): Promise<DiffData> {
  const resolvedPath = filePath.trim();
  if (!resolvedPath) {
    throw new Error('Missing working copy path');
  }

  setActiveCliArgs(buildDevWorkingCopyCliArgs(resolvedPath));
  const versioningStatus = await detectLocalSvnVersioningStatus(resolvedPath);
  const data = await buildDiffData({
    baseRevisionId: versioningStatus === 'versioned' ? REMOTE_HEAD_ID : undefined,
    mineRevisionId: versioningStatus === 'versioned' ? SPECIAL_MINE_ID : undefined,
    workbookCompareMode,
  });

  return {
    ...data,
    sourceNoticeCode: versioningStatus === 'unversioned' ? 'unversioned-working-copy' : null,
    perf: data.perf
      ? { ...data.perf, source: 'local-dev' }
      : { source: 'local-dev' },
  };
}

export async function buildLiteralLocalDiffData(
  basePath: string,
  minePath: string,
  workbookCompareMode: WorkbookCompareMode = 'strict',
): Promise<DiffData> {
  const buildStart = performance.now();
  const resolvedBasePath = basePath.trim();
  const resolvedMinePath = minePath.trim();
  const localArgs = buildLocalDiffCliArgs(resolvedBasePath, resolvedMinePath);
  setActiveCliArgs(localArgs);
  const resolvedFileName = path.basename(resolvedMinePath || resolvedBasePath || 'local-diff');
  const isWorkbook = isWorkbookFile(resolvedFileName);
  const workbookRequestContext = isWorkbook
    ? createWorkbookRequestContext({
        args: localArgs,
        target: '',
        resolvedFileName,
        baseRevisionId: undefined,
        mineRevisionId: undefined,
        baseSourceInfo: createRequestedRevisionInfo('base', undefined),
        mineSourceInfo: createRequestedRevisionInfo('mine', undefined),
        workingCopyPath: '',
      })
    : null;
  if (workbookRequestContext) {
    return buildContextArtifactWorkbookDiffData(workbookRequestContext, workbookCompareMode, {
      source: { kind: 'local', label: 'Local files', baseVersion: path.basename(resolvedBasePath), targetVersion: path.basename(resolvedMinePath) },
      svnUrl: '', fileName: resolvedFileName, basePath: resolvedBasePath, minePath: resolvedMinePath,
      sourceIdentity: workbookRequestContext.sourceIdentity, compareContext: 'literal_two_file_compare', timelineTargetUrl: null,
      workingCopyAvailable: false, initialPair: null, resetPair: null,
      launchBaseName: resolveSideName('', resolvedBasePath), launchMineName: resolveSideName('', resolvedMinePath),
      baseName: resolveSideName('', resolvedBasePath), mineName: resolveSideName('', resolvedMinePath),
      revisionOptions: null, baseRevisionInfo: null, mineRevisionInfo: null, canSwitchRevisions: false, sourceNoticeCode: null,
    });
  }
  const [basePayload, minePayload] = await Promise.all([
    readFilePayload(resolvedBasePath), readFilePayload(resolvedMinePath),
  ]);
  const sourceIdentity = buildSourceIdentity({
    kind: 'local-dev', fileName: resolvedFileName, baseUrl: '', mineUrl: '',
    baseRevision: '', mineRevision: '', pegRevision: '', basePath: resolvedBasePath,
    minePath: resolvedMinePath, baseName: localArgs.baseName, mineName: localArgs.mineName,
  });
  const analysisSnapshot = await resolveAnalysisSnapshot({
    sourceIdentity, compareMode: workbookCompareMode, basePayload, minePayload,
  });
  const preparedTextAnalysis = analysisSnapshot.textAnalysis;
  return {
    source: {
      kind: 'local',
      label: 'Local files',
      baseVersion: path.basename(resolvedBasePath),
      targetVersion: path.basename(resolvedMinePath),
    },
    svnUrl: '',
    fileName: resolvedFileName,
    basePath: resolvedBasePath,
    minePath: resolvedMinePath,
    sourceIdentity,
    compareContext: 'literal_two_file_compare',
    timelineTargetUrl: null,
    workingCopyAvailable: false,
    initialPair: null,
    resetPair: null,
    launchBaseName: resolveSideName('', resolvedBasePath),
    launchMineName: resolveSideName('', resolvedMinePath),
    baseName: resolveSideName('', resolvedBasePath),
    mineName: resolveSideName('', resolvedMinePath),
    baseContent: basePayload.content,
    mineContent: minePayload.content,
    analysisSnapshotsByMode: {
      [workbookCompareMode]: analysisSnapshot,
    },
    baseWorkbookMetadata: null,
    mineWorkbookMetadata: null,
    revisionOptions: null,
    baseRevisionInfo: null,
    mineRevisionInfo: null,
    canSwitchRevisions: false,
    workbookArtifactDiff: null,
    sourceNoticeCode: null,
    perf: {
      source: 'local-dev',
      mainLoadMs: performance.now() - buildStart,
      baseReadMs: basePayload.perf.readMs,
      mineReadMs: minePayload.perf.readMs,
      diffMs: preparedTextAnalysis?.perf?.diffMs ?? 0,
      baseBytes: basePayload.perf.byteLength,
      mineBytes: minePayload.perf.byteLength,
    },
  };
}

interface ResolvedTwoFileRevisionSource {
  id: string;
  info: SvnRevisionInfo;
}

async function resolveTwoFileRevisionSource(
  side: 'base' | 'mine',
  target: string,
  requestedId: string,
): Promise<ResolvedTwoFileRevisionSource> {
  const normalizedRequestedId = requestedId.trim();
  if (normalizedRequestedId && normalizedRequestedId !== REMOTE_HEAD_ID) {
    const fallbackInfo = createRequestedRevisionInfo(side, normalizedRequestedId);
    const info = await hydrateRevisionLogInfo(fallbackInfo, target) ?? fallbackInfo;
    return {
      id: info.id,
      info,
    };
  }

  const latestPayload = await queryRevisionOptionsForTarget(target, {
    limit: 1,
    includeSpecials: false,
    targetSide: side,
  });
  const latest = latestPayload.items.find((item) => item.kind === 'revision') ?? null;
  if (latest) {
    return {
      id: latest.id,
      info: latest,
    };
  }

  return {
    id: 'HEAD',
    info: {
      id: 'HEAD',
      revision: 'HEAD',
      title: 'HEAD',
      author: '',
      date: '',
      message: '',
      kind: 'revision',
    },
  };
}

async function buildVersionedTwoFileDiffData(
  localArgs: CliArgs,
  baseTarget: string,
  mineTarget: string,
  requestedBaseRevisionId: string,
  requestedMineRevisionId: string,
  workbookCompareMode: WorkbookCompareMode,
): Promise<DiffData> {
  const buildStart = performance.now();
  const [baseSource, mineSource] = await Promise.all([
    resolveTwoFileRevisionSource('base', baseTarget, requestedBaseRevisionId),
    resolveTwoFileRevisionSource('mine', mineTarget, requestedMineRevisionId),
  ]);
  const resolvedFileName = path.basename(localArgs.minePath || localArgs.basePath || 'local-diff');
  const isWorkbook = isWorkbookFile(resolvedFileName);
  const workbookRequestContext = isWorkbook
    ? createWorkbookRequestContext({
        args: localArgs,
        target: '',
        baseTarget,
        mineTarget,
        resolvedFileName,
        baseRevisionId: baseSource.id,
        mineRevisionId: mineSource.id,
        baseSourceInfo: baseSource.info,
        mineSourceInfo: mineSource.info,
        workingCopyPath: '',
        sourceIdentityKind: 'revision-switch',
      })
    : null;
  if (workbookRequestContext) {
    return buildContextArtifactWorkbookDiffData(workbookRequestContext, workbookCompareMode, {
      source: { kind: 'svn', label: 'SVN files', baseKind: 'svn', targetKind: 'svn', baseVersion: baseSource.id, targetVersion: mineSource.id },
      svnUrl: '', fileName: resolvedFileName, basePath: localArgs.basePath, minePath: localArgs.minePath,
      sourceIdentity: workbookRequestContext.sourceIdentity, compareContext: 'literal_two_file_compare', timelineTargetUrl: null,
      workingCopyAvailable: true,
      initialPair: { baseRevisionId: baseSource.id, mineRevisionId: mineSource.id },
      resetPair: { baseRevisionId: REMOTE_HEAD_ID, mineRevisionId: REMOTE_HEAD_ID },
      launchBaseName: resolveSideName('', localArgs.basePath), launchMineName: resolveSideName('', localArgs.minePath),
      baseName: makeSideDisplayName(path.basename(localArgs.basePath), baseSource.info, resolveSideName('', localArgs.basePath)),
      mineName: makeSideDisplayName(path.basename(localArgs.minePath), mineSource.info, resolveSideName('', localArgs.minePath)),
      revisionOptions: null, baseRevisionInfo: baseSource.info, mineRevisionInfo: mineSource.info, canSwitchRevisions: true, sourceNoticeCode: null,
    });
  }
  const sameSource = baseTarget.trim() === mineTarget.trim() && baseSource.id === mineSource.id;
  const basePayloadPromise = readRevisionPayload(baseSource.info, baseTarget, path.basename(localArgs.basePath));
  const [basePayload, minePayload] = await Promise.all([
    basePayloadPromise,
    sameSource ? basePayloadPromise : readRevisionPayload(mineSource.info, mineTarget, path.basename(localArgs.minePath)),
  ]);
  const sourceIdentity = buildSourceIdentity({
    kind: 'revision-switch', fileName: resolvedFileName, baseUrl: baseTarget, mineUrl: mineTarget,
    baseRevision: baseSource.id, mineRevision: mineSource.id, pegRevision: '', basePath: '', minePath: '',
    baseName: localArgs.baseName, mineName: localArgs.mineName,
  });
  const analysisSnapshot = await resolveAnalysisSnapshot({
    sourceIdentity, compareMode: workbookCompareMode, baseRevisionId: baseSource.id, mineRevisionId: mineSource.id,
    basePayload, minePayload,
  });
  const preparedTextAnalysis = analysisSnapshot.textAnalysis;
  return {
    source: {
      kind: 'svn',
      label: 'SVN files',
      baseKind: 'svn',
      targetKind: 'svn',
      baseVersion: baseSource.id,
      targetVersion: mineSource.id,
    },
    svnUrl: '',
    fileName: resolvedFileName,
    basePath: localArgs.basePath,
    minePath: localArgs.minePath,
    sourceIdentity,
    compareContext: 'literal_two_file_compare',
    timelineTargetUrl: null,
    workingCopyAvailable: true,
    initialPair: {
      baseRevisionId: baseSource.id,
      mineRevisionId: mineSource.id,
    },
    resetPair: {
      baseRevisionId: REMOTE_HEAD_ID,
      mineRevisionId: REMOTE_HEAD_ID,
    },
    launchBaseName: resolveSideName('', localArgs.basePath),
    launchMineName: resolveSideName('', localArgs.minePath),
    baseName: makeSideDisplayName(
      path.basename(localArgs.basePath),
      baseSource.info,
      resolveSideName('', localArgs.basePath),
    ),
    mineName: makeSideDisplayName(
      path.basename(localArgs.minePath),
      mineSource.info,
      resolveSideName('', localArgs.minePath),
    ),
    baseContent: basePayload.content,
    mineContent: minePayload.content,
    analysisSnapshotsByMode: {
      [workbookCompareMode]: analysisSnapshot,
    },
    baseWorkbookMetadata: null,
    mineWorkbookMetadata: null,
    revisionOptions: null,
    baseRevisionInfo: baseSource.info,
    mineRevisionInfo: mineSource.info,
    canSwitchRevisions: true,
    workbookArtifactDiff: null,
    sourceNoticeCode: null,
    perf: {
      source: 'revision-switch',
      mainLoadMs: performance.now() - buildStart,
      baseReadMs: basePayload.perf.readMs,
      mineReadMs: minePayload.perf.readMs,
      diffMs: preparedTextAnalysis?.perf?.diffMs ?? 0,
      baseBytes: basePayload.perf.byteLength,
      mineBytes: minePayload.perf.byteLength,
    },
  };
}

export async function buildTwoFileRevisionDiffData(
  baseRevisionId: string,
  mineRevisionId: string,
  workbookCompareMode: WorkbookCompareMode = 'strict',
): Promise<DiffData> {
  const args = getActiveCliArgs();
  if (
    !args.basePath.trim()
    || !args.minePath.trim()
    || !isRemoteRepositoryTarget(args.baseUrl)
    || !isRemoteRepositoryTarget(args.mineUrl)
  ) {
    throw new Error('Two-file SVN revision context is unavailable');
  }
  return buildVersionedTwoFileDiffData(
    args,
    args.baseUrl,
    args.mineUrl,
    baseRevisionId || REMOTE_HEAD_ID,
    mineRevisionId || REMOTE_HEAD_ID,
    workbookCompareMode,
  );
}

export async function buildLocalDiffData(
  basePath: string,
  minePath: string,
  workbookCompareMode: WorkbookCompareMode = 'strict',
): Promise<DiffData> {
  const localArgs = buildLocalDiffCliArgs(basePath, minePath);
  setActiveCliArgs(localArgs);
  const [baseTarget, mineTarget] = await Promise.all([
    resolveLocalSvnUrl(localArgs.basePath),
    resolveLocalSvnUrl(localArgs.minePath),
  ]);

  if (baseTarget && mineTarget) {
    const versionedArgs: CliArgs = {
      ...localArgs,
      baseUrl: baseTarget,
      mineUrl: mineTarget,
    };
    setActiveCliArgs(versionedArgs);
    return buildVersionedTwoFileDiffData(
      versionedArgs,
      baseTarget,
      mineTarget,
      REMOTE_HEAD_ID,
      REMOTE_HEAD_ID,
      workbookCompareMode,
    );
  }

  return buildLiteralLocalDiffData(basePath, minePath, workbookCompareMode);
}

// ---------------------------------------------------------------------------
// Workbook compare mode & metadata loaders
// ---------------------------------------------------------------------------

async function resolveFollowUpWorkbookArtifact(compareMode: WorkbookCompareMode, baseRevisionId?: string, mineRevisionId?: string): Promise<WorkbookArtifactReader> {
  const reader = getCurrentWorkbookArtifact(getCurrentComparisonSessionId());
  const context = reader && artifactContexts.get(reader);
  if (reader && context?.args === JSON.stringify(getActiveCliArgs())
    && (!baseRevisionId || context.baseRevisionId === baseRevisionId)
    && (!mineRevisionId || context.mineRevisionId === mineRevisionId)) return reader;

  // Cold follow-ups use the same preparation as an initial load, including its
  // source-key deduplication; there is no separate metadata parser or snapshot.
  const args = getActiveCliArgs();
  const twoFile = await import('./twoFileVersionOperations.js');
  const git = await import('./gitOperations.js');
  const data = twoFile.hasActiveTwoFileVersionSession()
    ? await twoFile.buildTwoFileVersionDiffData(baseRevisionId || SPECIAL_BASE_ID, mineRevisionId || SPECIAL_MINE_ID, compareMode)
    : git.getActiveGitWorkingFileSession()
    ? await (await import('./gitDiffBuilder.js')).buildGitFileRevisionDiffData(baseRevisionId, mineRevisionId, compareMode)
    : baseRevisionId && mineRevisionId && isRemoteRepositoryTarget(args.baseUrl) && isRemoteRepositoryTarget(args.mineUrl)
    ? await buildTwoFileRevisionDiffData(baseRevisionId, mineRevisionId, compareMode)
    : await buildDiffData({ baseRevisionId, mineRevisionId, workbookCompareMode: compareMode });
  if (!data.workbookArtifact) throw new Error('The current comparison is not a workbook.');
  return getWorkbookArtifactReader(data.workbookArtifact.artifactId);
}

export async function loadWorkbookCompareModeData(
  compareMode: WorkbookCompareMode,
  baseRevisionId?: string,
  mineRevisionId?: string,
): Promise<WorkbookCompareModePayload> {
  const reader = await resolveFollowUpWorkbookArtifact(compareMode, baseRevisionId, mineRevisionId);
  return { compareMode, workbookArtifact: await reader.getView(compareMode), perf: { rustDiffMs: reader.manifest.perf.totalMs } };
}

export async function loadWorkbookMetadataData(
  baseRevisionId?: string,
  mineRevisionId?: string,
): Promise<WorkbookMetadataPayload> {
  const reader = await resolveFollowUpWorkbookArtifact('strict', baseRevisionId, mineRevisionId);
  return { base: reader.baseMetadata, mine: reader.mineMetadata, perf: { metadataMs: 0 } };
}
