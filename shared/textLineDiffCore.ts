function splitTextLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '' || lines[lines.length - 1] === '\r') lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

import { createTextCharDiffBudget, type TextCharDiffBudget } from './textDiffBudget';

const MAX_LINES_FOR_DIFF = 50_000;
const MAX_LCS_CANDIDATE_PAIRS = 4_000_000;

interface LcsNode { baseIndex: number; mineIndex: number; previous: LcsNode | null }
export interface TextLineAnchor { baseIndex: number; mineIndex: number }
export type TextLineChangeContext = 'standard' | 'fallback';

export interface TextLineDiffSink {
  appendEqual(
    baseLine: string,
    mineLine: string,
    baseLineNumber: number,
    mineLineNumber: number,
  ): void;
  appendChangeBlock(
    deletedLines: string[],
    addedLines: string[],
    baseOffset: number,
    mineOffset: number,
    charDiffBudget: TextCharDiffBudget,
    context: TextLineChangeContext,
  ): void;
}

function appendEqualLines(
  sink: TextLineDiffSink,
  baseLines: readonly string[],
  mineLines: readonly string[],
  baseStart: number,
  mineStart: number,
  count: number,
): void {
  for (let index = 0; index < count; index += 1) {
    const baseIndex = baseStart + index;
    const mineIndex = mineStart + index;
    sink.appendEqual(baseLines[baseIndex]!, mineLines[mineIndex]!, baseIndex + 1, mineIndex + 1);
  }
}

function patienceLcs(baseLines: string[], mineLines: string[]): TextLineAnchor[] {
  if (baseLines.length === 0 || mineLines.length === 0) return [];
  const minePositions = new Map<string, number[]>();
  mineLines.forEach((line, index) => {
    const positions = minePositions.get(line);
    if (positions) positions.push(index);
    else minePositions.set(line, [index]);
  });
  const piles: LcsNode[] = [];
  const tails: number[] = [];
  for (let baseIndex = 0; baseIndex < baseLines.length; baseIndex += 1) {
    const positions = minePositions.get(baseLines[baseIndex]!);
    if (!positions) continue;
    for (let positionIndex = positions.length - 1; positionIndex >= 0; positionIndex -= 1) {
      const mineIndex = positions[positionIndex]!;
      let low = 0;
      let high = tails.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if ((tails[middle] ?? 0) < mineIndex) low = middle + 1;
        else high = middle;
      }
      if (low > 0 && (tails[low - 1] ?? 0) >= mineIndex) continue;
      piles[low] = {
        baseIndex,
        mineIndex,
        previous: low > 0 ? (piles[low - 1] ?? null) : null,
      };
      tails[low] = mineIndex;
    }
  }
  const anchors: TextLineAnchor[] = [];
  let node: LcsNode | null = piles[piles.length - 1] ?? null;
  while (node) {
    anchors.push({ baseIndex: node.baseIndex, mineIndex: node.mineIndex });
    node = node.previous;
  }
  return anchors.reverse();
}

function exceedsCandidateBudget(baseLines: string[], mineLines: string[]): boolean {
  if (baseLines.length === 0 || mineLines.length === 0) return false;
  const [countSource, probeSource] = baseLines.length <= mineLines.length
    ? [baseLines, mineLines]
    : [mineLines, baseLines];
  const counts = new Map<string, number>();
  countSource.forEach((line) => counts.set(line, (counts.get(line) ?? 0) + 1));
  let candidatePairs = 0;
  for (const line of probeSource) {
    candidatePairs += counts.get(line) ?? 0;
    if (candidatePairs > MAX_LCS_CANDIDATE_PAIRS) return true;
  }
  return false;
}

function longestIncreasingAnchors(candidates: TextLineAnchor[]): TextLineAnchor[] {
  if (candidates.length === 0) return [];
  const piles: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    let low = 0;
    let high = piles.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (candidates[piles[middle]!]!.mineIndex < candidate.mineIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = piles[low - 1]!;
    piles[low] = index;
  }
  const result: TextLineAnchor[] = [];
  let current = piles[piles.length - 1] ?? -1;
  while (current >= 0) {
    result.push(candidates[current]!);
    current = previous[current]!;
  }
  return result.reverse();
}

function findUniqueAnchors(baseLines: string[], mineLines: string[]): TextLineAnchor[] {
  const baseCounts = new Map<string, number>();
  const mineCounts = new Map<string, number>();
  baseLines.forEach((line) => baseCounts.set(line, (baseCounts.get(line) ?? 0) + 1));
  mineLines.forEach((line) => mineCounts.set(line, (mineCounts.get(line) ?? 0) + 1));
  const minePositions = new Map<string, number>();
  mineLines.forEach((line, index) => { if (mineCounts.get(line) === 1) minePositions.set(line, index); });
  const candidates: TextLineAnchor[] = [];
  baseLines.forEach((line, index) => {
    if (baseCounts.get(line) !== 1 || mineCounts.get(line) !== 1) return;
    const mineIndex = minePositions.get(line);
    if (mineIndex != null) candidates.push({ baseIndex: index, mineIndex });
  });
  return longestIncreasingAnchors(candidates);
}

