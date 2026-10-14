import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { HorizontalVirtualColumnEntry } from '@/hooks/virtualization/useHorizontalVirtualColumns';
import { LN_W } from '@/constants/layout';
import { FONT_CODE, getWorkbookFontScale } from '@/constants/typography';
import { useI18n } from '@/context/i18n';
import { useTheme, useThemeTokens } from '@/context/theme';
import type {
  WorkbookContextMenuPoint,
  WorkbookHiddenColumnSegment,
  WorkbookSelectionMode,
  WorkbookSelectionRequestReason,
  WorkbookSelectionState,
} from '@/types';
import { ROW_H } from '@/hooks/virtualization/useVirtual';
import { getWorkbookColumnLabel } from '@/utils/workbook/workbookSections';
import { buildWorkbookSelectionLookup } from '@/utils/workbook/workbookSelectionState';
import {
  getWorkbookCanvasDevicePixelRatio,
  syncWorkbookCanvasSurface,
} from '@/utils/workbook/workbookCanvasSurface';
import {
  clipWorkbookCanvasToViewport,
  getWorkbookCanvasCellViewportRect,
  getWorkbookCanvasLayerViewports,
} from '@/utils/workbook/workbookMergeLayout';
import { createWorkbookCanvasBorderRegistry } from '@/utils/workbook/workbookCanvasBorders';
import {
  resolveWorkbookRowSelectionAccent,
  resolveWorkbookVersionAccent,
} from '@/utils/workbook/workbookRowVisuals';
import WorkbookAnchorTooltip, { type WorkbookAnchorTooltipState } from '@/components/workbook/WorkbookAnchorTooltip';
import { subscribeWorkbookCanvasScrollRefFrame } from '@/utils/workbook/workbookCanvasFrameScheduler';
import {
  formatWorkbookHiddenColumnMarkerCount,
  getWorkbookHiddenColumnMarkerWidth,
  resolveWorkbookHiddenColumnMarkerLeft,
  type WorkbookHiddenColumnMarkerLayer,
} from '@/utils/workbook/workbookHiddenColumnVisuals';

type WorkbookCanvasHeaderMode = 'single' | 'paired-wide' | 'paired-compact';
const HIDDEN_MARKER_HEIGHT = 18;

interface ColumnSelectionRequestMeta {
  mode?: WorkbookSelectionMode;
  reason?: WorkbookSelectionRequestReason;
  clientPoint?: WorkbookContextMenuPoint;
  preserveExistingIfTargetSelected?: boolean;
}

interface WorkbookCanvasHeaderStripProps {
  mode: WorkbookCanvasHeaderMode;
  viewportWidth: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  freezeColumnCount: number;
  contentWidth: number;
  sheetName: string;
  selection: WorkbookSelectionState;
  fontSize: number;
  renderColumns: HorizontalVirtualColumnEntry[];
  columnLayoutByColumn: ReadonlyMap<number, HorizontalVirtualColumnEntry>;
  fixedSide?: 'base' | 'mine';
  showFixedSideAccent?: boolean;
  hiddenColumnSegments?: WorkbookHiddenColumnSegment[];
  onSelectColumn: (column: number, side: 'base' | 'mine', meta?: ColumnSelectionRequestMeta) => void;
  onRevealHiddenColumns?: ((columns: number[]) => void) | undefined;
  onColumnWidthChange?: ((column: number, width: number) => void) | undefined;
  onAutoFitColumn?: ((column: number) => void) | undefined;
}

interface HeaderHitTarget {
  kind: 'column' | 'resize' | 'hidden-segment';
  column: number;
  side: 'base' | 'mine';
  columns?: number[];
  count?: number;
  anchorRect?: WorkbookAnchorTooltipState['anchorRect'];
}

function getCompactSplit(width: number) {
  const baseWidth = Math.max(28, Math.floor(width / 2));
  return {
    baseWidth,
    mineWidth: Math.max(28, width - baseWidth),
  };
}

function getSelectionModeFromMouseEvent(event: Pick<React.MouseEvent<HTMLCanvasElement>, 'shiftKey' | 'ctrlKey' | 'metaKey'>): WorkbookSelectionMode {
  if (event.shiftKey) return 'range';
  if (event.ctrlKey || event.metaKey) return 'toggle';
  return 'replace';
}

