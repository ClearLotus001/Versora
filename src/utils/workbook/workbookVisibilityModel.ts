import type {
  DiffTypeFilter,
  SplitRow,
  WorkbookCompareMode,
  WorkbookSearchTarget,
} from '@/types';
import {
  resolveWorkbookRowDiffType,
  type ConcreteDiffType,
  type DiffTypeAvailability,
} from '@/utils/diff/diffTypeFilter';
import { buildWorkbookSplitRowCompareState } from '@/utils/workbook/workbookCompare';
import { getWorkbookSideRowNumber } from '@/utils/workbook/workbookNavigation';
import type { WorkbookSectionRowIndex } from '@/utils/workbook/workbookSheetIndex';
import type { WorkbookSection } from '@/utils/workbook/workbookSections';

export interface WorkbookRenderPolicy {
  mode: 'full' | 'differences-only';
  maskIrrelevantCells: boolean;
  diffTypeFilter: DiffTypeFilter;
}

export interface WorkbookVisibilityModel {
  policy: WorkbookRenderPolicy;
  modifiedSheetNames: ReadonlySet<string>;
  visibleSheetNames: ReadonlySet<string>;
  visibleLineIndexesBySheet: ReadonlyMap<string, ReadonlySet<number>>;
  searchableCellKeys: WorkbookSearchableCellIndex;
}

export interface WorkbookSearchableCellIndex {
  readonly size: number;
  has(key: string): boolean;
}

interface BuildWorkbookVisibilityModelOptions {
  showOnlyDifferences: boolean;
  diffTypeFilter: DiffTypeFilter;
  sections: readonly WorkbookSection[];
  sectionRowIndex: WorkbookSectionRowIndex;
  modifiedSheetNames: ReadonlySet<string>;
  compareMode: WorkbookCompareMode;
}

type WorkbookDiffTypeAvailabilityOptions = Pick<
  BuildWorkbookVisibilityModelOptions,
  'sections' | 'sectionRowIndex' | 'compareMode'
>;

interface WorkbookVisibilityCacheEntry {
  effectiveModifiedSheetNames: ReadonlySet<string>;
  models: Map<string, WorkbookVisibilityModel>;
  searchableCellKeysByType: Map<ConcreteDiffType, Set<string>>;
  populatedSearchTypes: Set<ConcreteDiffType>;
}

const CONCRETE_DIFF_TYPES: readonly ConcreteDiffType[] = ['add', 'modify', 'delete'];
const EMPTY_SEARCHABLE_CELL_INDEX = new Set<string>();
const WORKBOOK_VISIBILITY_CACHE_VARIANTS = 4;
const workbookVisibilityCache = new WeakMap<
  WorkbookSectionRowIndex,
  Map<string, WorkbookVisibilityCacheEntry>
>();
const filteredWorkbookRowsCache = new WeakMap<
  SplitRow[],
  WeakMap<WorkbookVisibilityModel, SplitRow[]>
>();

function buildCellKey(
  sheetName: string,
  side: 'base' | 'mine',
  rowNumber: number,
  column: number,
): string {
  return `${sheetName}\u0000${side}\u0000${rowNumber}\u0000${column}`;
}

function buildVisibilitySourceSignature(
  sections: readonly WorkbookSection[],
  modifiedSheetNames: ReadonlySet<string>,
  compareMode: WorkbookCompareMode,
) {
  const sectionSignature = sections.map((section) => (
    `${section.name}\u0000${section.changeType}\u0000${section.startLineIdx}\u0000${section.endLineIdx}`
  )).join('\u0001');
  const modifiedSignature = [...modifiedSheetNames].sort().join('\u0001');
  return `${compareMode}\u0002${sectionSignature}\u0002${modifiedSignature}`;
}

function getVisibilityCacheEntry(
  sections: readonly WorkbookSection[],
  sectionRowIndex: WorkbookSectionRowIndex,
  modifiedSheetNames: ReadonlySet<string>,
  compareMode: WorkbookCompareMode,
) {
  let cacheBySignature = workbookVisibilityCache.get(sectionRowIndex);
  if (!cacheBySignature) {
    cacheBySignature = new Map();
    workbookVisibilityCache.set(sectionRowIndex, cacheBySignature);
  }

  const signature = buildVisibilitySourceSignature(sections, modifiedSheetNames, compareMode);
  const cached = cacheBySignature.get(signature);
  if (cached) {
    cacheBySignature.delete(signature);
    cacheBySignature.set(signature, cached);
    return cached;
  }

  const effectiveModifiedSheetNames = new Set(modifiedSheetNames);
  sections.forEach((section) => {
    if (section.changeType !== 'equal') effectiveModifiedSheetNames.add(section.name);
  });
  const next: WorkbookVisibilityCacheEntry = {
    effectiveModifiedSheetNames,
    models: new Map(),
    searchableCellKeysByType: new Map(),
    populatedSearchTypes: new Set(),
  };
  cacheBySignature.set(signature, next);
  while (cacheBySignature.size > WORKBOOK_VISIBILITY_CACHE_VARIANTS) {
    const oldestKey = cacheBySignature.keys().next().value;
    if (oldestKey == null) break;
    cacheBySignature.delete(oldestKey);
  }
  return next;
}

