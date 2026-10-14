import { Suspense, useEffect, lazy, type ReactNode } from 'react';

import type {
  LayoutMode,
  TextLayoutSnapshot,
  WorkbookCompareLayoutSnapshot,
  WorkbookCompareMode,
  WorkbookDiffRegion,
  WorkbookHorizontalLayoutSnapshot,
  WorkbookMetadataMap,
  WorkbookMoveDirection,
  WorkbookSelectionRequest,
  WorkbookSelectionState,
} from '@/types';
import type { LoadPhase, WorkbookUiController } from '@/hooks/app';
import type { CollapseExpansionState } from '@/utils/collapse/collapseState';
import type { TextLayoutSnapshotsByMode } from '@/utils/diff/textLayoutState';
import type { WorkbookLayoutSnapshotsByMode } from '@/utils/workbook/workbookLayoutState';
import type { WorkbookSectionRowIndex } from '@/utils/workbook/workbookSheetIndex';
import type { WorkbookSection } from '@/utils/workbook/workbookSections';
import type { WorkbookVisibilityModel } from '@/utils/workbook/workbookVisibilityModel';
import type { WorkbookContextMenuSection } from '@/components/workbook/WorkbookContextMenu';
import type { UnifiedPanelProps } from '@/components/diff/UnifiedPanel';
import { waitForNextPaint } from '@/hooks/app/helpers';
import {
  revealWorkbookColumns,
  revealWorkbookRows,
} from '@/utils/workbook/workbookManualVisibility';
import HomeStartPanel from '@/components/app/HomeStartPanel';
import WorkbookContextMenu from '@/components/workbook/WorkbookContextMenu';

const UnifiedPanel = lazy(() => import('@/components/diff/UnifiedPanel'));
const SplitPanel = lazy(() => import('@/components/diff/SplitPanel'));
const WorkbookPanel = lazy(() => import('@/components/workbook/WorkbookPanel'));

type AppPanelProps = UnifiedPanelProps;

interface AppContentLifecycle {
  loadingLabel: string;
  loadPhase: LoadPhase;
  hasLoadedDiff: boolean;
  loadError: string;
  isElectron: boolean;
  isLoadingDiff: boolean;
  suppressWorkbookTooltips: boolean;
}

interface AppContentHome {
  onPickWorkingCopyFile: () => void;
  onOpenLocalFileCompare: () => void;
  onOpenSvnConfig: () => void;
}

interface AppContentSurface {
  isWorkbookMode: boolean;
  layout: LayoutMode;
  panelProps: AppPanelProps;
  baseRoleTitle: string;
  mineRoleTitle: string;
  baseVersionLabel: string;
  mineVersionLabel: string;
}

interface AppContentTextSurface {
  textLayoutSnapshots: TextLayoutSnapshotsByMode;
  onTextLayoutSnapshotChange: (snapshot: TextLayoutSnapshot) => void;
  textSharedExpandedBlocks: CollapseExpansionState;
  onTextExpandedBlocksChange: (expandedBlocks: CollapseExpansionState) => void;
}

interface AppContentWorkbookSurface {
  ui: WorkbookUiController;
  activeWorkbookDiffRegion: WorkbookDiffRegion | null;
  activeWorkbookTargetCell: WorkbookSelectionState['primary'];
  onWorkbookSelectionRequest: (request: WorkbookSelectionRequest) => void;
  onWorkbookNavigationReady: (fn: ((direction: WorkbookMoveDirection) => void) | null) => void;
  baseWorkbookMetadata: WorkbookMetadataMap | null;
  mineWorkbookMetadata: WorkbookMetadataMap | null;
  onWorkbookColumnWidthChange: (sheetName: string, column: number, nextWidth: number) => void;
  onWorkbookOperationError: (message: string) => void;
  workbookSections: WorkbookSection[];
  workbookSectionRowIndex: WorkbookSectionRowIndex;
  workbookVisibilityModel: WorkbookVisibilityModel;
  workbookCompareMode: WorkbookCompareMode;
  activeWorkbookSharedExpandedBlocks: CollapseExpansionState | null;
  onWorkbookExpandedBlocksChange: (
    sheetName: string | null,
    activeRegionId: string | null,
    expandedBlocks: CollapseExpansionState,
  ) => void;
  isDevMode: boolean;
  workbookLayoutSnapshots: WorkbookLayoutSnapshotsByMode;
  onWorkbookLayoutSnapshotChange: (
    snapshot: WorkbookCompareLayoutSnapshot | WorkbookHorizontalLayoutSnapshot,
  ) => void;
  workbookContextMenuSections: WorkbookContextMenuSection[];
}

