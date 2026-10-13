import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { streamCommandToFile } from './streamCommandToFile.js';

import { electronT } from '../i18n.js';
import { getComparisonGitWorkingFileSession, setComparisonGitWorkingFileSession } from './state.js';
import {
  DEFAULT_REVISION_QUERY_LIMIT,
  MAX_REVISION_QUERY_LIMIT,
  SPECIAL_BASE_ID,
  SPECIAL_MINE_ID,
} from './constants.js';
import type {
  LineBlameLine,
  LineBlamePayload,
  RevisionOptionsPayload,
  RevisionOptionsQuery,
  SvnRevisionInfo,
} from './types.js';

const GIT_COMMAND_TIMEOUT_MS = 30_000;
const GIT_TEXT_MAX_BYTES = 32 * 1024 * 1024;
const GIT_BLOB_MAX_BYTES = 256 * 1024 * 1024;
const GIT_LINE_BLAME_CACHE_LIMIT = 32;

export const GIT_EMPTY_REVISION_ID = '__git_empty__';

interface GitCommandOptions {
  maxBytes?: number;
  allowFailure?: boolean;
}

interface GitCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface GitWorkingFileSession {
  repositoryPath: string;
  workingFilePath: string;
  relativePath: string;
  currentBranch: string | null;
  headCommit: string | null;
  headShortHash: string;
  tracked: boolean;
}

const gitLineBlameCache = new Map<string, Promise<LineBlameLine[]>>();

function toErrorMessage(stderr: Buffer, fallback: string): string {
  const message = stderr.toString('utf8').trim();
  return message || fallback;
}

async function runGit(
  repositoryPath: string,
  args: string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  const maxBytes = options.maxBytes ?? GIT_TEXT_MAX_BYTES;

  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repositoryPath, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      child.kill();
      reject(error);
    };

    const timeoutHandle = setTimeout(() => {
      finishWithError(new Error('Git command timed out.'));
    }, GIT_COMMAND_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        finishWithError(new Error('Git command output is too large.'));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= GIT_TEXT_MAX_BYTES) stderrChunks.push(chunk);
    });

    child.on('error', (error) => {
      finishWithError(new Error(`Unable to run Git: ${error.message}`));
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      const result: GitCommandResult = {
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        exitCode: exitCode ?? 1,
      };
      if (result.exitCode !== 0 && !options.allowFailure) {
        reject(new Error(toErrorMessage(result.stderr, `Git exited with code ${result.exitCode}.`)));
        return;
      }
      resolve(result);
    });
  });
}

function toText(result: GitCommandResult): string {
  return result.stdout.toString('utf8').trim();
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath)
  );
}

function assertGitRevision(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.startsWith('-') || /[\0-\x1f\x7f]/.test(normalized)) {
    throw new Error('The selected Git version is invalid.');
  }
  return normalized;
}

function isWorkingTreeRevision(revisionId: string): boolean {
  return revisionId === SPECIAL_BASE_ID || revisionId === SPECIAL_MINE_ID;
}

