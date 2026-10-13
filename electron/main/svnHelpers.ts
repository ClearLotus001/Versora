import * as path from 'node:path';
import * as fs from 'node:fs';
import { electronT } from '../i18n.js';
import {
  APP_ROOT,
  DEFAULT_REVISION_QUERY_LIMIT,
  KEYWORD_VERSION,
  MAX_REVISION_QUERY_LIMIT,
  REMOTE_HEAD_ID,
  SPECIAL_BASE_ID,
  SPECIAL_MINE_ID,
  TRAILING_PAREN_VERSION,
  WORKBOOK_EXTENSIONS,
  XML,
} from './constants.js';
import { logMainWarn } from '../logging.js';
import { getActiveCliArgs } from './state.js';
import type {
  CliArgs,
  CompareContext,
  RevisionOptionsQuery,
  RevisionSelectionPair,
  LineBlameLine,
  SvnRevisionInfo,
  XmlNode,
} from './types.js';

// ---------------------------------------------------------------------------
// File-type helpers
// ---------------------------------------------------------------------------

export function isWorkbookFile(filePath: string): boolean {
  return WORKBOOK_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function asXmlNode(value: unknown): XmlNode | null {
  return value != null && typeof value === 'object' ? value as XmlNode : null;
}

function asXmlNodeArray(value: unknown): XmlNode[] {
  return asArray(value).map(asXmlNode).filter((item): item is XmlNode => item != null);
}

function getXmlString(node: XmlNode | null, key: string): string {
  const value = node?.[key];
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// File identity
// ---------------------------------------------------------------------------

function buildFileIdentity(filePath: string): string {
  const resolved = filePath.trim();
  if (!resolved) return '';

  try {
    const stat = fs.statSync(resolved);
    return `${resolved}::${stat.size}::${Math.round(stat.mtimeMs)}`;
  } catch {
    return resolved;
  }
}

export function buildSourceIdentity(params: {
  kind: 'cli' | 'revision-switch' | 'local-dev';
  fileName: string;
  baseUrl: string;
  mineUrl: string;
  baseRevision: string;
  mineRevision: string;
  pegRevision: string;
  basePath: string;
  minePath: string;
  baseName: string;
  mineName: string;
}): string {
  return [
    params.kind,
    params.fileName.trim(),
    params.baseUrl.trim(),
    params.mineUrl.trim(),
    params.baseRevision.trim(),
    params.mineRevision.trim(),
    params.pegRevision.trim(),
    buildFileIdentity(params.basePath),
    buildFileIdentity(params.minePath),
    params.baseName.trim(),
    params.mineName.trim(),
  ].join('::');
}

// ---------------------------------------------------------------------------
// SVN URL helpers
// ---------------------------------------------------------------------------

export function normalizeSvnUrlForCompare(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function isRemoteRepositoryTarget(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith('http://')
    || normalized.startsWith('https://')
    || normalized.startsWith('svn://')
    || normalized.startsWith('svn+ssh://')
    || normalized.startsWith('file://');
}

export function haveSameExplicitSvnUrl(args: CliArgs): boolean {
  const baseUrl = normalizeSvnUrlForCompare(args.baseUrl);
  const mineUrl = normalizeSvnUrlForCompare(args.mineUrl);
  if (!baseUrl || !mineUrl) return false;
  return baseUrl === mineUrl;
}

// ---------------------------------------------------------------------------
// Revision label helpers
// ---------------------------------------------------------------------------

export function normalizeRevisionNumber(revision: string): string {
  const trimmed = revision.trim();
  return trimmed.replace(/^r/i, '');
}

function formatRevisionLabel(revision: string): string {
  const normalized = normalizeRevisionNumber(revision);
  return normalized ? `r${normalized}` : '';
}

function normalizeRevisionLabelToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^(wc|working copy|local)$/i.test(trimmed)) return 'WC';
  if (/^(base|working base)$/i.test(trimmed)) return 'BASE';
  if (/^head$/i.test(trimmed)) return 'HEAD';

  const numeric = formatRevisionLabel(trimmed);
  if (numeric) return numeric;
  return trimmed;
}

function isWorkingCopyRevisionToken(value: string): boolean {
  return normalizeRevisionLabelToken(value) === 'WC';
}

function isRemoteRevisionToken(value: string): boolean {
  const normalized = normalizeRevisionLabelToken(value);
  return Boolean(normalized && (normalized === 'HEAD' || /^r\d+/i.test(normalized)));
}

export function isRemoteHeadSelectionId(value: string | undefined): boolean {
  return value?.trim() === REMOTE_HEAD_ID;
}

function extractRevisionToken(name: string): string {
  const normalized = name.trim();
  if (!normalized) return '';

  const parenMatch = normalized.match(TRAILING_PAREN_VERSION);
  const fromParen = parenMatch?.[1]?.trim() ?? '';
  if (/^r?[0-9]/i.test(fromParen)) {
    return fromParen.toLowerCase().startsWith('r') ? fromParen : `r${fromParen}`;
  }

  const keywordMatch = normalized.match(KEYWORD_VERSION);
  if (!keywordMatch) return '';
  const numeric = keywordMatch[1]?.trim() ?? '';
  if (!numeric) return '';
  return numeric.toLowerCase().startsWith('r') ? numeric : `r${numeric}`;
}

export function getRevisionNumberValue(revision: string): number | null {
  const normalized = normalizeRevisionNumber(revision);
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatLogDate(dateText: string): string {
  if (!dateText) return '';
  const parsed = new Date(dateText);
  if (Number.isNaN(parsed.getTime())) return dateText;
  const yyyy = parsed.getFullYear();
  const mm = `${parsed.getMonth() + 1}`.padStart(2, '0');
  const dd = `${parsed.getDate()}`.padStart(2, '0');
  const hh = `${parsed.getHours()}`.padStart(2, '0');
  const mi = `${parsed.getMinutes()}`.padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

// ---------------------------------------------------------------------------
// Revision query normalization
// ---------------------------------------------------------------------------

function clampRevisionQueryLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_REVISION_QUERY_LIMIT;
  return Math.max(1, Math.min(MAX_REVISION_QUERY_LIMIT, Math.floor(limit!)));
}

function normalizeAnchorDateTime(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function formatSvnDateQuery(value: string): string {
  return value.trim().replace('T', ' ');
}

export interface NormalizedRevisionOptionsQuery {
  limit: number;
  beforeRevisionId: string;
  anchorDateTime: string;
  includeSpecials: boolean;
  targetSide: '' | 'base' | 'mine';
}

export function normalizeRevisionQuery(
  query: RevisionOptionsQuery | undefined,
): NormalizedRevisionOptionsQuery {
  return {
    limit: clampRevisionQueryLimit(query?.limit),
    beforeRevisionId: formatRevisionLabel(query?.beforeRevisionId ?? ''),
    anchorDateTime: normalizeAnchorDateTime(query?.anchorDateTime),
    includeSpecials: Boolean(query?.includeSpecials),
    targetSide: query?.targetSide === 'base' || query?.targetSide === 'mine'
      ? query.targetSide
      : '',
  };
}

export function buildRevisionQueryCacheKey(query: NormalizedRevisionOptionsQuery): string {
  return JSON.stringify(query);
}

// ---------------------------------------------------------------------------
// CLI → Revision info
// ---------------------------------------------------------------------------

function getCliSideRevisionLabel(side: 'base' | 'mine'): string {
  const args = getActiveCliArgs();
  const explicit = side === 'base' ? args.baseRevision : args.mineRevision;
  const normalizedExplicit = normalizeRevisionLabelToken(explicit);
  if (normalizedExplicit) return normalizedExplicit;

  const sideName = side === 'base' ? args.baseName : args.mineName;
  return normalizeRevisionLabelToken(extractRevisionToken(sideName));
}

export function resolveSideName(explicitName: string, filePath: string): string {
  const normalized = explicitName.trim();
  if (normalized && !['base', 'mine'].includes(normalized.toLowerCase())) {
    return normalized;
  }

  if (filePath) return path.basename(filePath);
  return normalized;
}

function resolveUrlPegRevision(value: string): string {
  const normalized = normalizeRevisionLabelToken(value);
  if (!normalized) return '';
  if (normalized === 'HEAD') return 'HEAD';
  if (/^r\d+/i.test(normalized)) return normalizeRevisionNumber(normalized);
  return '';
}

export function getPeggedSvnTarget(target: string): string {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) return '';

  const pegRevision = resolveUrlPegRevision(getActiveCliArgs().pegRevision);
  if (!pegRevision) return normalizedTarget;
  return `${normalizedTarget}@${pegRevision}`;
}

export function resolveIconPath(): string | undefined {
  const candidates = [
    path.join(APP_ROOT, 'assets', 'icon.png'),
    path.join(APP_ROOT, 'assets', 'icon.ico'),
  ];

  return candidates.find(candidate => fs.existsSync(candidate));
}

// ---------------------------------------------------------------------------
// Revision info factories
// ---------------------------------------------------------------------------

function makeRevisionSelectionPair(
  baseRevisionId: string | null | undefined,
  mineRevisionId: string | null | undefined,
): RevisionSelectionPair {
  return {
    baseRevisionId: baseRevisionId?.trim() || null,
    mineRevisionId: mineRevisionId?.trim() || null,
  };
}

function createWorkingCopyRevisionInfo(): SvnRevisionInfo {
  return {
    id: SPECIAL_MINE_ID,
    revision: 'WC',
    title: electronT('revisionWorkingCopyTitle'),
    author: '',
    date: '',
    message: '',
    kind: 'working-copy',
  };
}

export function createCliRevisionInfo(side: 'base' | 'mine'): SvnRevisionInfo | null {
  const args = getActiveCliArgs();
  const filePath = side === 'base' ? args.basePath : args.minePath;
  const sideName = side === 'base' ? args.baseName : args.mineName;
  const revision = getCliSideRevisionLabel(side);

  if (isWorkingCopyRevisionToken(revision)) {
    return {
      id: side === 'base' ? SPECIAL_BASE_ID : SPECIAL_MINE_ID,
      revision: 'WC',
      title: resolveSideName(sideName, filePath) || sideName || electronT('revisionWorkingCopyTitle'),
      author: '',
      date: '',
      message: '',
      kind: 'working-copy',
    };
  }
  if (side === 'base' && revision === 'BASE') {
    return {
      id: SPECIAL_BASE_ID,
      revision: 'BASE',
      title: resolveSideName(sideName, filePath) || sideName || electronT('revisionWorkingBaseTitle'),
      author: '',
      date: '',
      message: '',
      kind: 'input-file',
    };
  }
  if (revision) {
    return {
      id: revision,
      revision,
      title: revision,
      author: '',
      date: '',
      message: '',
      kind: isRemoteRevisionToken(revision) ? 'revision' : 'input-file',
    };
  }

  const title = resolveSideName(sideName, filePath);
  if (!title) return null;
  return {
    id: side === 'base' ? SPECIAL_BASE_ID : SPECIAL_MINE_ID,
    revision: '',
    title,
    author: '',
    date: '',
    message: '',
    kind: side === 'base' ? 'input-file' : 'working-copy',
  };
}

function makeFallbackRevisionInfo(side: 'base' | 'mine'): SvnRevisionInfo {
  const args = getActiveCliArgs();
  const sideName = side === 'base' ? args.baseName : args.mineName;
  const filePath = side === 'base' ? args.basePath : args.minePath;
  const extractedRevision = getCliSideRevisionLabel(side);

  return {
    id: side === 'base' ? SPECIAL_BASE_ID : SPECIAL_MINE_ID,
    revision: extractedRevision || (side === 'base' ? 'BASE' : 'LOCAL'),
    title: resolveSideName(sideName, filePath) || (
      side === 'base'
        ? electronT('revisionBaseFallbackTitle')
        : electronT('revisionMineFallbackTitle')
    ),
    author: '',
    date: '',
    message: '',
    kind: side === 'base' ? 'input-file' : 'working-copy',
  };
}

function resolveCurrentRevisionInfo(
  side: 'base' | 'mine',
  options: SvnRevisionInfo[],
): SvnRevisionInfo {
  const extractedRevision = getCliSideRevisionLabel(side);
  if (extractedRevision) {
    const matchedRevision = options.find(
      option => option.revision.toLowerCase() === extractedRevision.toLowerCase(),
    );
    if (matchedRevision) return matchedRevision;
  }

  const specialId = side === 'base' ? SPECIAL_BASE_ID : SPECIAL_MINE_ID;
  const matchedSpecial = options.find(option => option.id === specialId);
  if (matchedSpecial) return matchedSpecial;

  return makeFallbackRevisionInfo(side);
}

function resolveRevisionById(
  side: 'base' | 'mine',
  options: SvnRevisionInfo[],
  requestedId: string | undefined,
): SvnRevisionInfo {
  const normalized = requestedId?.trim();
  if (normalized) {
    const matched = options.find(option => option.id === normalized);
    if (matched) return matched;
  }
  return resolveCurrentRevisionInfo(side, options);
}

export function isRevisionSelectionId(value: string | null | undefined): boolean {
  const normalized = value?.trim() ?? '';
  if (!normalized) return false;
  if (normalized === SPECIAL_BASE_ID || normalized === SPECIAL_MINE_ID || normalized === REMOTE_HEAD_ID) {
    return false;
  }
  return true;
}

function isStartupRevisionVsRevisionCompare(): boolean {
  return isRemoteRevisionToken(getCliSideRevisionLabel('base'))
    && isRemoteRevisionToken(getCliSideRevisionLabel('mine'));
}

function isStartupWorkingCopyCompare(): boolean {
  const baseRevision = getCliSideRevisionLabel('base');
  const mineRevision = getCliSideRevisionLabel('mine');
  return isWorkingCopyRevisionToken(mineRevision) || normalizeRevisionLabelToken(baseRevision) === 'BASE';
}

function hasStartupSvnRuntimeContextHint(): boolean {
  const args = getActiveCliArgs();
  return isRemoteRepositoryTarget(args.baseUrl)
    || isRemoteRepositoryTarget(args.mineUrl)
    || isStartupRevisionVsRevisionCompare()
    || isStartupWorkingCopyCompare();
}

export function shouldResolveSvnRuntimeContext(
  requestedBaseRevisionId?: string,
  requestedMineRevisionId?: string,
): boolean {
  return Boolean(
    requestedBaseRevisionId?.trim()
    || requestedMineRevisionId?.trim()
    || hasStartupSvnRuntimeContextHint()
  );
}

export function resolveCliSourceIdentityKind(
  requestedBaseRevisionId?: string,
  requestedMineRevisionId?: string,
): 'cli' | 'revision-switch' | 'local-dev' {
  if (requestedBaseRevisionId?.trim() || requestedMineRevisionId?.trim()) {
    return 'revision-switch';
  }
  return hasStartupSvnRuntimeContextHint() ? 'cli' : 'local-dev';
}

// ---------------------------------------------------------------------------
// Compare context / pair resolution
// ---------------------------------------------------------------------------

export function buildInitialPairFromCli(compareContext: CompareContext): RevisionSelectionPair | null {
  if (compareContext === 'literal_two_file_compare') return null;

  if (compareContext === 'standard_local_compare') {
    const baseRevisionId = isRemoteRevisionToken(getCliSideRevisionLabel('base'))
      ? getCliSideRevisionLabel('base')
      : null;
    const mineRevisionId = isWorkingCopyRevisionToken(getCliSideRevisionLabel('mine'))
      ? SPECIAL_MINE_ID
      : null;
    return makeRevisionSelectionPair(baseRevisionId, mineRevisionId);
  }

  const baseRevisionId = isRemoteRevisionToken(getCliSideRevisionLabel('base'))
    ? getCliSideRevisionLabel('base')
    : null;
  const mineRevisionId = isRemoteRevisionToken(getCliSideRevisionLabel('mine'))
    ? getCliSideRevisionLabel('mine')
    : null;
  return makeRevisionSelectionPair(baseRevisionId, mineRevisionId);
}

export function buildResetPair(
  compareContext: CompareContext,
  initialPair: RevisionSelectionPair | null,
  workingCopyAvailable: boolean,
): RevisionSelectionPair | null {
  if (compareContext === 'literal_two_file_compare') return null;
  if (compareContext === 'standard_local_compare' && workingCopyAvailable) {
    return makeRevisionSelectionPair(REMOTE_HEAD_ID, SPECIAL_MINE_ID);
  }
  return initialPair;
}

export function resolveCurrentCompareContext(params: {
  target: string;
  workingCopyAvailable: boolean;
  requestedBaseRevisionId?: string | undefined;
  requestedMineRevisionId?: string | undefined;
  args: CliArgs;
}): CompareContext {
  if (!params.target) return 'literal_two_file_compare';
  if (params.requestedMineRevisionId?.trim() === SPECIAL_MINE_ID) {
    return 'standard_local_compare';
  }
  if (params.requestedBaseRevisionId || params.requestedMineRevisionId) {
    return 'revision_vs_revision_compare';
  }
  if (isStartupRevisionVsRevisionCompare()) {
    return 'revision_vs_revision_compare';
  }
  if (isStartupWorkingCopyCompare()) {
    return 'standard_local_compare';
  }
  return 'literal_two_file_compare';
}

export function createCurrentPairInfo(params: {
  compareContext: CompareContext;
  requestedBaseRevisionId?: string | undefined;
  requestedMineRevisionId?: string | undefined;
  revisionOptions: SvnRevisionInfo[] | null;
}): { base: SvnRevisionInfo | null; mine: SvnRevisionInfo | null } {
  const { compareContext, requestedBaseRevisionId, requestedMineRevisionId, revisionOptions } = params;
  if (compareContext === 'literal_two_file_compare') {
    return { base: null, mine: null };
  }

  const startupBase = createCliRevisionInfo('base');
  const startupMine = createCliRevisionInfo('mine');

  if (!requestedBaseRevisionId && !requestedMineRevisionId) {
    if (revisionOptions) {
      if (compareContext === 'standard_local_compare') {
        return {
          base: resolveCurrentRevisionInfo('base', revisionOptions),
          mine: createWorkingCopyRevisionInfo(),
        };
      }

      return {
        base: resolveCurrentRevisionInfo('base', revisionOptions),
        mine: resolveCurrentRevisionInfo('mine', revisionOptions),
      };
    }

    return { base: startupBase, mine: startupMine };
  }

  if (revisionOptions && requestedBaseRevisionId) {
    if (compareContext === 'standard_local_compare') {
      return {
        base: resolveRevisionById('base', revisionOptions, requestedBaseRevisionId),
        mine: createWorkingCopyRevisionInfo(),
      };
    }

    return {
      base: resolveRevisionById('base', revisionOptions, requestedBaseRevisionId),
      mine: requestedMineRevisionId
        ? resolveRevisionById('mine', revisionOptions, requestedMineRevisionId)
        : createCliRevisionInfo('mine'),
    };
  }

  if (compareContext === 'standard_local_compare') {
    return {
      base: startupBase,
      mine: startupMine ?? createWorkingCopyRevisionInfo(),
    };
  }

  return { base: startupBase, mine: startupMine };
}

export function isSameWorkbookSource(
  args: CliArgs,
  baseRevisionId: string | undefined,
  mineRevisionId: string | undefined,
): boolean {
  if (!baseRevisionId && !mineRevisionId) {
    return Boolean(args.basePath && args.basePath === args.minePath);
  }
  if (baseRevisionId && mineRevisionId && baseRevisionId === mineRevisionId) {
    return true;
  }

  const baseUsesInput = !baseRevisionId || baseRevisionId === SPECIAL_BASE_ID;
  const mineUsesInput = !mineRevisionId || mineRevisionId === SPECIAL_MINE_ID;
  return baseUsesInput
    && mineUsesInput
    && Boolean(args.basePath && args.basePath === args.minePath);
}

export function createRequestedRevisionInfo(
  side: 'base' | 'mine',
  requestedId: string | undefined,
): SvnRevisionInfo {
  const requested = requestedId?.trim() ?? '';
  if (!requested) {
    return makeFallbackRevisionInfo(side);
  }
  if (requested === SPECIAL_BASE_ID) {
    return makeFallbackRevisionInfo(side);
  }
  if (requested === SPECIAL_MINE_ID) {
    return createWorkingCopyRevisionInfo();
  }
  const normalized = normalizeRevisionLabelToken(requested);
  if (side === 'base' && normalized === 'BASE') {
    return makeFallbackRevisionInfo(side);
  }
  if (side === 'mine' && normalized === 'WC') {
    return createWorkingCopyRevisionInfo();
  }

  const revision = formatRevisionLabel(normalized);
  return {
    id: normalized,
    revision: revision || normalized,
    title: revision || normalized,
    author: '',
    date: '',
    message: '',
    kind: 'revision',
  };
}

// ---------------------------------------------------------------------------
// Display name helpers
// ---------------------------------------------------------------------------

export function makeSideDisplayName(
  fileName: string,
  info: SvnRevisionInfo,
  fallback: string,
): string {
  const baseLabel = fileName.trim() || fallback.trim();
  const suffix = info.revision || info.title;
  if (baseLabel && suffix) return `${baseLabel} (${suffix})`;
  if (baseLabel) return baseLabel;
  if (suffix) return suffix;
  return fallback;
}

export function buildLaunchDisplayName(
  fileName: string,
  sideName: string,
  filePath: string,
): string {
  const label = resolveSideName(sideName, filePath);
  if (label) return label;
  return fileName.trim();
}

export function parseLogEntries(xmlText: string): SvnRevisionInfo[] {
  if (!xmlText.trim()) return [];

  try {
    const parsed = asXmlNode(XML.parse(xmlText));
    const mapped: Array<SvnRevisionInfo | null> = asXmlNodeArray(asXmlNode(parsed?.log)?.logentry)
      .map((entry): SvnRevisionInfo | null => {
        const revision = formatRevisionLabel(getXmlString(entry, 'revision').trim());
        if (!revision) return null;
        return {
          id: revision,
          revision,
          title: revision,
          author: getXmlString(entry, 'author').trim(),
          date: formatLogDate(getXmlString(entry, 'date').trim()),
          message: getXmlString(entry, 'msg').trim(),
          kind: 'revision' as const,
        };
      });

    return mapped.filter((entry): entry is SvnRevisionInfo => entry != null);
  } catch (error) {
    logMainWarn('svn-log-parse', error instanceof Error ? error.message : String(error));
    return [];
  }
}

export function parseBlameEntries(xmlText: string): LineBlameLine[] {
  if (!xmlText.trim()) return [];

  try {
    const parsed = asXmlNode(XML.parse(xmlText));
    const targets = asXmlNodeArray(asXmlNode(parsed?.blame)?.target);
    return targets.flatMap(target => asXmlNodeArray(target.entry)).flatMap((entry): LineBlameLine[] => {
      const lineNo = Number.parseInt(getXmlString(entry, 'line-number').trim(), 10);
      if (!Number.isFinite(lineNo) || lineNo < 1) return [];

      const commit = asXmlNode(entry.commit);
      const revision = formatRevisionLabel(getXmlString(commit, 'revision').trim());
      return [{
        lineNo,
        revision,
        author: getXmlString(commit, 'author').trim(),
        date: formatLogDate(getXmlString(commit, 'date').trim()),
        uncommitted: !revision,
      }];
    });
  } catch (error) {
    logMainWarn('svn-blame-parse', error instanceof Error ? error.message : String(error));
    return [];
  }
}

export function getLatestRemoteRevisionId(options: SvnRevisionInfo[] | null): string | undefined {
  return options?.find(option => option.kind === 'revision')?.id;
}
