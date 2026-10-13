import type {
  DiffAnalysisSnapshot,
  DiffData,
  DiffLine,
  PreparedTextAnalysis,
  RevisionSelectionPair,
  WorkbookArtifactDiff,
  WorkbookCompareMode,
} from '@/types';

function swapOptionalProperty<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K],
) {
  if (value === undefined) {
    delete target[key];
    return;
  }
  target[key] = value;
}

function swapDiffLineSides(line: DiffLine): DiffLine {
  const next: DiffLine = {
    ...line,
    type: line.type === 'add' ? 'delete' : line.type === 'delete' ? 'add' : 'equal',
    base: line.mine,
    mine: line.base,
    baseLineNo: line.mineLineNo,
    mineLineNo: line.baseLineNo,
    baseCharSpans: line.mineCharSpans,
    mineCharSpans: line.baseCharSpans,
  };
  swapOptionalProperty(next, 'baseBlame', line.mineBlame);
  swapOptionalProperty(next, 'mineBlame', line.baseBlame);
  return next;
}

interface SwappedDiffLinesResult {
  lines: DiffLine[];
  originalToSwappedIndex: Int32Array;
}

function swapDiffLinesWithIndexMap(lines: readonly DiffLine[]): SwappedDiffLinesResult {
  const swapped: DiffLine[] = [];
  const originalToSwappedIndex = new Int32Array(lines.length);
  originalToSwappedIndex.fill(-1);
  let index = 0;
  const appendSwappedLine = (sourceIndex: number) => {
    originalToSwappedIndex[sourceIndex] = swapped.length;
    swapped.push(swapDiffLineSides(lines[sourceIndex]!));
  };

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.type === 'equal') {
      appendSwappedLine(index);
      index += 1;
      continue;
    }

    const blockStart = index;
    while (index < lines.length && lines[index]!.type !== 'equal') {
      index += 1;
    }

    // Canonical diff blocks are delete-then-add. After exchanging the sides,
    // old additions become the new deletions and must lead the block.
    for (let sourceIndex = blockStart; sourceIndex < index; sourceIndex += 1) {
      if (lines[sourceIndex]!.type === 'add') appendSwappedLine(sourceIndex);
    }
    for (let sourceIndex = blockStart; sourceIndex < index; sourceIndex += 1) {
      if (lines[sourceIndex]!.type === 'delete') appendSwappedLine(sourceIndex);
    }
  }

  return { lines: swapped, originalToSwappedIndex };
}

export function swapDiffLinesSides(lines: readonly DiffLine[]): DiffLine[] {
  return swapDiffLinesWithIndexMap(lines).lines;
}

function remapLineIndex(indexMap: Int32Array, lineIdx: number | null) {
  if (lineIdx == null) return null;
  const mapped = indexMap[lineIdx] ?? -1;
  return mapped >= 0 ? mapped : null;
}

function swapPreparedTextAnalysis(analysis: PreparedTextAnalysis): PreparedTextAnalysis {
  const swapped = swapDiffLinesWithIndexMap(analysis.diffLines);
  const replacementPairs = analysis.replacementPairs
    .map((pair) => ({
      lineIdx: remapLineIndex(swapped.originalToSwappedIndex, pair.lineIdx),
      pairedLineIdx: remapLineIndex(swapped.originalToSwappedIndex, pair.pairedLineIdx),
    }))
    .filter((pair): pair is { lineIdx: number; pairedLineIdx: number } => (
      pair.lineIdx != null && pair.pairedLineIdx != null
    ))
    .sort((left, right) => left.lineIdx - right.lineIdx);
  const splitRowDescriptors = analysis.splitRowDescriptors.map((descriptor) => {
    const lineIdxs = descriptor.lineIdxs
      .map((lineIdx) => remapLineIndex(swapped.originalToSwappedIndex, lineIdx))
      .filter((lineIdx): lineIdx is number => lineIdx != null)
      .sort((left, right) => left - right);
    return {
      leftLineIdx: remapLineIndex(swapped.originalToSwappedIndex, descriptor.rightLineIdx),
      rightLineIdx: remapLineIndex(swapped.originalToSwappedIndex, descriptor.leftLineIdx),
      lineIdx: lineIdxs[0] ?? 0,
      lineIdxs,
      ...(descriptor.isReplacementPair ? { isReplacementPair: true } : {}),
    };
  });

  return {
    diffLines: swapped.lines,
    stats: {
      add: analysis.stats.del,
      del: analysis.stats.add,
      chg: analysis.stats.chg,
    },
    replacementPairs,
    splitRowDescriptors,
    perf: analysis.perf ?? null,
  };
}