function appendAnchoredReplacement(
  sink: TextLineDiffSink,
  baseLines: string[],
  mineLines: string[],
  budget: TextCharDiffBudget,
  baseOffset: number,
  mineOffset: number,
): void {
  const sharedLimit = Math.min(baseLines.length, mineLines.length);
  let prefix = 0;
  while (prefix < sharedLimit && baseLines[prefix] === mineLines[prefix]) {
    sink.appendEqual(baseLines[prefix]!, mineLines[prefix]!, baseOffset + prefix + 1, mineOffset + prefix + 1);
    prefix += 1;
  }
  let baseEnd = baseLines.length - 1;
  let mineEnd = mineLines.length - 1;
  while (baseEnd >= prefix && mineEnd >= prefix && baseLines[baseEnd] === mineLines[mineEnd]) {
    baseEnd -= 1;
    mineEnd -= 1;
  }
  sink.appendChangeBlock(
    prefix <= baseEnd ? baseLines.slice(prefix, baseEnd + 1) : [],
    prefix <= mineEnd ? mineLines.slice(prefix, mineEnd + 1) : [],
    baseOffset + prefix,
    mineOffset + prefix,
    budget,
    'fallback',
  );
  const suffixCount = baseLines.length - 1 - baseEnd;
  appendEqualLines(sink, baseLines, mineLines, baseEnd + 1, mineEnd + 1, suffixCount);
}

function appendFallback(
  sink: TextLineDiffSink,
  baseLines: string[],
  mineLines: string[],
  budget: TextCharDiffBudget,
  baseOffset: number,
  mineOffset: number,
): void {
  const anchors = findUniqueAnchors(baseLines, mineLines);
  if (anchors.length === 0) {
    appendAnchoredReplacement(sink, baseLines, mineLines, budget, baseOffset, mineOffset);
    return;
  }
  let baseStart = 0;
  let mineStart = 0;
  for (const anchor of anchors) {
    appendAnchoredReplacement(
      sink,
      baseLines.slice(baseStart, anchor.baseIndex),
      mineLines.slice(mineStart, anchor.mineIndex),
      budget,
      baseOffset + baseStart,
      mineOffset + mineStart,
    );
    sink.appendEqual(
      baseLines[anchor.baseIndex]!,
      mineLines[anchor.mineIndex]!,
      baseOffset + anchor.baseIndex + 1,
      mineOffset + anchor.mineIndex + 1,
    );
    baseStart = anchor.baseIndex + 1;
    mineStart = anchor.mineIndex + 1;
  }
  appendAnchoredReplacement(
    sink,
    baseLines.slice(baseStart),
    mineLines.slice(mineStart),
    budget,
    baseOffset + baseStart,
    mineOffset + mineStart,
  );
}

function appendMiddle(
  sink: TextLineDiffSink,
  baseLines: string[],
  mineLines: string[],
  budget: TextCharDiffBudget,
  baseOffset: number,
  mineOffset: number,
): void {
  if (baseLines.length > MAX_LINES_FOR_DIFF || mineLines.length > MAX_LINES_FOR_DIFF || exceedsCandidateBudget(baseLines, mineLines)) {
    appendFallback(sink, baseLines, mineLines, budget, baseOffset, mineOffset);
    return;
  }
  const anchors = patienceLcs(baseLines, mineLines);
  let baseIndex = 0;
  let mineIndex = 0;
  let anchorIndex = 0;
  while (baseIndex < baseLines.length || mineIndex < mineLines.length) {
    const anchor = anchors[anchorIndex] ?? null;
    if (anchor && baseIndex === anchor.baseIndex && mineIndex === anchor.mineIndex) {
      sink.appendEqual(baseLines[baseIndex]!, mineLines[mineIndex]!, baseOffset + baseIndex + 1, mineOffset + mineIndex + 1);
      baseIndex += 1;
      mineIndex += 1;
      anchorIndex += 1;
      continue;
    }
    const baseEnd = Math.max(baseIndex, anchor?.baseIndex ?? baseLines.length);
    const mineEnd = Math.max(mineIndex, anchor?.mineIndex ?? mineLines.length);
    sink.appendChangeBlock(
      baseLines.slice(baseIndex, baseEnd),
      mineLines.slice(mineIndex, mineEnd),
      baseOffset + baseIndex,
      mineOffset + mineIndex,
      budget,
      'standard',
    );
    baseIndex = baseEnd;
    mineIndex = mineEnd;
  }
}

export function buildTextLineDiff(baseText: string, mineText: string, sink: TextLineDiffSink): void {
  const baseLines = splitTextLines(baseText);
  const mineLines = baseText === mineText ? baseLines : splitTextLines(mineText);
  if (baseText === mineText) {
    appendEqualLines(sink, baseLines, mineLines, 0, 0, baseLines.length);
    return;
  }
  const budget = createTextCharDiffBudget();
  const sharedLimit = Math.min(baseLines.length, mineLines.length);
  let prefix = 0;
  while (prefix < sharedLimit && baseLines[prefix] === mineLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < sharedLimit - prefix
    && baseLines[baseLines.length - 1 - suffix] === mineLines[mineLines.length - 1 - suffix]
  ) suffix += 1;
  appendEqualLines(sink, baseLines, mineLines, 0, 0, prefix);
  appendMiddle(
    sink,
    baseLines.slice(prefix, baseLines.length - suffix),
    mineLines.slice(prefix, mineLines.length - suffix),
    budget,
    prefix,
    prefix,
  );
  appendEqualLines(
    sink,
    baseLines,
    mineLines,
    baseLines.length - suffix,
    mineLines.length - suffix,
    suffix,
  );
}
