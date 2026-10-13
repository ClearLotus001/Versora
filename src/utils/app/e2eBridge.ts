import { createWorkbookArtifactFixture } from '@/utils/app/workbookArtifactFixture';
import { computeDiff } from '@/engine/text/diff';
import { attachLineBlameToDiffLines } from '@/utils/diff/lineBlame';
import { prepareTextDiffAnalysisFromDiffLines } from '@/utils/diff/preparedTextAnalysis';
import { swapDiffDataSides } from '@/utils/diff/swapDiffSides';
import type { DiffData, LayoutMode, LineBlameLine, SvnRevisionInfo } from '@/types';

interface E2ERevisionPayload {
  source?: DiffData['source'];
  compareContext?: DiffData['compareContext'];
  basePath?: string;
  minePath?: string;
  revisionOptions?: SvnRevisionInfo[] | null;
  baseRevisionInfo?: SvnRevisionInfo | null;
  mineRevisionInfo?: SvnRevisionInfo | null;
  canSwitchRevisions?: boolean;
  revisionSwitchableSides?: { base: boolean; mine: boolean };
}

export interface E2ELoadTextDiffPayload extends E2ERevisionPayload {
  fileName?: string;
  baseName?: string;
  mineName?: string;
  baseContent: string;
  mineContent: string;
  layout?: LayoutMode;
  collapseCtx?: boolean;
  baseBlame?: LineBlameLine[];
  mineBlame?: LineBlameLine[];
}

export interface E2ELoadWorkbookDiffPayload extends E2ERevisionPayload {
  fileName?: string;
  baseName?: string;
  mineName?: string;
  baseContent: string;
  mineContent: string;
  layout?: LayoutMode;
  collapseCtx?: boolean;
  showOnlyDifferences?: boolean;
}

export interface E2EBridgeSnapshot {
  hasLoadedDiff: boolean;
  layout: LayoutMode;
  isWorkbookMode: boolean;
  fileName: string;
}

export interface E2EBridge {
  loadTextDiff(payload: E2ELoadTextDiffPayload): Promise<void>;
  loadWorkbookDiff(payload: E2ELoadWorkbookDiffPayload): Promise<void>;
  getSnapshot(): E2EBridgeSnapshot;
}

export function shouldEnableE2EBridge() {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('__e2e') === '1';
}

declare global {
  interface Window {
    __SVN_DIFF_E2E__?: E2EBridge;
  }
}

export function buildE2EDiffData(payload: E2ELoadTextDiffPayload): DiffData {
  const fileName = payload.fileName?.trim() || 'selection-sample.ts';
  const baseName = payload.baseName?.trim() || 'base.ts';
  const mineName = payload.mineName?.trim() || 'mine.ts';
  const diffLines = attachLineBlameToDiffLines(
    computeDiff(payload.baseContent, payload.mineContent),
    {
      base: payload.baseBlame ?? [],
      mine: payload.mineBlame ?? [],
    },
  );
  return {
    ...(payload.source ? { source: payload.source } : {}),
    svnUrl: '',
    fileName,
    ...(payload.basePath?.trim() ? { basePath: payload.basePath.trim() } : {}),
    ...(payload.minePath?.trim() ? { minePath: payload.minePath.trim() } : {}),
    baseName,
    mineName,
    launchBaseName: baseName,
    launchMineName: mineName,
    compareContext: payload.compareContext ?? 'literal_two_file_compare',
    baseContent: payload.baseContent,
    mineContent: payload.mineContent,
    analysisSnapshotsByMode: {
      strict: {
        compareMode: 'strict',
        textAnalysis: prepareTextDiffAnalysisFromDiffLines(diffLines),
      },
    },
    revisionOptions: payload.revisionOptions ?? null,
    baseRevisionInfo: payload.baseRevisionInfo ?? null,
    mineRevisionInfo: payload.mineRevisionInfo ?? null,
    canSwitchRevisions: payload.canSwitchRevisions ?? false,
    ...(payload.revisionSwitchableSides
      ? { revisionSwitchableSides: payload.revisionSwitchableSides }
      : {}),
    workbookArtifactDiff: null,
    sourceNoticeCode: null,
    perf: {
      source: 'local-dev',
    },
  };
}

export function buildE2EWorkbookDiffData(payload: E2ELoadWorkbookDiffPayload): DiffData {
  const fileName = payload.fileName?.trim() || 'workbook-sample.xlsx';
  const baseName = payload.baseName?.trim() || 'workbook-base.xlsx';
  const mineName = payload.mineName?.trim() || 'workbook-mine.xlsx';
  return {
    ...(payload.source ? { source: payload.source } : {}),
    svnUrl: '',
    fileName,
    ...(payload.basePath?.trim() ? { basePath: payload.basePath.trim() } : {}),
    ...(payload.minePath?.trim() ? { minePath: payload.minePath.trim() } : {}),
    baseName,
    mineName,
    launchBaseName: baseName,
    launchMineName: mineName,
    compareContext: payload.compareContext ?? 'literal_two_file_compare',
    baseContent: payload.baseContent,
    mineContent: payload.mineContent,
    analysisSnapshotsByMode: null,
    workbookArtifact: createWorkbookArtifactFixture(payload.baseContent, payload.mineContent),
    revisionOptions: payload.revisionOptions ?? null,
    baseRevisionInfo: payload.baseRevisionInfo ?? null,
    mineRevisionInfo: payload.mineRevisionInfo ?? null,
    canSwitchRevisions: payload.canSwitchRevisions ?? false,
    ...(payload.revisionSwitchableSides
      ? { revisionSwitchableSides: payload.revisionSwitchableSides }
      : {}),
    workbookArtifactDiff: null,
    sourceNoticeCode: null,
    perf: {
      source: 'local-dev',
    },
  };
}

/** Browser fixtures rebuild the artifact so swapping tests exercise actual cell direction. */
export function swapE2EWorkbookDiffData(data: DiffData): DiffData {
  if (!data.workbookArtifact?.artifactId.startsWith('fixture:')) throw new Error('Expected a workbook fixture');
  const swapped = swapDiffDataSides({ ...data, workbookArtifact: null });
  const descriptor = createWorkbookArtifactFixture(data.mineContent ?? '', data.baseContent ?? '', data.workbookArtifact.comparisonSessionId);
  return { ...swapped, workbookArtifact: descriptor, baseWorkbookMetadata: descriptor.baseMetadata, mineWorkbookMetadata: descriptor.mineMetadata };
}
