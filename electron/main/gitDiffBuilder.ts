import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import { writeManagedTempFile } from '../runtimePaths.js';
import {
  buildDevWorkingCopyDiffData,
  buildLocalDiffData,
  buildArtifactWorkbookDiffData,
} from './diffBuilder.js';
import {
  GIT_EMPTY_REVISION_ID,
  activateGitWorkingFileSession,
  clearActiveGitWorkingFileSession,
  getActiveGitWorkingFileSession,
  readGitFileRevision,
  writeGitFileRevision,
  resolveGitRevisionInfo,
  type GitWorkingFileSession,
} from './gitOperations.js';
import { SPECIAL_MINE_ID } from './constants.js';
import { artifactSourcePath } from './workbookArtifactService.js';
import { isWorkbookFile } from './svnHelpers.js';
import type { DiffData, WorkbookCompareMode } from './types.js';
import { EMPTY_CLI_ARGS } from '../cliArgs.js';
import { setActiveCliArgs } from './state.js';

function resolveComparisonExtension(filePath: string): string {
  return path.extname(filePath) || '.txt';
}

async function buildGitFileDiffData(
  session: GitWorkingFileSession,
  requestedBaseRevisionId: string | undefined,
  requestedMineRevisionId: string | undefined,
  workbookCompareMode: WorkbookCompareMode,
): Promise<DiffData> {
  const defaultBaseRevisionId = session.tracked && session.headCommit
    ? session.headCommit
    : GIT_EMPTY_REVISION_ID;
  const baseRevisionId = requestedBaseRevisionId?.trim() || defaultBaseRevisionId;
  const mineRevisionId = requestedMineRevisionId?.trim() || SPECIAL_MINE_ID;
  if (isWorkbookFile(session.workingFilePath)) {
    setActiveCliArgs({ ...EMPTY_CLI_ARGS, basePath: session.workingFilePath, minePath: session.workingFilePath,
      baseName: path.basename(session.workingFilePath), mineName: path.basename(session.workingFilePath), fileName: path.basename(session.workingFilePath) });
    const [baseRevisionInfo, mineRevisionInfo] = await Promise.all([
      resolveGitRevisionInfo(session, baseRevisionId), resolveGitRevisionInfo(session, mineRevisionId),
    ]);
    const fileName = path.basename(session.workingFilePath);
    const baseLabel = baseRevisionInfo.kind === 'working-copy' ? baseRevisionInfo.title : baseRevisionInfo.revision;
    const mineLabel = mineRevisionInfo.kind === 'working-copy' ? mineRevisionInfo.title : mineRevisionInfo.revision;
    const workingStat = baseRevisionInfo.kind === 'working-copy' || mineRevisionInfo.kind === 'working-copy'
      ? await fs.stat(session.workingFilePath) : null;
    const data = await buildArtifactWorkbookDiffData({
      source: { kind: 'git', label: path.basename(session.repositoryPath), repositoryPath: session.repositoryPath, baseVersion: baseRevisionId, targetVersion: mineRevisionId },
      svnUrl: '', fileName, basePath: session.workingFilePath, minePath: session.workingFilePath,
      sourceIdentity: ['git-file', session.repositoryPath, session.relativePath, baseRevisionId, mineRevisionId].join(':'),
      compareContext: 'git_compare', timelineTargetUrl: null, workingCopyAvailable: true,
      initialPair: { baseRevisionId: defaultBaseRevisionId, mineRevisionId: SPECIAL_MINE_ID },
      resetPair: { baseRevisionId: defaultBaseRevisionId, mineRevisionId: SPECIAL_MINE_ID },
      launchBaseName: `${fileName} — ${baseLabel}`, launchMineName: `${fileName} — ${mineLabel}`,
      baseName: `${fileName} — ${baseLabel}`, mineName: `${fileName} — ${mineLabel}`,
      revisionOptions: null, baseRevisionInfo, mineRevisionInfo, canSwitchRevisions: session.tracked,
      sourceNoticeCode: session.tracked ? null : 'unversioned-working-copy',
    }, workbookCompareMode, async (artifactDir, signal) => {
      const basePath = artifactSourcePath(artifactDir, 'base', resolveComparisonExtension(session.workingFilePath));
      const minePath = artifactSourcePath(artifactDir, 'mine', resolveComparisonExtension(session.workingFilePath));
      const results = await Promise.allSettled([
        writeGitFileRevision(session, baseRevisionInfo.id, basePath, signal), writeGitFileRevision(session, mineRevisionInfo.id, minePath, signal),
      ]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return { basePath, minePath };
    }, ['git-file', session.repositoryPath, session.relativePath, baseRevisionInfo.id, mineRevisionInfo.id,
      workingStat ? `${workingStat.size}:${workingStat.mtimeMs}` : '',
    ].join(':'));
    return { ...data, perf: { ...data.perf, source: 'local-dev' } };
  }
  const [baseContents, mineContents, baseRevisionInfo, mineRevisionInfo] = await Promise.all([
    readGitFileRevision(session, baseRevisionId),
    readGitFileRevision(session, mineRevisionId),
    resolveGitRevisionInfo(session, baseRevisionId),
    resolveGitRevisionInfo(session, mineRevisionId),
  ]);
  const extension = resolveComparisonExtension(session.workingFilePath);
  const [baseTempPath, mineTempPath] = await Promise.all([
    writeManagedTempFile('git-base', extension, baseContents),
    writeManagedTempFile('git-working', extension, mineContents),
  ]);
  const data = await buildLocalDiffData(baseTempPath, mineTempPath, workbookCompareMode);
  const fileName = path.basename(session.workingFilePath);
  const repositoryName = path.basename(session.repositoryPath);
  const baseLabel = baseRevisionInfo.kind === 'working-copy'
    ? baseRevisionInfo.title
    : baseRevisionInfo.revision;
  const mineLabel = mineRevisionInfo.kind === 'working-copy'
    ? mineRevisionInfo.title
    : mineRevisionInfo.revision;

  return {
    ...data,
    source: {
      kind: 'git',
      label: repositoryName,
      repositoryPath: session.repositoryPath,
      baseVersion: baseRevisionId,
      targetVersion: mineRevisionId,
    },
    svnUrl: '',
    fileName,
    sourceIdentity: [
      'git-file',
      session.repositoryPath,
      session.relativePath,
      baseRevisionId,
      mineRevisionId,
    ].join(':'),
    compareContext: 'git_compare',
    timelineTargetUrl: null,
    workingCopyAvailable: true,
    initialPair: {
      baseRevisionId: defaultBaseRevisionId,
      mineRevisionId: SPECIAL_MINE_ID,
    },
    resetPair: {
      baseRevisionId: defaultBaseRevisionId,
      mineRevisionId: SPECIAL_MINE_ID,
    },
    launchBaseName: `${fileName} — ${baseLabel}`,
    launchMineName: `${fileName} — ${mineLabel}`,
    baseName: `${fileName} — ${baseLabel}`,
    mineName: `${fileName} — ${mineLabel}`,
    revisionOptions: null,
    baseRevisionInfo,
    mineRevisionInfo,
    canSwitchRevisions: session.tracked,
    sourceNoticeCode: session.tracked ? null : 'unversioned-working-copy',
    perf: data.perf
      ? { ...data.perf, source: 'local-dev' }
      : { source: 'local-dev' },
  };
}

export async function buildSmartWorkingCopyDiffData(
  filePath: string,
  workbookCompareMode: WorkbookCompareMode = 'strict',
): Promise<DiffData> {
  const gitSession = await activateGitWorkingFileSession(filePath);
  if (gitSession) {
    return buildGitFileDiffData(gitSession, undefined, undefined, workbookCompareMode);
  }

  clearActiveGitWorkingFileSession();
  return buildDevWorkingCopyDiffData(filePath, workbookCompareMode);
}

export async function buildGitFileRevisionDiffData(
  baseRevisionId: string | undefined,
  mineRevisionId: string | undefined,
  workbookCompareMode: WorkbookCompareMode = 'strict',
): Promise<DiffData> {
  const session = getActiveGitWorkingFileSession();
  if (!session) throw new Error('No active Git working file is available.');
  return buildGitFileDiffData(
    session,
    baseRevisionId,
    mineRevisionId,
    workbookCompareMode,
  );
}
