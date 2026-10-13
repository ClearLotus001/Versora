// ─────────────────────────────────────────────────────────────────────────────
// SVN, diff loading, and shell integration types
// ─────────────────────────────────────────────────────────────────────────────

import type {
  DiffMeta,
  DiffPerformanceMetrics,
  DiffSourceNoticeCode,
} from '@/types/diff';
import type {
  WorkbookArtifactDiff,
  WorkbookCompareMode,
  WorkbookMetadataMap,
} from '@/types/workbook';
import type { DiffAnalysisSnapshot } from '@/types/analysis';
import type { ComparisonSourceDescriptor } from '../../shared/comparison';

export type SvnRevisionSourceKind = 'revision' | 'working-copy' | 'input-file';

export interface SvnRevisionInfo {
  id: string;
  revision: string;
  title: string;
  author: string;
  date: string;
  message: string;
  kind: SvnRevisionSourceKind;
}

export interface RevisionOptionsQuery {
  limit?: number;
  beforeRevisionId?: string;
  anchorDateTime?: string;
  includeSpecials?: boolean;
  targetSide?: LocalFilePickSide;
}

export interface RevisionOptionsPayload {
  items: SvnRevisionInfo[];
  hasMore: boolean;
  nextBeforeRevisionId: string | null;
  anchorRevisionId: string | null;
  queryDateTime: string | null;
}

export type CompareContext =
  | 'standard_local_compare'
  | 'literal_two_file_compare'
  | 'revision_vs_revision_compare'
  | 'git_compare';

export interface RevisionSelectionPair {
  baseRevisionId: string | null;
  mineRevisionId: string | null;
}

export interface DiffData extends DiffMeta {
  comparisonSessionId?: string;
  isSideOrderSwapped?: boolean;
  source?: ComparisonSourceDescriptor;
  sourceIdentity?: string;
  basePath?: string;
  minePath?: string;
  compareContext?: CompareContext;
  timelineTargetUrl?: string | null;
  workingCopyAvailable?: boolean;
  initialPair?: RevisionSelectionPair | null;
  resetPair?: RevisionSelectionPair | null;
  launchBaseName?: string;
  launchMineName?: string;
  baseContent: string | null;
  mineContent: string | null;
  analysisSnapshotsByMode?: Partial<Record<WorkbookCompareMode, DiffAnalysisSnapshot | null>> | null;
  baseWorkbookMetadata?: WorkbookMetadataMap | null;
  mineWorkbookMetadata?: WorkbookMetadataMap | null;
  revisionOptions?: SvnRevisionInfo[] | null;
  baseRevisionInfo?: SvnRevisionInfo | null;
  mineRevisionInfo?: SvnRevisionInfo | null;
  canSwitchRevisions?: boolean;
  revisionSwitchableSides?: { base: boolean; mine: boolean };
  workbookArtifactDiff?: WorkbookArtifactDiff | null;
  workbookArtifact?: import('../../shared/workbookArtifactProtocol').WorkbookArtifactDescriptor | null;
  sourceNoticeCode?: DiffSourceNoticeCode | null;
  perf?: DiffPerformanceMetrics | null;
}

export interface LocalDiffFilePickResult {
  path: string;
  name: string;
}

export type LocalFilePickSide = 'base' | 'mine';

export type SvnDiffViewerScope = 'all-files' | 'text-only' | 'workbook-only';
export type SvnDiffViewerMode = SvnDiffViewerScope | 'mixed' | 'unconfigured' | 'unsupported';
export type SvnDiffViewerAvailabilityReason =
  | 'ready'
  | 'windows-only'
  | 'packaged-only'
  | 'launcher-missing';

export interface SvnDiffViewerStatus {
  available: boolean;
  reason: SvnDiffViewerAvailabilityReason;
  executablePath: string | null;
  command: string | null;
  currentMode: SvnDiffViewerMode;
  canRestoreDefault: boolean;
  globalDiffCommand: string | null;
  workbookDiffCommands: Record<string, string | null>;
  workbookExtensions: string[];
}

export interface WindowFrameState {
  isMaximized: boolean;
}
