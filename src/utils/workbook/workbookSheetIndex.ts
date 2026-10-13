import type {
  DiffLine,
  SplitRow,
  WorkbookCompareMode,
} from '@/types';
import type { WorkbookSection } from '@/utils/workbook/workbookSections';
import { parseWorkbookDisplayLine } from '@/utils/workbook/workbookDisplay';
import { buildWorkbookLineSheetContextLookup } from '@/utils/workbook/workbookSections';
import {
  buildWorkbookRowSignature,
  alignWorkbookEntries,
  createWorkbookAlignmentEntry,
} from '@/utils/workbook/workbookAlignment';
import { workbookDebugLog, isWorkbookDebugEnabled } from '@/utils/workbook/workbookDebug';

export interface IndexedWorkbookSectionRows {
  rows: SplitRow[];
}

export interface WorkbookSectionRowIndex {
  artifactProvider?: import('@/utils/workbook/workbookArtifactProvider').WorkbookArtifactProvider;
  get(sectionName: string): IndexedWorkbookSectionRows | undefined;
}

export const EMPTY_WORKBOOK_SECTION_ROW_INDEX: WorkbookSectionRowIndex = {
  get: () => undefined,
};

const workbookSectionRowIndexCache = new WeakMap<
  DiffLine[],
  WeakMap<WorkbookSection[], Map<WorkbookCompareMode, WorkbookSectionRowIndex>>
>();
function createWorkbookSectionRowIndex(
  resolveRows: (sectionName: string) => IndexedWorkbookSectionRows | undefined,
): WorkbookSectionRowIndex {
  const rowsBySectionName = new Map<string, IndexedWorkbookSectionRows | undefined>();

  return {
    get(sectionName: string) {
      if (rowsBySectionName.has(sectionName)) {
        return rowsBySectionName.get(sectionName);
      }

      const nextValue = resolveRows(sectionName);
      rowsBySectionName.set(sectionName, nextValue);
      return nextValue;
    },
  };
}

function buildSplitRow(
  left: DiffLine | null,
  right: DiffLine | null,
  leftLineIdx: number | null,
  rightLineIdx: number | null,
  fallbackLineIdx: number,
): SplitRow {
  const lineIdxs = [leftLineIdx, rightLineIdx].filter((lineIdx): lineIdx is number => lineIdx != null);
  return {
    left,
    right,
    lineIdx: lineIdxs[0] ?? fallbackLineIdx,
    lineIdxs,
  };
}

function makeSideScopedEqualLine(
  line: DiffLine,
  side: 'base' | 'mine',
): DiffLine {
  return side === 'base'
    ? {
        ...line,
        mine: null,
        mineLineNo: null,
        mineCharSpans: null,
      }
    : {
        ...line,
        base: null,
        baseLineNo: null,
        baseCharSpans: null,
      };
}

function alignWorkbookChangeRows(
  baseRows: Array<ReturnType<typeof createWorkbookAlignmentEntry<{ line: DiffLine; lineIdx: number }>>>,
  mineRows: Array<ReturnType<typeof createWorkbookAlignmentEntry<{ line: DiffLine; lineIdx: number }>>>,
  fallbackLineIdx: number,
): SplitRow[] {
  return alignWorkbookEntries(
    baseRows.filter((entry): entry is NonNullable<typeof entry> => entry != null),
    mineRows.filter((entry): entry is NonNullable<typeof entry> => entry != null),
  ).map((pair) => buildSplitRow(
    pair.base?.meta.line ?? null,
    pair.mine?.meta.line ?? null,
    pair.base?.meta.lineIdx ?? null,
    pair.mine?.meta.lineIdx ?? null,
    fallbackLineIdx,
  ));
}

function buildWorkbookSplitRows(
  sectionDiffLines: Array<{ line: DiffLine; lineIdx: number }>,
  compareMode: WorkbookCompareMode = 'strict',
): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;

  while (index < sectionDiffLines.length) {
    const entry = sectionDiffLines[index]!;
    const line = entry.line;

    if (line.type === 'equal') {
      const lineIdx = entry.lineIdx;
      const leftParsed = line.base ? parseWorkbookDisplayLine(line.base) : null;
      const rightParsed = line.mine ? parseWorkbookDisplayLine(line.mine) : null;
      const rowNumbersDiffer = leftParsed?.kind === 'row' && rightParsed?.kind === 'row'
        ? leftParsed.rowNumber !== rightParsed.rowNumber
        : false;
      const lineSemanticallyDiffers = leftParsed?.kind === 'row' && rightParsed?.kind === 'row'
        ? buildWorkbookRowSignature(leftParsed, compareMode) !== buildWorkbookRowSignature(rightParsed, compareMode)
        : line.base !== line.mine;
      if (line.base && line.mine && (lineSemanticallyDiffers || rowNumbersDiffer)) {
        rows.push(buildSplitRow(
          makeSideScopedEqualLine(line, 'base'),
          makeSideScopedEqualLine(line, 'mine'),
          lineIdx,
          lineIdx,
          lineIdx,
        ));
      } else {
        rows.push({
          left: line,
          right: line,
          lineIdx,
          lineIdxs: [lineIdx],
        });
      }
      index += 1;
      continue;
    }

    const deleteStart = index;
    while (index < sectionDiffLines.length && sectionDiffLines[index]!.line.type === 'delete') index += 1;
    const addStart = index;
    while (index < sectionDiffLines.length && sectionDiffLines[index]!.line.type === 'add') index += 1;

    const baseRows = sectionDiffLines
      .slice(deleteStart, addStart)
      .map((scopedEntry) => createWorkbookAlignmentEntry(scopedEntry.line.base ?? scopedEntry.line.mine ?? '', {
        line: scopedEntry.line,
        lineIdx: scopedEntry.lineIdx,
      }, compareMode));
    const mineRows = sectionDiffLines
      .slice(addStart, index)
      .map((scopedEntry) => createWorkbookAlignmentEntry(scopedEntry.line.base ?? scopedEntry.line.mine ?? '', {
        line: scopedEntry.line,
        lineIdx: scopedEntry.lineIdx,
      }, compareMode));

    rows.push(...alignWorkbookChangeRows(
      baseRows,
      mineRows,
      sectionDiffLines[deleteStart]?.lineIdx ?? 0,
    ));

    if (index === deleteStart) index += 1;
  }

  return rows;
}