function getSearchTypes(filter: DiffTypeFilter): readonly ConcreteDiffType[] {
  return filter === 'all' ? CONCRETE_DIFF_TYPES : [filter];
}

export function getWorkbookDiffTypeAvailability({
  sections,
  sectionRowIndex,
  compareMode,
}: WorkbookDiffTypeAvailabilityOptions): DiffTypeAvailability {
  const availability: DiffTypeAvailability = {
    add: false,
    modify: false,
    delete: false,
  };

  for (const section of sections) {
    if (section.changeType === 'add' || section.changeType === 'delete') {
      availability[section.changeType] = true;
    } else if (section.changeType === 'rename') {
      availability.modify = true;
    }

    const rows = sectionRowIndex.get(section.name)?.rows ?? [];
    for (const row of rows) {
      const delta = buildWorkbookSplitRowCompareState(row, undefined, compareMode);
      const rowType = resolveWorkbookRowDiffType(delta);
      if (rowType) availability[rowType] = true;
      if (availability.add && availability.modify && availability.delete) return availability;
    }
  }

  return availability;
}

function createCompositeSearchableCellIndex(
  indexes: readonly Set<string>[],
): WorkbookSearchableCellIndex {
  return {
    size: indexes.reduce((total, index) => total + index.size, 0),
    has(key) {
      return indexes.some((index) => index.has(key));
    },
  };
}

export function buildWorkbookVisibilityModel({
  showOnlyDifferences,
  diffTypeFilter,
  sections,
  sectionRowIndex,
  modifiedSheetNames,
  compareMode,
}: BuildWorkbookVisibilityModelOptions): WorkbookVisibilityModel {
  const artifact = sectionRowIndex.artifactProvider;
  if (artifact) {
    const filtered = showOnlyDifferences || diffTypeFilter !== 'all';
    const visibleSheetNames = new Set<string>();
    const visibleLineIndexesBySheet = new Map<string, Set<number>>();
    for (const section of sections) {
      const indexes = new Set<number>();
      for (const row of sectionRowIndex.get(section.name)?.rows ?? []) {
        const type = resolveWorkbookRowDiffType(row.workbookRowDelta!);
        if (type && (diffTypeFilter === 'all' || type === diffTypeFilter)) indexes.add(row.lineIdx);
      }
      const structuralType = section.changeType === 'rename' ? 'modify' : section.changeType;
      if (!filtered || indexes.size || (structuralType !== 'equal' && (diffTypeFilter === 'all' || diffTypeFilter === structuralType))) visibleSheetNames.add(section.name);
      visibleLineIndexesBySheet.set(section.name, indexes);
    }
    return { policy: { mode: filtered ? 'differences-only' : 'full', maskIrrelevantCells: filtered, diffTypeFilter },
      modifiedSheetNames, visibleSheetNames, visibleLineIndexesBySheet,
      searchableCellKeys: { size: artifact.descriptor.stats.changedCells,
        has(key: string) {
          const [sheetName, side, physicalRow, column] = key.split('\u0000');
          if (side !== 'base' && side !== 'mine') return false;
          const sheet = artifact.descriptor.sheets.find((item) => item.name === sheetName);
          if (!sheet) return false;
          const rowIndex = artifact.findPhysicalRowIndex(sheet.id, side, Number(physicalRow));
          if (rowIndex == null || !visibleLineIndexesBySheet.get(sheet.name)?.has(rowIndex)) return false;
          const run = artifact.findRun(rowIndex, Number(column));
          return run >= 0 && artifact.runHasSide(run, side);
        } } };
  }
  const hasActiveDifferenceFilter = showOnlyDifferences || diffTypeFilter !== 'all';
  const cacheEntry = getVisibilityCacheEntry(
    sections,
    sectionRowIndex,
    modifiedSheetNames,
    compareMode,
  );
  const modelKey = hasActiveDifferenceFilter ? `filtered:${diffTypeFilter}` : 'full';
  const cachedModel = cacheEntry.models.get(modelKey);
  if (cachedModel) return cachedModel;

  if (!hasActiveDifferenceFilter) {
    const fullModel: WorkbookVisibilityModel = {
      policy: { mode: 'full', maskIrrelevantCells: false, diffTypeFilter: 'all' },
      modifiedSheetNames: cacheEntry.effectiveModifiedSheetNames,
      visibleSheetNames: new Set(sections.map((section) => section.name)),
      visibleLineIndexesBySheet: new Map(),
      searchableCellKeys: EMPTY_SEARCHABLE_CELL_INDEX,
    };
    cacheEntry.models.set(modelKey, fullModel);
    return fullModel;
  }

  const searchTypes = getSearchTypes(diffTypeFilter);
  const searchTypesToPopulate = new Set(
    searchTypes.filter((type) => !cacheEntry.populatedSearchTypes.has(type)),
  );
  searchTypes.forEach((type) => {
    if (!cacheEntry.searchableCellKeysByType.has(type)) {
      cacheEntry.searchableCellKeysByType.set(type, new Set());
    }
  });
  const visibleSheetNames = new Set<string>();
  const visibleLineIndexesBySheet = new Map<string, Set<number>>();

  sections.forEach((section) => {
    const structuralSectionType = section.changeType === 'add' || section.changeType === 'delete'
      ? section.changeType
      : section.changeType === 'rename'
        ? 'modify'
        : null;
    if (
      structuralSectionType != null
      && (diffTypeFilter === 'all' || diffTypeFilter === structuralSectionType)
    ) {
      visibleSheetNames.add(section.name);
    }
    if (diffTypeFilter === 'all' && cacheEntry.effectiveModifiedSheetNames.has(section.name)) {
      visibleSheetNames.add(section.name);
    }

    const rows = sectionRowIndex.get(section.name)?.rows ?? [];
    rows.forEach((row) => {
      const delta = buildWorkbookSplitRowCompareState(row, undefined, compareMode);
      const rowType = resolveWorkbookRowDiffType(delta);
      if (!rowType) return;

      if (diffTypeFilter === 'all' || diffTypeFilter === rowType) {
        visibleSheetNames.add(section.name);
        const lineIndexes = visibleLineIndexesBySheet.get(section.name) ?? new Set<number>();
        row.lineIdxs.forEach((lineIdx) => lineIndexes.add(lineIdx));
        visibleLineIndexesBySheet.set(section.name, lineIndexes);
      }

      if (!searchTypesToPopulate.has(rowType)) return;

      const changedColumns = delta.changedColumns.length > 0
        ? delta.changedColumns
        : delta.structuralChange
          ? Array.from({ length: section.maxColumns }, (_, column) => column)
          : [];
      const baseRowNumber = getWorkbookSideRowNumber(row, 'base');
      const mineRowNumber = getWorkbookSideRowNumber(row, 'mine');
      const searchableCellKeys = cacheEntry.searchableCellKeysByType.get(rowType)!;
      changedColumns.forEach((column) => {
        if (baseRowNumber != null) {
          searchableCellKeys.add(buildCellKey(section.name, 'base', baseRowNumber, column));
        }
        if (mineRowNumber != null) {
          searchableCellKeys.add(buildCellKey(section.name, 'mine', mineRowNumber, column));
        }
      });
    });
  });

  searchTypesToPopulate.forEach((type) => cacheEntry.populatedSearchTypes.add(type));
  const populatedSearchIndexes = searchTypes.map((type) => (
    cacheEntry.searchableCellKeysByType.get(type) ?? EMPTY_SEARCHABLE_CELL_INDEX
  ));
  const searchableCellKeys = diffTypeFilter === 'all'
    ? createCompositeSearchableCellIndex(populatedSearchIndexes)
    : populatedSearchIndexes[0] ?? EMPTY_SEARCHABLE_CELL_INDEX;

  const filteredModel: WorkbookVisibilityModel = {
    policy: { mode: 'differences-only', maskIrrelevantCells: true, diffTypeFilter },
    modifiedSheetNames: cacheEntry.effectiveModifiedSheetNames,
    visibleSheetNames,
    visibleLineIndexesBySheet,
    searchableCellKeys,
  };
  cacheEntry.models.set(modelKey, filteredModel);
  return filteredModel;
}