interface AppContentProps {
  lifecycle: AppContentLifecycle;
  home: AppContentHome;
  surface: AppContentSurface;
  textSurface: AppContentTextSurface;
  workbookSurface: AppContentWorkbookSurface;
  onInitialVisualReady?: () => void;
}

function InitialVisualReadySignal({
  onReady,
}: {
  onReady: (() => void) | undefined;
}) {
  useEffect(() => {
    if (!onReady) return undefined;

    let cancelled = false;
    void waitForNextPaint().then(() => {
      if (!cancelled) onReady();
    });

    return () => {
      cancelled = true;
    };
  }, [onReady]);

  return null;
}

function DiffLoadingState({
  loadingLabel,
  onReady,
  overlay = false,
}: {
  loadingLabel: string;
  onReady?: (() => void) | undefined;
  overlay?: boolean;
}) {
  return (
    <div
      data-testid={overlay ? 'diff-loading-overlay' : 'diff-loading-state'}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={overlay
        ? 'diff-loading-surface diff-loading-surface--overlay absolute inset-0 z-[60] flex items-center justify-center p-6 pointer-events-auto cursor-progress'
        : 'diff-loading-surface flex-1 w-full min-w-0 min-h-0 flex items-center justify-center p-6'}>
      <InitialVisualReadySignal onReady={onReady} />
      <div className="diff-loading-card grid gap-3 justify-items-center p-[20px_28px] rounded-2xl border border-border-default text-text-primary">
        <div
          aria-hidden="true"
          className="diff-loading-indicator size-7 rounded-full border-2 border-border-default"
        />
        <span className="text-center text-[13px] font-semibold">{loadingLabel}</span>
      </div>
    </div>
  );
}

function renderBootstrappingState() {
  return (
    <div
      data-testid="app-bootstrapping-state"
      aria-hidden="true"
      className="flex-1 w-full min-w-0 min-h-0 bg-bg-base"
      style={{ background: 'var(--boot-bg, var(--bg-base))' }}
    />
  );
}

function renderLazyPanel(
  content: ReactNode,
  loadingLabel: string,
  onReady?: () => void,
) {
  return (
    <Suspense fallback={<DiffLoadingState loadingLabel={loadingLabel} onReady={onReady} />}>
      <>
        <InitialVisualReadySignal onReady={onReady} />
        {content}
      </>
    </Suspense>
  );
}

