import type { DiffData, WorkbookCompareMode } from '@/types';

export function buildDiffSessionKey(data: DiffData): string {
  const sourceIdentity = data.sourceIdentity?.trim();
  if (sourceIdentity) {
    return data.isSideOrderSwapped
      ? [sourceIdentity, 'side-order-swapped'].join('::')
      : sourceIdentity;
  }

  return [
    data.fileName,
    data.baseRevisionInfo?.id ?? data.baseName,
    data.mineRevisionInfo?.id ?? data.mineName,
    data.baseContent?.length ?? 0,
    data.mineContent?.length ?? 0,
  ].join('::');
}

export function buildDiffCacheKey(data: DiffData, compareMode: WorkbookCompareMode): string {
  return [compareMode, buildDiffSessionKey(data)].join('::');
}