function drawCompressionChevron(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  direction: 'left' | 'right',
) {
  const directionScale = direction === 'right' ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(x - (2 * directionScale), y - 3);
  ctx.lineTo(x + (1.5 * directionScale), y);
  ctx.lineTo(x - (2 * directionScale), y + 3);
  ctx.stroke();
}

const WorkbookCanvasHeaderStrip = memo(({
  mode,
  viewportWidth,
  scrollRef,
  freezeColumnCount,
  contentWidth,
  sheetName,
  selection,
  fontSize,
  renderColumns,
  columnLayoutByColumn,
  fixedSide = 'base',
  showFixedSideAccent = true,
  hiddenColumnSegments = [],
  onSelectColumn,
  onRevealHiddenColumns,
  onColumnWidthChange,
  onAutoFitColumn,
}: WorkbookCanvasHeaderStripProps) => {
  const T = useThemeTokens();
  const themeKey = useTheme();
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizes = useMemo(() => getWorkbookFontScale(fontSize), [fontSize]);
  const suppressClickRef = useRef(false);
  const [cursor, setCursor] = useState<'default' | 'pointer' | 'col-resize'>('default');
  const [hiddenColumnHover, setHiddenColumnHover] = useState<WorkbookAnchorTooltipState | null>(null);
  const selectionLookup = useMemo(() => buildWorkbookSelectionLookup(selection), [selection]);
  const primarySelection = selection.primary;
  const headerColumnPartition = useMemo(() => {
    const frozenEntries = renderColumns.filter(entry => entry.position < freezeColumnCount);
    const floatingEntries = renderColumns.filter(entry => entry.position >= freezeColumnCount);
    const frozenWidth = frozenEntries.reduce((sum, entry) => sum + entry.displayWidth, 0);
    const contentLeft = LN_W + 3;
    return { frozenEntries, floatingEntries, frozenWidth, contentLeft };
  }, [renderColumns, freezeColumnCount]);

  const resolveHiddenIndicatorLayouts = useCallback((currentScrollLeft: number) => {
    const contentLeft = LN_W + 3;
    const contentRight = Math.min(viewportWidth, contentWidth);
    const frozenBoundaryX = contentLeft + headerColumnPartition.frozenWidth;

    return hiddenColumnSegments.flatMap((segment) => {
      const afterEntry = segment.afterColumn != null
        ? columnLayoutByColumn.get(segment.afterColumn) ?? null
        : null;
      const beforeEntry = segment.beforeColumn != null
        ? columnLayoutByColumn.get(segment.beforeColumn) ?? null
        : null;

      let boundaryX: number | null = null;
      if (afterEntry) {
        boundaryX = afterEntry.position < freezeColumnCount
          ? contentLeft + afterEntry.offset
          : contentLeft + afterEntry.offset - currentScrollLeft;
      } else if (beforeEntry) {
        const beforeLeft = beforeEntry.position < freezeColumnCount
          ? contentLeft + beforeEntry.offset
          : contentLeft + beforeEntry.offset - currentScrollLeft;
        boundaryX = beforeLeft + beforeEntry.displayWidth;
      }

      if (boundaryX == null) return [];

      const width = getWorkbookHiddenColumnMarkerWidth(segment.count);
      if (boundaryX < contentLeft - width || boundaryX > contentRight + width) return [];
      const layer: WorkbookHiddenColumnMarkerLayer = afterEntry?.position != null
        && afterEntry.position < freezeColumnCount
        ? 'frozen'
        : 'scroll';
      const left = resolveWorkbookHiddenColumnMarkerLeft({
        boundaryX,
        width,
        contentLeft,
        contentRight,
        frozenBoundaryX,
        layer,
      });

      return [{
        segment,
        left,
        top: Math.floor((ROW_H - HIDDEN_MARKER_HEIGHT) / 2),
        width,
        height: HIDDEN_MARKER_HEIGHT,
        layer,
      }];
    });
  }, [columnLayoutByColumn, contentWidth, freezeColumnCount, headerColumnPartition.frozenWidth, hiddenColumnSegments, viewportWidth]);

  const resolveHit = (x: number, canvasRect?: DOMRect): HeaderHitTarget | null => {
    const contentHitRight = Math.min(viewportWidth, contentWidth);
    if (x < LN_W + 3 || x >= contentHitRight) return null;

    const contentLeft = LN_W + 3;
    const currentScrollLeft = scrollRef.current?.scrollLeft ?? 0;
    const hiddenIndicator = resolveHiddenIndicatorLayouts(currentScrollLeft).find((indicator) => (
      x >= indicator.left && x <= indicator.left + indicator.width
    ));
    if (hiddenIndicator) {
      const baseHit: HeaderHitTarget = {
        kind: 'hidden-segment',
        column: hiddenIndicator.segment.startCol,
        side: fixedSide,
        columns: hiddenIndicator.segment.columns,
        count: hiddenIndicator.segment.count,
      };
      if (!canvasRect) return baseHit;
      return {
        ...baseHit,
        anchorRect: {
          left: canvasRect.left + hiddenIndicator.left,
          top: canvasRect.top + hiddenIndicator.top,
          width: hiddenIndicator.width,
          height: hiddenIndicator.height,
          right: canvasRect.left + hiddenIndicator.left + hiddenIndicator.width,
          bottom: canvasRect.top + hiddenIndicator.top + hiddenIndicator.height,
        },
      };
    }

    for (const entry of renderColumns) {
      const pairWidth = mode === 'single'
        ? entry.width
        : mode === 'paired-wide'
        ? entry.displayWidth
        : entry.width;
      const drawX = entry.position < freezeColumnCount
        ? contentLeft + entry.offset
        : contentLeft + entry.offset - currentScrollLeft;
      const viewportRect = getWorkbookCanvasCellViewportRect({
        drawLeft: drawX,
        drawWidth: pairWidth,
        contentLeft,
        frozenWidth: headerColumnPartition.frozenWidth,
        frozen: entry.position < freezeColumnCount,
      });
      if (!viewportRect || x < viewportRect.left || x >= viewportRect.left + viewportRect.width) continue;

      if (onColumnWidthChange && onAutoFitColumn && x >= (viewportRect.left + viewportRect.width - 6)) {
        return {
          kind: 'resize',
          column: entry.column,
          side: fixedSide,
        };
      }

      if (mode === 'single') {
        return {
          kind: 'column',
          column: entry.column,
          side: fixedSide,
        };
      }

      const split = mode === 'paired-wide'
        ? { baseWidth: entry.width, mineWidth: entry.width }
        : getCompactSplit(entry.width);
      const withinPairX = x - drawX;
      return {
        kind: 'column',
        column: entry.column,
        side: withinPairX < split.baseWidth ? 'base' : 'mine',
      };
    }

    return null;
  };

  const drawRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const dpr = getWorkbookCanvasDevicePixelRatio();
      const width = Math.max(1, Math.ceil(viewportWidth));
      const height = ROW_H;
      const currentScrollLeft = scrollRef.current?.scrollLeft ?? 0;
      const contentRight = Math.min(width, contentWidth);
      syncWorkbookCanvasSurface(canvas, width, height, dpr);

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = T.bg1;
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = T.bg2;
      ctx.fillRect(0, 0, LN_W + 3, height);
      ctx.strokeStyle = T.workbookGridBorder;
      ctx.beginPath();
      ctx.moveTo(0, height - 0.5);
      ctx.lineTo(contentRight, height - 0.5);
      ctx.stroke();
      const scrollBorderRegistry = createWorkbookCanvasBorderRegistry();
      const frozenBorderRegistry = createWorkbookCanvasBorderRegistry();
      const deferredFocusDraws = {
        floating: [] as Array<() => void>,
        frozen: [] as Array<() => void>,
      };

      const { contentLeft, frozenWidth, frozenEntries, floatingEntries } = headerColumnPartition;
      const layerViewports = getWorkbookCanvasLayerViewports({
        contentLeft,
        contentRight,
        frozenWidth,
      });
      const scrollViewport = layerViewports.scroll ?? layerViewports.content;
      const drawColumn = (
        entry: HorizontalVirtualColumnEntry,
        layer: 'floating' | 'frozen',
      ) => {
        const borderRegistry = layer === 'floating'
          ? scrollBorderRegistry
          : frozenBorderRegistry;
        const deferredFocusDrawBucket = deferredFocusDraws[layer];
        const pairWidth = mode === 'single'
          ? entry.width
          : mode === 'paired-wide'
          ? entry.displayWidth
          : entry.width;
        const drawX = entry.position < freezeColumnCount
          ? contentLeft + entry.offset
          : contentLeft + entry.offset - currentScrollLeft;
        if (drawX > contentRight || drawX + pairWidth < contentLeft) return;

        const column = entry.column;
        const label = getWorkbookColumnLabel(column);
        const isSelectedColumn = Boolean(
          selectionLookup.columnKeys.has(`${sheetName}:${column}`)
          || selectionLookup.cellColumnKeys.has(`${sheetName}:${column}`)
        );
        const isBaseFocused = isSelectedColumn && primarySelection?.side === 'base';
        const isMineFocused = isSelectedColumn && primarySelection?.side === 'mine';
        const shadowBoundary = entry.position === freezeColumnCount - 1;

        if (mode === 'single') {
          const accent = resolveWorkbookVersionAccent(T, fixedSide);
          const selectionAccent = resolveWorkbookRowSelectionAccent(T, fixedSide);
          ctx.fillStyle = isBaseFocused || isMineFocused
            ? `${selectionAccent}28`
            : isSelectedColumn
            ? `${selectionAccent}16`
            : T.bg1;
          ctx.fillRect(drawX, 0, entry.width, height);
          if (showFixedSideAccent) {
            ctx.fillStyle = accent;
            ctx.fillRect(drawX, 0, 3, height);
          }
          borderRegistry.addRect({
            x: drawX,
            y: 0,
            width: entry.width,
            height,
            color: isSelectedColumn ? `${selectionAccent}88` : T.workbookGridBorder,
            priority: isSelectedColumn ? 1 : 0,
          });
          ctx.fillStyle = isBaseFocused || isMineFocused ? T.t0 : T.t1;
          ctx.font = `${sizes.header}px ${FONT_CODE}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, drawX + (entry.width / 2), height / 2);
        } else {
          const split = mode === 'paired-wide'
            ? { baseWidth: entry.width, mineWidth: entry.width }
            : getCompactSplit(entry.width);
          const baseX = drawX;
          const mineX = drawX + split.baseWidth;
          const isLightTheme = themeKey === 'light';
          const focusedTintAlpha = isLightTheme ? '70' : '52';
          const selectedTintAlpha = isLightTheme ? '50' : '36';
          const restingTintAlpha = isLightTheme ? '34' : '24';

          ctx.fillStyle = isBaseFocused
            ? `${T.versionBase}${focusedTintAlpha}`
            : isSelectedColumn
            ? `${T.versionBase}${selectedTintAlpha}`
            : `${T.versionBase}${restingTintAlpha}`;
          ctx.fillRect(baseX, 0, split.baseWidth, height);

          ctx.fillStyle = isMineFocused
            ? `${T.versionMine}${focusedTintAlpha}`
            : isSelectedColumn
            ? `${T.versionMine}${selectedTintAlpha}`
            : `${T.versionMine}${restingTintAlpha}`;
          ctx.fillRect(mineX, 0, split.mineWidth, height);

          borderRegistry.addRect({
            x: drawX,
            y: 0,
            width: pairWidth,
            height,
            color: T.workbookGridBorder,
          });
          if (isSelectedColumn) {
            const focusAccent = resolveWorkbookRowSelectionAccent(T, primarySelection?.side === 'mine' ? 'mine' : 'base');
            deferredFocusDrawBucket.push(() => {
              ctx.strokeStyle = `${focusAccent}96`;
              ctx.lineWidth = 2;
              ctx.strokeRect(drawX + 1, 1, pairWidth - 2, height - 2);
              ctx.lineWidth = 1;
            });
          }

          ctx.font = `${sizes.header}px ${FONT_CODE}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = isBaseFocused ? T.t0 : T.t1;
          ctx.fillText(label, baseX + (split.baseWidth / 2), height / 2);
          ctx.fillStyle = isMineFocused ? T.t0 : T.t1;
          ctx.fillText(label, mineX + (split.mineWidth / 2), height / 2);
        }

        if (shadowBoundary) {
          ctx.fillStyle = `${T.workbookGridBorderStrong}c0`;
          ctx.fillRect(drawX + pairWidth - 1, 0, 1, height);
        }

        if (onColumnWidthChange && onAutoFitColumn) {
          ctx.fillStyle = cursor === 'col-resize'
            ? `${T.acc2}b0`
            : `${T.workbookGridBorderStrong}b8`;
          ctx.fillRect(drawX + pairWidth - 2, 8, 2, height - 16);
        }
      };

      if (scrollViewport.width > 0) {
        clipWorkbookCanvasToViewport(ctx, scrollViewport, 0, height, () => {
          floatingEntries.forEach((entry) => {
            drawColumn(entry, 'floating');
          });
        });
      }

      if (layerViewports.frozen) {
        ctx.fillStyle = T.bg1;
        ctx.fillRect(layerViewports.frozen.left, 0, layerViewports.frozen.width, height);
        clipWorkbookCanvasToViewport(ctx, layerViewports.frozen, 0, height, () => {
          frozenEntries.forEach((entry) => {
            drawColumn(entry, 'frozen');
          });
        });
      }

      if (scrollViewport.width > 0) {
        clipWorkbookCanvasToViewport(ctx, scrollViewport, 0, height, () => {
          scrollBorderRegistry.flush(ctx);
          deferredFocusDraws.floating.forEach((drawFocus) => drawFocus());
        });
      }
      if (layerViewports.frozen) {
        clipWorkbookCanvasToViewport(ctx, layerViewports.frozen, 0, height, () => {
          frozenBorderRegistry.flush(ctx);
          deferredFocusDraws.frozen.forEach((drawFocus) => drawFocus());
        });
      }

      resolveHiddenIndicatorLayouts(currentScrollLeft).forEach((indicator) => {
        const hoverKey = `${sheetName}:${indicator.segment.startCol}:${indicator.segment.count}`;
        const isHovered = hiddenColumnHover?.key === hoverKey;
        const markerColor = isHovered ? T.acc2 : T.border2;
        const markerTextColor = isHovered ? T.acc2 : T.t0;
        const centerX = indicator.left + (indicator.width / 2);
        const centerY = indicator.top + (indicator.height / 2);
        const label = formatWorkbookHiddenColumnMarkerCount(indicator.segment.count);
        const fillGradient = ctx.createLinearGradient(
          indicator.left,
          indicator.top,
          indicator.left,
          indicator.top + indicator.height,
        );
        fillGradient.addColorStop(0, T.bg0);
        fillGradient.addColorStop(1, T.bg2);

        ctx.save();
        const markerClipLeft = indicator.layer === 'scroll'
          ? layerViewports.scroll?.left ?? contentLeft
          : layerViewports.frozen?.left ?? contentLeft;
        const markerClipWidth = indicator.layer === 'scroll'
          ? layerViewports.scroll?.width ?? Math.max(0, contentRight - markerClipLeft)
          : layerViewports.frozen?.width ?? Math.max(0, contentRight - markerClipLeft);
        ctx.beginPath();
        ctx.rect(markerClipLeft, 0, markerClipWidth, height);
        ctx.clip();
        ctx.fillStyle = fillGradient;
        ctx.strokeStyle = markerColor;
        ctx.lineWidth = 1;
        ctx.setLineDash(isHovered ? [] : [3, 2]);
        ctx.shadowColor = `${markerColor}${isHovered ? '44' : '22'}`;
        ctx.shadowBlur = isHovered ? 6 : 3;
        ctx.beginPath();
        ctx.roundRect(indicator.left, indicator.top, indicator.width, indicator.height, 999);
        ctx.fill();
        ctx.stroke();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.setLineDash([]);

        ctx.fillStyle = markerTextColor;
        ctx.font = `${Math.max(10, sizes.header - 1)}px ${FONT_CODE}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, centerX, centerY + 0.25);

        ctx.strokeStyle = markerColor;
        ctx.lineWidth = isHovered ? 1.5 : 1.25;
        drawCompressionChevron(ctx, centerX - 10, centerY, isHovered ? 'left' : 'right');
        drawCompressionChevron(ctx, centerX + 10, centerY, isHovered ? 'right' : 'left');
        ctx.restore();
      });

      ctx.restore();
    };

    drawRef.current = draw;
    draw();

    return undefined;
  }, [
    contentWidth,
    cursor,
    fixedSide,
    freezeColumnCount,
    headerColumnPartition,
    hiddenColumnHover?.key,
    hiddenColumnSegments,
    columnLayoutByColumn,
    mode,
    onAutoFitColumn,
    onColumnWidthChange,
    primarySelection?.side,
    renderColumns,
    resolveHiddenIndicatorLayouts,
    scrollRef,
    selection,
    selectionLookup.cellColumnKeys,
    selectionLookup.columnKeys,
    sheetName,
    showFixedSideAccent,
    sizes.header,
    T,
    themeKey,
    viewportWidth,
  ]);

  useLayoutEffect(() => {
    let lastScrollLeft = scrollRef.current?.scrollLeft ?? 0;
    return subscribeWorkbookCanvasScrollRefFrame(scrollRef, ({ scrollLeft: nextScrollLeft }) => {
      setHiddenColumnHover((prev) => (prev !== null ? null : prev));
      if (nextScrollLeft === lastScrollLeft) return;
      lastScrollLeft = nextScrollLeft;
      drawRef.current();
    });
  }, [scrollRef]);

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onColumnWidthChange || !onAutoFitColumn || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = resolveHit(event.clientX - rect.left);
    if (!hit || hit.kind !== 'resize') return;

    event.preventDefault();
    suppressClickRef.current = true;
    const entry = renderColumns.find((item) => item.column === hit.column);
    if (!entry) return;

    const startX = event.clientX;
    const startWidth = entry.width;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const handlePointerMove = (moveEvent: PointerEvent) => {
      onColumnWidthChange(hit.column, startWidth + (moveEvent.clientX - startX));
    };

    const handlePointerUp = () => {
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      requestAnimationFrame(() => {
        suppressClickRef.current = false;
      });
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
    window.addEventListener('pointercancel', handlePointerUp, { once: true });
  };

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (suppressClickRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = resolveHit(event.clientX - rect.left);
    if (!hit) return;
    if (hit.kind === 'hidden-segment') {
      onRevealHiddenColumns?.(hit.columns ?? []);
      setHiddenColumnHover(null);
      return;
    }
    if (hit.kind !== 'column') return;
    onSelectColumn(hit.column, hit.side, {
      mode: getSelectionModeFromMouseEvent(event),
      reason: 'click',
    });
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onColumnWidthChange || !onAutoFitColumn) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = resolveHit(event.clientX - rect.left);
    if (!hit || hit.kind !== 'resize') return;
    event.preventDefault();
    onAutoFitColumn(hit.column);
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = resolveHit(event.clientX - rect.left, rect);
    const nextCursor = hit?.kind === 'resize'
      ? 'col-resize'
      : hit?.kind === 'column' || hit?.kind === 'hidden-segment'
      ? 'pointer'
      : 'default';
    if (cursor !== nextCursor) setCursor(nextCursor);
    if (hit?.kind === 'hidden-segment' && hit.anchorRect && hit.count != null) {
      const anchorRect = hit.anchorRect;
      const count = hit.count;
      const nextHoverKey = `${sheetName}:${hit.column}:${hit.count}`;
      const nextHover: WorkbookAnchorTooltipState = {
        key: nextHoverKey,
        text: t('workbookHiddenColumnsTooltip', { count }),
        anchorRect,
      };
      if (
        !hiddenColumnHover
        || hiddenColumnHover.key !== nextHoverKey
        || hiddenColumnHover.anchorRect.left !== anchorRect.left
        || hiddenColumnHover.anchorRect.top !== anchorRect.top
      ) {
        setHiddenColumnHover(nextHover);
      }
    } else if (hiddenColumnHover) {
      setHiddenColumnHover(null);
    }
  };

  const handleMouseLeave = () => {
    if (cursor !== 'default') setCursor('default');
    setHiddenColumnHover(null);
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = resolveHit(event.clientX - rect.left, rect);
    if (!hit || hit.kind !== 'column') return;
    event.preventDefault();
    setHiddenColumnHover(null);
    onSelectColumn(hit.column, hit.side, {
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
    <>
      <canvas
        ref={canvasRef}
        data-workbook-column-header-canvas="true"
        onPointerDown={handlePointerDown}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleDoubleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{
          display: 'block',
          cursor,
          backfaceVisibility: 'hidden',
        }}
      />
      <WorkbookAnchorTooltip hover={hiddenColumnHover} />
    </>
  );
});

export default WorkbookCanvasHeaderStrip;
