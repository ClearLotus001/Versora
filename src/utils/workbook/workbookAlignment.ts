import type { WorkbookCompareMode } from '@/types';
import type { WorkbookRowDisplayLine } from '@/utils/workbook/workbookDisplay';
import { parseWorkbookDisplayLine } from '@/utils/workbook/workbookDisplay';
import { hasWorkbookCellContent, serializeWorkbookCellForMode } from '@/utils/workbook/workbookCellContract';

export interface WorkbookAlignmentEntry<TMeta = unknown> {
  rawLine: string;
  parsed: WorkbookRowDisplayLine;
  signature: string;
  meta: TMeta;
}

export interface WorkbookAlignedEntryPair<TMeta = unknown> {
  base: WorkbookAlignmentEntry<TMeta> | null;
  mine: WorkbookAlignmentEntry<TMeta> | null;
}

interface LCSNode {
  baseIdx: number;
  mineIdx: number;
  prev: LCSNode | null;
}

interface LCSEntry {
  baseIdx: number;
  mineIdx: number;
}

const MAX_WORKBOOK_LCS_CANDIDATE_PAIRS = 4_000_000;
const MAX_WORKBOOK_RUN_ALIGNMENT_CELLS = 250_000;
const MAX_WORKBOOK_SAMPLED_CANDIDATE_PAIRS = 500_000;

interface AlignmentRun {
  signature: string;
  start: number;
  count: number;
}

export function buildWorkbookRowSignature(
  parsed: WorkbookRowDisplayLine,
  compareMode: WorkbookCompareMode = 'strict',
): string {
  const cells = [...parsed.cells];
  while (cells.length > 0) {
    const lastCell = cells[cells.length - 1];
    if (!lastCell || hasWorkbookCellContent(lastCell, compareMode)) break;
    cells.pop();
  }

  return cells
    .map(cell => serializeWorkbookCellForMode(cell, compareMode))
    .join('\t');
}

export function createWorkbookAlignmentEntry<TMeta>(
  rawLine: string,
  meta: TMeta,
  compareMode: WorkbookCompareMode = 'strict',
): WorkbookAlignmentEntry<TMeta> | null {
  const parsed = parseWorkbookDisplayLine(rawLine);
  if (parsed?.kind !== 'row') return null;

  return {
    rawLine,
    parsed,
    signature: buildWorkbookRowSignature(parsed, compareMode),
    meta,
  };
}

function buildRuns<TMeta>(rows: WorkbookAlignmentEntry<TMeta>[]): AlignmentRun[] {
  const runs: AlignmentRun[] = [];
  rows.forEach((row, index) => {
    const previous = runs[runs.length - 1];
    if (previous?.signature === row.signature) previous.count += 1;
    else runs.push({ signature: row.signature, start: index, count: 1 });
  });
  return runs;
}

function commonRunUnitSize(baseRuns: AlignmentRun[], mineRuns: AlignmentRun[]): number {
  let unit = 0;
  for (const runs of [baseRuns, mineRuns]) {
    for (const run of runs) {
      let count = run.count;
      while (count > 0) [unit, count] = [count, unit % count];
      if (unit === 1) return 1;
    }
  }
  return unit;
}

function splitRunUnits(runs: AlignmentRun[], unit: number): AlignmentRun[] {
  const units: AlignmentRun[] = [];
  for (const run of runs) {
    for (let offset = 0; offset < run.count; offset += unit) {
      units.push({ signature: run.signature, start: run.start + offset, count: unit });
    }
  }
  return units;
}

function weightedRunAnchors(baseRuns: AlignmentRun[], mineRuns: AlignmentRun[]): LCSEntry[] {
  const width = mineRuns.length + 1;
  const decisions = new Uint8Array((baseRuns.length + 1) * width);
  let previous = new Float64Array(width);
  let current = new Float64Array(width);
  for (let row = 1; row <= baseRuns.length; row += 1) {
    current[0] = 0;
    const base = baseRuns[row - 1]!;
    for (let column = 1; column <= mineRuns.length; column += 1) {
      const mine = mineRuns[column - 1]!;
      let score = previous[column]!;
      let direction = 1;
      if (current[column - 1]! > score) {
        score = current[column - 1]!;
        direction = 0;
      }
      if (base.signature === mine.signature) {
        const matchScore = previous[column - 1]! + Math.min(base.count, mine.count);
        if (matchScore >= score) {
          score = matchScore;
          direction = 2;
        }
      }
      current[column] = score;
      decisions[row * width + column] = direction;
    }
    [previous, current] = [current, previous];
  }

  const pairs: Array<{ base: AlignmentRun; mine: AlignmentRun }> = [];
  let row = baseRuns.length;
  let column = mineRuns.length;
  while (row > 0 && column > 0) {
    const direction = decisions[row * width + column];
    if (direction === 2) {
      pairs.push({ base: baseRuns[--row]!, mine: mineRuns[--column]! });
    } else if (direction === 1) row -= 1;
    else column -= 1;
  }
  const anchors: LCSEntry[] = [];
  for (const pair of pairs.reverse()) {
    const count = Math.min(pair.base.count, pair.mine.count);
    for (let offset = 0; offset < count; offset += 1) {
      anchors.push({ baseIdx: pair.base.start + offset, mineIdx: pair.mine.start + offset });
    }
  }
  return anchors;
}

