import type {
  DiffLine,
  PreparedTextAnalysis,
  SplitRowDescriptor,
  SplitRow,
  TextReplacementPair,
  TextDiffStats,
} from '@/types';
import { alignTextChangeBlock } from '@/engine/text/textChangeAlignment';

const preparedAnalysisCache = new WeakMap<DiffLine[], PreparedTextAnalysis>();
const reboundAnalysisCache = new WeakMap<PreparedTextAnalysis, WeakMap<DiffLine[], PreparedTextAnalysis>>();
const splitRowsDescriptorCache = new WeakMap<
  readonly SplitRowDescriptor[],
  WeakMap<DiffLine[], SplitRow[]>
>();

function buildStatsAndDescriptors(diffLines: DiffLine[]): {
  stats: TextDiffStats;
  replacementPairs: TextReplacementPair[];
  splitRowDescriptors: SplitRowDescriptor[];
} {
  const stats: TextDiffStats = { add: 0, del: 0, chg: 0 };
  const replacementPairs: TextReplacementPair[] = [];
  const splitRowDescriptors: SplitRowDescriptor[] = [];
  let index = 0;

  while (index < diffLines.length) {
    if (diffLines[index]!.type === 'equal') {
      splitRowDescriptors.push({
        leftLineIdx: index,
        rightLineIdx: index,
        lineIdx: index,
        lineIdxs: [index],
      });
      index += 1;
      continue;
    }

    const deleteStart = index;
    while (index < diffLines.length && diffLines[index]!.type === 'delete') {
      index += 1;
    }
    const addStart = index;
    while (index < diffLines.length && diffLines[index]!.type === 'add') {
      index += 1;
    }

    const deleteLines = diffLines.slice(deleteStart, addStart);
    const addLines = diffLines.slice(addStart, index);
    const pairs = alignTextChangeBlock(
      deleteLines.map((line) => line.base ?? ''),
      addLines.map((line) => line.mine ?? ''),
    );

    pairs.forEach((pair) => {
      if (pair.isReplacement && pair.deleteIndex != null && pair.addIndex != null) {
        const leftLineIdx = deleteStart + pair.deleteIndex;
        const rightLineIdx = addStart + pair.addIndex;
        replacementPairs.push(
          { lineIdx: leftLineIdx, pairedLineIdx: rightLineIdx },
          { lineIdx: rightLineIdx, pairedLineIdx: leftLineIdx },
        );
        stats.chg += 1;
      } else {
        if (pair.deleteIndex != null) stats.del += 1;
        if (pair.addIndex != null) stats.add += 1;
      }

      const leftLineIdx = pair.deleteIndex != null ? deleteStart + pair.deleteIndex : null;
      const rightLineIdx = pair.addIndex != null ? addStart + pair.addIndex : null;
      const lineIdxs = [leftLineIdx, rightLineIdx].filter((value): value is number => value != null);
      splitRowDescriptors.push({
        leftLineIdx,
        rightLineIdx,
        lineIdx: lineIdxs[0] ?? deleteStart,
        lineIdxs,
        ...(pair.isReplacement ? { isReplacementPair: true } : {}),
      });
    });
  }

  return {
    stats,
    replacementPairs,
    splitRowDescriptors,
  };
}

export function prepareTextDiffAnalysisFromDiffLines(diffLines: DiffLine[]): PreparedTextAnalysis {
  const cached = preparedAnalysisCache.get(diffLines);
  if (cached) return cached;

  const next = {
    diffLines,
    ...buildStatsAndDescriptors(diffLines),
    perf: null,
  } satisfies PreparedTextAnalysis;
  preparedAnalysisCache.set(diffLines, next);
  return next;
}

export function resolvePreparedTextAnalysisForDiffLines(
  analysis: PreparedTextAnalysis,
  diffLines: DiffLine[],
): PreparedTextAnalysis {
  if (analysis.diffLines.length > 0 && analysis.splitRowDescriptors.length === 0) {
    return prepareTextDiffAnalysisFromDiffLines(diffLines);
  }
  if (analysis.diffLines === diffLines) return analysis;

  let byDiffLines = reboundAnalysisCache.get(analysis);
  if (!byDiffLines) {
    byDiffLines = new WeakMap<DiffLine[], PreparedTextAnalysis>();
    reboundAnalysisCache.set(analysis, byDiffLines);
  }
  const cached = byDiffLines.get(diffLines);
  if (cached) return cached;

  let canReuseAlignment = analysis.diffLines.length === diffLines.length;
  for (let index = 0; canReuseAlignment && index < diffLines.length; index += 1) {
    const source = analysis.diffLines[index]!;
    const current = diffLines[index]!;
    canReuseAlignment = source.type === current.type
      && source.base === current.base
      && source.mine === current.mine
      && source.baseLineNo === current.baseLineNo
      && source.mineLineNo === current.mineLineNo;
  }

  // Attribution and other line metadata can arrive after the prepared snapshot.
  // Rebind the lines without repeating alignment, but rebuild if their content changed.
  const next = canReuseAlignment
    ? { ...analysis, diffLines }
    : prepareTextDiffAnalysisFromDiffLines(diffLines);
  byDiffLines.set(diffLines, next);
  return next;
}


export function buildReplacementPairIndexFromPairs(
  replacementPairs: readonly TextReplacementPair[],
): Map<number, number> {
  const next = new Map<number, number>();
  replacementPairs.forEach((pair) => {
    next.set(pair.lineIdx, pair.pairedLineIdx);
  });
  return next;
}

export function materializeSplitRowsFromDescriptors(
  diffLines: DiffLine[],
  splitRowDescriptors: readonly SplitRowDescriptor[],
): SplitRow[] {
  let rowsByDiffLines = splitRowsDescriptorCache.get(splitRowDescriptors);
  if (!rowsByDiffLines) {
    rowsByDiffLines = new WeakMap<DiffLine[], SplitRow[]>();
    splitRowsDescriptorCache.set(splitRowDescriptors, rowsByDiffLines);
  }
  const cached = rowsByDiffLines.get(diffLines);
  if (cached) return cached;

  const rows = splitRowDescriptors.map<SplitRow>((descriptor) => ({
    left: descriptor.leftLineIdx != null ? (diffLines[descriptor.leftLineIdx] ?? null) : null,
    right: descriptor.rightLineIdx != null ? (diffLines[descriptor.rightLineIdx] ?? null) : null,
    lineIdx: descriptor.lineIdx,
    lineIdxs: descriptor.lineIdxs,
    ...(descriptor.isReplacementPair ? { isReplacementPair: true } : {}),
  }));
  rowsByDiffLines.set(diffLines, rows);
  return rows;
}
