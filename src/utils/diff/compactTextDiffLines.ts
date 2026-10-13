import type { CompactTextDiffLines, DiffData, DiffLine } from '@/types';
import { materializeCompactTextSplitRowDescriptors } from '../../../shared/textSplitRowTransport';

const materializedLineCache = new WeakMap<CompactTextDiffLines, DiffLine[]>();
const materializedDataCache = new WeakMap<DiffData, DiffData>();

function assertSparseEntries(
  entries: ReadonlyArray<readonly [lineIdx: number, ...values: unknown[]]>,
  lineCount: number,
  name: string,
) {
  let previousLineIdx = -1;
  for (const entry of entries) {
    const lineIdx = entry[0];
    if (!Number.isInteger(lineIdx) || lineIdx <= previousLineIdx || lineIdx >= lineCount) {
      throw new Error(`Invalid compact text diff ${name} index.`);
    }
    previousLineIdx = lineIdx;
  }
}

export function materializeCompactTextDiffLines(compact: CompactTextDiffLines): DiffLine[] {
  const cached = materializedLineCache.get(compact);
  if (cached) return cached;

  const lineCount = compact.types.length;
  if (
    compact.version !== 1
    || compact.baseLineNumbers.length !== lineCount
    || compact.mineLineNumbers.length !== lineCount
    || compact.texts.length !== lineCount
  ) {
    throw new Error('Invalid compact text diff column lengths.');
  }
  assertSparseEntries(compact.mineTextOverrides, lineCount, 'override');
  assertSparseEntries(compact.charSpans, lineCount, 'character span');

  const diffLines = new Array<DiffLine>(lineCount);
  let overrideCursor = 0;
  let charSpanCursor = 0;

  for (let lineIdx = 0; lineIdx < lineCount; lineIdx += 1) {
    const text = compact.texts[lineIdx];
    const typeCode = compact.types[lineIdx];
    const baseLineNumber = compact.baseLineNumbers[lineIdx];
    const mineLineNumber = compact.mineLineNumbers[lineIdx];
    if (
      typeof text !== 'string'
      || baseLineNumber == null
      || baseLineNumber < -1
      || mineLineNumber == null
      || mineLineNumber < -1
    ) {
      throw new Error('Invalid compact text diff line value.');
    }

    const override = compact.mineTextOverrides[overrideCursor];
    const mineOverride = override?.[0] === lineIdx ? override[1] : null;
    if (mineOverride !== null) overrideCursor += 1;

    const spanEntry = compact.charSpans[charSpanCursor];
    const hasSpans = spanEntry?.[0] === lineIdx;
    if (hasSpans) charSpanCursor += 1;

    const baseLineNo = baseLineNumber === -1 ? null : baseLineNumber;
    const mineLineNo = mineLineNumber === -1 ? null : mineLineNumber;
    const baseCharSpans = hasSpans ? (spanEntry?.[1] ?? null) : null;
    const mineCharSpans = hasSpans ? (spanEntry?.[2] ?? null) : null;

    if (typeCode === 0) {
      diffLines[lineIdx] = {
        type: 'equal',
        base: text,
        mine: mineOverride ?? text,
        baseLineNo,
        mineLineNo,
        baseCharSpans,
        mineCharSpans,
      };
    } else if (typeCode === 1) {
      if (mineOverride !== null) throw new Error('Invalid compact text diff add override.');
      diffLines[lineIdx] = {
        type: 'add',
        base: null,
        mine: text,
        baseLineNo,
        mineLineNo,
        baseCharSpans,
        mineCharSpans,
      };
    } else if (typeCode === 2) {
      if (mineOverride !== null) throw new Error('Invalid compact text diff delete override.');
      diffLines[lineIdx] = {
        type: 'delete',
        base: text,
        mine: null,
        baseLineNo,
        mineLineNo,
        baseCharSpans,
        mineCharSpans,
      };
    } else {
      throw new Error('Invalid compact text diff type.');
    }
  }

  materializedLineCache.set(compact, diffLines);
  return diffLines;
}

export function getTransportTextDiffLineCount(
  analysis: { diffLines: DiffLine[]; compactDiffLines?: CompactTextDiffLines } | null | undefined,
): number {
  if (!analysis) return 0;
  return Math.max(analysis.diffLines.length, analysis.compactDiffLines?.types.length ?? 0);
}

export function materializeCompactTransportDiffData(data: DiffData): DiffData {
  const cached = materializedDataCache.get(data);
  if (cached) return cached;

  const snapshots = data.analysisSnapshotsByMode;
  if (!snapshots) return data;

  let nextSnapshots = snapshots;
  for (const compareMode of ['strict', 'content'] as const) {
    const snapshot = snapshots[compareMode];
    const textAnalysis = snapshot?.textAnalysis;
    if (!snapshot || !textAnalysis || (!textAnalysis.compactDiffLines && !textAnalysis.compactSplitRowDescriptors)) continue;

    if (nextSnapshots === snapshots) nextSnapshots = { ...snapshots };
    const nextTextAnalysis = {
      ...textAnalysis,
      diffLines: textAnalysis.diffLines.length > 0 || !textAnalysis.compactDiffLines
        ? textAnalysis.diffLines
        : materializeCompactTextDiffLines(textAnalysis.compactDiffLines),
    };
    if (textAnalysis.compactSplitRowDescriptors) {
      nextTextAnalysis.splitRowDescriptors = textAnalysis.splitRowDescriptors.length > 0
        ? textAnalysis.splitRowDescriptors
        : materializeCompactTextSplitRowDescriptors(
            textAnalysis.compactSplitRowDescriptors,
            nextTextAnalysis.diffLines.length,
          );
    }
    delete nextTextAnalysis.compactDiffLines;
    delete nextTextAnalysis.compactSplitRowDescriptors;
    nextSnapshots[compareMode] = {
      ...snapshot,
      textAnalysis: nextTextAnalysis,
    };
  }

  if (nextSnapshots === snapshots) return data;
  const materialized = {
    ...data,
    analysisSnapshotsByMode: nextSnapshots,
  };
  materializedDataCache.set(data, materialized);
  return materialized;
}
