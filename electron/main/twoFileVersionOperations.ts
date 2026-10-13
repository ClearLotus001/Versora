import * as fs from 'node:fs';
import * as path from 'node:path';

import { electronT } from '../i18n.js';
import {
  getActiveCliArgs,
  getComparisonTwoFileVersionSession,
  resolveComparisonSourcePath,
  runInComparisonSessionTransaction,
  setActiveCliArgs,
  setComparisonTwoFileVersionSession,
} from './state.js';
import { EMPTY_CLI_ARGS } from '../cliArgs.js';
import { removeTrackedManagedTempFilesSync, writeManagedTempFile } from '../runtimePaths.js';
import {
  buildArtifactWorkbookDiffData,
  buildDiffData,
  buildLiteralLocalDiffData,
  buildLocalDiffData,
  buildTwoFileRevisionDiffData,
} from './diffBuilder.js';
import { artifactSourcePath } from './workbookArtifactService.js';
import { runSvnToFile } from './rustBridge.js';
import { getPeggedSvnTarget, isRemoteRepositoryTarget, isWorkbookFile, normalizeRevisionNumber } from './svnHelpers.js';
import {
  queryGitRevisionOptionsForSession,
  loadGitFileRevisionLineBlame,
  readGitFileRevision,
  writeGitFileRevision,
  resolveGitRevisionInfo,
  resolveGitWorkingFileSession,
  type GitWorkingFileSession,
} from './gitOperations.js';
import {
  queryRevisionOptionsForTarget,
  loadSvnTargetLineBlame,
  loadSvnWorkingFileLineBlame,
  querySvnRevisionInfoForTarget,
  readSvnFileRevision,
  resolveLocalSvnUrl,
} from './svnOperations.js';
import { SPECIAL_BASE_ID, SPECIAL_MINE_ID } from './constants.js';
import type {
  DiffData,
  LineBlameLine,
  LineBlamePayload,
  RevisionOptionsPayload,
  RevisionOptionsQuery,
  SvnRevisionInfo,
  WorkbookCompareMode,
} from './types.js';

type TwoFileSideContext =
  | { provider: 'git'; path: string; git: GitWorkingFileSession }
  | { provider: 'svn'; path: string; target: string }
  | { provider: 'local'; path: string };

export interface TwoFileVersionSession {
  base: TwoFileSideContext;
  mine: TwoFileSideContext;
}


function sideSpecialId(side: 'base' | 'mine'): string {
  return side === 'base' ? SPECIAL_BASE_ID : SPECIAL_MINE_ID;
}

function isWorkingSourceId(value: string | null | undefined): boolean {
  return !value || value === SPECIAL_BASE_ID || value === SPECIAL_MINE_ID;
}

function workingSourceInfo(
  side: 'base' | 'mine',
  context: TwoFileSideContext,
): SvnRevisionInfo {
  const versioned = context.provider !== 'local';
  return {
    id: sideSpecialId(side),
    revision: versioned ? 'WC' : '',
    title: versioned ? electronT('revisionWorkingCopyTitle') : path.basename(context.path),
    author: '',
    date: '',
    message: '',
    kind: versioned ? 'working-copy' : 'input-file',
  };
}

async function resolveSideContext(filePath: string): Promise<TwoFileSideContext> {
  const git = await resolveGitWorkingFileSession(filePath);
  if (git?.tracked) return { provider: 'git', path: filePath, git };
  const target = await resolveLocalSvnUrl(filePath);
  return target
    ? { provider: 'svn', path: filePath, target }
    : { provider: 'local', path: filePath };
}

function decorateDiffData(
  data: DiffData,
  session: TwoFileVersionSession,
  baseInfo: SvnRevisionInfo,
  mineInfo: SvnRevisionInfo,
): DiffData {
  const switchableSides = {
    base: session.base.provider !== 'local',
    mine: session.mine.provider !== 'local',
  };
  return {
    ...data,
    source: {
      kind: 'local',
      label: 'Versioned local files',
      baseKind: session.base.provider,
      targetKind: session.mine.provider,
      baseVersion: baseInfo.id,
      targetVersion: mineInfo.id,
    },
    basePath: session.base.path,
    minePath: session.mine.path,
    sourceIdentity: [
      'two-file-versioned',
      session.base.provider,
      session.base.path,
      baseInfo.id,
      session.mine.provider,
      session.mine.path,
      mineInfo.id,
    ].join('::'),
    compareContext: 'literal_two_file_compare',
    workingCopyAvailable: switchableSides.base || switchableSides.mine,
    initialPair: {
      baseRevisionId: sideSpecialId('base'),
      mineRevisionId: sideSpecialId('mine'),
    },
    resetPair: {
      baseRevisionId: sideSpecialId('base'),
      mineRevisionId: sideSpecialId('mine'),
    },
    revisionOptions: null,
    baseRevisionInfo: baseInfo,
    mineRevisionInfo: mineInfo,
    canSwitchRevisions: switchableSides.base || switchableSides.mine,
    revisionSwitchableSides: switchableSides,
  };
}