function patienceAnchors<TMeta>(
  baseRows: WorkbookAlignmentEntry<TMeta>[],
  getPositions: (baseIndex: number, signature: string) => readonly number[] | undefined,
): LCSEntry[] {

  const piles: LCSNode[] = [];
  const tails: number[] = [];

  for (let baseIdx = 0; baseIdx < baseRows.length; baseIdx += 1) {
    const positions = getPositions(baseIdx, baseRows[baseIdx]!.signature);
    if (!positions) continue;

    // Iterate matching mine positions in reverse order.
    // This is the standard Hunt–Szymanski / patience-LCS trick that prevents
    // one base row from being chained against multiple duplicate mine rows
    // (for example many consecutive blank workbook rows).
    for (let positionIndex = positions.length - 1; positionIndex >= 0; positionIndex -= 1) {
      const mineIdx = positions[positionIndex]!;
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((tails[mid] ?? 0) < mineIdx) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && (tails[lo - 1] ?? 0) >= mineIdx) continue;

      const node: LCSNode = {
        baseIdx,
        mineIdx,
        prev: lo > 0 ? (piles[lo - 1] ?? null) : null,
      };
      piles[lo] = node;
      tails[lo] = mineIdx;
    }
  }

  const result: LCSEntry[] = [];
  let node: LCSNode | null = piles[piles.length - 1] ?? null;
  while (node) {
    result.push({ baseIdx: node.baseIdx, mineIdx: node.mineIdx });
    node = node.prev;
  }
  return result.reverse();
}

function sampledAnchors<TMeta>(
  baseRows: WorkbookAlignmentEntry<TMeta>[],
  mineIndex: ReadonlyMap<string, readonly number[]>,
  mineCount: number,
): LCSEntry[] {
  const baseCounts = new Map<string, number>();
  baseRows.forEach((row) => baseCounts.set(row.signature, (baseCounts.get(row.signature) ?? 0) + 1));
  const occurrences = new Map<string, number>();
  const quota = Math.max(1, Math.min(16, Math.floor(MAX_WORKBOOK_SAMPLED_CANDIDATE_PAIRS / baseRows.length)));
  return patienceAnchors(baseRows, (baseIndex, signature) => {
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    const positions = mineIndex.get(signature);
    if (!positions || positions.length <= quota) return positions;

    const occurrenceCenter = Math.floor(occurrence * positions.length / baseCounts.get(signature)!);
    const expectedPosition = baseIndex * mineCount / baseRows.length;
    let low = 0;
    let high = positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions[middle]! < expectedPosition) low = middle + 1;
      else high = middle;
    }
    const positionCenter = Math.min(low, positions.length - 1);
    const selected = new Set<number>();
    const select = (index: number) => {
      if (index >= 0 && index < positions.length && selected.size < quota) selected.add(index);
    };
    select(occurrenceCenter);
    select(positionCenter);
    select(0);
    select(positions.length - 1);
    for (let distance = 1; distance <= quota && selected.size < quota; distance += 1) {
      select(occurrenceCenter - distance);
      select(occurrenceCenter + distance);
      select(positionCenter - distance);
      select(positionCenter + distance);
    }
    return [...selected].sort((left, right) => left - right).map((index) => positions[index]!);
  });
}