async function resolveCommit(repositoryPath: string, revisionId: string): Promise<string> {
  const revision = assertGitRevision(revisionId);
  const result = await runGit(repositoryPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${revision}^{commit}`,
  ], { allowFailure: true });
  const commit = toText(result);
  if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new Error(`Git version "${revision}" could not be resolved.`);
  }
  return commit;
}

async function readWorkingTreeFile(session: GitWorkingFileSession): Promise<Buffer> {
  const [realRepositoryPath, realFilePath] = await Promise.all([
    fs.promises.realpath(session.repositoryPath),
    fs.promises.realpath(session.workingFilePath),
  ]);
  if (!isPathInside(realRepositoryPath, realFilePath)) {
    throw new Error('Refusing to read a working-tree file outside the repository.');
  }
  const stat = await fs.promises.stat(realFilePath);
  if (!stat.isFile()) throw new Error('The selected working-copy item is not a regular file.');
  if (stat.size > GIT_BLOB_MAX_BYTES) throw new Error('The selected Git file is too large to compare.');
  return fs.promises.readFile(realFilePath);
}

function normalizeLimit(value: number | undefined): number {
  const parsed = Number(value ?? DEFAULT_REVISION_QUERY_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_REVISION_QUERY_LIMIT;
  return Math.max(1, Math.min(MAX_REVISION_QUERY_LIMIT, Math.floor(parsed)));
}

function buildWorkingTreeRevisionInfo(): SvnRevisionInfo {
  return {
    id: SPECIAL_MINE_ID,
    revision: 'WORKTREE',
    title: electronT('revisionWorkingCopyTitle'),
    author: 'Git',
    date: '',
    message: '',
    kind: 'working-copy',
  };
}

function buildEmptyRevisionInfo(): SvnRevisionInfo {
  return {
    id: GIT_EMPTY_REVISION_ID,
    revision: 'EMPTY',
    title: 'Empty baseline',
    author: 'Git',
    date: '',
    message: '',
    kind: 'input-file',
  };
}

function parseGitRevisionInfo(line: string): SvnRevisionInfo | null {
  const [id, shortHash, author, date, message] = line.trimEnd().split('\0');
  if (!id || !shortHash) return null;
  return {
    id,
    revision: shortHash,
    title: shortHash,
    author: author ?? '',
    date: date ?? '',
    message: message ?? '',
    kind: 'revision',
  };
}

function formatGitBlameDate(epochSeconds: string): string {
  const parsedSeconds = Number.parseInt(epochSeconds.trim(), 10);
  if (!Number.isFinite(parsedSeconds)) return '';
  const parsed = new Date(parsedSeconds * 1_000);
  if (Number.isNaN(parsed.getTime())) return '';
  const yyyy = parsed.getFullYear();
  const mm = `${parsed.getMonth() + 1}`.padStart(2, '0');
  const dd = `${parsed.getDate()}`.padStart(2, '0');
  const hh = `${parsed.getHours()}`.padStart(2, '0');
  const mi = `${parsed.getMinutes()}`.padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export function parseGitLineBlame(output: string): LineBlameLine[] {
  const entries: LineBlameLine[] = [];
  let current: {
    hash: string;
    lineNo: number;
    author: string;
    authorTime: string;
  } | null = null;

  for (const line of output.split(/\r?\n/)) {
    const header = line.match(/^\^?([0-9a-f]{40,64})\s+\d+\s+(\d+)(?:\s+\d+)?$/i);
    if (header) {
      current = {
        hash: header[1] ?? '',
        lineNo: Number.parseInt(header[2] ?? '', 10),
        author: '',
        authorTime: '',
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('author ')) {
      current.author = line.slice('author '.length).trim();
      continue;
    }
    if (line.startsWith('author-time ')) {
      current.authorTime = line.slice('author-time '.length).trim();
      continue;
    }
    if (!line.startsWith('\t')) continue;

    const uncommitted = /^0+$/.test(current.hash);
    entries.push({
      lineNo: current.lineNo,
      revision: uncommitted ? '' : current.hash.slice(0, 10),
      author: uncommitted ? '' : current.author,
      date: uncommitted ? '' : formatGitBlameDate(current.authorTime),
      uncommitted,
    });
    current = null;
  }

  return entries;
}

function rememberGitLineBlame(
  key: string,
  value: Promise<LineBlameLine[]>,
): Promise<LineBlameLine[]> {
  if (gitLineBlameCache.has(key)) gitLineBlameCache.delete(key);
  gitLineBlameCache.set(key, value);
  while (gitLineBlameCache.size > GIT_LINE_BLAME_CACHE_LIMIT) {
    const oldestKey = gitLineBlameCache.keys().next().value;
    if (!oldestKey) break;
    gitLineBlameCache.delete(oldestKey);
  }
  return value;
}

async function queryGitLineBlame(
  session: GitWorkingFileSession,
  revisionId: string,
): Promise<LineBlameLine[]> {
  if (!session.tracked || revisionId === GIT_EMPTY_REVISION_ID) return [];

  const workingTree = isWorkingTreeRevision(revisionId);
  const resolvedRevision = workingTree
    ? ''
    : await resolveCommit(session.repositoryPath, revisionId);
  const cacheKey = [session.repositoryPath, session.relativePath, resolvedRevision].join('::');
  if (!workingTree) {
    const cached = gitLineBlameCache.get(cacheKey);
    if (cached) return cached;
  }

  const pending = (async () => {
    const args = ['blame', '--line-porcelain'];
    if (resolvedRevision) args.push(resolvedRevision);
    args.push('--', session.relativePath);
    const result = await runGit(session.repositoryPath, args, { allowFailure: true });
    return result.exitCode === 0
      ? parseGitLineBlame(result.stdout.toString('utf8'))
      : [];
  })();

  if (!workingTree) {
    void rememberGitLineBlame(cacheKey, pending);
    void pending.catch(() => gitLineBlameCache.delete(cacheKey));
  }
  return pending;
}

export async function loadGitLineBlame(
  baseRevisionId?: string,
  mineRevisionId?: string,
): Promise<LineBlamePayload> {
  const session = getActiveGitWorkingFileSession();
  if (!session) return { base: [], mine: [] };

  const baseId = baseRevisionId?.trim() || session.headCommit || GIT_EMPTY_REVISION_ID;
  const mineId = mineRevisionId?.trim() || SPECIAL_MINE_ID;
  const basePromise = queryGitLineBlame(session, baseId);
  const [base, mine] = baseId === mineId
    ? await Promise.all([basePromise, basePromise])
    : await Promise.all([basePromise, queryGitLineBlame(session, mineId)]);
  return { base, mine };
}

export function clearActiveGitWorkingFileSession(): void {
  setComparisonGitWorkingFileSession(null);
}

export function getActiveGitWorkingFileSession(): GitWorkingFileSession | null {
  return getComparisonGitWorkingFileSession();
}

export async function resolveGitWorkingFileSession(
  filePath: string,
): Promise<GitWorkingFileSession | null> {
  const workingFilePath = path.resolve(filePath.trim());
  if (!workingFilePath) return null;

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(workingFilePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  let repositoryResult: GitCommandResult;
  try {
    repositoryResult = await runGit(path.dirname(workingFilePath), [
      'rev-parse',
      '--show-toplevel',
    ], { allowFailure: true });
  } catch {
    return null;
  }
  const repositoryPath = path.resolve(toText(repositoryResult));
  if (repositoryResult.exitCode !== 0 || !repositoryPath) {
    return null;
  }

  const prefixResult = await runGit(path.dirname(workingFilePath), [
    'rev-parse',
    '--show-prefix',
  ], { allowFailure: true });
  if (prefixResult.exitCode !== 0) return null;
  const relativePath = `${toText(prefixResult).replaceAll('\\', '/')}${path.basename(workingFilePath)}`;
  if (
    !relativePath
    || path.posix.isAbsolute(relativePath)
    || relativePath.split('/').some((segment) => segment === '..')
  ) {
    return null;
  }
  const normalizedWorkingFilePath = path.resolve(
    repositoryPath,
    ...relativePath.split('/'),
  );
  const [branchResult, headResult, trackedResult] = await Promise.all([
    runGit(repositoryPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true }),
    runGit(repositoryPath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFailure: true }),
    runGit(repositoryPath, ['ls-files', '--error-unmatch', '--', relativePath], { allowFailure: true }),
  ]);
  const headCommit = toText(headResult);
  const hasHeadCommit = headResult.exitCode === 0 && /^[0-9a-f]{40,64}$/i.test(headCommit);
  const headFileResult = hasHeadCommit
    ? await runGit(repositoryPath, ['cat-file', '-e', `${headCommit}:${relativePath}`], { allowFailure: true })
    : null;
  const tracked = trackedResult.exitCode === 0 && headFileResult?.exitCode === 0;

  const session: GitWorkingFileSession = {
    repositoryPath,
    workingFilePath: normalizedWorkingFilePath,
    relativePath,
    currentBranch: toText(branchResult) || null,
    headCommit: hasHeadCommit ? headCommit : null,
    headShortHash: hasHeadCommit ? headCommit.slice(0, 10) : '',
    tracked,
  };
  return session;
}

export async function activateGitWorkingFileSession(
  filePath: string,
): Promise<GitWorkingFileSession | null> {
  setComparisonGitWorkingFileSession(null);
  const session = await resolveGitWorkingFileSession(filePath);
  setComparisonGitWorkingFileSession(session);
  return session;
}

export async function loadGitWorkingFileLineBlame(
  filePath: string,
): Promise<LineBlameLine[]> {
  const session = await resolveGitWorkingFileSession(filePath);
  if (!session?.tracked) return [];
  return queryGitLineBlame(session, SPECIAL_MINE_ID);
}

export function loadGitFileRevisionLineBlame(
  session: GitWorkingFileSession,
  revisionId: string,
): Promise<LineBlameLine[]> {
  return queryGitLineBlame(session, revisionId);
}

export async function readGitFileRevision(
  session: GitWorkingFileSession,
  revisionId: string,
): Promise<Buffer> {
  if (revisionId === GIT_EMPTY_REVISION_ID) return Buffer.alloc(0);
  if (isWorkingTreeRevision(revisionId)) return readWorkingTreeFile(session);

  const commit = await resolveCommit(session.repositoryPath, revisionId);
  const result = await runGit(session.repositoryPath, [
    'show',
    `${commit}:${session.relativePath}`,
  ], { maxBytes: GIT_BLOB_MAX_BYTES });
  return result.stdout;
}

export async function writeGitFileRevision(
  session: GitWorkingFileSession,
  revisionId: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (revisionId === GIT_EMPTY_REVISION_ID) { await fs.promises.writeFile(destination, '', { flag: 'wx' }); return; }
  if (isWorkingTreeRevision(revisionId)) {
    const [repository, source] = await Promise.all([fs.promises.realpath(session.repositoryPath), fs.promises.realpath(session.workingFilePath)]);
    if (!isPathInside(repository, source)) throw new Error('Refusing to read a working-tree file outside the repository.');
    const before = await fs.promises.stat(source);
    if (!before.isFile()) throw new Error('The selected working-copy item is not a regular file.');
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    const after = await fs.promises.stat(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('The working-tree source changed while its snapshot was copied.');
    signal?.throwIfAborted();
    return;
  }
  const commit = await resolveCommit(session.repositoryPath, revisionId);
  await streamCommandToFile('git', ['-C', session.repositoryPath, 'show', `${commit}:${session.relativePath}`], destination, {
    ...(signal ? { signal } : {}), timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
}

export async function resolveGitRevisionInfo(
  session: GitWorkingFileSession,
  revisionId: string,
): Promise<SvnRevisionInfo> {
  if (revisionId === GIT_EMPTY_REVISION_ID) return buildEmptyRevisionInfo();
  if (isWorkingTreeRevision(revisionId)) return buildWorkingTreeRevisionInfo();

  const commit = await resolveCommit(session.repositoryPath, revisionId);
  const result = await runGit(session.repositoryPath, [
    'show',
    '-s',
    '--format=%H%x00%h%x00%an%x00%aI%x00%s',
    commit,
  ]);
  return parseGitRevisionInfo(result.stdout.toString('utf8')) ?? {
    id: commit,
    revision: commit.slice(0, 10),
    title: commit.slice(0, 10),
    author: 'Git',
    date: '',
    message: '',
    kind: 'revision',
  };
}

export async function queryGitRevisionOptionsForSession(
  session: GitWorkingFileSession | null,
  query: RevisionOptionsQuery | undefined,
): Promise<RevisionOptionsPayload> {
  const limit = normalizeLimit(query?.limit);
  const queryDateTime = query?.anchorDateTime?.trim() || null;
  if (!session || !session.tracked || !session.headCommit) {
    return {
      items: query?.includeSpecials ? [buildWorkingTreeRevisionInfo()] : [],
      hasMore: false,
      nextBeforeRevisionId: null,
      anchorRevisionId: null,
      queryDateTime,
    };
  }

  const args = [
    'log',
    `--max-count=${limit + 1}`,
    '--format=%H%x00%h%x00%an%x00%aI%x00%s',
  ];
  if (queryDateTime) args.push(`--before=${queryDateTime}`);
  if (query?.beforeRevisionId?.trim()) {
    args.push('--skip=1', assertGitRevision(query.beforeRevisionId));
  } else {
    args.push('HEAD');
  }
  args.push('--', session.relativePath);

  const result = await runGit(session.repositoryPath, args, { allowFailure: true });
  const parsedItems = result.exitCode === 0
    ? result.stdout.toString('utf8')
      .split(/\r?\n/)
      .map(parseGitRevisionInfo)
      .filter((item): item is SvnRevisionInfo => item !== null)
    : [];
  const hasMore = parsedItems.length > limit;
  const pageItems = parsedItems.slice(0, limit);
  const headInfo = await resolveGitRevisionInfo(session, session.headCommit);
  const specials = query?.includeSpecials
    ? [buildWorkingTreeRevisionInfo(), headInfo]
    : [];
  const seenIds = new Set<string>();
  const items = [...specials, ...pageItems].filter((item) => {
    if (seenIds.has(item.id)) return false;
    seenIds.add(item.id);
    return true;
  });
  const lastPageItem = pageItems[pageItems.length - 1] ?? null;

  return {
    items,
    hasMore,
    nextBeforeRevisionId: hasMore ? lastPageItem?.id ?? null : null,
    anchorRevisionId: queryDateTime ? pageItems[0]?.id ?? null : null,
    queryDateTime,
  };
}

export function queryGitRevisionOptions(
  query: RevisionOptionsQuery | undefined,
): Promise<RevisionOptionsPayload> {
  return queryGitRevisionOptionsForSession(getActiveGitWorkingFileSession(), query);
}

export async function getGitRevisionOptions(): Promise<SvnRevisionInfo[]> {
  const payload = await queryGitRevisionOptions({
    limit: 60,
    includeSpecials: true,
  });
  return payload.items;
}
