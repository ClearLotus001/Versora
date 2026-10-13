import { useCallback, useEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import type {
  DiffData,
  WorkbookCompareMode,
  WorkbookDiffRegion,
  WorkbookMetadataMap,
  WorkbookSelectionRequest,
  WorkbookSelectedCell,
} from '@/types';
import type { TranslationFn } from '@/context/i18n';
import { copyText } from '@/utils/app/clipboard';
import {
  hideWorkbookColumns,
  hideWorkbookRows,
  revealWorkbookColumns,
  revealWorkbookRows,
  revealWorkbookSelection,
} from '@/utils/workbook/workbookManualVisibility';
import {
  applyWorkbookSelection,
  createWorkbookSelectionState,
  getWorkbookSelectionCount,
} from '@/utils/workbook/workbookSelectionState';
import {
  applyWorkbookFreezePatch,
  areWorkbookFreezeStatesEqual,
  type WorkbookFreezeDefaults,
  type WorkbookFreezePatch,
} from '@/utils/workbook/workbookFreeze';
import {
  clampWorkbookColumnWidth,
  measureWorkbookAutoFitColumnWidthsAsync,
} from '@/utils/workbook/workbookColumnWidths';
import {
  buildWorkbookSheetPresentation,
} from '@/utils/workbook/workbookMeta';
import { findWorkbookDiffRegionIndexForSelection } from '@/utils/workbook/workbookDiffRegion';
import { getSelectedWorkbookColumns, getSelectedWorkbookRows } from '@/utils/workbook/workbookManualVisibility';
import type { WorkbookSectionRowIndex } from '@/utils/workbook/workbookSheetIndex';
import type { WorkbookSection } from '@/utils/workbook/workbookSections';
import type { WorkbookContextMenuSection } from '@/components/workbook/WorkbookContextMenu';
import type { WorkbookUiController } from '@/hooks/app/contracts';

interface UseWorkbookActionsArgs {
  t: TranslationFn;
  selectedCell: WorkbookSelectedCell | null;
  fontSize: number;
  workbookCompareMode: WorkbookCompareMode;
  workbookSections: WorkbookSection[];
  workbookSectionRowIndex: WorkbookSectionRowIndex;
  baseWorkbookMetadata: WorkbookMetadataMap | null;
  mineWorkbookMetadata: WorkbookMetadataMap | null;
  workbookUi: WorkbookUiController;
  workbookDiffRegions: WorkbookDiffRegion[];
  isWorkbookMode: boolean;
  setHunkIdx: Dispatch<SetStateAction<number>>;
  onError: (message: string) => void;
  currentDiffDataRef: MutableRefObject<DiffData | null>;
}

export interface UseWorkbookActionsResult {
  handleFreezeRow: () => void;
  handleFreezeColumn: () => void;
  handleFreezePane: () => void;
  handleUnfreezeRow: () => void;
  handleUnfreezeColumn: () => void;
  handleResetFreeze: () => void;
  handleWorkbookColumnWidthChange: (sheetName: string, column: number, width: number) => void;
  handleWorkbookSelectionRequest: (request: WorkbookSelectionRequest) => void;
  workbookContextMenuSections: WorkbookContextMenuSection[];
}

export default function useWorkbookActions({
  t,
  selectedCell,
  fontSize,
  workbookCompareMode,
  workbookSections,
  workbookSectionRowIndex,
  baseWorkbookMetadata,
  mineWorkbookMetadata,
  workbookUi,
  workbookDiffRegions,
  isWorkbookMode,
  setHunkIdx,
  onError,
  currentDiffDataRef,
}: UseWorkbookActionsArgs): UseWorkbookActionsResult {
  const latestActionContext = useRef({ workbookSectionRowIndex, workbookCompareMode, fontSize, onError });
  latestActionContext.current = { workbookSectionRowIndex, workbookCompareMode, fontSize, onError };
  const autoFitSequence = useRef(0);
  const autoFitController = useRef<AbortController | null>(null);
  useEffect(() => () => {
    autoFitSequence.current += 1;
    autoFitController.current?.abort();
  }, [workbookSectionRowIndex, workbookCompareMode, fontSize]);
  const isActionCurrent = useCallback((data: DiffData | null) => (
    currentDiffDataRef.current === data
    && latestActionContext.current.workbookSectionRowIndex === workbookSectionRowIndex
    && latestActionContext.current.workbookCompareMode === workbookCompareMode
  ), [currentDiffDataRef, workbookCompareMode, workbookSectionRowIndex]);
  const reportActionError = useCallback((error: unknown, data: DiffData | null) => {
    if (!isActionCurrent(data)) return;
    latestActionContext.current.onError(error instanceof Error ? error.message : String(error));
  }, [isActionCurrent]);
  const {
    state: {
      selection: workbookSelection,
      hiddenStateBySheet: workbookHiddenStateBySheet,
      contextMenu: workbookContextMenu,
      freezeBySheet: workbookFreezeBySheet,
    },
    actions: {
      setSelection: setWorkbookSelection,
      setHiddenStateBySheet: setWorkbookHiddenStateBySheet,
      setContextMenu: setWorkbookContextMenu,
      setFreezeBySheet: setWorkbookFreezeBySheet,
      setColumnWidthBySheet: setWorkbookColumnWidthBySheet,
      setShowHiddenColumns,
    },
  } = workbookUi;

  const getWorkbookFreezeDefaults = useCallback((sheetName: string): WorkbookFreezeDefaults => {
    const section = workbookSections.find((item) => item.name === sheetName);
    return {
      rowNumber: section?.firstDataRowNumber ?? 0,
      colCount: 1,
    };
  }, [workbookSections]);

  const updateWorkbookFreezeForSelection = useCallback((
    target: WorkbookSelectedCell | null,
    patch: WorkbookFreezePatch | null,
  ) => {
    if (!target) return;

    const defaults = getWorkbookFreezeDefaults(target.sheetName);
    const currentFreezeState = workbookFreezeBySheet[target.sheetName] ?? null;
    const nextFreezeState = applyWorkbookFreezePatch(currentFreezeState, patch, defaults);
    if (areWorkbookFreezeStatesEqual(currentFreezeState, nextFreezeState)) {
      setWorkbookContextMenu(null);
      return;
    }

    setWorkbookFreezeBySheet((prev) => {
      const next = { ...prev };
      if (!nextFreezeState) {
        delete next[target.sheetName];
      } else {
        next[target.sheetName] = nextFreezeState;
      }
      return next;
    });
    setWorkbookContextMenu(null);
  }, [
    getWorkbookFreezeDefaults,
    setWorkbookContextMenu,
    setWorkbookFreezeBySheet,
    workbookFreezeBySheet,
  ]);

  const handleFreezeRowForSelection = useCallback((target: WorkbookSelectedCell | null) => {
    if (!target || target.kind === 'column') return;
    updateWorkbookFreezeForSelection(target, { rowNumber: target.rowNumber });
  }, [updateWorkbookFreezeForSelection]);

  const handleFreezeColumnForSelection = useCallback((target: WorkbookSelectedCell | null) => {
    if (!target || target.kind === 'row') return;
    updateWorkbookFreezeForSelection(target, { colCount: target.colIndex + 1 });
  }, [updateWorkbookFreezeForSelection]);

  const handleFreezePaneForSelection = useCallback((target: WorkbookSelectedCell | null) => {
    if (!target || target.kind !== 'cell') return;
    updateWorkbookFreezeForSelection(target, {
      rowNumber: target.rowNumber,
      colCount: target.colIndex + 1,
    });
  }, [updateWorkbookFreezeForSelection]);

  const handleUnfreezeRowForSelection = useCallback((target: WorkbookSelectedCell | null) => {
    updateWorkbookFreezeForSelection(target, { rowNumber: null });
  }, [updateWorkbookFreezeForSelection]);

  const handleUnfreezeColumnForSelection = useCallback((target: WorkbookSelectedCell | null) => {
    updateWorkbookFreezeForSelection(target, { colCount: null });
  }, [updateWorkbookFreezeForSelection]);

  const handleResetFreezeForSelection = useCallback((target: WorkbookSelectedCell | null) => {
    updateWorkbookFreezeForSelection(target, null);
  }, [updateWorkbookFreezeForSelection]);

  const handleFreezeRow = useCallback(() => {
    handleFreezeRowForSelection(selectedCell);
  }, [handleFreezeRowForSelection, selectedCell]);

  const handleFreezeColumn = useCallback(() => {
    handleFreezeColumnForSelection(selectedCell);
  }, [handleFreezeColumnForSelection, selectedCell]);

  const handleFreezePane = useCallback(() => {
    handleFreezePaneForSelection(selectedCell);
  }, [handleFreezePaneForSelection, selectedCell]);

  const handleUnfreezeRow = useCallback(() => {
    handleUnfreezeRowForSelection(selectedCell);
  }, [handleUnfreezeRowForSelection, selectedCell]);

  const handleUnfreezeColumn = useCallback(() => {
    handleUnfreezeColumnForSelection(selectedCell);
  }, [handleUnfreezeColumnForSelection, selectedCell]);

  const handleResetFreeze = useCallback(() => {
    handleResetFreezeForSelection(selectedCell);
  }, [handleResetFreezeForSelection, selectedCell]);

  const handleWorkbookColumnWidthChange = useCallback((
    sheetName: string,
    column: number,
    width: number,
  ) => {
    autoFitSequence.current += 1;
    autoFitController.current?.abort();
    workbookSectionRowIndex.artifactProvider?.cancelColumnMeasurement();
    const nextWidth = clampWorkbookColumnWidth(width);
    setWorkbookColumnWidthBySheet((prev) => {
      const nextSheet = {
        ...(prev[sheetName] ?? {}),
        [column]: nextWidth,
      };
      return {
        ...prev,
        [sheetName]: nextSheet,
      };
    });
  }, [setWorkbookColumnWidthBySheet, workbookSectionRowIndex]);

  const handleHideSelectedRows = useCallback(() => {
    if (!selectedCell || selectedCell.kind !== 'row') return;
    const section = workbookSections.find((item) => item.name === selectedCell.sheetName);
    if (!section) return;
    const freezeLimit = Math.max(
      section.firstDataRowNumber ?? 0,
      workbookFreezeBySheet[selectedCell.sheetName]?.rowNumber ?? 0,
    );
    const rowNumbers = getSelectedWorkbookRows(workbookSelection).filter((rowNumber) => rowNumber > freezeLimit);
    if (rowNumbers.length === 0) return;
    setWorkbookHiddenStateBySheet((prev) => hideWorkbookRows(prev, selectedCell.sheetName, rowNumbers));
    setWorkbookSelection(createWorkbookSelectionState(null));
    setWorkbookContextMenu(null);
  }, [
    selectedCell,
    setWorkbookContextMenu,
    setWorkbookHiddenStateBySheet,
    setWorkbookSelection,
    workbookFreezeBySheet,
    workbookSections,
    workbookSelection,
  ]);

  const handleHideSelectedColumns = useCallback(() => {
    if (!selectedCell || selectedCell.kind !== 'column') return;
    const sectionRows = workbookSectionRowIndex.get(selectedCell.sheetName)?.rows ?? [];
    const section = workbookSections.find((item) => item.name === selectedCell.sheetName);
    if (!section) return;
    const currentlyHiddenColumns = workbookHiddenStateBySheet[selectedCell.sheetName]?.hiddenColumns ?? [];
    const visiblePresentation = buildWorkbookSheetPresentation(
      sectionRows,
      selectedCell.sheetName,
      baseWorkbookMetadata,
      mineWorkbookMetadata,
      section.maxColumns ?? 1,
      false,
      workbookCompareMode,
      currentlyHiddenColumns,
    );
    const nextColumns = getSelectedWorkbookColumns(workbookSelection)
      .filter((column) => !currentlyHiddenColumns.includes(column));
    if (nextColumns.length === 0 || nextColumns.length >= visiblePresentation.visibleColumns.length) return;
    setShowHiddenColumns(false);
    setWorkbookHiddenStateBySheet((prev) => hideWorkbookColumns(prev, selectedCell.sheetName, nextColumns));
    setWorkbookSelection(createWorkbookSelectionState(null));
    setWorkbookContextMenu(null);
  }, [
    baseWorkbookMetadata,
    mineWorkbookMetadata,
    selectedCell,
    setShowHiddenColumns,
    setWorkbookContextMenu,
    setWorkbookHiddenStateBySheet,
    setWorkbookSelection,
    workbookCompareMode,
    workbookHiddenStateBySheet,
    workbookSectionRowIndex,
    workbookSections,
    workbookSelection,
  ]);

  const handleRevealAllHiddenRows = useCallback((sheetName: string) => {
    const rowNumbers = workbookHiddenStateBySheet[sheetName]?.hiddenRows ?? [];
    if (rowNumbers.length === 0) return;
    setWorkbookHiddenStateBySheet((prev) => revealWorkbookRows(prev, sheetName, rowNumbers));
    setWorkbookContextMenu(null);
  }, [setWorkbookContextMenu, setWorkbookHiddenStateBySheet, workbookHiddenStateBySheet]);

  const handleRevealAllHiddenColumns = useCallback((sheetName: string) => {
    const columns = workbookHiddenStateBySheet[sheetName]?.hiddenColumns ?? [];
    if (columns.length === 0) return;
    setWorkbookHiddenStateBySheet((prev) => revealWorkbookColumns(prev, sheetName, columns));
    setWorkbookContextMenu(null);
  }, [setWorkbookContextMenu, setWorkbookHiddenStateBySheet, workbookHiddenStateBySheet]);

  const handleAutoFitSelectedColumns = useCallback(async () => {
    if (!selectedCell || selectedCell.kind !== 'column') return;
    const columns = getSelectedWorkbookColumns(workbookSelection);
    if (columns.length === 0) return;
    const data = currentDiffDataRef.current;
    const sequence = ++autoFitSequence.current;
    autoFitController.current?.abort();
    const controller = new AbortController();
    autoFitController.current = controller;
    let measured: number[];
    try {
      measured = await measureWorkbookAutoFitColumnWidthsAsync(workbookSectionRowIndex.artifactProvider, selectedCell.sheetName, columns, fontSize, {
        signal: controller.signal,
        isCurrent: () => isActionCurrent(data) && sequence === autoFitSequence.current && latestActionContext.current.fontSize === fontSize,
      });
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof Error && error.name === 'AbortError') && sequence === autoFitSequence.current) reportActionError(error, data);
      return;
    } finally {
      if (autoFitController.current === controller) autoFitController.current = null;
    }
    if (!isActionCurrent(data) || sequence !== autoFitSequence.current || latestActionContext.current.fontSize !== fontSize) return;
    setWorkbookColumnWidthBySheet((prev) => {
      const nextSheet = { ...(prev[selectedCell.sheetName] ?? {}) };
      columns.forEach((column, index) => {
        nextSheet[column] = measured[index]!;
      });
      return {
        ...prev,
        [selectedCell.sheetName]: nextSheet,
      };
    });
    setWorkbookContextMenu(null);
  }, [
    fontSize,
    selectedCell,
    setWorkbookColumnWidthBySheet,
    setWorkbookContextMenu,
    workbookSectionRowIndex,
    workbookSelection,
    isActionCurrent,
    reportActionError,
    currentDiffDataRef,
  ]);

  const handleCopyCell = useCallback(async (primary: WorkbookSelectedCell, field: 'value' | 'formula' | 'address') => {
    const data = currentDiffDataRef.current;
    try {
      const provider = workbookSectionRowIndex.get(primary.sheetName)?.rows[0]?.workbookArtifactRow?.provider;
      const resolved = field !== 'address' && provider ? await provider.resolveSelection(primary) : primary;
      if (!isActionCurrent(data)) return;
      const copied = await copyText(resolved[field]);
      if (!copied) reportActionError(t('workbookCellLoadError'), data);
    } catch (error) {
      reportActionError(error, data);
    }
  }, [currentDiffDataRef, workbookSectionRowIndex, isActionCurrent, reportActionError, t]);

  const workbookContextMenuSections = useMemo<WorkbookContextMenuSection[]>(() => {
    const menuSelection = workbookContextMenu?.selection ?? createWorkbookSelectionState(null);
    const primary = menuSelection.primary;
    if (!primary) return [];

    const sections: WorkbookContextMenuSection[] = [];
    const sheetName = primary.sheetName;
    const sheetFreezeState = workbookFreezeBySheet[sheetName] ?? null;
    const hasCustomRowFreeze = Boolean(sheetFreezeState?.rowNumber);
    const hasCustomColumnFreeze = Boolean(sheetFreezeState?.colCount);
    const hasCustomFreeze = hasCustomRowFreeze || hasCustomColumnFreeze;
    const hiddenSheetState = workbookHiddenStateBySheet[sheetName] ?? {
      hiddenRows: [],
      hiddenColumns: [],
    };
    const selectionCount = getWorkbookSelectionCount(menuSelection);

    if (primary.kind === 'cell') {
      sections.push({
        title: t('workbookContextSectionCopy'),
        items: [
          {
            id: 'copy-value',
            label: t('workbookContextCopyValue'),
            onSelect: () => { void handleCopyCell(primary, 'value'); },
          },
          {
            id: 'copy-formula',
            label: t('workbookContextCopyFormula'),
            onSelect: () => { void handleCopyCell(primary, 'formula'); },
          },
          {
            id: 'copy-address',
            label: t('workbookContextCopyAddress'),
            onSelect: () => { void handleCopyCell(primary, 'address'); },
          },
        ],
      });
    }

    if (primary.kind === 'row') {
      const section = workbookSections.find((item) => item.name === sheetName);
      const freezeLimit = Math.max(
        section?.firstDataRowNumber ?? 0,
        workbookFreezeBySheet[sheetName]?.rowNumber ?? 0,
      );
      const hideableRows = getSelectedWorkbookRows(menuSelection).filter((rowNumber) => rowNumber > freezeLimit);
      sections.push({
        title: t('workbookContextSectionRows'),
        items: [
          {
            id: 'hide-rows',
            label: t('workbookContextHideRows', { count: selectionCount }),
            disabled: hideableRows.length === 0,
            onSelect: handleHideSelectedRows,
          },
          {
            id: 'reveal-rows',
            label: t('workbookContextRevealAllRows'),
            disabled: hiddenSheetState.hiddenRows.length === 0,
            onSelect: () => handleRevealAllHiddenRows(sheetName),
          },
        ],
      });
    }

    if (primary.kind === 'column') {
      const section = workbookSections.find((item) => item.name === sheetName);
      const sectionRows = workbookSectionRowIndex.get(sheetName)?.rows ?? [];
      const visiblePresentation = buildWorkbookSheetPresentation(
        sectionRows,
        sheetName,
        baseWorkbookMetadata,
        mineWorkbookMetadata,
        section?.maxColumns ?? 1,
        false,
        workbookCompareMode,
        hiddenSheetState.hiddenColumns,
      );
      const hideableColumns = getSelectedWorkbookColumns(menuSelection)
        .filter((column) => !hiddenSheetState.hiddenColumns.includes(column));
      sections.push({
        title: t('workbookContextSectionColumns'),
        items: [
          {
            id: 'auto-fit-columns',
            label: t('workbookContextAutoFitColumns', { count: selectionCount }),
            disabled: getSelectedWorkbookColumns(menuSelection).length === 0,
            onSelect: () => { void handleAutoFitSelectedColumns(); },
          },
          {
            id: 'hide-columns',
            label: t('workbookContextHideColumns', { count: selectionCount }),
            disabled: hideableColumns.length === 0 || hideableColumns.length >= visiblePresentation.visibleColumns.length,
            onSelect: handleHideSelectedColumns,
          },
          {
            id: 'reveal-columns',
            label: t('workbookContextRevealAllColumns'),
            disabled: hiddenSheetState.hiddenColumns.length === 0,
            onSelect: () => handleRevealAllHiddenColumns(sheetName),
          },
        ],
      });
    }

    sections.push({
      title: t('workbookContextSectionFreeze'),
      items: [
        {
          id: 'freeze-row',
          label: t('formulaFreezeRowAction'),
          disabled: primary.kind === 'column',
          onSelect: () => handleFreezeRowForSelection(primary),
        },
        {
          id: 'freeze-column',
          label: t('formulaFreezeColumnAction'),
          disabled: primary.kind === 'row',
          onSelect: () => handleFreezeColumnForSelection(primary),
        },
        {
          id: 'freeze-pane',
          label: t('formulaFreezePaneAction'),
          disabled: primary.kind !== 'cell',
          onSelect: () => handleFreezePaneForSelection(primary),
        },
        {
          id: 'freeze-unfreeze-row',
          label: t('formulaFreezeUnfreezeRowAction'),
          disabled: !hasCustomRowFreeze,
          onSelect: () => handleUnfreezeRowForSelection(primary),
        },
        {
          id: 'freeze-unfreeze-column',
          label: t('formulaFreezeUnfreezeColumnAction'),
          disabled: !hasCustomColumnFreeze,
          onSelect: () => handleUnfreezeColumnForSelection(primary),
        },
        {
          id: 'freeze-reset',
          label: t('formulaFreezeResetAction'),
          disabled: !hasCustomFreeze,
          onSelect: () => handleResetFreezeForSelection(primary),
        },
      ],
    });

    if (primary.kind === 'cell' && (hiddenSheetState.hiddenRows.length > 0 || hiddenSheetState.hiddenColumns.length > 0)) {
      sections.push({
        title: t('workbookContextSectionVisibility'),
        items: [
          {
            id: 'reveal-all-rows',
            label: t('workbookContextRevealAllRows'),
            disabled: hiddenSheetState.hiddenRows.length === 0,
            onSelect: () => handleRevealAllHiddenRows(sheetName),
          },
          {
            id: 'reveal-all-columns',
            label: t('workbookContextRevealAllColumns'),
            disabled: hiddenSheetState.hiddenColumns.length === 0,
            onSelect: () => handleRevealAllHiddenColumns(sheetName),
          },
        ],
      });
    }

    return sections;
  }, [
    baseWorkbookMetadata,
    handleAutoFitSelectedColumns,
    handleCopyCell,
    handleFreezeColumnForSelection,
    handleFreezePaneForSelection,
    handleFreezeRowForSelection,
    handleHideSelectedColumns,
    handleHideSelectedRows,
    handleResetFreezeForSelection,
    handleRevealAllHiddenColumns,
    handleRevealAllHiddenRows,
    handleUnfreezeColumnForSelection,
    handleUnfreezeRowForSelection,
    mineWorkbookMetadata,
    t,
    workbookCompareMode,
    workbookContextMenu,
    workbookFreezeBySheet,
    workbookHiddenStateBySheet,
    workbookSectionRowIndex,
    workbookSections,
  ]);

  const handleWorkbookSelectionRequest = useCallback((request: WorkbookSelectionRequest) => {
    const nextSelection = applyWorkbookSelection(workbookSelection, request.target, {
      mode: request.mode,
      preserveExistingIfTargetSelected: request.preserveExistingIfTargetSelected,
    });

    setWorkbookSelection(nextSelection);
    setWorkbookHiddenStateBySheet((prev) => revealWorkbookSelection(prev, nextSelection.primary));
    if (request.reason === 'contextmenu' && request.clientPoint) {
      setWorkbookContextMenu({
        anchorPoint: request.clientPoint,
        selection: nextSelection,
      });
    } else {
      setWorkbookContextMenu(null);
    }

    const nextPrimary = nextSelection.primary;
    if (!nextPrimary || !isWorkbookMode || nextPrimary.kind !== 'cell') return;
    const regionIndex = findWorkbookDiffRegionIndexForSelection(workbookDiffRegions, nextPrimary);
    if (regionIndex >= 0) {
      setHunkIdx(regionIndex);
    }
  }, [
    isWorkbookMode,
    setHunkIdx,
    setWorkbookContextMenu,
    setWorkbookHiddenStateBySheet,
    setWorkbookSelection,
    workbookDiffRegions,
    workbookSelection,
  ]);

  return {
    handleFreezeRow,
    handleFreezeColumn,
    handleFreezePane,
    handleUnfreezeRow,
    handleUnfreezeColumn,
    handleResetFreeze,
    handleWorkbookColumnWidthChange,
    handleWorkbookSelectionRequest,
    workbookContextMenuSections,
  };
}