export function clearActiveTwoFileVersionSession(): void {
  setComparisonTwoFileVersionSession(null);
}

export function hasActiveTwoFileVersionSession(): boolean {
  return getComparisonTwoFileVersionSession() != null;
}

/** Swaps complete file sources together with their selected versions. */
export async function swapTwoFileDiff(
  baseRevisionId: string | null | undefined,
  mineRevisionId: string | null | undefined,
  compareMode: WorkbookCompareMode,
): Promise<DiffData> {
  return runInComparisonSessionTransaction(async () => {
    const args = getActiveCliArgs();
    const session = getComparisonTwoFileVersionSession();
    const swappedArgs = {
      ...args,
      basePath: session?.mine.path ?? args.minePath,
      minePath: session?.base.path ?? args.basePath,
      baseName: args.mineName,
      mineName: args.baseName,
      baseUrl: args.mineUrl,
      mineUrl: args.baseUrl,
      baseRevision: args.mineRevision,
      mineRevision: args.baseRevision,
      fileName: path.basename(resolveComparisonSourcePath(session?.base.path ?? args.basePath)) || args.fileName,
    };
    if (!swappedArgs.basePath || !swappedArgs.minePath) throw new Error('Two-file comparison context is unavailable.');
    setActiveCliArgs(swappedArgs);
    const swapRevision = (side: 'base' | 'mine', id: string | null | undefined) => (
      isWorkingSourceId(id) ? sideSpecialId(side) : id!
    );
    if (session) {
      setComparisonTwoFileVersionSession({ base: session.mine, mine: session.base });
      return buildTwoFileVersionDiffData(swapRevision('base', mineRevisionId), swapRevision('mine', baseRevisionId), compareMode);
    }
    if (isRemoteRepositoryTarget(swappedArgs.baseUrl) && isRemoteRepositoryTarget(swappedArgs.mineUrl)) {
      return buildTwoFileRevisionDiffData(
        isWorkingSourceId(mineRevisionId) ? (mineRevisionId ? SPECIAL_BASE_ID : '') : mineRevisionId!,
        isWorkingSourceId(baseRevisionId) ? (baseRevisionId ? SPECIAL_MINE_ID : '') : baseRevisionId!,
        compareMode,
      );
    }
    return buildDiffData({ workbookCompareMode: compareMode });
  });
}

export async function buildSmartLocalFileDiffData(
  basePath: string,
  minePath: string,
  compareMode: WorkbookCompareMode,
): Promise<DiffData> {
  const [base, mine] = await Promise.all([
    resolveSideContext(basePath),
    resolveSideContext(minePath),
  ]);
  const session = { base, mine } satisfies TwoFileVersionSession;
  const hasGit = base.provider === 'git' || mine.provider === 'git';
  const bothSvn = base.provider === 'svn' && mine.provider === 'svn';
  const hasMixedVersionSource = (
    base.provider === 'svn' || mine.provider === 'svn'
  ) && !bothSvn;

  if (!hasGit && !hasMixedVersionSource) {
    setComparisonTwoFileVersionSession(null);
    return buildLocalDiffData(basePath, minePath, compareMode);
  }

  if (isWorkbookFile(mine.path)) {
    setActiveCliArgs({ ...EMPTY_CLI_ARGS, basePath: base.path, minePath: mine.path,
      baseName: path.basename(base.path), mineName: path.basename(mine.path), fileName: path.basename(mine.path) });
    setComparisonTwoFileVersionSession(session);
    return buildTwoFileVersionDiffData(SPECIAL_BASE_ID, SPECIAL_MINE_ID, compareMode);
  }

  const data = await buildLiteralLocalDiffData(basePath, minePath, compareMode);
  setComparisonTwoFileVersionSession(session);
  return decorateDiffData(
    data,
    session,
    workingSourceInfo('base', base),
    workingSourceInfo('mine', mine),
  );
}

