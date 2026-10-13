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
import { resolveWorkbookCompareCellVisual } from '@/utils/workbook/workbookCompareVisuals';
import {
  clipWorkbookCanvasToViewport,
  getWorkbookCanvasLayerViewports,
  getWorkbookCanvasHoverRowSegmentBounds,
  getWorkbookCanvasRowSegmentCenterY,
  getWorkbookCanvasRowSegmentLineCenters,
  getWorkbookMergeDrawInfo,
  getWorkbookColumnSpanBounds,
  getWorkbookCanvasSpanRect,
  findWorkbookMergeRange,
} from '@/utils/workbook/workbookMergeLayout';
import { resolveWorkbookCanvasCompareCell } from '@/utils/workbook/workbookCanvasCompareCells';
import {
  formatWorkbookVisibleRowNumber,
  resolveWorkbookHeaderRowDividerColor,
  resolveWorkbookRowGutterBackground,
  resolveWorkbookRowSelectionAccent,
  resolveWorkbookRowBorderColor,
  resolveWorkbookRowLineNumberColor,
  resolveWorkbookRowSurfaceBackground,
  resolveWorkbookVersionIdentityVisual,
} from '@/utils/workbook/workbookRowVisuals';
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
  buildWorkbookCanvasHitColumnFrames,
  findWorkbookCanvasHitXFrame,
  type WorkbookCanvasHitColumnFrame,
} from '@/utils/workbook/workbookCanvasHitTest';
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
  WorkbookCellDelta,
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
import type { WorkbookCompareStateByRow } from '@/utils/workbook/workbookPanelHelpers';
import { subscribeWorkbookCanvasScrollFrame } from '@/utils/workbook/workbookCanvasFrameScheduler';
import {
  buildWorkbookCanvasBitmapCacheKey,
  buildWorkbookCanvasBitmapViewportColumnKey,
  restoreWorkbookCanvasBitmap,
  storeWorkbookCanvasBitmap,
} from '@/utils/workbook/workbookCanvasBitmapCache';

export interface WorkbookPaneCanvasRow {
  row: SplitRow;
  isSearchMatch: boolean;
  isActiveSearch: boolean;
  isGuided: boolean;
  isGuidedStart: boolean;
  isGuidedEnd: boolean;
}

type WorkbookPaneCanvasDrawReason = 'full' | 'scroll';

interface WorkbookPaneCanvasStripProps {
  rows: WorkbookPaneCanvasRow[];
  side: 'base' | 'mine';
  viewportWidth: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  freezeColumnCount: number;
  contentWidth: number;
  sheetName: string;
  versionLabel: string;
  headerRowNumber: number;
  selection: WorkbookSelectionState;
  onSelectionRequest: (request: WorkbookSelectionRequest) => void;
  onHoverChange?: (hover: WorkbookCanvasHoverCell | null) => void;
  fontSize: number;
  visibleColumns: number[];
  renderColumns: HorizontalVirtualColumnEntry[];
  columnLayoutByColumn: ReadonlyMap<number, HorizontalVirtualColumnEntry>;
  mergedRanges: ReadonlyArray<WorkbookMergeRange>;
  rowEntryByRowNumber: Map<number, WorkbookRowEntry>;
  compareStateByRow: WorkbookCompareStateByRow;
  compareCellsByRowNumber: Map<number, ReturnType<typeof buildWorkbookSplitRowCompareState>['cellDeltas']>;
  compareMode: WorkbookCompareMode;
  maskedRegions: WorkbookMaskedRegionModel;
}

function getSelectionModeFromMouseEvent(event: Pick<React.MouseEvent<HTMLCanvasElement>, 'shiftKey' | 'ctrlKey' | 'metaKey'>): WorkbookSelectionMode {
  if (event.shiftKey) return 'range';
  if (event.ctrlKey || event.metaKey) return 'toggle';
  return 'replace';
}

