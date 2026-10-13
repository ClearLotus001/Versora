import {
  memo,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  type WheelEvent,
} from 'react';
import { useThemeTokens } from '@/context/theme';
import { useI18n } from '@/context/i18n';
import {
  buildMiniMapOverlayMarkers,
  DEFAULT_MINIMAP_OVERLAY_MARKER_HEIGHT,
  type MiniMapOverlayMarker,
} from '@/utils/diff/minimapOverlayMarkers';
import { resolveDiffMiniMapPaint } from '@/utils/diff/minimapColors';
import {
  computeMiniMapDragScrollTop,
  computeMiniMapKeyboardScrollTop,
  computeMiniMapViewportMetrics,
  computeMiniMapWheelScrollTop,
  resolveMiniMapContentHeight,
  resolveMiniMapTrackHeight,
} from '@/utils/diff/minimapInteraction';
import { resolveWorkbookMiniMapPaint } from '@/utils/workbook/workbookRowVisuals';
import {
  beginVirtualFastScrollSession,
  clearVirtualFastScrollSession,
  endVirtualFastScrollSession,
} from '@/utils/virtualization/fastScrollSession';

export type WorkbookMiniMapTone = 'equal' | 'add' | 'delete' | 'modify' | 'strict-only' | 'mixed';
export type WorkbookMiniMapPaintTone = Exclude<WorkbookMiniMapTone, 'equal' | 'mixed'>;

export interface WorkbookMiniMapSegment {
  tone: WorkbookMiniMapTone;
  height: number;
  tones?: readonly WorkbookMiniMapPaintTone[];
  searchHit?: boolean;
  activeSearchHit?: boolean;
}

export type WorkbookMiniMapDiffMarker = MiniMapOverlayMarker<
  WorkbookMiniMapTone,
  { tones: WorkbookMiniMapPaintTone[] }
>;

export interface WorkbookMiniMapDebugStats {
  clickCount: number;
  lastClickMs: number;
}

interface WorkbookMiniMapProps {
  segments: WorkbookMiniMapSegment[];
  scrollRef: RefObject<HTMLDivElement | null>;
  contentHeight: number;
  debugRef?: MutableRefObject<WorkbookMiniMapDebugStats | null>;
}

const WIDTH = 28;
const MIN_DIFF_MARKER_HEIGHT = DEFAULT_MINIMAP_OVERLAY_MARKER_HEIGHT;
const WORKBOOK_MINIMAP_TONE_ORDER: readonly WorkbookMiniMapPaintTone[] = [
  'delete',
  'modify',
  'add',
  'strict-only',
] as const;

interface WorkbookMiniMapDragState {
  pointerId: number;
  startClientY: number;
  startScrollTop: number;
  maxScrollTop: number;
  trackHeight: number;
}

function normalizeWorkbookMiniMapPaintTones(
  tones: readonly WorkbookMiniMapPaintTone[] | undefined,
  tone: WorkbookMiniMapTone,
): WorkbookMiniMapPaintTone[] {
  const rawTones = tones && tones.length > 0
    ? tones
    : tone === 'equal'
      ? []
      : tone === 'mixed'
        ? ['modify']
        : [tone];
  const seen = new Set<WorkbookMiniMapPaintTone>();
  WORKBOOK_MINIMAP_TONE_ORDER.forEach((candidate) => {
    if (rawTones.includes(candidate)) {
      seen.add(candidate);
    }
  });
  return [...seen];
}