async function resolveSideRevision(
  side: 'base' | 'mine',
  context: TwoFileSideContext,
  revisionId: string,
): Promise<{ bytes: Buffer; info: SvnRevisionInfo }> {
  if (context.provider === 'local' || isWorkingSourceId(revisionId)) {
    const bytes = await fs.promises.readFile(context.path);
    return { bytes, info: workingSourceInfo(side, context) };
  }
  if (context.provider === 'git') {
    const [bytes, info] = await Promise.all([
      readGitFileRevision(context.git, revisionId),
      resolveGitRevisionInfo(context.git, revisionId),
    ]);
    return { bytes, info };
  }

  const [bytes, info] = await Promise.all([
    readSvnFileRevision(context.target, revisionId),
    querySvnRevisionInfoForTarget(context.target, revisionId),
  ]);
  return {
    bytes,
    info: info ?? {
      id: revisionId,
      revision: revisionId,
      title: revisionId,
      author: '',
      date: '',
      message: '',
      kind: 'revision',
    },
  };
}

export async function buildTwoFileVersionDiffData(
  baseRevisionId: string,
  mineRevisionId: string,
  compareMode: WorkbookCompareMode,
): Promise<DiffData> {
  const session = getComparisonTwoFileVersionSession();
  if (!session) throw new Error('Two-file version context is unavailable.');
  if (isWorkbookFile(session.mine.path)) {
    const resolveInfo = async (side: 'base' | 'mine', context: TwoFileSideContext, revisionId: string): Promise<SvnRevisionInfo> => {
      if (context.provider === 'local' || isWorkingSourceId(revisionId)) return workingSourceInfo(side, context);
      if (context.provider === 'git') return resolveGitRevisionInfo(context.git, revisionId);
      return await querySvnRevisionInfoForTarget(context.target, revisionId) ?? { id: revisionId, revision: revisionId, title: revisionId, author: '', date: '', message: '', kind: 'revision' };
    };
    const [baseInfo, mineInfo] = await Promise.all([resolveInfo('base', session.base, baseRevisionId), resolveInfo('mine', session.mine, mineRevisionId)]);
    const switchableSides = { base: session.base.provider !== 'local', mine: session.mine.provider !== 'local' };
    const fileName = path.basename(session.mine.path);
    const sourceIdentity = ['two-file-versioned', session.base.provider, session.base.path, baseInfo.id, session.mine.provider, session.mine.path, mineInfo.id].join('::');
    const sourceStats = await Promise.all([session.base, session.mine].map(async (context, index) => {
      const revisionId = index === 0 ? baseRevisionId : mineRevisionId;
      if (context.provider !== 'local' && !isWorkingSourceId(revisionId)) return '';
      const stat = await fs.promises.stat(context.path); return `${stat.size}:${stat.mtimeMs}`;
    }));
    return buildArtifactWorkbookDiffData({
      source: { kind: 'local', label: 'Versioned local files', baseKind: session.base.provider, targetKind: session.mine.provider, baseVersion: baseInfo.id, targetVersion: mineInfo.id },
      basePath: session.base.path, minePath: session.mine.path, fileName, svnUrl: '', sourceIdentity,
      compareContext: 'literal_two_file_compare', timelineTargetUrl: null, workingCopyAvailable: switchableSides.base || switchableSides.mine,
      initialPair: { baseRevisionId: sideSpecialId('base'), mineRevisionId: sideSpecialId('mine') },
      resetPair: { baseRevisionId: sideSpecialId('base'), mineRevisionId: sideSpecialId('mine') },
      launchBaseName: path.basename(session.base.path), launchMineName: path.basename(session.mine.path),
      baseName: path.basename(session.base.path), mineName: path.basename(session.mine.path),
      revisionOptions: null, baseRevisionInfo: baseInfo, mineRevisionInfo: mineInfo,
      canSwitchRevisions: switchableSides.base || switchableSides.mine, revisionSwitchableSides: switchableSides, sourceNoticeCode: null,
    }, compareMode, async (artifactDir, signal) => {
      const resolvePath = async (side: 'base' | 'mine', context: TwoFileSideContext, info: SvnRevisionInfo, revisionId: string): Promise<string> => {
        if (context.provider === 'local' || isWorkingSourceId(revisionId)) return context.path;
        const destination = artifactSourcePath(artifactDir, side, path.extname(context.path));
        if (context.provider === 'git') await writeGitFileRevision(context.git, info.id, destination, signal);
        else await runSvnToFile(['cat', '-r', normalizeRevisionNumber(info.revision), getPeggedSvnTarget(context.target)], destination, signal);
        return destination;
      };
      const results = await Promise.allSettled([
        resolvePath('base', session.base, baseInfo, baseRevisionId), resolvePath('mine', session.mine, mineInfo, mineRevisionId),
      ]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return { basePath: (results[0] as PromiseFulfilledResult<string>).value, minePath: (results[1] as PromiseFulfilledResult<string>).value };
    }, `${sourceIdentity}:${sourceStats.join('|')}`);
  }
  const [base, mine] = await Promise.all([
    resolveSideRevision('base', session.base, baseRevisionId),
    resolveSideRevision('mine', session.mine, mineRevisionId),
  ]);
  const sourceArgs = getActiveCliArgs();
  const tempPaths: string[] = [];
  try {
    const writes = await Promise.allSettled([
      { prefix: 'two-file-base', filePath: session.base.path, bytes: base.bytes },
      { prefix: 'two-file-mine', filePath: session.mine.path, bytes: mine.bytes },
    ].map(source => writeManagedTempFile(source.prefix, path.extname(source.filePath) || '.txt', source.bytes)));
    for (const result of writes) if (result.status === 'fulfilled') tempPaths.push(result.value);
    const [baseTempPath, mineTempPath] = writes.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    const data = await buildLiteralLocalDiffData(baseTempPath!, mineTempPath!, compareMode);
    return decorateDiffData(data, session, base.info, mine.info);
  } finally {
    setActiveCliArgs(sourceArgs);
    removeTrackedManagedTempFilesSync(tempPaths);
  }
}

export async function queryTwoFileRevisionOptions(
  query: RevisionOptionsQuery | undefined,
): Promise<RevisionOptionsPayload> {
  const session = getComparisonTwoFileVersionSession();
  const side = query?.targetSide;
  if (!session || (side !== 'base' && side !== 'mine')) {
    return {
      items: [],
      hasMore: false,
      nextBeforeRevisionId: null,
      anchorRevisionId: null,
      queryDateTime: query?.anchorDateTime?.trim() || null,
    };
  }
  const context = session[side];
  if (context.provider === 'local') {
    return {
      items: [],
      hasMore: false,
      nextBeforeRevisionId: null,
      anchorRevisionId: null,
      queryDateTime: query?.anchorDateTime?.trim() || null,
    };
  }
  if (context.provider === 'git') {
    const payload = await queryGitRevisionOptionsForSession(context.git, query);
    return {
      ...payload,
      items: payload.items.map(item => item.kind === 'working-copy'
        ? { ...item, id: sideSpecialId(side) }
        : item),
    };
  }

  const payload = await queryRevisionOptionsForTarget(context.target, query);
  const items = query?.includeSpecials
    ? [workingSourceInfo(side, context), ...payload.items]
    : payload.items;
  return { ...payload, items };
}

async function resolveSideLineBlame(
  context: TwoFileSideContext,
  revisionId: string,
): Promise<LineBlameLine[]> {
  if (context.provider === 'local') return [];
  if (isWorkingSourceId(revisionId)) {
    return context.provider === 'git'
      ? loadGitFileRevisionLineBlame(context.git, SPECIAL_MINE_ID)
      : loadSvnWorkingFileLineBlame(context.path);
  }
  return context.provider === 'git'
    ? loadGitFileRevisionLineBlame(context.git, revisionId)
    : loadSvnTargetLineBlame(context.target, revisionId);
}

export async function loadTwoFileVersionLineBlame(
  baseRevisionId: string,
  mineRevisionId: string,
): Promise<LineBlamePayload> {
  const session = getComparisonTwoFileVersionSession();
  if (!session) return { base: [], mine: [] };
  const [base, mine] = await Promise.all([
    resolveSideLineBlame(session.base, baseRevisionId),
    resolveSideLineBlame(session.mine, mineRevisionId),
  ]);
  return { base, mine };
}
