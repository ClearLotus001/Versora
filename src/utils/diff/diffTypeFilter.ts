import type {
  DiffLine,
  DiffTypeFilter,
  PreparedTextAnalysis,
  SplitRowDescriptor,
  TextReplacementPair,
  WorkbookRowDelta,
} from '@/types';

export type ConcreteDiffType = Exclude<DiffTypeFilter, 'all'>;

export interface DiffTypeAvailability {
  add: boolean;
  modify: boolean;
  delete: boolean;
}

const EMPTY_DIFF_TYPE_AVAILABILITY: DiffTypeAvailability = {
  add: false,
  modify: false,
  delete: false,
};

type WorkbookRowClassification = Pick<
  WorkbookRowDelta,
  'hasChanges' | 'structuralChange' | 'tone'
>;

export function resolveWorkbookRowDiffType(
  delta: WorkbookRowClassification,
): ConcreteDiffType | null {
  if (delta.structuralChange === 'add') return 'add';
  if (delta.structuralChange === 'delete') return 'delete';
  if (delta.tone === 'add') return 'add';
  if (delta.tone === 'delete') return 'delete';
  return delta.hasChanges ? 'modify' : null;
}

export function getTextDiffTypeAvailability(
  analysis: Pick<PreparedTextAnalysis, 'stats'> | null,
): DiffTypeAvailability {
  if (!analysis) return EMPTY_DIFF_TYPE_AVAILABILITY;
  return {
    add: analysis.stats.add > 0,
    modify: analysis.stats.chg > 0,
    delete: analysis.stats.del > 0,
  };
}

const filteredTextAnalysisCache = new WeakMap<
  DiffLine[],
  Map<ConcreteDiffType, PreparedTextAnalysis>
>();
const replacementLineIndexCache = new WeakMap<DiffLine[], ReadonlySet<number>>();

function getReplacementLineIndexes(analysis: PreparedTextAnalysis) {
  const cached = replacementLineIndexCache.get(analysis.diffLines);
  if (cached) return cached;
  const next = new Set<number>();
  analysis.replacementPairs.forEach((pair) => next.add(pair.lineIdx));
  replacementLineIndexCache.set(analysis.diffLines, next);
  return next;
}

function buildFilteredTextAnalysis(
  analysis: PreparedTextAnalysis,
  filter: DiffTypeFilter,
): PreparedTextAnalysis {
  const replacementLineIndexes = getReplacementLineIndexes(analysis);

  const diffLines: DiffLine[] = [];
  const sourceToFilteredIndex = new Map<number, number>();
  analysis.diffLines.forEach((line, lineIdx) => {
    const replacement = replacementLineIndexes.has(lineIdx);
    if (
      (filter === 'modify' && replacement)
      || (filter === 'add' && line.type === 'add' && !replacement)
      || (filter === 'delete' && line.type === 'delete' && !replacement)
    ) {
      sourceToFilteredIndex.set(lineIdx, diffLines.length);
      diffLines.push(line);
    }
  });

  const replacementPairs = filter === 'modify'
    ? analysis.replacementPairs.reduce<TextReplacementPair[]>((next, pair) => {
        const lineIdx = sourceToFilteredIndex.get(pair.lineIdx);
        const pairedLineIdx = sourceToFilteredIndex.get(pair.pairedLineIdx);
        if (lineIdx != null && pairedLineIdx != null) {
          next.push({ lineIdx, pairedLineIdx });
        }
        return next;
      }, [])
    : [];

  const splitRowDescriptors = analysis.splitRowDescriptors.reduce<SplitRowDescriptor[]>((next, descriptor) => {
    const leftLineIdx = descriptor.leftLineIdx == null
      ? null
      : (sourceToFilteredIndex.get(descriptor.leftLineIdx) ?? null);
    const rightLineIdx = descriptor.rightLineIdx == null
      ? null
      : (sourceToFilteredIndex.get(descriptor.rightLineIdx) ?? null);
    if (leftLineIdx == null && rightLineIdx == null) return next;
    const lineIdxs: number[] = [];
    descriptor.lineIdxs.forEach((lineIdx) => {
      const mapped = sourceToFilteredIndex.get(lineIdx);
      if (mapped != null) lineIdxs.push(mapped);
    });

    next.push({
      leftLineIdx,
      rightLineIdx,
      lineIdx: lineIdxs[0]!,
      lineIdxs,
      ...(descriptor.isReplacementPair ? { isReplacementPair: true } : {}),
    });
    return next;
  }, []);

  return {
    diffLines,
    stats: filter === 'modify'
      ? { add: 0, del: 0, chg: analysis.stats.chg }
      : filter === 'add'
        ? { add: analysis.stats.add, del: 0, chg: 0 }
        : { add: 0, del: analysis.stats.del, chg: 0 },
    replacementPairs,
    splitRowDescriptors,
    perf: analysis.perf ?? null,
  };
}

export function filterTextDiffAnalysis(
  analysis: PreparedTextAnalysis,
  filter: DiffTypeFilter,
): PreparedTextAnalysis {
  if (filter === 'all') return analysis;

  let cacheByFilter = filteredTextAnalysisCache.get(analysis.diffLines);
  if (!cacheByFilter) {
    cacheByFilter = new Map();
    filteredTextAnalysisCache.set(analysis.diffLines, cacheByFilter);
  }
  const cached = cacheByFilter.get(filter);
  if (cached) return cached;

  const next = buildFilteredTextAnalysis(analysis, filter);
  cacheByFilter.set(filter, next);
  return next;
}
