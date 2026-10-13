export type SharedWorkbookCompareMode = 'strict' | 'content';
export type SharedWorkbookCellDeltaKind = 'equal' | 'add' | 'delete' | 'modify';
export type SharedWorkbookRowDeltaTone = 'equal' | 'add' | 'delete' | 'mixed';
export type SharedWorkbookMiniMapPaintTone = 'add' | 'delete' | 'modify' | 'strict-only';
export type SharedWorkbookMiniMapTone = SharedWorkbookMiniMapPaintTone | 'equal' | 'mixed';

export interface WorkbookCellLike {
  value: string;
  formula: string;
}

export interface WorkbookCellDeltaLike {
  changed: boolean;
  kind?: SharedWorkbookCellDeltaKind;
  strictOnly?: boolean;
}

function normalizeWorkbookCellValueForMode(
  value: string,
  compareMode: SharedWorkbookCompareMode = 'strict',
): string {
  return compareMode === 'content' && value.trim() === '' ? '' : value;
}

export function hasWorkbookCellContent(
  cell: WorkbookCellLike,
  compareMode: SharedWorkbookCompareMode = 'strict',
): boolean {
  return normalizeWorkbookCellValueForMode(cell.value, compareMode) !== '' || cell.formula !== '';
}

export function serializeWorkbookCellForMode(
  cell: WorkbookCellLike,
  compareMode: SharedWorkbookCompareMode = 'strict',
): string {
  return `${normalizeWorkbookCellValueForMode(cell.value, compareMode)}\u001F${cell.formula}`;
}

export function workbookCellsDiffer(
  leftCell: WorkbookCellLike,
  rightCell: WorkbookCellLike,
  compareMode: SharedWorkbookCompareMode = 'strict',
): boolean {
  return (
    normalizeWorkbookCellValueForMode(leftCell.value, compareMode)
    !== normalizeWorkbookCellValueForMode(rightCell.value, compareMode)
  ) || leftCell.formula !== rightCell.formula;
}

export function resolveWorkbookCellDeltaKind(
  baseCell: WorkbookCellLike,
  mineCell: WorkbookCellLike,
  compareMode: SharedWorkbookCompareMode = 'strict',
): SharedWorkbookCellDeltaKind {
  if (!workbookCellsDiffer(baseCell, mineCell, compareMode)) return 'equal';
  const baseHasContent = hasWorkbookCellContent(baseCell, compareMode);
  const mineHasContent = hasWorkbookCellContent(mineCell, compareMode);
  if (baseHasContent !== mineHasContent) return mineHasContent ? 'add' : 'delete';
  return 'modify';
}

export function isWorkbookStrictOnlyDifference(
  leftCell: WorkbookCellLike,
  rightCell: WorkbookCellLike,
): boolean {
  return workbookCellsDiffer(leftCell, rightCell, 'strict')
    && !workbookCellsDiffer(leftCell, rightCell, 'content');
}

export function resolveWorkbookRowDeltaTone(
  cellDeltas: Iterable<WorkbookCellDeltaLike>,
): SharedWorkbookRowDeltaTone {
  let sawAdd = false;
  let sawDelete = false;
  let sawModify = false;

  for (const delta of cellDeltas) {
    if (!delta.changed) continue;
    if (delta.kind === 'modify') sawModify = true;
    else if (delta.kind === 'add') sawAdd = true;
    else if (delta.kind === 'delete') sawDelete = true;
  }

  if (!sawAdd && !sawDelete && !sawModify) return 'equal';
  if (sawModify || (sawAdd && sawDelete)) return 'mixed';
  return sawAdd ? 'add' : 'delete';
}

export function resolveWorkbookMiniMapDescriptorFromDeltas(
  cellDeltas: Iterable<WorkbookCellDeltaLike>,
): {
  tone: SharedWorkbookMiniMapTone;
  tones: SharedWorkbookMiniMapPaintTone[];
} {
  let sawAdd = false;
  let sawDelete = false;
  let sawModify = false;
  let sawStrictOnly = false;

  for (const delta of cellDeltas) {
    if (!delta.changed) continue;
    if (delta.strictOnly) {
      sawStrictOnly = true;
      continue;
    }
    if (delta.kind === 'add') sawAdd = true;
    else if (delta.kind === 'delete') sawDelete = true;
    else if (delta.kind === 'modify') sawModify = true;
  }

  const tones: SharedWorkbookMiniMapPaintTone[] = [];
  if (sawDelete) tones.push('delete');
  if (sawModify) tones.push('modify');
  if (sawAdd) tones.push('add');
  if (sawStrictOnly) tones.push('strict-only');

  if (tones.length === 0) return { tone: 'equal', tones };
  if (tones.length === 1) return { tone: tones[0]!, tones };
  return { tone: 'mixed', tones };
}