export function isWorkbookSearchTargetVisible(
  model: WorkbookVisibilityModel,
  target: WorkbookSearchTarget | null | undefined,
): boolean {
  if (model.policy.mode === 'full') return true;
  return Boolean(
    target?.sheetName
    && target.side
    && target.rowNumber != null
    && target.colIndex != null
    && model.searchableCellKeys.has(buildCellKey(
      target.sheetName,
      target.side,
      target.rowNumber,
      target.colIndex,
    )),
  );
}

export function filterWorkbookSectionsByVisibility(
  model: WorkbookVisibilityModel,
  sections: readonly WorkbookSection[],
): WorkbookSection[] {
  if (model.policy.mode === 'full') return [...sections];
  return sections.filter((section) => model.visibleSheetNames.has(section.name));
}

export function filterWorkbookRowsByVisibility(
  model: WorkbookVisibilityModel,
  section: WorkbookSection | null | undefined,
  rows: SplitRow[],
): SplitRow[] {
  if (model.policy.mode === 'full' || !section) return rows;

  let cacheByModel = filteredWorkbookRowsCache.get(rows);
  if (!cacheByModel) {
    cacheByModel = new WeakMap();
    filteredWorkbookRowsCache.set(rows, cacheByModel);
  }
  const cached = cacheByModel.get(model);
  if (cached) return cached;

  const visibleLineIndexes = model.visibleLineIndexesBySheet.get(section.name);
  const headerLineIdx = section.firstDataLineIdx;
  const filteredRows = rows.filter((row) => row.lineIdxs.some((lineIdx) => (
    lineIdx === headerLineIdx || visibleLineIndexes?.has(lineIdx)
  )));
  cacheByModel.set(model, filteredRows);
  return filteredRows;
}