function swapRevisionPair(pair: RevisionSelectionPair | null | undefined) {
  if (!pair) return pair;
  return {
    baseRevisionId: pair.mineRevisionId,
    mineRevisionId: pair.baseRevisionId,
  } satisfies RevisionSelectionPair;
}

function swapArtifactDiff(diff: WorkbookArtifactDiff | null | undefined) {
  if (!diff) return diff;
  return {
    ...diff,
    baseBytes: diff.mineBytes,
    mineBytes: diff.baseBytes,
  } satisfies WorkbookArtifactDiff;
}

function swapAnalysisSnapshot(snapshot: DiffAnalysisSnapshot): DiffAnalysisSnapshot {
  return {
    ...snapshot,
    textAnalysis: snapshot.textAnalysis
      ? swapPreparedTextAnalysis(snapshot.textAnalysis)
      : null,
  };
}

export function swapDiffDataSides(data: DiffData): DiffData {
  if (data.workbookArtifact) throw new Error('Workbook sides must be swapped by preparing a new artifact.');
  const next: DiffData = {
    ...data,
    isSideOrderSwapped: !data.isSideOrderSwapped,
    baseName: data.mineName,
    mineName: data.baseName,
    baseContent: data.mineContent,
    mineContent: data.baseContent,
  };

  const swappedSnapshots = data.analysisSnapshotsByMode
    ? (Object.entries(data.analysisSnapshotsByMode) as Array<[
        WorkbookCompareMode,
        DiffAnalysisSnapshot | null,
      ]>).reduce<NonNullable<DiffData['analysisSnapshotsByMode']>>((snapshots, [mode, snapshot]) => {
        snapshots[mode] = snapshot ? swapAnalysisSnapshot(snapshot) : null;
        return snapshots;
      }, {})
    : data.analysisSnapshotsByMode;
  swapOptionalProperty(next, 'analysisSnapshotsByMode', swappedSnapshots);

  swapOptionalProperty(next, 'basePath', data.minePath);
  swapOptionalProperty(next, 'minePath', data.basePath);
  swapOptionalProperty(next, 'launchBaseName', data.launchMineName);
  swapOptionalProperty(next, 'launchMineName', data.launchBaseName);
  swapOptionalProperty(next, 'baseWorkbookMetadata', data.mineWorkbookMetadata);
  swapOptionalProperty(next, 'mineWorkbookMetadata', data.baseWorkbookMetadata);
  swapOptionalProperty(next, 'baseRevisionInfo', data.mineRevisionInfo);
  swapOptionalProperty(next, 'mineRevisionInfo', data.baseRevisionInfo);
  swapOptionalProperty(next, 'initialPair', swapRevisionPair(data.initialPair));
  swapOptionalProperty(next, 'resetPair', swapRevisionPair(data.resetPair));
  swapOptionalProperty(next, 'workbookArtifactDiff', swapArtifactDiff(data.workbookArtifactDiff));

  if (data.revisionSwitchableSides) {
    next.revisionSwitchableSides = {
      base: data.revisionSwitchableSides.mine,
      mine: data.revisionSwitchableSides.base,
    };
  } else {
    delete next.revisionSwitchableSides;
  }

  if (data.source) {
    const swappedSource = { ...data.source };
    swapOptionalProperty(swappedSource, 'baseKind', data.source.targetKind);
    swapOptionalProperty(swappedSource, 'targetKind', data.source.baseKind);
    swapOptionalProperty(swappedSource, 'baseVersion', data.source.targetVersion);
    swapOptionalProperty(swappedSource, 'targetVersion', data.source.baseVersion);
    next.source = swappedSource;
  }

  return next;
}