function patienceMiddleLCS<TMeta>(
  baseRows: WorkbookAlignmentEntry<TMeta>[],
  mineRows: WorkbookAlignmentEntry<TMeta>[],
): LCSEntry[] {
  if (baseRows.length === 0 || mineRows.length === 0) return [];

  const mineIndex = new Map<string, number[]>();
  mineRows.forEach((row, index) => {
    const existing = mineIndex.get(row.signature);
    if (existing) existing.push(index);
    else mineIndex.set(row.signature, [index]);
  });

  let candidatePairs = 0;
  for (const row of baseRows) {
    candidatePairs += mineIndex.get(row.signature)?.length ?? 0;
    if (candidatePairs > MAX_WORKBOOK_LCS_CANDIDATE_PAIRS) {
      // Strong contiguous matches survive repeated-row ambiguity. Run weights
      // count actual equal rows, rather than treating a long block as one row.
      // If runs are numerous, retain bounded candidate neighborhoods and let
      // patience-LCS choose a monotonic sequence instead of taking early matches.
      const baseRuns = buildRuns(baseRows);
      const mineRuns = buildRuns(mineRows);
      const unit = commonRunUnitSize(baseRuns, mineRuns);
      if (unit > 1 && (baseRows.length / unit) * (mineRows.length / unit) <= MAX_WORKBOOK_RUN_ALIGNMENT_CELLS) {
        // Equal-size units allow one source run to match several destination
        // runs and preserve the exact LCS of uniformly expanded row blocks.
        return weightedRunAnchors(splitRunUnits(baseRuns, unit), splitRunUnits(mineRuns, unit));
      }
      if (baseRuns.length * mineRuns.length <= MAX_WORKBOOK_RUN_ALIGNMENT_CELLS) {
        const weighted = weightedRunAnchors(baseRuns, mineRuns);
        if (weighted.length === Math.min(baseRows.length, mineRows.length)) return weighted;
        // A long run can be split by inserted rows on the other side. Sampled
        // row anchors can reuse its remaining rows across several run matches.
        const sampled = sampledAnchors(baseRows, mineIndex, mineRows.length);
        return sampled.length > weighted.length ? sampled : weighted;
      }
      return sampledAnchors(baseRows, mineIndex, mineRows.length);
    }
  }
  return patienceAnchors(baseRows, (_baseIndex, signature) => mineIndex.get(signature));
}

function patienceLCS<TMeta>(
  baseRows: WorkbookAlignmentEntry<TMeta>[],
  mineRows: WorkbookAlignmentEntry<TMeta>[],
): LCSEntry[] {
  const sharedLimit = Math.min(baseRows.length, mineRows.length);
  let prefix = 0;
  while (prefix < sharedLimit && baseRows[prefix]!.signature === mineRows[prefix]!.signature) prefix += 1;
  let suffix = 0;
  while (
    suffix < sharedLimit - prefix
    && baseRows[baseRows.length - 1 - suffix]!.signature === mineRows[mineRows.length - 1 - suffix]!.signature
  ) suffix += 1;

  const result: LCSEntry[] = [];
  for (let index = 0; index < prefix; index += 1) result.push({ baseIdx: index, mineIdx: index });
  const middle = patienceMiddleLCS(
    baseRows.slice(prefix, baseRows.length - suffix),
    mineRows.slice(prefix, mineRows.length - suffix),
  );
  for (const anchor of middle) {
    result.push({ baseIdx: anchor.baseIdx + prefix, mineIdx: anchor.mineIdx + prefix });
  }
  for (let index = suffix; index > 0; index -= 1) {
    result.push({ baseIdx: baseRows.length - index, mineIdx: mineRows.length - index });
  }
  return result;
}

export function alignWorkbookEntries<TMeta>(
  baseRows: WorkbookAlignmentEntry<TMeta>[],
  mineRows: WorkbookAlignmentEntry<TMeta>[],
): WorkbookAlignedEntryPair<TMeta>[] {
  const anchors = patienceLCS(baseRows, mineRows);
  const result: WorkbookAlignedEntryPair<TMeta>[] = [];
  let baseIdx = 0;
  let mineIdx = 0;

  const emitUnmatched = (baseEnd: number, mineEnd: number) => {
    const unmatchedCount = Math.max(baseEnd - baseIdx, mineEnd - mineIdx);
    for (let offset = 0; offset < unmatchedCount; offset += 1) {
      result.push({
        base: baseIdx + offset < baseEnd ? (baseRows[baseIdx + offset] ?? null) : null,
        mine: mineIdx + offset < mineEnd ? (mineRows[mineIdx + offset] ?? null) : null,
      });
    }
    baseIdx = baseEnd;
    mineIdx = mineEnd;
  };

  anchors.forEach((anchor) => {
    emitUnmatched(anchor.baseIdx, anchor.mineIdx);
    result.push({
      base: baseRows[anchor.baseIdx] ?? null,
      mine: mineRows[anchor.mineIdx] ?? null,
    });
    baseIdx = anchor.baseIdx + 1;
    mineIdx = anchor.mineIdx + 1;
  });

  emitUnmatched(baseRows.length, mineRows.length);
  return result;
}
