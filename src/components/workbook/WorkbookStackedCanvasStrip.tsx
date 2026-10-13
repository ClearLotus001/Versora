import { getWorkbookPendingCellPaint } from '@/utils/workbook/workbookArtifactProvider';
import { useWorkbookArtifactWindow } from '@/hooks/workbook/useWorkbookArtifactWindow';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { HorizontalVirtualColumnEntry } from '@/hooks/virtualization/useHorizontalVirtualColumns';
import { LN_W } from '@/constants/layout';
import { FONT_CODE, FONT_UI, getWorkbookFontScale } from '@/constants/typography';
import { hasWorkbookCellContent } from '@/utils/workbook/workbookCellContract';
import { buildWorkbookSplitRowCompareState } from '@/utils/workbook/workbookCompare';
import {
  buildWorkbookRowEntry,
  buildWorkbookSelectedCell,
  getWorkbookSideRowNumber,
  type WorkbookRowEntry,
} from '@/utils/workbook/workbookNavigation';
import { resolveWorkbookCanvasSelectionKind } from '@/utils/workbook/workbookCanvasSelection';
import {
  getWorkbookMergeContinuationVisual,
  resolveWorkbookCompareCellVisual,
} from '@/utils/workbook/workbookCompareVisuals';
import {
  clipWorkbookCanvasToViewport,
  getWorkbookCanvasHoverRowSegmentBounds,
  getWorkbookCanvasLayerViewports,
  getWorkbookCanvasRowSegmentBounds,
  getWorkbookCanvasRowSegmentCenterY,
  getWorkbookCanvasRowSegmentLineCenters,
  findWorkbookMergeRange,
  getWorkbookCanvasSpanRect,
  getWorkbookColumnSpanBounds,
  getWorkbookMergeDrawInfo,
} from '@/utils/workbook/workbookMergeLayout';
import { resolveWorkbookCanvasAnchor, resolveWorkbookCanvasCompareCell } from '@/utils/workbook/workbookCanvasCompareCells';
import {
  drawWorkbookCanvasSelectionFrame,
  getWorkbookSelectionBorderVisual,
  getWorkbookSelectionOverlay,
  getWorkbookSelectionVisualState,
} from '@/utils/workbook/workbookSelectionVisual';
import { buildWorkbookSelectionLookup } from '@/utils/workbook/workbookSelectionState';
import {
  getWorkbookCanvasTextInsetRect,
  getWorkbookCanvasTextBaselineY,
  layoutWorkbookCanvasTextLines,
} from '@/utils/workbook/workbookCanvasText';
import { drawWorkbookCanvasComparedCellText } from '@/utils/workbook/workbookCanvasTextDiff';
import {
  createWorkbookCanvasBorderRegistry,
  registerWorkbookCanvasCellBorders,
  resolveWorkbookCanvasCellBorderPriority,
} from '@/utils/workbook/workbookCanvasBorders';
import {
  getWorkbookCanvasDevicePixelRatio,
  paintWorkbookCanvasBackdrop,
  syncWorkbookCanvasSurface,
} from '@/utils/workbook/workbookCanvasSurface';
import {
  resolveWorkbookStackedLineNumberTone,
} from '@/utils/diff/lineNumberTone';
import {
  formatWorkbookVisibleRowNumber,
  resolveWorkbookHeaderRowDividerColor,
  resolveWorkbookRowGutterBackground,
  resolveWorkbookRowSelectionAccent,
  resolveWorkbookRowLineNumberColor,
  resolveWorkbookRowRuleColor,
  resolveWorkbookRowSurfaceBackground,
  resolveWorkbookVersionAccent,
  resolveWorkbookVersionIdentityVisual,
} from '@/utils/workbook/workbookRowVisuals';
import { useThemeTokens } from '@/context/theme';
import {
  drawWorkbookMaskedCellSegments,
  resolveWorkbookMaskedCellOpacity,
} from '@/utils/workbook/workbookMaskedCellVisual';
import {
  getWorkbookMaskedRegionId,
  type WorkbookMaskedRegionModel,
} from '@/utils/workbook/workbookMaskedRegionModel';
import type {
  SplitRow,
  WorkbookCompareMode,
  WorkbookSelectionMode,
  WorkbookSelectedCell,
  WorkbookSelectionRequest,
  WorkbookSelectionState,
} from '@/types';
import { ROW_H } from '@/hooks/virtualization/useVirtual';
import type { WorkbookMergeRange } from '@/utils/workbook/workbookMeta';
import type { WorkbookCanvasHoverCell } from '@/components/workbook/WorkbookCanvasHoverTooltip';
import useWorkbookCanvasHoverController, { resolveWorkbookCanvasHoverForCanvas } from '@/components/workbook/useWorkbookCanvasHoverController';
import useWorkbookCanvasSelectionInteractions from '@/components/workbook/useWorkbookCanvasSelectionInteractions';
import { useWorkbookMaskedRegionReveal } from '@/components/workbook/WorkbookMaskedRegionRevealContext';
import {
  getWorkbookStackedBandDisplayRowNumber,
  getWorkbookStackedVisibleBands,
} from '@/utils/workbook/workbookRowBehavior';
import type { WorkbookCompareStateByRow } from '@/utils/workbook/workbookPanelHelpers';
import { subscribeWorkbookCanvasScrollFrame } from '@/utils/workbook/workbookCanvasFrameScheduler';
import {
  buildWorkbookCanvasBitmapCacheKey,
  buildWorkbookCanvasBitmapViewportColumnKey,
  restoreWorkbookCanvasBitmap,
  storeWorkbookCanvasBitmap,
} from '@/utils/workbook/workbookCanvasBitmapCache';
import {
  buildWorkbookCanvasHitColumnFrames,
  findWorkbookCanvasHitXFrame,
  findWorkbookCanvasHitYFrame,
  type WorkbookCanvasHitColumnFrame,
} from '@/utils/workbook/workbookCanvasHitTest';

type CanvasRenderMode = 'single-base' | 'single-mine' | 'single-equal' | 'double';
type WorkbookStackedCanvasDrawReason = 'full' | 'scroll';

export interface WorkbookCanvasRenderRow {
  row: SplitRow;
  renderMode: CanvasRenderMode;
  height: number;
  isSearchMatch: boolean;
  isActiveSearch: boolean;
  isGuided: boolean;
  isGuidedStart: boolean;
  isGuidedEnd: boolean;
}

export interface WorkbookCanvasRenderGroup {
  key: string;
  rows: WorkbookCanvasRenderRow[];
  height: number;
  hasVerticalMerge: boolean;
  baseTrack: Array<{ sourceRowIndex: number; rowNumber: number }>;
  mineTrack: Array<{ sourceRowIndex: number; rowNumber: number }>;
}

interface WorkbookStackedCanvasStripProps {
  groups: WorkbookCanvasRenderGroup[];
  viewportWidth: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  freezeColumnCount: number;
  contentWidth: number;
  sheetName: string;
  baseVersion: string;
  mineVersion: string;
  headerRowNumber: number;
  selection: WorkbookSelectionState;
  onSelectionRequest: (request: WorkbookSelectionRequest) => void;
  onHoverChange?: (hover: WorkbookCanvasHoverCell | null) => void;
  fontSize: number;
  visibleColumns: number[];
  renderColumns: HorizontalVirtualColumnEntry[];
  columnLayoutByColumn: ReadonlyMap<number, HorizontalVirtualColumnEntry>;
  baseMergedRanges: ReadonlyArray<WorkbookMergeRange>;
  mineMergedRanges: ReadonlyArray<WorkbookMergeRange>;
  baseRowEntryByRowNumber: Map<number, WorkbookRowEntry>;
  mineRowEntryByRowNumber: Map<number, WorkbookRowEntry>;
  compareStateByRow: WorkbookCompareStateByRow;
  baseCompareCellsByRowNumber: Map<number, ReturnType<typeof buildWorkbookSplitRowCompareState>['cellDeltas']>;
  mineCompareCellsByRowNumber: Map<number, ReturnType<typeof buildWorkbookSplitRowCompareState>['cellDeltas']>;
  compareMode: WorkbookCompareMode;
  maskedRegions: WorkbookMaskedRegionModel;
}