function isWorkbookDataRow(row: SplitRow): boolean {
  const leftParsed = parseWorkbookDisplayLine(row.left?.base ?? row.left?.mine ?? '');
  const rightParsed = parseWorkbookDisplayLine(row.right?.base ?? row.right?.mine ?? '');
  if (leftParsed?.kind === 'sheet' || rightParsed?.kind === 'sheet') return false;
  return leftParsed?.kind === 'row' || rightParsed?.kind === 'row';
}

export function buildWorkbookSectionRowIndex(
  diffLines: DiffLine[],
  sections: WorkbookSection[],
  compareMode: WorkbookCompareMode = 'strict',
): WorkbookSectionRowIndex {
  let sectionCache = workbookSectionRowIndexCache.get(diffLines);
  if (!sectionCache) {
    sectionCache = new WeakMap();
    workbookSectionRowIndexCache.set(diffLines, sectionCache);
  }
  let compareModeCache = sectionCache.get(sections);
  if (!compareModeCache) {
    compareModeCache = new Map();
    sectionCache.set(sections, compareModeCache);
  }
  const cached = compareModeCache.get(compareMode);
  if (cached) return cached;

  if (sections.length === 0) {
    compareModeCache.set(compareMode, EMPTY_WORKBOOK_SECTION_ROW_INDEX);
    return EMPTY_WORKBOOK_SECTION_ROW_INDEX;
  }

  const lineSheetContextLookup = buildWorkbookLineSheetContextLookup(diffLines);
  const sectionByName = new Map(
    sections.map((section) => [section.name, section] as const),
  );
  const nextIndex = createWorkbookSectionRowIndex((sectionName) => {
    const section = sectionByName.get(sectionName);
    if (!section) return undefined;

    const contentStartIdx = Math.min(section.startLineIdx + 1, section.endLineIdx + 1);
    const scopedSectionDiffLines = diffLines
      .slice(contentStartIdx, section.endLineIdx + 1)
      .flatMap((line, localIndex) => {
        const lineIdx = contentStartIdx + localIndex;
        const context = lineSheetContextLookup.get(lineIdx);
        const parsedBase = line.base ? parseWorkbookDisplayLine(line.base) : null;
        const parsedMine = line.mine ? parseWorkbookDisplayLine(line.mine) : null;
        const keepBase = parsedBase?.kind === 'row' && context?.baseSheetName === section.name;
        const keepMine = parsedMine?.kind === 'row' && context?.mineSheetName === section.name;
        if (!keepBase && !keepMine) return [];

        if (
          isWorkbookDebugEnabled()
          && parsedBase?.kind === 'row'
          && parsedMine?.kind === 'row'
          && context?.baseSheetName !== context?.mineSheetName
        ) {
          workbookDebugLog('sheet-index/js-cross-sheet-row', {
            sectionName: section.name,
            lineIdx,
            baseSheetName: context?.baseSheetName ?? null,
            mineSheetName: context?.mineSheetName ?? null,
            keepBase,
            keepMine,
            baseRowNumber: parsedBase.rowNumber,
            mineRowNumber: parsedMine.rowNumber,
            baseColumnCount: parsedBase.cells.length,
            mineColumnCount: parsedMine.cells.length,
          });
        }

        return [{
          lineIdx,
          line: {
            ...line,
            type: keepBase && keepMine ? 'equal' : keepBase ? 'delete' : 'add',
            base: keepBase ? line.base : null,
            mine: keepMine ? line.mine : null,
            baseLineNo: keepBase ? line.baseLineNo : null,
            mineLineNo: keepMine ? line.mineLineNo : null,
            baseCharSpans: keepBase ? line.baseCharSpans : null,
            mineCharSpans: keepMine ? line.mineCharSpans : null,
          } satisfies DiffLine,
        }];
      });
    const splitRows = buildWorkbookSplitRows(scopedSectionDiffLines, compareMode)
      .filter(isWorkbookDataRow);
    return { rows: splitRows };
  });

  compareModeCache.set(compareMode, nextIndex);
  return nextIndex;
}
