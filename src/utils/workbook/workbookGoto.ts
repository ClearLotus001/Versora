import type {
  DiffLine,
  WorkbookSelectedCell,
} from '@/types';
import type { WorkbookLineSheetContext } from '@/utils/workbook/workbookSections';
import type { WorkbookArtifactDescriptor } from '../../../shared/workbookArtifactProtocol';

interface WorkbookGotoRowCandidate {
  lineIdx: number;
  rowNumber: number;
  side: 'base' | 'mine';
  sheetName: string;
}

export interface ResolveWorkbookGotoTargetParams {
  lineNo: number;
  diffLines: readonly DiffLine[];
  lineSheetContexts: readonly WorkbookLineSheetContext[];
  sheetName: string | null;
  preferredSide?: 'base' | 'mine' | null | undefined;
  preferredColumn?: number | undefined;
  preferredColumnLabel?: string | undefined;
  baseVersionLabel: string;
  mineVersionLabel: string;
  allowedLineIndexes?: ReadonlySet<number> | undefined;
  artifact?: WorkbookArtifactDescriptor | undefined;
}

export interface ResolvedWorkbookGotoTarget {
  lineIdx: number;
  selection: WorkbookSelectedCell;
}

function getWorkbookColumnLabel(index: number): string {
  let value = index + 1;
  let label = '';

  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }

  return label;
}

function getSidePriority(
  side: 'base' | 'mine',
  preferredSide: 'base' | 'mine' | null | undefined,
): number {
  if (preferredSide && side === preferredSide) return 0;
  return side === 'mine' ? 1 : 2;
}

function compareExactCandidates(
  left: WorkbookGotoRowCandidate,
  right: WorkbookGotoRowCandidate,
  preferredSide: 'base' | 'mine' | null | undefined,
): number {
  return getSidePriority(left.side, preferredSide)
    - getSidePriority(right.side, preferredSide)
    || left.lineIdx - right.lineIdx;
}

function compareNearestCandidates(
  left: WorkbookGotoRowCandidate,
  right: WorkbookGotoRowCandidate,
  preferredSide: 'base' | 'mine' | null | undefined,
): number {
  return left.rowNumber - right.rowNumber
    || compareExactCandidates(left, right, preferredSide);
}

function compareLastCandidates(
  left: WorkbookGotoRowCandidate,
  right: WorkbookGotoRowCandidate,
  preferredSide: 'base' | 'mine' | null | undefined,
): number {
  return right.rowNumber - left.rowNumber
    || compareExactCandidates(left, right, preferredSide);
}

export function collectWorkbookGotoRowCandidates(
  diffLines: readonly DiffLine[],
  lineSheetContexts: readonly WorkbookLineSheetContext[],
  sheetName: string | null,
  allowedLineIndexes?: ReadonlySet<number>,
): WorkbookGotoRowCandidate[] {
  if (!sheetName) return [];

  const candidates: WorkbookGotoRowCandidate[] = [];
  diffLines.forEach((line, lineIdx) => {
    if (allowedLineIndexes && !allowedLineIndexes.has(lineIdx)) return;
    const context = lineSheetContexts[lineIdx] ?? null;
    if (!context) return;

    if (line.baseLineNo != null && context.baseSheetName === sheetName) {
      candidates.push({
        lineIdx,
        rowNumber: line.baseLineNo,
        side: 'base',
        sheetName,
      });
    }

    if (line.mineLineNo != null && context.mineSheetName === sheetName) {
      candidates.push({
        lineIdx,
        rowNumber: line.mineLineNo,
        side: 'mine',
        sheetName,
      });
    }
  });

  return candidates;
}

function resolveWorkbookGotoCandidate(
  candidates: Iterable<WorkbookGotoRowCandidate>,
  lineNo: number,
  preferredSide: 'base' | 'mine' | null | undefined,
): WorkbookGotoRowCandidate | null {
  let exact: WorkbookGotoRowCandidate | null = null;
  let nearest: WorkbookGotoRowCandidate | null = null;
  let last: WorkbookGotoRowCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.rowNumber === lineNo && (!exact || compareExactCandidates(candidate, exact, preferredSide) < 0)) exact = candidate;
    if (candidate.rowNumber >= lineNo && (!nearest || compareNearestCandidates(candidate, nearest, preferredSide) < 0)) nearest = candidate;
    if (!last || compareLastCandidates(candidate, last, preferredSide) < 0) last = candidate;
  }
  return exact ?? nearest ?? last;
}

function* artifactGotoCandidates(artifact: WorkbookArtifactDescriptor, sheetName: string | null, allowed?: ReadonlySet<number>): Iterable<WorkbookGotoRowCandidate> {
  const sheet = artifact.sheets.find((item) => item.name === sheetName);
  if (!sheet) return;
  for (let lineIdx = sheet.pairStart; lineIdx < sheet.pairStart + sheet.pairCount; lineIdx += 1) {
    if (allowed && !allowed.has(lineIdx)) continue;
    const base = artifact.rows.baseRowNumbers[lineIdx]!;
    const mine = artifact.rows.mineRowNumbers[lineIdx]!;
    if (base) yield { lineIdx, rowNumber: base, side: 'base', sheetName: sheet.name };
    if (mine) yield { lineIdx, rowNumber: mine, side: 'mine', sheetName: sheet.name };
  }
}

export function getWorkbookSheetMaxRowNumber(
  diffLines: readonly DiffLine[],
  lineSheetContexts: readonly WorkbookLineSheetContext[],
  sheetName: string | null,
  allowedLineIndexes?: ReadonlySet<number>,
): number {
  const candidates = collectWorkbookGotoRowCandidates(diffLines, lineSheetContexts, sheetName, allowedLineIndexes);
  return candidates.reduce((max, candidate) => Math.max(max, candidate.rowNumber), 0);
}

export function resolveWorkbookGotoTarget({
  lineNo,
  diffLines,
  lineSheetContexts,
  sheetName,
  preferredSide = null,
  preferredColumn = 0,
  preferredColumnLabel,
  baseVersionLabel,
  mineVersionLabel,
  allowedLineIndexes,
  artifact,
}: ResolveWorkbookGotoTargetParams): ResolvedWorkbookGotoTarget | null {
  const candidates = artifact ? artifactGotoCandidates(artifact, sheetName, allowedLineIndexes)
    : collectWorkbookGotoRowCandidates(diffLines, lineSheetContexts, sheetName, allowedLineIndexes);
  const candidate = resolveWorkbookGotoCandidate(candidates, lineNo, preferredSide);
  if (!candidate) return null;

  const colIndex = Math.max(0, preferredColumn);
  const colLabel = preferredColumnLabel || getWorkbookColumnLabel(colIndex);

  return {
    lineIdx: candidate.lineIdx,
    selection: {
      kind: 'row',
      sheetName: candidate.sheetName,
      side: candidate.side,
      versionLabel: candidate.side === 'base' ? baseVersionLabel : mineVersionLabel,
      rowNumber: candidate.rowNumber,
      colIndex,
      colLabel,
      address: String(candidate.rowNumber),
      value: '',
      formula: '',
    },
  };
}