interface CanvasBand {
  groupKey: string;
  entry: WorkbookRowEntry | null;
  displayRowNumber: number | null;
  side: 'base' | 'mine';
  tone: 'neutral' | 'add' | 'delete';
  hasCompanionBand: boolean;
  useSideAccentForChanges: boolean;
  compareCells: ReturnType<typeof buildWorkbookSplitRowCompareState>['cellDeltas'];
  hasBaseRow: boolean;
  hasMineRow: boolean;
  y: number;
  height: number;
  isGuided: boolean;
  isSearchMatch: boolean;
  isActiveSearch: boolean;
  rowHighlightBg?: string | undefined;
}

interface CanvasGroupFrame {
  key: string;
  top: number;
  height: number;
  rows: WorkbookCanvasRenderRow[];
  baseTrack: Array<{ sourceRowIndex: number; rowNumber: number }>;
  mineTrack: Array<{ sourceRowIndex: number; rowNumber: number }>;
}

interface CanvasRowFrame {
  sourceRowIndex: number;
  top: number;
  renderRow: WorkbookCanvasRenderRow;
  baseEntry: WorkbookRowEntry | null;
  mineEntry: WorkbookRowEntry | null;
  rowDelta: ReturnType<typeof buildWorkbookSplitRowCompareState>;
  hasBaseRow: boolean;
  hasMineRow: boolean;
  rowHighlightBg?: string | undefined;
}

interface CanvasGroupRuntime {
  frame: CanvasGroupFrame;
  rowFrames: CanvasRowFrame[];
  rowFrameBySourceIndex: Map<number, CanvasRowFrame>;
  visibleBandsBySourceRowIndex: Map<number, {
    base?: { top: number; height: number };
    mine?: { top: number; height: number };
  }>;
  renderedRowNumbers: {
    base: number[];
    mine: number[];
  };
  bandPositionBySideRowNumber: {
    base: Map<number, { top: number; height: number }>;
    mine: Map<number, { top: number; height: number }>;
  };
}

interface CanvasHitRowFrame {
  groupRuntime: CanvasGroupRuntime;
  rowFrame: CanvasRowFrame;
  top: number;
  bottom: number;
}

function getSelectionModeFromMouseEvent(event: Pick<React.MouseEvent<HTMLCanvasElement>, 'shiftKey' | 'ctrlKey' | 'metaKey'>): WorkbookSelectionMode {
  if (event.shiftKey) return 'range';
  if (event.ctrlKey || event.metaKey) return 'toggle';
  return 'replace';
}