function applyWorkbookMiniMapPaint(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
  tone: WorkbookMiniMapTone,
  tones: readonly WorkbookMiniMapPaintTone[] | undefined,
  theme: ReturnType<typeof useThemeTokens>,
): CanvasFillStrokeStyles['fillStyle'] {
  const resolvedTones = normalizeWorkbookMiniMapPaintTones(tones, tone);
  if (resolvedTones.length > 1) {
    if (resolvedTones.includes('modify')) {
      const modifyPaint = resolveDiffMiniMapPaint(theme, 'modify');
      ctx.fillStyle = modifyPaint.color ?? theme.chgBrd;
      ctx.fillRect(left, top, width, height);

      const accentStripeWidth = Math.max(2, Math.min(5, Math.floor(width * 0.18)));
      if (resolvedTones.includes('delete')) {
        const deletePaint = resolveDiffMiniMapPaint(theme, 'delete');
        ctx.fillStyle = deletePaint.color ?? theme.delBrd;
        ctx.fillRect(left, top, accentStripeWidth, height);
      }
      if (resolvedTones.includes('add')) {
        const addPaint = resolveDiffMiniMapPaint(theme, 'add');
        ctx.fillStyle = addPaint.color ?? theme.addBrd;
        ctx.fillRect(left + width - accentStripeWidth, top, accentStripeWidth, height);
      }
      if (resolvedTones.includes('strict-only')) {
        const strictStripeLeft = left + Math.floor((width - accentStripeWidth) / 2);
        ctx.fillStyle = theme.whitespaceBrd;
        ctx.fillRect(strictStripeLeft, top, accentStripeWidth, height);
      }
      return ctx.fillStyle;
    }

    const stripeWidth = width / resolvedTones.length;
    resolvedTones.forEach((stripeTone, index) => {
      const stripeLeft = left + (stripeWidth * index);
      const nextLeft = index === resolvedTones.length - 1
        ? left + width
        : left + (stripeWidth * (index + 1));
      const stripePaint = resolveWorkbookMiniMapPaint(theme, stripeTone);
      ctx.fillStyle = stripePaint.color ?? theme.chgBrd;
      ctx.fillRect(stripeLeft, top, Math.max(1, nextLeft - stripeLeft), height);
    });
    return ctx.fillStyle;
  }

  const paint = resolveWorkbookMiniMapPaint(theme, tone);
  if (paint.kind === 'solid') {
    return paint.color ?? theme.bg2;
  }

  const gradient = ctx.createLinearGradient(left, top, left + width, top);
  const stops = paint.stops ?? [];
  if (stops.length === 0) return resolveDiffMiniMapPaint(theme, 'modify').color ?? theme.chgBrd;
  stops.forEach((stop) => {
    gradient.addColorStop(stop.offset, stop.color);
  });
  return gradient;
}

function resolveWorkbookMiniMapSegments(
  segments: readonly WorkbookMiniMapSegment[],
  contentHeight: number,
): WorkbookMiniMapSegment[] {
  return segments.length > 0
    ? [...segments]
    : [{ tone: 'equal', height: Math.max(1, contentHeight) }];
}

export function computeMiniMapTargetScrollTop(
  ratio: number,
  contentHeight: number,
  viewportHeight: number,
): number {
  const normalizedRatio = Math.max(0, Math.min(1, ratio));
  const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
  const targetCenter = normalizedRatio * contentHeight;
  return Math.max(0, Math.min(maxScrollTop, targetCenter - (viewportHeight / 2)));
}

export function interpolateMiniMapDragScrollTop(
  currentScrollTop: number,
  targetScrollTop: number,
  factor = 0.72,
): number {
  const normalizedFactor = Math.max(0, Math.min(1, factor));
  const distance = targetScrollTop - currentScrollTop;
  if (Math.abs(distance) < 0.5) return targetScrollTop;
  return currentScrollTop + (distance * normalizedFactor);
}

export function resolveWorkbookMiniMapProjectionHeight(
  contentHeight: number,
  viewportHeight: number,
): number {
  return Math.max(1, contentHeight, viewportHeight);
}

export function buildWorkbookMiniMapDiffMarkers(
  segments: readonly WorkbookMiniMapSegment[],
  contentHeight: number,
  canvasHeight: number,
  minMarkerHeight = MIN_DIFF_MARKER_HEIGHT,
): WorkbookMiniMapDiffMarker[] {
  return buildMiniMapOverlayMarkers<WorkbookMiniMapTone, WorkbookMiniMapSegment, { tones: WorkbookMiniMapPaintTone[] }>({
    segments,
    contentHeight: resolveWorkbookMiniMapProjectionHeight(contentHeight, canvasHeight),
    canvasHeight,
    emptyTone: 'equal',
    minMarkerHeight,
    resolveExtra: (segment) => ({
      tones: normalizeWorkbookMiniMapPaintTones(segment.tones, segment.tone),
    }),
    mergeExtra: (left, right) => ({
      tones: normalizeWorkbookMiniMapPaintTones(
        [...left.tones, ...right.tones],
        'equal',
      ),
    }),
    mergeTone: (left, right) => (left === right ? left : 'mixed'),
  });
}

