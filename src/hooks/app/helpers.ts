import type {
  CompareContext,
  DiffData,
  DiffAnalysisSnapshot,
  DiffLine,
  PreparedTextAnalysis,
  SvnRevisionInfo,
  WorkbookCompareMode,
  WorkbookMetadataPayload,
} from '@/types';
import type { RevisionOptionsStatus } from '@/hooks/app/types';

export function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    // Single rAF is sufficient to let the browser commit the current frame.
    // Using MessageChannel for a micro-task yield after rAF avoids the extra
    // ~16ms cost of double-rAF while still guaranteeing paint completion.
    requestAnimationFrame(() => {
      if (typeof MessageChannel !== 'undefined') {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(undefined);
      } else {
        setTimeout(resolve, 0);
      }
    });
  });
}

export function getNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function debugLog(message: string, payload?: unknown) {
  window.versora?.debugLog?.(message, payload);
}

export function cycleHunkIndex(current: number, total: number, direction: -1 | 1): number {
  if (total <= 0) return 0;
  return (current + direction + total) % total;
}

function getAnalysisSnapshotForMode(
  data: DiffData | null | undefined,
  compareMode: WorkbookCompareMode,
): DiffAnalysisSnapshot | null {
  return data?.analysisSnapshotsByMode?.[compareMode] ?? null;
}

export function getPreparedTextAnalysisForMode(
  data: DiffData | null | undefined,
  compareMode: WorkbookCompareMode,
): PreparedTextAnalysis | null {
  return getAnalysisSnapshotForMode(data, compareMode)?.textAnalysis ?? null;
}

export function getPreparedDiffLinesForMode(
  data: DiffData | null | undefined,
  compareMode: WorkbookCompareMode,
): DiffLine[] | null {
  return getPreparedTextAnalysisForMode(data, compareMode)?.diffLines ?? null;
}

export function mergeWorkbookMetadataPayload(data: DiffData, payload: WorkbookMetadataPayload): DiffData {
  return {
    ...data,
    baseWorkbookMetadata: payload.base,
    mineWorkbookMetadata: payload.mine,
    perf: payload.perf
      ? { ...(data.perf ?? { source: 'local-dev' as const }), ...payload.perf }
      : (data.perf ?? null),
  };
}

export function getRevisionOptionsStatus(
  data: Partial<Pick<DiffData, 'revisionOptions' | 'canSwitchRevisions'>>,
): RevisionOptionsStatus {
  if (!data.canSwitchRevisions) return 'loaded';
  return data.revisionOptions?.length ? 'loaded' : 'idle';
}

export function getCompareContextLabels(compareContext: CompareContext, swapped = false) {
  if (compareContext === 'standard_local_compare') {
    const labels = {
      baseTitleKey: 'splitHeaderCompareVersionTitle',
      mineTitleKey: 'splitHeaderWorkingCopyTitle',
      baseStatsKey: 'statsCompareVersion',
      mineStatsKey: 'statsWorkingCopy',
    } as const;
    return swapped
      ? {
          baseTitleKey: labels.mineTitleKey,
          mineTitleKey: labels.baseTitleKey,
          baseStatsKey: labels.mineStatsKey,
          mineStatsKey: labels.baseStatsKey,
        } as const
      : labels;
  }
  if (compareContext === 'revision_vs_revision_compare' || compareContext === 'git_compare') {
    return {
      baseTitleKey: 'splitHeaderLeftVersionTitle',
      mineTitleKey: 'splitHeaderRightVersionTitle',
      baseStatsKey: 'statsLeftVersion',
      mineStatsKey: 'statsRightVersion',
    } as const;
  }
  return {
    baseTitleKey: 'splitHeaderLeftFileTitle',
    mineTitleKey: 'splitHeaderRightFileTitle',
    baseStatsKey: 'statsLeftFile',
    mineStatsKey: 'statsRightFile',
  } as const;
}

export function mergeRevisionOptions(current: SvnRevisionInfo[], incoming: SvnRevisionInfo[]): SvnRevisionInfo[] {
  const nextById = new Map<string, SvnRevisionInfo>();
  current.forEach((option) => {
    nextById.set(option.id, option);
  });
  incoming.forEach((option) => {
    nextById.set(option.id, option);
  });

  const ordered: SvnRevisionInfo[] = [];
  const seen = new Set<string>();
  [...current, ...incoming].forEach((option) => {
    if (seen.has(option.id)) return;
    const latest = nextById.get(option.id);
    if (!latest) return;
    seen.add(option.id);
    ordered.push(latest);
  });
  return ordered;
}