const WorkbookStackedCanvasStrip = memo(({
  groups,
  viewportWidth,
  scrollRef,
  freezeColumnCount,
  contentWidth,
  sheetName,
  baseVersion,
  mineVersion,
  headerRowNumber,
  selection,
  onSelectionRequest,
  onHoverChange,
  fontSize,
  visibleColumns,
  renderColumns,
  columnLayoutByColumn,
  baseMergedRanges,
  mineMergedRanges,
  baseRowEntryByRowNumber: initialBaseRowEntryByRowNumber,
  mineRowEntryByRowNumber: initialMineRowEntryByRowNumber,
  compareStateByRow: initialCompareStateByRow,
  baseCompareCellsByRowNumber: initialBaseCompareCellsByRowNumber,
  mineCompareCellsByRowNumber: initialMineCompareCellsByRowNumber,
  compareMode,
  maskedRegions,
}: WorkbookStackedCanvasStripProps) => {
  const windowData = useWorkbookArtifactWindow({
    rows: groups.flatMap((group) => group.rows.map((item) => item.row)), columns: renderColumns.map((entry) => entry.column),
    baseVersion, mineVersion, baseMerges: baseMergedRanges, mineMerges: mineMergedRanges,
    fallback: { entries: { base: initialBaseRowEntryByRowNumber, mine: initialMineRowEntryByRowNumber },
      cells: { base: initialBaseCompareCellsByRowNumber, mine: initialMineCompareCellsByRowNumber }, states: initialCompareStateByRow },
  });
  const baseRowEntryByRowNumber = windowData.entries.base;
  const mineRowEntryByRowNumber = windowData.entries.mine;
  const baseCompareCellsByRowNumber = windowData.cells.base;
  const mineCompareCellsByRowNumber = windowData.cells.mine;
  const compareStateByRow = windowData.states;
  const T = useThemeTokens();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clearHoverRef = useRef<() => void>(() => {});
  const clearMaskedRegionRef = useRef<() => void>(() => {});
  const hasActiveHoverRef = useRef<() => boolean>(() => false);
  const [dragPreviewActive, setDragPreviewActive] = useState(false);
  const {
    motionByRegion,
    revealRegion,
    clearRegion,
  } = useWorkbookMaskedRegionReveal();
  clearMaskedRegionRef.current = clearRegion;
  const sizes = useMemo(() => getWorkbookFontScale(fontSize), [fontSize]);
  const renderedColumnNumbers = useMemo(() => renderColumns.map(entry => entry.column), [renderColumns]);
  const groupFrames = useMemo<CanvasGroupFrame[]>(
    () => {
      let cursorTop = 0;
      return groups.map((group) => {
        const frame = {
          key: group.key,
          top: cursorTop,
          height: group.height,
          rows: group.rows,
          baseTrack: group.baseTrack,
          mineTrack: group.mineTrack,
        };
        cursorTop += group.height;
        return frame;
      });
    },
    [groups],
  );
  const totalHeight = useMemo(() => groupFrames.reduce((sum, group) => sum + group.height, 0), [groupFrames]);
  const selectionLookup = useMemo(() => buildWorkbookSelectionLookup(selection), [selection]);
  const primarySelection = selection.primary;

  const groupRuntimes = useMemo<CanvasGroupRuntime[]>(() => {
    return groupFrames.map((groupFrame) => {
      let cursorY = groupFrame.top;
      const rowFrames = groupFrame.rows.map((renderRow, sourceRowIndex) => {
        const baseRowNumber = getWorkbookSideRowNumber(renderRow.row, 'base');
        const mineRowNumber = getWorkbookSideRowNumber(renderRow.row, 'mine');
        const baseEntry = baseRowNumber != null
          ? baseRowEntryByRowNumber.get(baseRowNumber)
            ?? buildWorkbookRowEntry(renderRow.row, 'base', sheetName, baseVersion, visibleColumns)
          : null;
        const mineEntry = mineRowNumber != null
          ? mineRowEntryByRowNumber.get(mineRowNumber)
            ?? buildWorkbookRowEntry(renderRow.row, 'mine', sheetName, mineVersion, visibleColumns)
          : null;
        const rowDelta = compareStateByRow.get(renderRow.row)
          ?? buildWorkbookSplitRowCompareState(
            renderRow.row,
            visibleColumns,
            compareMode,
          );
        const hasBaseRow = Boolean(baseEntry);
        const hasMineRow = Boolean(mineEntry);
        const isHeaderRow = headerRowNumber > 0 && (
          baseEntry?.rowNumber === headerRowNumber
          || mineEntry?.rowNumber === headerRowNumber
        );
        const rowHighlightBg = resolveWorkbookRowSurfaceBackground({
          theme: T,
          isGuided: renderRow.isGuided,
          isActiveSearch: renderRow.isActiveSearch,
          isSearchMatch: renderRow.isSearchMatch,
          isHeaderRow,
        });
        const frame = {
          sourceRowIndex,
          top: cursorY,
          renderRow,
          baseEntry,
          mineEntry,
          rowDelta,
          hasBaseRow,
          hasMineRow,
          rowHighlightBg,
        };
        cursorY += renderRow.height;
        return frame;
      });

      const rowFrameBySourceIndex = new Map(rowFrames.map((rowFrame) => [rowFrame.sourceRowIndex, rowFrame]));
      const rowOffsetTops = rowFrames.map((rowFrame) => rowFrame.top);
      const runtime: CanvasGroupRuntime = {
        frame: groupFrame,
        rowFrames,
        rowFrameBySourceIndex,
        visibleBandsBySourceRowIndex: new Map<number, {
          base?: { top: number; height: number };
          mine?: { top: number; height: number };
        }>(),
        renderedRowNumbers: {
          base: groupFrame.baseTrack.map((track) => track.rowNumber),
          mine: groupFrame.mineTrack.map((track) => track.rowNumber),
        },
        bandPositionBySideRowNumber: {
          base: new Map<number, { top: number; height: number }>(),
          mine: new Map<number, { top: number; height: number }>(),
        },
      };

      groupFrame.baseTrack.forEach((track) => {
        const top = rowOffsetTops[track.sourceRowIndex] ?? groupFrame.top;
        runtime.bandPositionBySideRowNumber.base.set(track.rowNumber, {
          top,
          height: ROW_H,
        });
        const visibleBands = runtime.visibleBandsBySourceRowIndex.get(track.sourceRowIndex) ?? {};
        visibleBands.base = { top, height: ROW_H };
        runtime.visibleBandsBySourceRowIndex.set(track.sourceRowIndex, visibleBands);
      });

      groupFrame.mineTrack.forEach((track) => {
        const rowFrame = rowFrameBySourceIndex.get(track.sourceRowIndex);
        const baseTop = rowOffsetTops[track.sourceRowIndex] ?? groupFrame.top;
        const top = rowFrame && rowFrame.renderRow.height > ROW_H ? baseTop + ROW_H : baseTop;
        runtime.bandPositionBySideRowNumber.mine.set(track.rowNumber, {
          top,
          height: ROW_H,
        });
        const visibleBands = runtime.visibleBandsBySourceRowIndex.get(track.sourceRowIndex) ?? {};
        if (rowFrame && getWorkbookStackedVisibleBands(
          Boolean(rowFrame.baseEntry),
          Boolean(rowFrame.mineEntry),
          rowFrame.renderRow.height,
        ).mine) {
          visibleBands.mine = { top, height: ROW_H };
          runtime.visibleBandsBySourceRowIndex.set(track.sourceRowIndex, visibleBands);
        }
      });

      rowFrames.forEach((rowFrame) => {
        const visibleBandPlan = getWorkbookStackedVisibleBands(
          Boolean(rowFrame.baseEntry),
          Boolean(rowFrame.mineEntry),
          rowFrame.renderRow.height,
        );
        const visibleBands = runtime.visibleBandsBySourceRowIndex.get(rowFrame.sourceRowIndex) ?? {};
        if (visibleBandPlan.base) {
          visibleBands.base ??= { top: rowFrame.top, height: ROW_H };
        }
        if (visibleBandPlan.mine) {
          visibleBands.mine ??= {
            top: rowFrame.renderRow.height > ROW_H ? rowFrame.top + ROW_H : rowFrame.top,
            height: ROW_H,
          };
        }
        runtime.visibleBandsBySourceRowIndex.set(rowFrame.sourceRowIndex, visibleBands);
      });

      return runtime;
    });
  }, [
    T,
    baseRowEntryByRowNumber,
    baseVersion,
    compareMode,
    compareStateByRow,
    groupFrames,
    headerRowNumber,
    mineRowEntryByRowNumber,
    mineVersion,
    sheetName,
    visibleColumns,
  ]);
  const groupRuntimeByKey = useMemo(
    () => new Map(groupRuntimes.map((runtime) => [runtime.frame.key, runtime])),
    [groupRuntimes],
  );
  const hitRowFrames = useMemo<CanvasHitRowFrame[]>(() => (
    groupRuntimes.flatMap((groupRuntime) => groupRuntime.rowFrames.map((rowFrame) => ({
      groupRuntime,
      rowFrame,
      top: rowFrame.top,
      bottom: rowFrame.top + rowFrame.renderRow.height,
    })))
  ), [groupRuntimes]);
  const renderBands = useMemo(() => {
    const bands: CanvasBand[] = [];

    groupRuntimes.forEach((runtime) => {
      const groupBands: CanvasBand[] = [];

      runtime.rowFrames.forEach((rowFrame) => {
        const visibleBands = runtime.visibleBandsBySourceRowIndex.get(rowFrame.sourceRowIndex) ?? {};
        const hasCompanionBand = Boolean(visibleBands.base && visibleBands.mine);
        const useSideAccentForChanges = hasCompanionBand;

        if (visibleBands.base) {
          const tone: CanvasBand['tone'] = (rowFrame.renderRow.row.workbookArtifactRow?.kind === 2 || rowFrame.renderRow.row.left?.type === 'delete')
            ? 'delete'
            : (!rowFrame.baseEntry && (rowFrame.renderRow.row.workbookArtifactRow?.kind === 1 || rowFrame.renderRow.row.right?.type === 'add'))
            ? 'add'
            : 'neutral';

          groupBands.push({
            groupKey: runtime.frame.key,
            entry: rowFrame.baseEntry,
            displayRowNumber: getWorkbookStackedBandDisplayRowNumber(
              'base',
              rowFrame.baseEntry?.rowNumber ?? null,
              rowFrame.mineEntry?.rowNumber ?? null,
            ),
            side: 'base',
            tone,
            hasCompanionBand,
            useSideAccentForChanges,
            compareCells: rowFrame.rowDelta.cellDeltas,
            hasBaseRow: rowFrame.hasBaseRow,
            hasMineRow: rowFrame.hasMineRow,
            y: visibleBands.base.top,
            height: ROW_H,
            isGuided: rowFrame.renderRow.isGuided,
            isSearchMatch: rowFrame.renderRow.isSearchMatch,
            isActiveSearch: rowFrame.renderRow.isActiveSearch,
            rowHighlightBg: rowFrame.rowHighlightBg,
          });
        }

        if (visibleBands.mine) {
          const tone: CanvasBand['tone'] = (rowFrame.renderRow.row.workbookArtifactRow?.kind === 1 || rowFrame.renderRow.row.right?.type === 'add')
            ? 'add'
            : (!rowFrame.mineEntry && (rowFrame.renderRow.row.workbookArtifactRow?.kind === 2 || rowFrame.renderRow.row.left?.type === 'delete'))
            ? 'delete'
            : 'neutral';

          groupBands.push({
            groupKey: runtime.frame.key,
            entry: rowFrame.mineEntry,
            displayRowNumber: getWorkbookStackedBandDisplayRowNumber(
              'mine',
              rowFrame.baseEntry?.rowNumber ?? null,
              rowFrame.mineEntry?.rowNumber ?? null,
            ),
            side: 'mine',
            tone,
            hasCompanionBand,
            useSideAccentForChanges,
            compareCells: rowFrame.rowDelta.cellDeltas,
            hasBaseRow: rowFrame.hasBaseRow,
            hasMineRow: rowFrame.hasMineRow,
            y: visibleBands.mine.top,
            height: ROW_H,
            isGuided: rowFrame.renderRow.isGuided,
            isSearchMatch: rowFrame.renderRow.isSearchMatch,
            isActiveSearch: rowFrame.renderRow.isActiveSearch,
            rowHighlightBg: rowFrame.rowHighlightBg,
          });
        }
      });

      groupBands.sort((left, right) => (
        left.y - right.y
        || (left.side === right.side ? 0 : left.side === 'base' ? -1 : 1)
      ));
      bands.push(...groupBands);
    });

    return bands;
  }, [groupRuntimes]);

  const columnPartition = useMemo(() => {
    const frozenEntries = renderColumns.filter(column => column.position < freezeColumnCount);
    const floatingEntries = renderColumns.filter(column => column.position >= freezeColumnCount);
    const frozenWidth = frozenEntries.reduce((sum, entry) => sum + entry.displayWidth, 0);
    const contentLeft = LN_W + 3;
    return { frozenEntries, floatingEntries, frozenWidth, contentLeft };
  }, [renderColumns, freezeColumnCount]);
  const bitmapCacheEnabled = !dragPreviewActive && Object.keys(motionByRegion).length === 0;
  const bitmapCacheBaseKey = useMemo(() => buildWorkbookCanvasBitmapCacheKey('stacked', [
    sheetName,
    baseVersion,
    mineVersion,
    groups.map(group => `${group.key}:${group.rows.map(row => `${row.row.lineIdx}:${row.renderMode}:${Number(row.isSearchMatch)}:${Number(row.isActiveSearch)}:${Number(row.isGuided)}:${Number(row.isGuidedStart)}:${Number(row.isGuidedEnd)}`).join(',')}`).join(';'),
    viewportWidth,
    totalHeight,
    freezeColumnCount,
    headerRowNumber,
    fontSize,
    compareMode,
    selection,
    T,
    baseMergedRanges,
    mineMergedRanges,
    baseRowEntryByRowNumber,
    mineRowEntryByRowNumber,
    compareStateByRow,
    baseCompareCellsByRowNumber,
    mineCompareCellsByRowNumber,
    maskedRegions,
    motionByRegion,
  ]), [T, baseCompareCellsByRowNumber, baseMergedRanges, baseRowEntryByRowNumber, baseVersion, compareMode, compareStateByRow, fontSize, freezeColumnCount, groups, headerRowNumber, maskedRegions, mineCompareCellsByRowNumber, mineMergedRanges, mineRowEntryByRowNumber, mineVersion, motionByRegion, selection, sheetName, totalHeight, viewportWidth]);

  const hitColumnFramesCacheRef = useRef<{
    columnPartition: typeof columnPartition;
    scrollLeft: number;
    frames: WorkbookCanvasHitColumnFrame[];
  } | null>(null);

  const getHitColumnFrames = useCallback((currentScrollLeft: number): WorkbookCanvasHitColumnFrame[] => {
    const cached = hitColumnFramesCacheRef.current;
    if (cached?.columnPartition === columnPartition && cached.scrollLeft === currentScrollLeft) {
      return cached.frames;
    }

    const { contentLeft, frozenEntries, floatingEntries, frozenWidth } = columnPartition;
    const frames = buildWorkbookCanvasHitColumnFrames({
      contentLeft,
      frozenEntries,
      floatingEntries,
      frozenWidth,
      scrollLeft: currentScrollLeft,
    });
    hitColumnFramesCacheRef.current = {
      columnPartition,
      scrollLeft: currentScrollLeft,
      frames,
    };
    return frames;
  }, [columnPartition]);

  const drawRef = useRef<(reason?: WorkbookStackedCanvasDrawReason) => void>(() => {});

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = (reason: WorkbookStackedCanvasDrawReason = 'full') => {
      const dpr = getWorkbookCanvasDevicePixelRatio();
      const width = Math.max(1, Math.ceil(viewportWidth));
      const height = Math.max(1, Math.ceil(totalHeight));
      const currentScrollLeft = scrollRef.current?.scrollLeft ?? 0;
      const contentRight = Math.min(width, contentWidth);
      const previousPixelWidth = canvas.width;
      const previousPixelHeight = canvas.height;
      syncWorkbookCanvasSurface(canvas, width, height, dpr);
      const fullDraw = reason === 'full'
        || previousPixelWidth !== canvas.width
        || previousPixelHeight !== canvas.height;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const viewportColumnKey = buildWorkbookCanvasBitmapViewportColumnKey(
        getHitColumnFrames(currentScrollLeft),
        width,
      );
      const bitmapCacheKey = `${bitmapCacheBaseKey}|columns:${viewportColumnKey}|x:${currentScrollLeft.toFixed(2)}`;
      if (bitmapCacheEnabled && restoreWorkbookCanvasBitmap(canvas, bitmapCacheKey)) return;

      ctx.save();
      ctx.scale(dpr, dpr);
      if (fullDraw) {
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = T.workbookCanvasBg;
        ctx.fillRect(0, 0, width, height);
      }
      const floatingMergedDraws: Array<() => void> = [];
      const frozenMergedDraws: Array<() => void> = [];
      const deferredSelectionDraws = {
        floating: [] as Array<() => void>,
        frozen: [] as Array<() => void>,
      };
      const scrollBorderRegistry = createWorkbookCanvasBorderRegistry();
      const frozenBorderRegistry = createWorkbookCanvasBorderRegistry();

      const { frozenWidth, contentLeft, frozenEntries, floatingEntries } = columnPartition;
      const layerViewports = getWorkbookCanvasLayerViewports({
        contentLeft,
        contentRight,
        frozenWidth,
      });
      const scrollViewport = layerViewports.scroll ?? (fullDraw ? layerViewports.content : null);
      if (!scrollViewport) {
        ctx.restore();
        return;
      }
      const drawBandChrome = (band: CanvasBand, bandIndex: number) => {
        const entry = band.entry;
        const y = band.y;
        const h = band.height;
        const rowNumber = band.displayRowNumber ?? entry?.rowNumber ?? 0;
        const previousBand = bandIndex > 0 ? renderBands[bandIndex - 1] : null;
        const previousBandRowNumber = previousBand
          ? previousBand.displayRowNumber ?? previousBand.entry?.rowNumber ?? null
          : headerRowNumber > 0 && rowNumber > headerRowNumber
            ? headerRowNumber
            : null;
        const previousVisibleRowNumber = previousBandRowNumber === rowNumber
          ? rowNumber
          : previousBandRowNumber;
        const isHeaderRow = headerRowNumber > 0 && (
          entry?.rowNumber === headerRowNumber
          || band.displayRowNumber === headerRowNumber
        );
        const rowBg = band.rowHighlightBg ?? T.workbookCanvasBg;
        const selectionAccent = resolveWorkbookRowSelectionAccent(T, band.side);
        const sideAccent = band.useSideAccentForChanges ? band.side : null;
        const bandRule = resolveWorkbookRowRuleColor(T, band.tone, sideAccent);
        const isSelectedRow = Boolean(
          selectionLookup.rowKeys.has(`${sheetName}:${rowNumber}`),
        );
        const lineNumberTone = resolveWorkbookStackedLineNumberTone({
          side: band.side,
          hasCompanionBand: band.hasCompanionBand,
          tone: band.tone,
          hasBaseRow: band.hasBaseRow,
          hasMineRow: band.hasMineRow,
        });

        ctx.fillStyle = rowBg;
        ctx.fillRect(0, y, contentLeft, h);

        ctx.fillStyle = resolveWorkbookRowGutterBackground({
          theme: T,
          selectionAccent,
          isSelected: isSelectedRow,
          isHeaderRow,
          versionSide: band.side,
        });
        ctx.fillRect(3, y, LN_W, h);
        ctx.fillStyle = resolveWorkbookVersionAccent(T, band.side);
        ctx.fillRect(0, y, 3, h);
        ctx.strokeStyle = bandRule;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(contentRight, y + 0.5);
        ctx.stroke();

        if (isSelectedRow) {
          ctx.strokeStyle = `${selectionAccent}a6`;
          ctx.lineWidth = 2;
          ctx.strokeRect(4, y + 1, LN_W - 2, h - 2);
          ctx.lineWidth = 1;
        }

        ctx.fillStyle = isSelectedRow
          ? selectionAccent
          : resolveWorkbookRowLineNumberColor({
            theme: T,
            tone: band.useSideAccentForChanges ? 'equal' : band.tone,
            fallbackTone: lineNumberTone,
            active: band.isActiveSearch,
          });
        ctx.font = `${isHeaderRow ? '600 ' : ''}${sizes.line}px ${FONT_CODE}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          formatWorkbookVisibleRowNumber(rowNumber, previousVisibleRowNumber),
          LN_W - 8,
          y + (h / 2),
        );
      };
      const drawBandCells = (
        band: CanvasBand,
        entries: HorizontalVirtualColumnEntry[],
        layer: 'floating' | 'frozen',
      ) => {
        const entry = band.entry;
        const y = band.y;
        const h = band.height;
        const groupRuntime = groupRuntimeByKey.get(band.groupKey);
        if (!groupRuntime) return;
        const rowNumber = entry?.rowNumber ?? 0;
        const displayRowNumber = band.displayRowNumber ?? rowNumber;
        const cellTextColor = band.side === 'mine' ? T.t0 : T.t1;
        const deferredMergedDraws = layer === 'floating' ? floatingMergedDraws : frozenMergedDraws;
        const deferredSelectionDrawBucket = layer === 'floating'
          ? deferredSelectionDraws.floating
          : deferredSelectionDraws.frozen;
        const borderRegistry = layer === 'floating' ? scrollBorderRegistry : frozenBorderRegistry;
        const drawCell = (entryMeta: HorizontalVirtualColumnEntry, drawX: number) => {
          if (drawX >= contentRight || drawX + entryMeta.width <= contentLeft) return;

          if (!entry) {
            const compareCell = band.compareCells.get(entryMeta.column);
            const placeholderCell = band.side === 'base'
              ? compareCell?.baseCell
              : compareCell?.mineCell;
            const cell = placeholderCell ?? { value: '', formula: '' };
            const hasContent = hasWorkbookCellContent(cell, compareMode);
            const isHeaderRow = headerRowNumber > 0 && displayRowNumber === headerRowNumber;
            const cellVisual = resolveWorkbookCompareCellVisual({
              theme: T,
              compareCell,
              side: band.side,
              isHeaderRow,
              hasEntry: false,
              hasContent,
              hasBaseRow: band.hasBaseRow,
              hasMineRow: band.hasMineRow,
              defaultTextColor: cellTextColor,
            });
            const versionIdentity = resolveWorkbookVersionIdentityVisual(
              T,
              band.side,
              Boolean(compareCell?.changed),
              isHeaderRow ? 'header' : 'body',
            );
            const selectionVisual = getWorkbookSelectionVisualState(
              T,
              selectionLookup,
              sheetName,
              band.side,
              displayRowNumber,
              entryMeta.column,
              band.isActiveSearch,
              dragPreviewActive,
              {
                startRow: displayRowNumber,
                endRow: displayRowNumber,
                startColumn: entryMeta.column,
                endColumn: entryMeta.column,
              },
            );
            const selectionBorder = getWorkbookSelectionBorderVisual(selectionVisual);
            const maskedRegionId = getWorkbookMaskedRegionId(maskedRegions, band.side, displayRowNumber, entryMeta.column);
            const maskOpacity = resolveWorkbookMaskedCellOpacity({
              maskedRegionId,
              motion: maskedRegionId ? motionByRegion[maskedRegionId] : undefined,
              rowNumber: displayRowNumber,
              column: entryMeta.column,
              isHeaderRow,
              isSearchMatch: band.isSearchMatch || band.isActiveSearch,
            });

            ctx.fillStyle = cellVisual.background;
            ctx.fillRect(drawX, y, entryMeta.width, h);
            if (versionIdentity.overlay) {
              ctx.fillStyle = versionIdentity.overlay;
              ctx.fillRect(drawX, y, entryMeta.width, h);
            }
            if (versionIdentity.rail && !selectionVisual.hasSelectionHighlight) {
              ctx.fillStyle = versionIdentity.rail;
              ctx.fillRect(drawX, y, versionIdentity.railWidth, h);
            }
            if (cellVisual.maskOverlay) {
              ctx.fillStyle = cellVisual.maskOverlay;
              ctx.fillRect(drawX, y, entryMeta.width, h);
            }
            registerWorkbookCanvasCellBorders({
              registry: borderRegistry,
              x: drawX,
              y,
              width: entryMeta.width,
              height: h,
              semantic: {
                color: cellVisual.border,
                thickness: 1,
                priority: resolveWorkbookCanvasCellBorderPriority(compareCell, false),
              },
              selection: selectionBorder,
            });
            deferredSelectionDrawBucket.push(() => {
              drawWorkbookCanvasSelectionFrame(
                ctx,
                drawX,
                y,
                entryMeta.width,
                h,
                selectionVisual,
              );
            });

            if (hasContent) {
              const textRect = getWorkbookCanvasTextInsetRect(drawX, y, entryMeta.width, h);
              ctx.save();
              ctx.beginPath();
              ctx.rect(textRect.left, textRect.top, textRect.width, textRect.height);
              ctx.clip();
              ctx.fillStyle = cellVisual.textColor;
              ctx.font = `${isHeaderRow ? '600 ' : ''}${sizes.ui}px ${FONT_UI}`;
              ctx.textAlign = 'left';
              ctx.textBaseline = 'alphabetic';
              drawWorkbookCanvasComparedCellText({
                ctx,
                value: cell.value,
                compareCell,
                side: band.side,
                theme: T,
                x: textRect.left,
                baselineY: getWorkbookCanvasTextBaselineY(ctx, y + (h / 2), sizes.ui),
                fallbackFontSize: sizes.ui,
                textColor: cellVisual.textColor,
              });
              ctx.restore();
            }
            if (maskOpacity > 0.001) {
              drawWorkbookMaskedCellSegments(
                ctx,
                [{ left: drawX, width: entryMeta.width }],
                [{ top: y, height: h }],
                T,
                maskOpacity,
              );
            }
            return;
          }

          const column = entryMeta.column;
          const mergedRanges = band.side === 'base' ? baseMergedRanges : mineMergedRanges;
          const renderedRowNumbers = groupRuntime?.renderedRowNumbers[band.side] ?? [];
          const bandPositions = groupRuntime?.bandPositionBySideRowNumber[band.side]
            ?? new Map<number, { top: number; height: number }>();
          const mergeInfo = getWorkbookMergeDrawInfo({
            rowNumber,
            column,
            rowTop: y,
            rowHeight: h,
            renderedRowNumbers,
            rowLayoutByRowNumber: bandPositions,
            renderedColumns: renderedColumnNumbers,
            mergedRanges,
            columnLayoutByColumn,
            contentLeft,
            currentScrollLeft,
            freezeColumnCount,
            frozenWidth,
            mode: 'single',
            layer: layer === 'frozen' ? 'frozen' : 'scroll',
          });
          if (mergeInfo.covered && !mergeInfo.region) return;

          // The merge anchor may live in a different virtual group. Keep its
          // value and comparison state while clipping drawing to this group.
          const rowEntryByRowNumber = band.side === 'base' ? baseRowEntryByRowNumber : mineRowEntryByRowNumber;
          const compareCellsByRowNumber = band.side === 'base' ? baseCompareCellsByRowNumber : mineCompareCellsByRowNumber;
          const anchor = resolveWorkbookCanvasAnchor({ entry, rowEntryByRowNumber, column, mergeRange: mergeInfo.region?.range ?? null });
          const anchorRowNumber = anchor.rowNumber;
          const anchorColumn = anchor.column;
          const anchorEntry = anchor.entry;
          const isHeaderRow = headerRowNumber > 0 && anchorRowNumber === headerRowNumber;
          const cell = anchorEntry?.cells[anchorColumn] ?? { value: getWorkbookPendingCellPaint(anchorEntry, anchorColumn), formula: '' };
          const compareCell = resolveWorkbookCanvasCompareCell({
            compareCellsByRowNumber,
            rowCompareCells: band.compareCells,
            anchorRowNumber,
            column,
            mergeRange: mergeInfo.region?.range ?? null,
          });
          const hasContent = hasWorkbookCellContent(cell, compareMode);
          const selectionRowNumber = anchorRowNumber;
          const selectionColumn = anchorColumn;
          const selectionVisual = getWorkbookSelectionVisualState(
            T,
            selectionLookup,
            sheetName,
            band.side,
            selectionRowNumber,
            selectionColumn,
            band.isActiveSearch,
            dragPreviewActive,
            {
              startRow: mergeInfo.region?.range.startRow ?? selectionRowNumber,
              endRow: mergeInfo.region?.range.endRow ?? selectionRowNumber,
              startColumn: mergeInfo.region?.range.startCol ?? selectionColumn,
              endColumn: mergeInfo.region?.range.endCol ?? selectionColumn,
            },
          );
          const selectionBorder = getWorkbookSelectionBorderVisual(selectionVisual);
          const cellVisual = resolveWorkbookCompareCellVisual({
            theme: T,
            compareCell,
            side: band.side,
            isHeaderRow,
            hasEntry: true,
            hasContent,
            hasBaseRow: band.hasBaseRow,
            hasMineRow: band.hasMineRow,
            defaultTextColor: cellTextColor,
          });
          const versionIdentity = resolveWorkbookVersionIdentityVisual(
            T,
            band.side,
            Boolean(compareCell?.changed),
            isHeaderRow ? 'header' : 'body',
          );
          const maskedRegionId = getWorkbookMaskedRegionId(maskedRegions, band.side, anchorRowNumber, anchorColumn);
          const maskOpacity = resolveWorkbookMaskedCellOpacity({
            maskedRegionId,
            motion: maskedRegionId ? motionByRegion[maskedRegionId] : undefined,
            rowNumber: anchorRowNumber,
            column: anchorColumn,
            isHeaderRow,
            isSearchMatch: band.isSearchMatch || band.isActiveSearch,
          });
          const mergedRegion = mergeInfo.region;
          const rowSegments = mergedRegion?.rowSegments ?? [{ top: y, height: h }];
          const regionLeft = mergeInfo.region?.left ?? drawX;
          const regionWidth = mergeInfo.region?.width ?? entryMeta.width;
          const regionBounds = getWorkbookCanvasRowSegmentBounds(rowSegments);
          const regionTop = regionBounds?.top ?? (mergeInfo.region?.top ?? y);
          const regionHeight = regionBounds?.height ?? (mergeInfo.region?.height ?? h);
          const regionSegments = mergeInfo.region?.segments ?? [{ left: regionLeft, width: regionWidth }];
          const textRowSegments = mergedRegion
            ? rowSegments.slice(0, 1)
            : rowSegments;
          const anchorRowSegment = rowSegments[0] ?? { top: regionTop, height: regionHeight };
          const continuationRowSegments = rowSegments.slice(1);
          const textCenterY = getWorkbookCanvasRowSegmentCenterY(textRowSegments) ?? (regionTop + (regionHeight / 2));
          const textRect = getWorkbookCanvasTextInsetRect(regionLeft, regionTop, regionWidth, regionHeight);
          const textX = textRect.left;
          const centerMergedText = Boolean(mergeInfo.region && regionSegments.length === 1);
          const withRowSegmentClip = (targetRowSegments: typeof rowSegments, callback: () => void) => {
            ctx.save();
            ctx.beginPath();
            targetRowSegments.forEach((rowSegment) => {
              regionSegments.forEach((segment) => {
                ctx.rect(segment.left, rowSegment.top, segment.width, rowSegment.height);
              });
            });
            ctx.clip();
            callback();
            ctx.restore();
          };
          const withRegionClip = (callback: () => void) => withRowSegmentClip(rowSegments, callback);

          const paintRegion = () => {
            ctx.fillStyle = cellVisual.background;
            withRegionClip(() => {
              regionSegments.forEach((segment) => {
                ctx.fillRect(segment.left, regionTop, segment.width, regionHeight);
              });
            });
            if (versionIdentity.overlay) {
              ctx.fillStyle = versionIdentity.overlay;
              withRegionClip(() => {
                regionSegments.forEach((segment) => {
                  ctx.fillRect(segment.left, regionTop, segment.width, regionHeight);
                });
              });
            }
            if (versionIdentity.rail && !selectionVisual.hasSelectionHighlight) {
              ctx.fillStyle = versionIdentity.rail;
              withRegionClip(() => {
                rowSegments.forEach((rowSegment) => {
                  regionSegments.forEach((segment) => {
                    ctx.fillRect(segment.left, rowSegment.top, versionIdentity.railWidth, rowSegment.height);
                  });
                });
              });
            }
            if (cellVisual.maskOverlay) {
              ctx.fillStyle = cellVisual.maskOverlay;
              withRegionClip(() => {
                regionSegments.forEach((segment) => {
                  ctx.fillRect(segment.left, regionTop, segment.width, regionHeight);
                });
              });
            }
            const selectionOverlay = getWorkbookSelectionOverlay(selectionVisual);
            if (selectionOverlay) {
              ctx.fillStyle = selectionOverlay;
              withRegionClip(() => {
                regionSegments.forEach((segment) => {
                  ctx.fillRect(segment.left, regionTop, segment.width, regionHeight);
                });
              });
            }
            if (continuationRowSegments.length > 0) {
              const continuationVisual = getWorkbookMergeContinuationVisual(T, cellVisual.border);
              withRowSegmentClip([anchorRowSegment], () => {
                regionSegments.forEach((segment) => {
                  registerWorkbookCanvasCellBorders({
                    registry: borderRegistry,
                    x: segment.left,
                    y: anchorRowSegment.top,
                    width: segment.width,
                    height: anchorRowSegment.height,
                    semantic: {
                      color: cellVisual.border,
                      thickness: 1,
                      priority: resolveWorkbookCanvasCellBorderPriority(compareCell, true),
                    },
                    selection: selectionBorder,
                  });
                });
              });
              ctx.fillStyle = continuationVisual.background;
              continuationRowSegments.forEach((rowSegment) => {
                regionSegments.forEach((segment) => {
                  ctx.fillRect(segment.left, rowSegment.top, segment.width, rowSegment.height);
                });
              });
              ctx.strokeStyle = continuationVisual.guideStroke;
              ctx.lineWidth = 1;
              continuationRowSegments.forEach((rowSegment) => {
                regionSegments.forEach((segment) => {
                  ctx.beginPath();
                  ctx.moveTo(segment.left + 1.5, rowSegment.top + 1.5);
                  ctx.lineTo(segment.left + 1.5, rowSegment.top + rowSegment.height - 1.5);
                  ctx.stroke();
                });
              });
            } else {
              withRegionClip(() => {
                regionSegments.forEach((segment) => {
                  registerWorkbookCanvasCellBorders({
                    registry: borderRegistry,
                    x: segment.left,
                    y: regionTop,
                    width: segment.width,
                    height: regionHeight,
                    semantic: {
                      color: cellVisual.border,
                      thickness: 1,
                      priority: resolveWorkbookCanvasCellBorderPriority(compareCell, true),
                    },
                    selection: selectionBorder,
                  });
                });
              });
            }
            deferredSelectionDrawBucket.push(() => {
              withRowSegmentClip([anchorRowSegment], () => {
                regionSegments.forEach((segment) => {
                  drawWorkbookCanvasSelectionFrame(
                    ctx,
                    segment.left,
                    anchorRowSegment.top,
                    segment.width,
                    anchorRowSegment.height,
                    selectionVisual,
                  );
                });
              });
              if (continuationRowSegments.length > 0 && selectionVisual.hasSelectionHighlight) {
                ctx.save();
                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = `${selectionVisual.accent}55`;
                ctx.lineWidth = 1;
                continuationRowSegments.forEach((rowSegment) => {
                  regionSegments.forEach((segment) => {
                    ctx.strokeRect(
                      segment.left + 1.5,
                      rowSegment.top + 1.5,
                      Math.max(0, segment.width - 3),
                      Math.max(0, rowSegment.height - 3),
                    );
                  });
                });
                ctx.restore();
              }
            });

            ctx.save();
            ctx.beginPath();
            textRowSegments.forEach((rowSegment) => {
              regionSegments.forEach((segment) => {
                const insetRect = getWorkbookCanvasTextInsetRect(
                  segment.left,
                  rowSegment.top,
                  segment.width,
                  rowSegment.height,
                );
                ctx.rect(insetRect.left, insetRect.top, insetRect.width, insetRect.height);
              });
            });
            ctx.clip();
            ctx.fillStyle = cellVisual.textColor;
            ctx.font = `${isHeaderRow ? '600 ' : ''}${sizes.ui}px ${FONT_UI}`;
            ctx.textBaseline = 'alphabetic';
            if (centerMergedText) {
              const lineHeight = Math.max(sizes.ui + 4, 16);
              const maxLines = Math.max(1, textRowSegments.reduce((sum, rowSegment) => (
                sum + Math.max(1, Math.floor(Math.max(0, rowSegment.height - 4) / lineHeight))
              ), 0));
              const lines = layoutWorkbookCanvasTextLines({
                value: cell.value || '',
                maxWidth: textRect.width,
                maxLines,
                measureText: (value) => ctx.measureText(value).width,
              });
              ctx.textAlign = 'center';
              const lineCenters = getWorkbookCanvasRowSegmentLineCenters(textRowSegments, lines.length, lineHeight);
              lines.forEach((line, index) => {
                ctx.fillText(
                  line,
                  regionLeft + (regionWidth / 2),
                  getWorkbookCanvasTextBaselineY(ctx, lineCenters[index] ?? textCenterY, sizes.ui),
                );
              });
            } else {
              ctx.textAlign = 'left';
              drawWorkbookCanvasComparedCellText({
                ctx,
                value: cell.value,
                compareCell,
                side: band.side,
                theme: T,
                x: textX,
                baselineY: getWorkbookCanvasTextBaselineY(ctx, textCenterY, sizes.ui),
                fallbackFontSize: sizes.ui,
                textColor: cellVisual.textColor,
              });
            }
            ctx.restore();
            if (maskOpacity > 0.001) {
              drawWorkbookMaskedCellSegments(ctx, regionSegments, rowSegments, T, maskOpacity);
            }
          };

          if (mergeInfo.region) {
            deferredMergedDraws.push(paintRegion);
            return;
          }

          paintRegion();
        };

        entries.forEach((columnEntry) => {
          if (layer === 'frozen') {
            const frozenX = contentLeft + columnEntry.offset;
            if (frozenX > contentRight) return;
            drawCell(columnEntry, frozenX);
            return;
          }

          const x = contentLeft + columnEntry.offset - currentScrollLeft;
          if (x > contentRight || x + columnEntry.width <= contentLeft) return;
          drawCell(columnEntry, x);
        });
      };
      const drawBandBackdrops = (viewport: { left: number; width: number }) => {
        if (viewport.width <= 0) return;
        renderBands.forEach((band) => {
          const sideAccent = band.useSideAccentForChanges ? band.side : null;
          paintWorkbookCanvasBackdrop(
            ctx,
            { left: viewport.left, top: band.y, width: viewport.width, height: band.height },
            T.workbookCanvasBg,
            band.rowHighlightBg ?? T.workbookCanvasBg,
          );
          ctx.strokeStyle = resolveWorkbookRowRuleColor(T, band.tone, sideAccent);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(viewport.left, band.y + 0.5);
          ctx.lineTo(viewport.left + viewport.width, band.y + 0.5);
          ctx.stroke();
        });
      };

      if (fullDraw) {
        renderBands.forEach(drawBandChrome);
      }

      if (scrollViewport.width > 0) {
        ctx.clearRect(scrollViewport.left, 0, scrollViewport.width, height);
        ctx.fillStyle = T.workbookCanvasBg;
        ctx.fillRect(scrollViewport.left, 0, scrollViewport.width, height);
        drawBandBackdrops(scrollViewport);
        renderBands.forEach((band) => {
          clipWorkbookCanvasToViewport(ctx, scrollViewport, band.y, band.height, () => {
            drawBandCells(band, floatingEntries, 'floating');
          });
        });
      }

      if (floatingMergedDraws.length > 0 && scrollViewport.width > 0) {
        clipWorkbookCanvasToViewport(ctx, scrollViewport, 0, height, () => {
          floatingMergedDraws.forEach((paintRegion) => paintRegion());
        });
      }

      const frozenViewport = layerViewports.frozen;

      if (fullDraw) {
        if (frozenViewport) {
          drawBandBackdrops(frozenViewport);
          renderBands.forEach((band) => {
            clipWorkbookCanvasToViewport(ctx, frozenViewport, band.y, band.height, () => {
              drawBandCells(band, frozenEntries, 'frozen');
            });
          });
        }

        if (frozenMergedDraws.length > 0 && frozenViewport) {
          clipWorkbookCanvasToViewport(ctx, frozenViewport, 0, height, () => {
            frozenMergedDraws.forEach((paintRegion) => paintRegion());
          });
        }
      }

      renderBands.forEach((band) => {
        const isHeaderRow = headerRowNumber > 0 && (
          band.entry?.rowNumber === headerRowNumber
          || band.displayRowNumber === headerRowNumber
        );
        if (!isHeaderRow) return;
        ctx.fillStyle = resolveWorkbookHeaderRowDividerColor(T);
        ctx.fillRect(0, band.y + band.height - 2, contentRight, 2);
      });
      if (renderBands.length > 0) {
        const terminalBoundaryRight = frozenViewport
          ? frozenViewport.left + frozenViewport.width
          : contentLeft;
        ctx.fillStyle = T.workbookGridBorderStrong;
        ctx.fillRect(0, height - 1, terminalBoundaryRight, 1);
      }
      if (scrollViewport.width > 0) {
        clipWorkbookCanvasToViewport(ctx, scrollViewport, 0, height, () => {
          scrollBorderRegistry.flush(ctx);
        });
      }
      if (fullDraw && frozenViewport) {
        clipWorkbookCanvasToViewport(ctx, frozenViewport, 0, height, () => {
          frozenBorderRegistry.flush(ctx);
        });
      }
      if (scrollViewport.width > 0) {
        clipWorkbookCanvasToViewport(ctx, scrollViewport, 0, height, () => {
          deferredSelectionDraws.floating.forEach((drawSelection) => drawSelection());
        });
      }
      if (fullDraw && frozenViewport) {
        clipWorkbookCanvasToViewport(ctx, frozenViewport, 0, height, () => {
          deferredSelectionDraws.frozen.forEach((drawSelection) => drawSelection());
        });
      }

      if (fullDraw && frozenViewport) {
        ctx.fillStyle = `${T.workbookGridBorderStrong}b8`;
        ctx.fillRect(frozenViewport.left + frozenViewport.width - 1, 0, 1, height);
      }

      ctx.restore();
      if (bitmapCacheEnabled) storeWorkbookCanvasBitmap(canvas, bitmapCacheKey);
    };

    drawRef.current = draw;
    draw();

    return undefined;
  }, [baseCompareCellsByRowNumber, baseMergedRanges, baseRowEntryByRowNumber, bitmapCacheBaseKey, bitmapCacheEnabled, columnLayoutByColumn, columnPartition, compareMode, contentWidth, dragPreviewActive, freezeColumnCount, getHitColumnFrames, groupRuntimeByKey, headerRowNumber, maskedRegions, mineCompareCellsByRowNumber, mineMergedRanges, mineRowEntryByRowNumber, motionByRegion, renderBands, renderedColumnNumbers, renderColumns, scrollRef, selectionLookup, sheetName, sizes.line, sizes.ui, T, totalHeight, viewportWidth]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    let lastScrollLeft = scroller.scrollLeft ?? 0;
    return subscribeWorkbookCanvasScrollFrame(scroller, ({ scrollLeft: nextScrollLeft }) => {
      if (nextScrollLeft === lastScrollLeft) return;
      lastScrollLeft = nextScrollLeft;
      if (hasActiveHoverRef.current()) clearHoverRef.current();
      clearMaskedRegionRef.current();
      drawRef.current('scroll');
    });
  }, [scrollRef]);

  const resolveHit = (
    x: number,
    y: number,
    canvasRect: DOMRect,
  ): { selection: WorkbookSelectedCell; hover: WorkbookCanvasHoverCell | null } | null => {
    const contentHitRight = Math.min(viewportWidth, contentWidth);
    if (x >= contentHitRight) return null;

    const { contentLeft, frozenWidth } = columnPartition;
    const currentScrollLeft = scrollRef.current?.scrollLeft ?? 0;
    const hitRowFrame = findWorkbookCanvasHitYFrame(hitRowFrames, y);
    if (!hitRowFrame) return null;

    const { groupRuntime, rowFrame } = hitRowFrame;
    const rowTop = rowFrame.top;
    const baseEntry = rowFrame.baseEntry;
    const mineEntry = rowFrame.mineEntry;
    const localY = y - rowTop;
    const visibleBands = groupRuntime.visibleBandsBySourceRowIndex.get(rowFrame.sourceRowIndex) ?? {};
    let side: 'base' | 'mine';
    let entry: WorkbookRowEntry | null;

    if (visibleBands.base && visibleBands.mine) {
      side = localY < ROW_H ? 'base' : 'mine';
      entry = side === 'base' ? baseEntry : mineEntry;
    } else if (visibleBands.mine) {
      side = 'mine';
      entry = mineEntry;
    } else {
      side = 'base';
      entry = baseEntry;
    }

    if (!entry) return null;

    const selectionKind = resolveWorkbookCanvasSelectionKind({
      hitX: x,
      contentLeft,
      rowNumber: entry.rowNumber,
      headerRowNumber,
    });
    if (selectionKind === 'row') {
      return {
        selection: {
          kind: 'row',
          sheetName,
          side,
          versionLabel: entry.versionLabel,
          rowNumber: entry.rowNumber,
          colIndex: primarySelection?.colIndex ?? 0,
          colLabel: primarySelection?.colLabel ?? 'A',
          address: `${entry.rowNumber}`,
          value: '',
          formula: '',
        },
        hover: null,
      };
    }

    const hitColumnFrame = findWorkbookCanvasHitXFrame(getHitColumnFrames(currentScrollLeft), x);
    if (!hitColumnFrame) return null;
    const hitEntry = hitColumnFrame.entry;
    const column = hitEntry.column;
    const mergedRanges = side === 'base' ? baseMergedRanges : mineMergedRanges;
    const rowEntryByRowNumber = side === 'base' ? baseRowEntryByRowNumber : mineRowEntryByRowNumber;
    const mergeRange = findWorkbookMergeRange(mergedRanges, entry.rowNumber, column);
    const anchor = resolveWorkbookCanvasAnchor({ entry, rowEntryByRowNumber, column, mergeRange });
    const anchorRowNumber = anchor.rowNumber;
    const anchorColumn = anchor.column;
    const anchorEntry = anchor.entry;
    const bounds = getWorkbookColumnSpanBounds(
      mergeRange?.startCol ?? column,
      mergeRange?.endCol ?? column,
      columnLayoutByColumn,
      'single',
      freezeColumnCount,
    );
    const spanRect = bounds
      ? getWorkbookCanvasSpanRect(bounds, contentLeft, currentScrollLeft, frozenWidth)
      : null;
    const compareCellsByRowNumber = side === 'base' ? baseCompareCellsByRowNumber : mineCompareCellsByRowNumber;
    const anchorCompareCells = compareCellsByRowNumber.get(anchorRowNumber)
      ?? rowFrame.rowDelta.cellDeltas;
    const compareCell = resolveWorkbookCanvasCompareCell({
      compareCellsByRowNumber,
      rowCompareCells: anchorCompareCells,
      anchorRowNumber,
      column,
      mergeRange,
    });
    const maskedRegionId = getWorkbookMaskedRegionId(maskedRegions, side, anchorRowNumber, anchorColumn);
    const columnX = spanRect?.left ?? hitColumnFrame.left;
    const bandY = visibleBands[side]?.top ?? rowTop;
    const renderedRowNumbers = groupRuntime.renderedRowNumbers[side] ?? [];
    const bandPositions = groupRuntime.bandPositionBySideRowNumber[side]
      ?? new Map<number, { top: number; height: number }>();
    const mergeDrawInfo = getWorkbookMergeDrawInfo({
      rowNumber: entry.rowNumber,
      column,
      rowTop: bandY,
      rowHeight: ROW_H,
      renderedRowNumbers,
      rowLayoutByRowNumber: bandPositions,
      renderedColumns: renderedColumnNumbers,
      mergedRanges,
      columnLayoutByColumn,
      contentLeft,
      currentScrollLeft,
      freezeColumnCount,
      frozenWidth,
      mode: 'single',
      layer: 'content',
    });
    const hoverRowSegments = mergeDrawInfo.region?.rowSegments ?? [{ top: bandY, height: ROW_H }];
    const columnWidth = spanRect?.width ?? (hitColumnFrame.right - hitColumnFrame.left);
    const hoverBounds = getWorkbookCanvasHoverRowSegmentBounds(hoverRowSegments, y)
      ?? { top: bandY, height: ROW_H };
    const hoverTop = hoverRowSegments.length > 1
      ? hoverBounds.top
      : (mergeDrawInfo.region?.top ?? hoverBounds.top);
    const hoverHeight = hoverRowSegments.length > 1
      ? hoverBounds.height
      : (mergeDrawInfo.region?.height ?? hoverBounds.height);
    const selected = buildWorkbookSelectedCell(anchorEntry, anchorColumn, mergedRanges);
    if (selectionKind === 'column') {
      return {
        selection: {
          kind: 'column',
          sheetName,
          side,
          versionLabel: entry.versionLabel,
          rowNumber: anchorEntry.rowNumber,
          colIndex: anchorColumn,
          colLabel: selected.colLabel,
          address: selected.colLabel,
          value: selected.value,
          formula: selected.formula,
        },
        hover: {
          key: `${side}-${anchorEntry.rowNumber}-${anchorColumn}`,
          anchorRect: {
            left: canvasRect.left + columnX,
            top: canvasRect.top + hoverTop,
            width: columnWidth,
            height: hoverHeight,
            right: canvasRect.left + columnX + columnWidth,
            bottom: canvasRect.top + hoverTop + hoverHeight,
          },
          address: selected.address,
          displayValue: selected.value,
          wrapText: Boolean(mergeDrawInfo.region),
          compareCell,
          ...(maskedRegionId ? {
            maskedRegionId,
            maskedRegionRowNumber: anchorRowNumber,
            maskedRegionColumn: anchorColumn,
          } : {}),
        },
      };
    }

    return {
      selection: selected,
      hover: {
        key: `${side}-${anchorEntry.rowNumber}-${anchorColumn}`,
        anchorRect: {
          left: canvasRect.left + columnX,
          top: canvasRect.top + hoverTop,
          width: columnWidth,
          height: hoverHeight,
          right: canvasRect.left + columnX + columnWidth,
          bottom: canvasRect.top + hoverTop + hoverHeight,
        },
        address: selected.address,
        displayValue: selected.value,
        wrapText: Boolean(mergeDrawInfo.region),
        compareCell,
        ...(maskedRegionId ? {
          maskedRegionId,
          maskedRegionRowNumber: anchorRowNumber,
          maskedRegionColumn: anchorColumn,
        } : {}),
      },
    };
  };

  const resolveHoverAtPointer = (
    canvas: HTMLCanvasElement,
    clientX: number,
    clientY: number,
  ): WorkbookCanvasHoverCell | null => {
    const canvasRect = canvas.getBoundingClientRect();
    const hit = resolveHit(
      clientX - canvasRect.left,
      clientY - canvasRect.top,
      canvasRect,
    );
    return resolveWorkbookCanvasHoverForCanvas(canvas, hit?.hover ?? null, sizes.ui);
  };

  const { handleMouseMove, clearHover, hasActiveHover } = useWorkbookCanvasHoverController(resolveHoverAtPointer, onHoverChange);
  clearHoverRef.current = clearHover;
  hasActiveHoverRef.current = hasActiveHover;
  const selectionInteractions = useWorkbookCanvasSelectionInteractions({
    canvasRef,
    resolveHit,
    onSelectionRequest,
    clearHover,
    scrollRef,
    onDragSelectingChange: setDragPreviewActive,
  });

  const handleCanvasMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (selectionInteractions.isPointerSelectingRef.current) return;
    const hover = resolveHoverAtPointer(event.currentTarget, event.clientX, event.clientY);
    const maskedRegionId = hover?.maskedRegionId ?? null;
    const origin = hover?.maskedRegionRowNumber != null && hover.maskedRegionColumn != null
      ? { rowNumber: hover.maskedRegionRowNumber, column: hover.maskedRegionColumn }
      : undefined;
    revealRegion(maskedRegionId, origin);
    if (maskedRegionId) {
      clearHover();
      return;
    }
    handleMouseMove(event);
  };

  const handleCanvasMouseLeave = useCallback(() => {
    if (selectionInteractions.isPointerSelectingRef.current) return;
    clearRegion();
    clearHover();
  }, [clearHover, clearRegion, selectionInteractions]);

  const handleContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvasRect = event.currentTarget.getBoundingClientRect();
    const hit = resolveHit(
      event.clientX - canvasRect.left,
      event.clientY - canvasRect.top,
      canvasRect,
    );
    if (!hit) return;
    event.preventDefault();
    clearHover();
    onSelectionRequest({
      target: hit.selection,
      mode: getSelectionModeFromMouseEvent(event),
      reason: 'contextmenu',
      preserveExistingIfTargetSelected: true,
      clientPoint: {
        x: event.clientX,
        y: event.clientY,
      },
    });
  };

  return (
    <canvas
      ref={canvasRef}
      data-workbook-cell-canvas="true"
      data-workbook-header-row-canvas={renderBands.some((band) => (
        headerRowNumber > 0 && (
          band.entry?.rowNumber === headerRowNumber
          || band.displayRowNumber === headerRowNumber
        )
      )) ? 'true' : undefined}
      onPointerDown={selectionInteractions.handlePointerDown}
      onPointerMove={selectionInteractions.handlePointerMove}
      onPointerUp={selectionInteractions.handlePointerUp}
      onPointerCancel={selectionInteractions.handlePointerCancel}
      onLostPointerCapture={selectionInteractions.handleLostPointerCapture}
      onContextMenu={handleContextMenu}
      onMouseMove={handleCanvasMouseMove}
      onMouseLeave={handleCanvasMouseLeave}
      style={{
        display: 'block',
        cursor: 'pointer',
        backfaceVisibility: 'hidden',
        touchAction: 'none',
      }}
    />
  );
});

export default WorkbookStackedCanvasStrip;