export default function AppContent({
  lifecycle,
  home,
  surface,
  textSurface,
  workbookSurface,
  onInitialVisualReady,
}: AppContentProps) {
  const {
    loadingLabel, loadPhase, hasLoadedDiff, loadError,
    isElectron, isLoadingDiff, suppressWorkbookTooltips,
  } = lifecycle;
  const { onPickWorkingCopyFile, onOpenLocalFileCompare, onOpenSvnConfig } = home;
  const {
    isWorkbookMode, layout, panelProps,
    baseRoleTitle, mineRoleTitle, baseVersionLabel, mineVersionLabel,
  } = surface;
  const {
    textLayoutSnapshots, onTextLayoutSnapshotChange,
    textSharedExpandedBlocks, onTextExpandedBlocksChange,
  } = textSurface;
  const {
    ui: workbookUi,
    activeWorkbookDiffRegion, activeWorkbookTargetCell,
    onWorkbookSelectionRequest, onWorkbookNavigationReady,
    baseWorkbookMetadata, mineWorkbookMetadata,
    onWorkbookColumnWidthChange, onWorkbookOperationError,
    workbookSections, workbookSectionRowIndex, workbookVisibilityModel,
    workbookCompareMode,
    activeWorkbookSharedExpandedBlocks, onWorkbookExpandedBlocksChange,
    isDevMode, workbookLayoutSnapshots, onWorkbookLayoutSnapshotChange,
    workbookContextMenuSections,
  } = workbookSurface;
  const {
    selection: workbookSelection,
    hiddenStateBySheet: workbookHiddenStateBySheet,
    contextMenu: workbookContextMenu,
    freezeBySheet: workbookFreezeBySheet,
    columnWidthBySheet: workbookColumnWidthBySheet,
    activeSheetName: activeWorkbookSheetName,
    showHiddenColumns,
  } = workbookUi.state;
  const setWorkbookHiddenStateBySheet = workbookUi.actions.setHiddenStateBySheet;
  const onActiveWorkbookSheetChange = workbookUi.actions.setActiveSheetName;
  const onCloseWorkbookContextMenu = () => workbookUi.actions.setContextMenu(null);
  const handleRevealHiddenRows = (sheetName: string, rowNumbers: number[]) => {
    setWorkbookHiddenStateBySheet((prev) => revealWorkbookRows(prev, sheetName, rowNumbers));
    onCloseWorkbookContextMenu();
  };

  const handleRevealHiddenColumns = (sheetName: string, columns: number[]) => {
    setWorkbookHiddenStateBySheet((prev) => revealWorkbookColumns(prev, sheetName, columns));
    onCloseWorkbookContextMenu();
  };

  if (!hasLoadedDiff && loadPhase === 'bootstrapping') {
    return renderBootstrappingState();
  }

  if (!hasLoadedDiff && loadPhase === 'loading') {
    return <DiffLoadingState loadingLabel={loadingLabel} onReady={onInitialVisualReady} />;
  }

  if (!hasLoadedDiff) {
    return (
      <div className="comparison-content-enter flex-1 flex min-h-0 min-w-0">
        <InitialVisualReadySignal onReady={onInitialVisualReady} />
        <HomeStartPanel
          error={loadError}
          isElectron={isElectron}
          onPickWorkingCopy={onPickWorkingCopyFile}
          onOpenLocalFileCompare={onOpenLocalFileCompare}
          onOpenSvnConfig={onOpenSvnConfig}
        />
      </div>
    );
  }

  const workbookComparePanelMode = layout === 'split-v' ? 'columns' : 'stacked';
  const workbookComparePanelSnapshot = (
    layout === 'split-v'
      ? workbookLayoutSnapshots['split-v']
      : workbookLayoutSnapshots.unified
  ) as WorkbookCompareLayoutSnapshot | null;
  const sharedWorkbookPanelProps = {
    ...panelProps,
    active: true,
    baseTitle: baseRoleTitle,
    mineTitle: mineRoleTitle,
    baseVersionLabel,
    mineVersionLabel,
    activeDiffRegion: activeWorkbookDiffRegion,
    navigationTargetCell: activeWorkbookTargetCell,
    selection: workbookSelection,
    onSelectionRequest: onWorkbookSelectionRequest,
    onWorkbookNavigationReady,
    baseWorkbookMetadata,
    mineWorkbookMetadata,
    workbookHiddenStateBySheet,
    freezeStateBySheet: workbookFreezeBySheet,
    columnWidthBySheet: workbookColumnWidthBySheet,
    onColumnWidthChange: onWorkbookColumnWidthChange,
    onOperationError: onWorkbookOperationError,
    onRevealHiddenRows: handleRevealHiddenRows,
    onRevealHiddenColumns: handleRevealHiddenColumns,
    workbookSections,
    workbookSectionRowIndex,
    visibilityModel: workbookVisibilityModel,
    activeWorkbookSheetName,
    onActiveWorkbookSheetChange,
    compareMode: workbookCompareMode,
    sharedExpandedBlocks: activeWorkbookSharedExpandedBlocks,
    onExpandedBlocksChange: onWorkbookExpandedBlocksChange,
    showPerfDebug: isDevMode,
    showHiddenColumns,
    tooltipDisabled: isLoadingDiff || suppressWorkbookTooltips,
    onLayoutSnapshotChange: onWorkbookLayoutSnapshotChange,
  };

  return (
    <div
      data-testid="comparison-content"
      className={`${isWorkbookMode ? '' : 'comparison-content-enter '}relative flex-1 flex overflow-hidden min-h-0 min-w-0`}>
      {!isWorkbookMode && layout === 'unified' && (
        renderLazyPanel(
          <UnifiedPanel
            {...panelProps}
            layoutSnapshot={textLayoutSnapshots.unified}
            onLayoutSnapshotChange={onTextLayoutSnapshotChange}
            sharedExpandedBlocks={textSharedExpandedBlocks}
            onExpandedBlocksChange={onTextExpandedBlocksChange}
          />,
          loadingLabel,
          !isLoadingDiff ? onInitialVisualReady : undefined,
        )
      )}
      {!isWorkbookMode && layout === 'split-h' && (
        renderLazyPanel(
          <SplitPanel
            {...panelProps}
            vertical={false}
            layoutSnapshot={textLayoutSnapshots['split-h']}
            onLayoutSnapshotChange={onTextLayoutSnapshotChange}
            sharedExpandedBlocks={textSharedExpandedBlocks}
            onExpandedBlocksChange={onTextExpandedBlocksChange}
          />,
          loadingLabel,
          !isLoadingDiff ? onInitialVisualReady : undefined,
        )
      )}
      {!isWorkbookMode && layout === 'split-v' && (
        renderLazyPanel(
          <SplitPanel
            {...panelProps}
            vertical
            layoutSnapshot={textLayoutSnapshots['split-v']}
            onLayoutSnapshotChange={onTextLayoutSnapshotChange}
            sharedExpandedBlocks={textSharedExpandedBlocks}
            onExpandedBlocksChange={onTextExpandedBlocksChange}
          />,
          loadingLabel,
          !isLoadingDiff ? onInitialVisualReady : undefined,
        )
      )}

      {isWorkbookMode && (
        <div className="relative flex-1 min-w-0 min-h-0">
          {layout !== 'split-h' && (
            <div className="relative flex w-full h-full min-w-0 min-h-0">
              {renderLazyPanel(
                <WorkbookPanel
                  kind="compare"
                  panelProps={{
                    ...sharedWorkbookPanelProps,
                    mode: workbookComparePanelMode,
                    layoutSnapshot: workbookComparePanelSnapshot,
                  }}
                />,
                loadingLabel,
                !isLoadingDiff ? onInitialVisualReady : undefined,
              )}
            </div>
          )}
          {layout === 'split-h' && (
            <div className="relative flex w-full h-full min-w-0 min-h-0">
              {renderLazyPanel(
                <WorkbookPanel
                  kind="horizontal"
                  panelProps={{
                    ...sharedWorkbookPanelProps,
                    layoutSnapshot: workbookLayoutSnapshots['split-h'] as WorkbookHorizontalLayoutSnapshot | null,
                  }}
                />,
                loadingLabel,
                !isLoadingDiff ? onInitialVisualReady : undefined,
              )}
            </div>
          )}
        </div>
      )}

      {isWorkbookMode && (
        <WorkbookContextMenu
          anchorPoint={workbookContextMenu?.anchorPoint ?? null}
          sections={workbookContextMenuSections}
          onClose={onCloseWorkbookContextMenu}
        />
      )}

      {isLoadingDiff && (
        <DiffLoadingState loadingLabel={loadingLabel} overlay />
      )}
    </div>
  );
}