const WorkbookPaneCanvasStrip = memo(({
  rows,
  side,
  viewportWidth,
  scrollRef,
  freezeColumnCount,
  contentWidth,
  sheetName,
  versionLabel,
  headerRowNumber,
  selection,
  onSelectionRequest,
  onHoverChange,
  fontSize,
  visibleColumns,
  renderColumns,
  columnLayoutByColumn,
  mergedRanges,
  rowEntryByRowNumber: initialRowEntryByRowNumber,
  compareStateByRow: initialCompareStateByRow,
  compareCellsByRowNumber: initialCompareCellsByRowNumber,
  compareMode,
  maskedRegions,
}: WorkbookPaneCanvasStripProps) => {
  const windowData = useWorkbookArtifactWindow({
    rows: rows.map((item) => item.row), columns: renderColumns.map((entry) => entry.column),
    baseVersion: versionLabel, mineVersion: versionLabel,
    baseMerges: side === 'base' ? mergedRanges : [], mineMerges: side === 'mine' ? mergedRanges : [],
    fallback: { entries: { base: side === 'base' ? initialRowEntryByRowNumber : new Map<number, WorkbookRowEntry>(), mine: side === 'mine' ? initialRowEntryByRowNumber : new Map<number, WorkbookRowEntry>() },
      cells: { base: side === 'base' ? initialCompareCellsByRowNumber : new Map<number, Map<number, WorkbookCellDelta>>(), mine: side === 'mine' ? initialCompareCellsByRowNumber : new Map<number, Map<number, WorkbookCellDelta>>() }, states: initialCompareStateByRow },
  });
  const rowEntryByRowNumber = windowData.entries[side];
  const compareCellsByRowNumber = windowData.cells[side];
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
  const height = rows.length * ROW_H;
  const selectionLookup = useMemo(() => buildWorkbookSelectionLookup(selection), [selection]);
  const primarySelection = selection.primary;
  const renderedColumnNumbers = useMemo(() => renderColumns.map(entry => entry.column), [renderColumns]);

  const renderRows = useMemo(() => rows.map((renderRow) => {
    const baseRowNumber = getWorkbookSideRowNumber(renderRow.row, 'base');
    const mineRowNumber = getWorkbookSideRowNumber(renderRow.row, 'mine');
    const sideRowNumber = side === 'base' ? baseRowNumber : mineRowNumber;
    const entry = sideRowNumber != null
      ? rowEntryByRowNumber.get(sideRowNumber)
        ?? buildWorkbookRowEntry(renderRow.row, side, sheetName, versionLabel, visibleColumns)
      : null;
    const rowDelta = compareStateByRow.get(renderRow.row)
      ?? buildWorkbookSplitRowCompareState(
        renderRow.row,
        visibleColumns,
        compareMode,
      );
    return {
      entry,
      rowNumber: entry?.rowNumber ?? baseRowNumber ?? mineRowNumber ?? 0,
      rowTone: rowDelta.tone,
      tone: side === 'base'
        ? ((renderRow.row.workbookArtifactRow?.kind === 2 || renderRow.row.left?.type === 'delete') ? 'delete' : 'neutral')
        : ((renderRow.row.workbookArtifactRow?.kind === 1 || renderRow.row.right?.type === 'add') ? 'add' : 'neutral'),
      compareCells: entry
        ? (compareCellsByRowNumber.get(entry.rowNumber) ?? rowDelta.cellDeltas)
        : rowDelta.cellDeltas,
      hasBaseRow: baseRowNumber != null,
      hasMineRow: mineRowNumber != null,
      isSearchMatch: renderRow.isSearchMatch,
      isActiveSearch: renderRow.isActiveSearch,
      isGuided: renderRow.isGuided,
      isGuidedStart: renderRow.isGuidedStart,
      isGuidedEnd: renderRow.isGuidedEnd,
    };
  }), [compareCellsByRowNumber, compareMode, compareStateByRow, rowEntryByRowNumber, rows, sheetName, side, versionLabel, visibleColumns]);
  const renderedRowNumbers = useMemo(
    () => renderRows.map(renderRow => renderRow.entry?.rowNumber ?? -1).filter(rowNumber => rowNumber > 0),
    [renderRows],
  );
  const rowLayoutByRowNumber = useMemo(
    () => new Map(
      renderRows.flatMap((renderRow, rowIndex) => renderRow.entry?.rowNumber != null
        ? [[renderRow.entry.rowNumber, { top: rowIndex * ROW_H, height: ROW_H }]]
        : []),
    ),
    [renderRows],
  );
  const columnPartition = useMemo(() => {
    const frozenEntries = renderColumns.filter(column => column.position < freezeColumnCount);
    const floatingEntries = renderColumns.filter(column => column.position >= freezeColumnCount);
    const frozenWidth = frozenEntries.reduce((sum, entry) => sum + entry.displayWidth, 0);
    const contentLeft = LN_W + 3;
    return { frozenEntries, floatingEntries, frozenWidth, contentLeft };
  }, [renderColumns, freezeColumnCount]);
  const bitmapCacheEnabled = !dragPreviewActive && Object.keys(motionByRegion).length === 0;
  const bitmapCacheBaseKey = useMemo(() => buildWorkbookCanvasBitmapCacheKey('pane', [
    sheetName,
    side,
    versionLabel,
    rows.map(row => `${row.row.lineIdx}:${Number(row.isSearchMatch)}:${Number(row.isActiveSearch)}:${Number(row.isGuided)}:${Number(row.isGuidedStart)}:${Number(row.isGuidedEnd)}`).join(','),
    viewportWidth,
    height,
    freezeColumnCount,
    headerRowNumber,
    fontSize,
    compareMode,
    selection,
    T,
    mergedRanges,
    rowEntryByRowNumber,
    compareStateByRow,
    compareCellsByRowNumber,
    maskedRegions,
    motionByRegion,
  ]), [T, compareCellsByRowNumber, compareMode, compareStateByRow, fontSize, freezeColumnCount, headerRowNumber, height, maskedRegions, mergedRanges, motionByRegion, rowEntryByRowNumber, rows, selection, sheetName, side, versionLabel, viewportWidth]);
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

    const frames = buildWorkbookCanvasHitColumnFrames({
      contentLeft: columnPartition.contentLeft,
      frozenEntries: columnPartition.frozenEntries,
      floatingEntries: columnPartition.floatingEntries,
      frozenWidth: columnPartition.frozenWidth,
      scrollLeft: currentScrollLeft,
    });
    hitColumnFramesCacheRef.current = {
      columnPartition,
      scrollLeft: currentScrollLeft,
      frames,
    };
    return frames;
  }, [columnPartition]);

  const drawRef = useRef<(reason?: WorkbookPaneCanvasDrawReason) => void>(() => {});

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = (reason: WorkbookPaneCanvasDrawReason = 'full') => {
      const dpr = getWorkbookCanvasDevicePixelRatio();
      const width = Math.max(1, Math.ceil(viewportWidth));
      const canvasHeight = Math.max(1, Math.ceil(height));
      const currentScrollLeft = scrollRef.current?.scrollLeft ?? 0;
      const contentRight = Math.min(width, contentWidth);
      const previousPixelWidth = canvas.width;
      const previousPixelHeight = canvas.height;
      syncWorkbookCanvasSurface(canvas, width, canvasHeight, dpr);
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
        ctx.clearRect(0, 0, width, canvasHeight);
        ctx.fillStyle = T.workbookCanvasBg;
        ctx.fillRect(0, 0, width, canvasHeight);
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
      const getRowBg = (renderRow: typeof renderRows[number]) => resolveWorkbookRowSurfaceBackground({
        theme: T,
        isGuided: renderRow.isGuided,
        isActiveSearch: renderRow.isActiveSearch,
        isSearchMatch: renderRow.isSearchMatch,
        isHeaderRow: headerRowNumber > 0 && renderRow.rowNumber === headerRowNumber,
      });
      const drawRowChrome = (renderRow: typeof renderRows[number], rowIndex: number) => {
        const y = rowIndex * ROW_H;
        const rowBg = getRowBg(renderRow);
        const border = resolveWorkbookRowBorderColor(T, renderRow.rowTone);
        const entry = renderRow.entry;
        const rowNumber = renderRow.rowNumber;
        const previousVisibleRowNumber = rowIndex > 0
          ? (renderRows[rowIndex - 1]?.rowNumber ?? null)
          : headerRowNumber > 0 && rowNumber > headerRowNumber
            ? headerRowNumber
            : null;
        const isHeaderRow = headerRowNumber > 0 && rowNumber === headerRowNumber;
        const selectionAccent = resolveWorkbookRowSelectionAccent(T, side);
        const isSelectedRow = Boolean(
          selectionLookup.rowKeys.has(`${sheetName}:${rowNumber}`),
        );
        const lineNumberColor = resolveWorkbookRowLineNumberColor({
          theme: T,
          tone: renderRow.rowTone,
          fallbackTone: side,
          active: renderRow.isActiveSearch,
        });

        ctx.fillStyle = rowBg;
        ctx.fillRect(0, y, contentLeft, ROW_H);
        ctx.fillStyle = resolveWorkbookRowGutterBackground({
          theme: T,
          selectionAccent,
          isSelected: isSelectedRow,
          isHeaderRow,
          versionSide: side,
        });
        ctx.fillRect(3, y, LN_W, ROW_H);
        ctx.fillStyle = border;
        ctx.fillRect(0, y, 3, ROW_H);
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(contentRight, y + 0.5);
        ctx.stroke();

        if (isSelectedRow) {
          ctx.strokeStyle = `${selectionAccent}a6`;
          ctx.lineWidth = 2;
          ctx.strokeRect(4, y + 1, LN_W - 2, ROW_H - 2);
          ctx.lineWidth = 1;
        }

        ctx.fillStyle = isSelectedRow
          ? selectionAccent
          : lineNumberColor;
        ctx.font = `${isHeaderRow ? '600 ' : ''}${sizes.line}px ${FONT_CODE}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          entry ? formatWorkbookVisibleRowNumber(entry.rowNumber, previousVisibleRowNumber) : '',
          LN_W - 8,
          y + (ROW_H / 2),
        );
      };
      const drawCellsForLayer = (
        renderRow: typeof renderRows[number],
        rowIndex: number,
        entries: HorizontalVirtualColumnEntry[],
        layer: 'floating' | 'frozen',
      ) => {
        const y = rowIndex * ROW_H;
        const entry = renderRow.entry;
        const rowNumber = renderRow.rowNumber;
        const deferredMergedDraws = layer === 'floating' ? floatingMergedDraws : frozenMergedDraws;
        const deferredSelectionDrawBucket = layer === 'floating'
          ? deferredSelectionDraws.floating
          : deferredSelectionDraws.frozen;
        const borderRegistry = layer === 'floating' ? scrollBorderRegistry : frozenBorderRegistry;
        const drawCell = (entryMeta: HorizontalVirtualColumnEntry, drawX: number) => {
          if (drawX >= contentRight || drawX + entryMeta.width <= contentLeft) return;

          // Keep alignment rows visible even when this side has no concrete row entry.
          // In that case we can still render placeholder cells from compare deltas.
          if (!entry) {
            const compareCell = renderRow.compareCells.get(entryMeta.column);
            const placeholderCell = side === 'base'
              ? compareCell?.baseCell
              : compareCell?.mineCell;
            const cell = placeholderCell ?? { value: '', formula: '' };
            const hasContent = hasWorkbookCellContent(cell, compareMode);
            const isHeaderRow = headerRowNumber > 0 && rowNumber === headerRowNumber;
            const cellVisual = resolveWorkbookCompareCellVisual({
              theme: T,
              compareCell,
              side,
              isHeaderRow,
              hasEntry: false,
              hasContent,
              hasBaseRow: renderRow.hasBaseRow,
              hasMineRow: renderRow.hasMineRow,
              defaultTextColor: side === 'mine' ? T.t0 : T.t1,
            });
            const versionIdentity = resolveWorkbookVersionIdentityVisual(
              T,
              side,
              Boolean(compareCell?.changed),
              isHeaderRow ? 'header' : 'body',
            );
            const selectionVisual = getWorkbookSelectionVisualState(
              T,
              selectionLookup,
              sheetName,
              side,
              rowNumber,
              entryMeta.column,
              renderRow.isActiveSearch,
              dragPreviewActive,
              {
                startRow: rowNumber,
                endRow: rowNumber,
                startColumn: entryMeta.column,
                endColumn: entryMeta.column,
              },
            );
            const selectionBorder = getWorkbookSelectionBorderVisual(selectionVisual);
            const maskedRegionId = getWorkbookMaskedRegionId(maskedRegions, side, rowNumber, entryMeta.column);
            const maskOpacity = resolveWorkbookMaskedCellOpacity({
              maskedRegionId,
              motion: maskedRegionId ? motionByRegion[maskedRegionId] : undefined,
              rowNumber,
              column: entryMeta.column,
              isHeaderRow,
              isSearchMatch: renderRow.isSearchMatch || renderRow.isActiveSearch,
            });

            ctx.fillStyle = cellVisual.background;
            ctx.fillRect(drawX, y, entryMeta.width, ROW_H);
            if (versionIdentity.overlay) {
              ctx.fillStyle = versionIdentity.overlay;
              ctx.fillRect(drawX, y, entryMeta.width, ROW_H);
            }
            if (versionIdentity.rail && !selectionVisual.hasSelectionHighlight) {
              ctx.fillStyle = versionIdentity.rail;
              ctx.fillRect(drawX, y, versionIdentity.railWidth, ROW_H);
            }
            if (cellVisual.maskOverlay) {
              ctx.fillStyle = cellVisual.maskOverlay;
              ctx.fillRect(drawX, y, entryMeta.width, ROW_H);
            }
            registerWorkbookCanvasCellBorders({
              registry: borderRegistry,
              x: drawX,
              y,
              width: entryMeta.width,
              height: ROW_H,
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
                ROW_H,
                selectionVisual,
              );
            });

            if (hasContent) {
              const textRect = getWorkbookCanvasTextInsetRect(drawX, y, entryMeta.width, ROW_H);
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
                side,
                theme: T,
                x: textRect.left,
                baselineY: getWorkbookCanvasTextBaselineY(ctx, y + (ROW_H / 2), sizes.ui),
                fallbackFontSize: sizes.ui,
                textColor: cellVisual.textColor,
              });
              ctx.restore();
            }
            if (maskOpacity > 0.001) {
              drawWorkbookMaskedCellSegments(
                ctx,
                [{ left: drawX, width: entryMeta.width }],
                [{ top: y, height: ROW_H }],
                T,
                maskOpacity,
              );
            }
            return;
          }

          const column = entryMeta.column;
          const cellRowNumber = entry?.rowNumber ?? rowNumber;
          const mergeInfo = getWorkbookMergeDrawInfo({
            rowNumber: cellRowNumber,
            column,
            rowTop: y,
            rowHeight: ROW_H,
            renderedRowNumbers,
            rowLayoutByRowNumber,
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

          const anchorRowNumber = mergeInfo.region?.range.startRow ?? cellRowNumber;
          const anchorColumn = mergeInfo.region?.range.startCol ?? column;
          const isHeaderRow = headerRowNumber > 0 && anchorRowNumber === headerRowNumber;
          const anchorEntry = rowEntryByRowNumber.get(anchorRowNumber) ?? entry;
          const cell = anchorEntry?.cells[anchorColumn] ?? { value: getWorkbookPendingCellPaint(anchorEntry, anchorColumn), formula: '' };
          const compareCell = resolveWorkbookCanvasCompareCell({
            compareCellsByRowNumber,
            rowCompareCells: renderRow.compareCells,
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
            side,
            selectionRowNumber,
            selectionColumn,
            renderRow.isActiveSearch,
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
            side,
            isHeaderRow,
            hasEntry: Boolean(entry),
            hasContent,
            hasBaseRow: renderRow.hasBaseRow,
            hasMineRow: renderRow.hasMineRow,
            defaultTextColor: side === 'mine' ? T.t0 : T.t1,
          });
          const versionIdentity = resolveWorkbookVersionIdentityVisual(
            T,
            side,
            Boolean(compareCell?.changed),
            isHeaderRow ? 'header' : 'body',
          );
          const maskedRegionId = getWorkbookMaskedRegionId(maskedRegions, side, anchorRowNumber, anchorColumn);
          const maskOpacity = resolveWorkbookMaskedCellOpacity({
            maskedRegionId,
            motion: maskedRegionId ? motionByRegion[maskedRegionId] : undefined,
            rowNumber: anchorRowNumber,
            column: anchorColumn,
            isHeaderRow,
            isSearchMatch: renderRow.isSearchMatch || renderRow.isActiveSearch,
          });
          const regionLeft = mergeInfo.region?.left ?? drawX;
          const regionTop = mergeInfo.region?.top ?? y;
          const regionWidth = mergeInfo.region?.width ?? entryMeta.width;
          const regionHeight = mergeInfo.region?.height ?? ROW_H;
          const regionSegments = mergeInfo.region?.segments ?? [{ left: regionLeft, width: regionWidth }];
          const rowSegments = mergeInfo.region?.rowSegments ?? [{ top: regionTop, height: regionHeight }];
          const selectionSegments = regionSegments;
          const selectionTop = regionTop;
          const selectionHeight = regionHeight;
          const textCenterY = getWorkbookCanvasRowSegmentCenterY(rowSegments) ?? (regionTop + (regionHeight / 2));
          const textRect = getWorkbookCanvasTextInsetRect(regionLeft, regionTop, regionWidth, regionHeight);
          const textX = textRect.left;
          const centerMergedText = Boolean(mergeInfo.region && regionSegments.length === 1);
          const withRowSegmentClip = (callback: () => void) => {
            ctx.save();
            ctx.beginPath();
            rowSegments.forEach((rowSegment) => {
              regionSegments.forEach((segment) => {
                ctx.rect(segment.left, rowSegment.top, segment.width, rowSegment.height);
              });
            });
            ctx.clip();
            callback();
            ctx.restore();
          };

          const paintRegion = () => {
            ctx.fillStyle = cellVisual.background;
            withRowSegmentClip(() => {
              regionSegments.forEach((segment) => {
                ctx.fillRect(segment.left, regionTop, segment.width, regionHeight);
              });
            });
            if (versionIdentity.overlay) {
              ctx.fillStyle = versionIdentity.overlay;
              withRowSegmentClip(() => {
                regionSegments.forEach((segment) => {
                  ctx.fillRect(segment.left, regionTop, segment.width, regionHeight);
                });
              });
            }
            if (versionIdentity.rail && !selectionVisual.hasSelectionHighlight) {
              ctx.fillStyle = versionIdentity.rail;
              withRowSegmentClip(() => {
                rowSegments.forEach((rowSegment) => {
                  regionSegments.forEach((segment) => {
                    ctx.fillRect(segment.left, rowSegment.top, versionIdentity.railWidth, rowSegment.height);
                  });
                });
              });
            }
            if (cellVisual.maskOverlay) {
              ctx.fillStyle = cellVisual.maskOverlay;
              withRowSegmentClip(() => {
                regionSegments.forEach((segment) => {
                  ctx.fillRect(segment.left, regionTop, segment.width, regionHeight);
                });
              });
            }
            const selectionOverlay = getWorkbookSelectionOverlay(selectionVisual);
            if (selectionOverlay) {
              ctx.fillStyle = selectionOverlay;
              withRowSegmentClip(() => {
                selectionSegments.forEach((segment) => {
                  ctx.fillRect(segment.left, selectionTop, segment.width, selectionHeight);
                });
              });
            }
            withRowSegmentClip(() => {
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
                    priority: resolveWorkbookCanvasCellBorderPriority(compareCell, Boolean(entry)),
                  },
                  selection: selectionBorder,
                });
              });
            });
            deferredSelectionDrawBucket.push(() => {
              withRowSegmentClip(() => {
                selectionSegments.forEach((segment) => {
                  drawWorkbookCanvasSelectionFrame(
                    ctx,
                    segment.left,
                    selectionTop,
                    segment.width,
                    selectionHeight,
                    selectionVisual,
                  );
                });
              });
            });

            ctx.save();
            ctx.beginPath();
            rowSegments.forEach((rowSegment) => {
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
              const maxLines = Math.max(1, rowSegments.reduce((sum, rowSegment) => (
                sum + Math.max(1, Math.floor(Math.max(0, rowSegment.height - 4) / lineHeight))
              ), 0));
              const lines = layoutWorkbookCanvasTextLines({
                value: cell.value || '',
                maxWidth: textRect.width,
                maxLines,
                measureText: (value) => ctx.measureText(value).width,
              });
              ctx.textAlign = 'center';
              const lineCenters = getWorkbookCanvasRowSegmentLineCenters(rowSegments, lines.length, lineHeight);
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
                side,
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

        entries.forEach((entryMeta) => {
          const x = contentLeft + entryMeta.offset - currentScrollLeft;
          if (layer === 'frozen') {
            const frozenX = contentLeft + entryMeta.offset;
            if (frozenX > contentRight) return;
            drawCell(entryMeta, frozenX);
            return;
          }
          drawCell(entryMeta, x);
        });
      };
      const drawRowBackdrops = (viewport: { left: number; width: number }) => {
        if (viewport.width <= 0) return;
        renderRows.forEach((renderRow, rowIndex) => {
          const y = rowIndex * ROW_H;
          paintWorkbookCanvasBackdrop(
            ctx,
            { left: viewport.left, top: y, width: viewport.width, height: ROW_H },
            T.workbookCanvasBg,
            getRowBg(renderRow),
          );
          ctx.strokeStyle = resolveWorkbookRowBorderColor(T, renderRow.rowTone);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(viewport.left, y + 0.5);
          ctx.lineTo(viewport.left + viewport.width, y + 0.5);
          ctx.stroke();
        });
      };

      if (fullDraw) {
        renderRows.forEach(drawRowChrome);
      }

      if (scrollViewport.width > 0) {
        ctx.clearRect(scrollViewport.left, 0, scrollViewport.width, canvasHeight);
        ctx.fillStyle = T.workbookCanvasBg;
        ctx.fillRect(scrollViewport.left, 0, scrollViewport.width, canvasHeight);
        drawRowBackdrops(scrollViewport);
        renderRows.forEach((renderRow, rowIndex) => {
          clipWorkbookCanvasToViewport(ctx, scrollViewport, rowIndex * ROW_H, ROW_H, () => {
            drawCellsForLayer(renderRow, rowIndex, floatingEntries, 'floating');
          });
        });
      }

      if (floatingMergedDraws.length > 0 && scrollViewport.width > 0) {
        clipWorkbookCanvasToViewport(ctx, scrollViewport, 0, canvasHeight, () => {
          floatingMergedDraws.forEach((paintRegion) => paintRegion());
        });
      }

      const frozenViewport = layerViewports.frozen;

      if (fullDraw && frozenViewport) {
        drawRowBackdrops(frozenViewport);
      }

      if (fullDraw && frozenViewport) {
        renderRows.forEach((renderRow, rowIndex) => {
          clipWorkbookCanvasToViewport(ctx, frozenViewport, rowIndex * ROW_H, ROW_H, () => {
            drawCellsForLayer(renderRow, rowIndex, frozenEntries, 'frozen');
          });
        });
      }

      if (fullDraw && frozenMergedDraws.length > 0 && frozenViewport) {
        clipWorkbookCanvasToViewport(ctx, frozenViewport, 0, canvasHeight, () => {
          frozenMergedDraws.forEach((paintRegion) => paintRegion());
        });
      }

      renderRows.forEach((renderRow, rowIndex) => {
        if (headerRowNumber <= 0 || renderRow.rowNumber !== headerRowNumber) return;
        ctx.fillStyle = resolveWorkbookHeaderRowDividerColor(T);
        ctx.fillRect(0, ((rowIndex + 1) * ROW_H) - 2, contentRight, 2);
      });
      if (renderRows.length > 0) {
        const terminalBoundaryRight = frozenViewport
          ? frozenViewport.left + frozenViewport.width
          : contentLeft;
        ctx.fillStyle = T.workbookGridBorderStrong;
        ctx.fillRect(0, canvasHeight - 1, terminalBoundaryRight, 1);
      }
      if (scrollViewport.width > 0) {
        clipWorkbookCanvasToViewport(ctx, scrollViewport, 0, canvasHeight, () => {
          scrollBorderRegistry.flush(ctx);
        });
      }
      if (fullDraw && frozenViewport) {
        clipWorkbookCanvasToViewport(ctx, frozenViewport, 0, canvasHeight, () => {
          frozenBorderRegistry.flush(ctx);
        });
      }
      if (scrollViewport.width > 0) {
        clipWorkbookCanvasToViewport(ctx, scrollViewport, 0, canvasHeight, () => {
          deferredSelectionDraws.floating.forEach((drawSelection) => drawSelection());
        });
      }
      if (fullDraw && frozenViewport) {
        clipWorkbookCanvasToViewport(ctx, frozenViewport, 0, canvasHeight, () => {
          deferredSelectionDraws.frozen.forEach((drawSelection) => drawSelection());
        });
      }

      if (fullDraw && frozenViewport) {
        ctx.fillStyle = `${T.workbookGridBorderStrong}b8`;
        ctx.fillRect(frozenViewport.left + frozenViewport.width - 1, 0, 1, canvasHeight);
      }

      ctx.restore();
      if (bitmapCacheEnabled) storeWorkbookCanvasBitmap(canvas, bitmapCacheKey);
    };

    drawRef.current = draw;
    draw();

    return undefined;
  }, [bitmapCacheBaseKey, bitmapCacheEnabled, columnLayoutByColumn, columnPartition, compareCellsByRowNumber, compareMode, contentWidth, dragPreviewActive, freezeColumnCount, getHitColumnFrames, headerRowNumber, height, maskedRegions, mergedRanges, motionByRegion, renderedColumnNumbers, renderColumns, renderRows, renderedRowNumbers, rowEntryByRowNumber, rowLayoutByRowNumber, scrollRef, selectionLookup, sheetName, side, sizes.line, sizes.ui, T, viewportWidth]);

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

    const rowIndex = Math.floor(y / ROW_H);
    const renderRow = renderRows[rowIndex];
    if (!renderRow) return null;
    const entry = renderRow.entry;
    if (!entry) return null;

    const contentLeft = columnPartition.contentLeft;
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
          versionLabel,
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

    const currentScrollLeft = scrollRef.current?.scrollLeft ?? 0;
    const { frozenWidth } = columnPartition;
    const hitColumnFrame = findWorkbookCanvasHitXFrame(getHitColumnFrames(currentScrollLeft), x);
    if (!hitColumnFrame) return null;
    const hitEntry = hitColumnFrame.entry;

    const column = hitEntry.column;
    const mergeRange = findWorkbookMergeRange(mergedRanges, entry.rowNumber, column);
    const anchorRowNumber = mergeRange?.startRow ?? entry.rowNumber;
    const anchorColumn = mergeRange?.startCol ?? column;
    const anchorEntry = rowEntryByRowNumber.get(anchorRowNumber) ?? entry;
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
    const compareCell = resolveWorkbookCanvasCompareCell({
      compareCellsByRowNumber,
      rowCompareCells: renderRow.compareCells,
      anchorRowNumber,
      column,
      mergeRange,
    });
    const maskedRegionId = getWorkbookMaskedRegionId(maskedRegions, side, anchorRowNumber, anchorColumn);
    const columnX = spanRect?.left ?? hitColumnFrame.left;
    const columnWidth = spanRect?.width ?? (hitColumnFrame.right - hitColumnFrame.left);
    const mergeDrawInfo = getWorkbookMergeDrawInfo({
      rowNumber: entry.rowNumber,
      column,
      rowTop: rowIndex * ROW_H,
      rowHeight: ROW_H,
      renderedRowNumbers,
      rowLayoutByRowNumber,
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
    const hoverRowSegments = mergeDrawInfo.region?.rowSegments ?? [{ top: rowIndex * ROW_H, height: ROW_H }];
    const hoverBounds = getWorkbookCanvasHoverRowSegmentBounds(hoverRowSegments, y)
      ?? { top: rowIndex * ROW_H, height: ROW_H };
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
      data-testid={`workbook-pane-canvas-${side}`}
      data-workbook-cell-canvas="true"
      data-workbook-header-row-canvas={renderRows.some((row) => (
        headerRowNumber > 0 && row.rowNumber === headerRowNumber
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

export default WorkbookPaneCanvasStrip;