const WorkbookMiniMap = memo(({
  segments,
  scrollRef,
  contentHeight,
  debugRef,
}: WorkbookMiniMapProps) => {
  const T = useThemeTokens();
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const contRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<WorkbookMiniMapDragState | null>(null);
  const dragScrollFrameRef = useRef(0);
  const clickScrollEndFrameRef = useRef(0);
  const pendingDragScrollTopRef = useRef<number | null>(null);
  const [contHeight, setContHeight] = useState(320);
  const [isDragging, setIsDragging] = useState(false);

  const flushPendingDragScroll = () => {
    dragScrollFrameRef.current = 0;
    const targetScrollTop = pendingDragScrollTopRef.current;
    const el = scrollRef.current;
    if (!el || targetScrollTop == null) return;
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const nextScrollTop = reduceMotion
      ? targetScrollTop
      : interpolateMiniMapDragScrollTop(el.scrollTop, targetScrollTop);
    if (Math.abs(el.scrollTop - nextScrollTop) >= 0.5) {
      el.scrollTop = nextScrollTop;
    }
    if (dragStateRef.current && Math.abs(targetScrollTop - nextScrollTop) >= 0.5) {
      dragScrollFrameRef.current = requestAnimationFrame(flushPendingDragScroll);
      return;
    }
    pendingDragScrollTopRef.current = null;
  };

  useEffect(() => {
    const cont = contRef.current;
    if (!cont) return;

    const updateHeight = () => {
      const nextHeight = Math.max(1, cont.clientHeight || 320);
      setContHeight(prev => (prev === nextHeight ? prev : nextHeight));
    };

    const ro = new ResizeObserver(updateHeight);
    ro.observe(cont);
    updateHeight();
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const H = contHeight;
    canvas.width = WIDTH;
    canvas.height = H;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resolvedSegments = resolveWorkbookMiniMapSegments(segments, contentHeight);
    const total = Math.max(
      resolveWorkbookMiniMapProjectionHeight(contentHeight, H),
      resolvedSegments.reduce((sum, segment) => sum + segment.height, 0),
    );
    const scale = H / total;

    ctx.clearRect(0, 0, WIDTH, H);

    let offset = 0;
    resolvedSegments.forEach((segment) => {
      const y = Math.floor(offset * scale);
      const h = Math.max(1, Math.ceil(segment.height * scale));

      ctx.fillStyle = applyWorkbookMiniMapPaint(ctx, 0, y, WIDTH, h, segment.tone, segment.tones, T);
      if (normalizeWorkbookMiniMapPaintTones(segment.tones, segment.tone).length <= 1) {
        ctx.fillRect(0, y, WIDTH, h);
      }

      if (segment.searchHit) {
        const markerWidth = segment.activeSearchHit ? 8 : 6;
        ctx.fillStyle = T.searchHl;
        ctx.fillRect(
          WIDTH - markerWidth,
          y,
          markerWidth,
          Math.max(segment.activeSearchHit ? 3 : 2, h),
        );
      }

      offset += segment.height;
    });
  }, [contentHeight, contHeight, segments, T]);

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;

    const H = contHeight;
    canvas.width = WIDTH;
    canvas.height = H;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, WIDTH, H);

    const markers = buildWorkbookMiniMapDiffMarkers(segments, contentHeight, H);
    markers.forEach((marker) => {
      ctx.fillStyle = applyWorkbookMiniMapPaint(ctx, 0, marker.top, WIDTH, marker.height, marker.tone, marker.tones, T);
      if (normalizeWorkbookMiniMapPaintTones(marker.tones, marker.tone).length <= 1) {
        ctx.fillRect(0, marker.top, WIDTH, marker.height);
      }
    });
  }, [contentHeight, contHeight, segments, T]);

  useEffect(() => {
    const el = scrollRef.current;
    const cont = contRef.current;
    if (!el || !cont) return;

    let frameId = 0;
    let pendingScrollTop = Math.max(0, el.scrollTop);
    let heightDirty = true;
    let layoutMetrics = {
      viewportHeight: Math.max(0, el.clientHeight),
      contentHeight: resolveMiniMapContentHeight(contentHeight, el.scrollHeight, el.clientHeight),
      minimapHeight: resolveMiniMapTrackHeight(cont.clientHeight || contHeight, el.clientHeight),
    };

    const flushViewport = () => {
      frameId = 0;
      const viewport = viewportRef.current;
      if (!viewport) return;
      const metrics = computeMiniMapViewportMetrics({
        scrollTop: pendingScrollTop,
        ...layoutMetrics,
      });
      const nextTransform = `translate3d(0, ${metrics.top}px, 0)`;
      if (viewport.style.transform !== nextTransform) {
        viewport.style.transform = nextTransform;
      }
      if (heightDirty) {
        const nextHeight = `${metrics.height}px`;
        if (viewport.style.height !== nextHeight) {
          viewport.style.height = nextHeight;
        }
        heightDirty = false;
      }
    };

    const scheduleViewport = () => {
      if (frameId) return;
      frameId = requestAnimationFrame(flushViewport);
    };

    const updateLayoutMetrics = () => {
      const viewportHeight = Math.max(0, el.clientHeight);
      layoutMetrics = {
        viewportHeight,
        contentHeight: resolveMiniMapContentHeight(contentHeight, el.scrollHeight, viewportHeight),
        minimapHeight: resolveMiniMapTrackHeight(cont.clientHeight || contHeight, viewportHeight),
      };
      pendingScrollTop = Math.max(0, el.scrollTop);
      heightDirty = true;
      scheduleViewport();
    };

    const onScroll = () => {
      pendingScrollTop = Math.max(0, el.scrollTop);
      scheduleViewport();
    };

    const ro = new ResizeObserver(updateLayoutMetrics);
    ro.observe(cont);
    ro.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    updateLayoutMetrics();

    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [contentHeight, contHeight, scrollRef]);

  useEffect(() => () => {
    if (dragScrollFrameRef.current) cancelAnimationFrame(dragScrollFrameRef.current);
    if (clickScrollEndFrameRef.current) cancelAnimationFrame(clickScrollEndFrameRef.current);
    dragStateRef.current = null;
    const scroller = scrollRef.current;
    if (scroller) clearVirtualFastScrollSession(scroller, 'minimap');
  }, [scrollRef]);

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const cont = contRef.current;
    const el = scrollRef.current;
    if (!cont || !el) return;

    const rect = cont.getBoundingClientRect();
    const H = resolveMiniMapTrackHeight(cont.clientHeight || contHeight, el.clientHeight);
    const ratio = (event.clientY - rect.top) / H;
    const contentExtent = resolveMiniMapContentHeight(contentHeight, el.scrollHeight, el.clientHeight);
    const nextTop = computeMiniMapTargetScrollTop(ratio, contentExtent, el.clientHeight);
    beginVirtualFastScrollSession(el, 'minimap');
    el.scrollTo({ top: nextTop, behavior: 'auto' });
    if (clickScrollEndFrameRef.current) cancelAnimationFrame(clickScrollEndFrameRef.current);
    let remainingFrames = 4;
    const finishClickScroll = () => {
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        clickScrollEndFrameRef.current = requestAnimationFrame(finishClickScroll);
        return;
      }
      clickScrollEndFrameRef.current = 0;
      endVirtualFastScrollSession(el, 'minimap');
    };
    clickScrollEndFrameRef.current = requestAnimationFrame(finishClickScroll);
    if (debugRef) {
      const duration = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
      const current = debugRef.current ?? { clickCount: 0, lastClickMs: 0 };
      debugRef.current = {
        clickCount: current.clickCount + 1,
        lastClickMs: duration,
      };
    }
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || event.deltaY === 0) return;

    const contentExtent = resolveMiniMapContentHeight(contentHeight, el.scrollHeight, el.clientHeight);
    const maxScrollTop = Math.max(0, contentExtent - el.clientHeight);
    if (maxScrollTop <= 0) return;

    const nextScrollTop = computeMiniMapWheelScrollTop({
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      currentScrollTop: el.scrollTop,
      maxScrollTop,
      viewportHeight: el.clientHeight,
    });

    if (Math.abs(el.scrollTop - nextScrollTop) >= 0.5) {
      el.scrollTop = nextScrollTop;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const nextScrollTop = computeMiniMapKeyboardScrollTop({
      key: event.key,
      currentScrollTop: el.scrollTop,
      maxScrollTop: el.scrollHeight - el.clientHeight,
      viewportHeight: el.clientHeight,
    });
    if (nextScrollTop == null) return;
    el.scrollTop = nextScrollTop;
    event.preventDefault();
  };

  const handleViewportPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const cont = contRef.current;
    const el = scrollRef.current;
    if (!cont || !el) return;
    if (clickScrollEndFrameRef.current) {
      cancelAnimationFrame(clickScrollEndFrameRef.current);
      clickScrollEndFrameRef.current = 0;
    }

    const H = resolveMiniMapTrackHeight(cont.clientHeight || contHeight, el.clientHeight);
    const metrics = computeMiniMapViewportMetrics({
      scrollTop: el.scrollTop,
      viewportHeight: el.clientHeight,
      contentHeight: resolveMiniMapContentHeight(contentHeight, el.scrollHeight, el.clientHeight),
      minimapHeight: H,
    });

    dragStateRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startScrollTop: el.scrollTop,
      maxScrollTop: metrics.maxScrollTop,
      trackHeight: metrics.trackHeight,
    };
    beginVirtualFastScrollSession(el, 'minimap');
    setIsDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const handleViewportPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    const el = scrollRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId || !el) return;

    pendingDragScrollTopRef.current = computeMiniMapDragScrollTop({
      pointerDeltaY: event.clientY - dragState.startClientY,
      startScrollTop: dragState.startScrollTop,
      maxScrollTop: dragState.maxScrollTop,
      trackHeight: dragState.trackHeight,
    });
    if (!dragScrollFrameRef.current) {
      dragScrollFrameRef.current = requestAnimationFrame(flushPendingDragScroll);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const finishViewportDrag = (event: PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const el = scrollRef.current;
    if (dragScrollFrameRef.current) {
      cancelAnimationFrame(dragScrollFrameRef.current);
      dragScrollFrameRef.current = 0;
    }
    const finalScrollTop = pendingDragScrollTopRef.current;
    pendingDragScrollTopRef.current = null;
    if (el && finalScrollTop != null && Math.abs(el.scrollTop - finalScrollTop) >= 0.5) {
      el.scrollTop = finalScrollTop;
    }
    dragStateRef.current = null;
    if (el) {
      endVirtualFastScrollSession(el, 'minimap');
    }
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={contRef}
      onClick={handleClick}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      role="navigation"
      aria-label={t('workbookMiniMapAriaLabel')}
      tabIndex={0}
      className="group relative overflow-hidden cursor-pointer shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--acc2)]"
      style={{
        width: WIDTH,
        minWidth: WIDTH,
        background: T.workbookCanvasBg,
        borderLeft: `1px solid ${T.border}`,
      }}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full opacity-60 group-hover:opacity-90 group-focus-visible:opacity-90 transition-opacity duration-150"
        style={{ imageRendering: 'pixelated', zIndex: 0 }}
      />
      <div
        ref={viewportRef}
        data-dragging={isDragging ? 'true' : undefined}
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={finishViewportDrag}
        onPointerCancel={finishViewportDrag}
        onClick={(event) => event.stopPropagation()}
        className={`minimap-viewport-frosted absolute ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{
          top: 0,
          height: 40,
          transform: 'translate3d(0, 0px, 0)',
          touchAction: 'none',
          userSelect: 'none',
          contain: 'layout paint style',
          willChange: 'transform',
          transition: isDragging ? 'none' : 'transform 90ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          zIndex: 3,
        }}
      />
      <canvas
        ref={overlayCanvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none opacity-75 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-150"
        style={{ imageRendering: 'pixelated', zIndex: 1 }}
      />
    </div>
  );
});

export default WorkbookMiniMap;
