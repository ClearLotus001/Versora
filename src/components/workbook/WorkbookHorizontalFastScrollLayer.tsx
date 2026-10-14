import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';

import WorkbookPaneCanvasStrip from '@/components/workbook/WorkbookPaneCanvasStrip';
import {
  useWorkbookHorizontalBodyLayout,
  type WorkbookHorizontalRenderItem,
} from '@/hooks/workbook/useWorkbookHorizontalBodyLayout';
import { computeVariableRange } from '@/hooks/virtualization/useVariableVirtual';
import type { Hunk } from '@/types';
import { subscribeWorkbookCanvasScrollFrame } from '@/utils/workbook/workbookCanvasFrameScheduler';
import {
  VIRTUAL_FAST_SCROLL_END_EVENT,
  VIRTUAL_FAST_SCROLL_START_EVENT,
  isVirtualFastScrollSessionActive,
} from '@/utils/virtualization/fastScrollSession';

interface WorkbookHorizontalFastScrollLayerProps {
  sessionScrollRef: RefObject<HTMLDivElement | null>;
  paneGridTemplateColumns: string;
  viewportHeight: number;
  stickyHeaderHeight: number;
  items: WorkbookHorizontalRenderItem[];
  itemHeights: number[];
  guidedHunkRange: Hunk | null;
  activeSearchLineIdx: number;
  searchMatchSet: ReadonlySet<number>;
  panes: {
    left: Omit<ComponentProps<typeof WorkbookPaneCanvasStrip>, 'rows'>;
    right: Omit<ComponentProps<typeof WorkbookPaneCanvasStrip>, 'rows'>;
  };
}

export default function WorkbookHorizontalFastScrollLayer({
  sessionScrollRef,
  paneGridTemplateColumns,
  viewportHeight,
  stickyHeaderHeight,
  items,
  itemHeights,
  guidedHunkRange,
  activeSearchLineIdx,
  searchMatchSet,
  panes,
}: WorkbookHorizontalFastScrollLayerProps) {
  const [scrollState, setScrollState] = useState({ active: false, settling: false, scrollTop: 0 });
  const hideTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const scroller = sessionScrollRef.current;
    if (!scroller) return;

    const readState = (active: boolean, settling = false) => ({
      active,
      settling,
      scrollTop: Math.max(0, scroller.scrollTop),
    });
    const onStart = () => {
      if (hideTimeoutRef.current != null) {
        window.clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
      setScrollState(readState(true));
    };
    const unsubscribeScroll = subscribeWorkbookCanvasScrollFrame(scroller, ({ scrollTop }) => {
      if (!isVirtualFastScrollSessionActive(scroller)) return;
      flushSync(() => {
        setScrollState({ active: true, settling: false, scrollTop });
      });
    });
    const onEnd = () => {
      setScrollState(readState(true, true));
      if (hideTimeoutRef.current != null) window.clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = window.setTimeout(() => {
        hideTimeoutRef.current = null;
        setScrollState(previous => ({ ...previous, active: false }));
      }, 90);
    };

    scroller.addEventListener(VIRTUAL_FAST_SCROLL_START_EVENT, onStart);
    scroller.addEventListener(VIRTUAL_FAST_SCROLL_END_EVENT, onEnd);
    return () => {
      scroller.removeEventListener(VIRTUAL_FAST_SCROLL_START_EVENT, onStart);
      scroller.removeEventListener(VIRTUAL_FAST_SCROLL_END_EVENT, onEnd);
      unsubscribeScroll();
      if (hideTimeoutRef.current != null) window.clearTimeout(hideTimeoutRef.current);
    };
  }, [sessionScrollRef]);

  const prefixSums = useMemo(() => {
    const sums = new Array<number>(itemHeights.length + 1).fill(0);
    itemHeights.forEach((height, index) => {
      sums[index + 1] = sums[index]! + height;
    });
    return sums;
  }, [itemHeights]);
  const totalH = prefixSums[prefixSums.length - 1] ?? 0;
  const bodyViewportHeight = Math.max(1, viewportHeight - stickyHeaderHeight);
  const averageHeight = itemHeights.length > 0 ? totalH / itemHeights.length : 24;
  const range = useMemo(() => computeVariableRange({
    heightsLength: itemHeights.length,
    prefixSums,
    totalH,
    averageHeight,
    scrollTop: scrollState.scrollTop,
    viewH: bodyViewportHeight,
    overscanMin: 2,
    overscanFactor: 0.25,
  }), [averageHeight, bodyViewportHeight, itemHeights.length, prefixSums, scrollState.scrollTop, totalH]);
  const bodyLayout = useWorkbookHorizontalBodyLayout({
    items,
    startIdx: scrollState.active ? range.startIdx : 0,
    endIdx: scrollState.active ? range.endIdx : 0,
    guidedHunkRange,
    activeSearchLineIdx,
    searchMatchSet,
  });

  if (!scrollState.active || viewportHeight <= stickyHeaderHeight) return null;

  const renderPane = (side: 'left' | 'right') => (
    <div
      data-workbook-fast-scroll-viewport={`horizontal-${side}`}
      style={{
        position: 'relative',
        gridColumn: side === 'left' ? 1 : 3,
        minWidth: 0,
        height: viewportHeight,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}>
      <div
        style={{
          position: 'absolute',
          top: stickyHeaderHeight,
          left: 0,
          right: 0,
          height: bodyViewportHeight,
          overflow: 'hidden',
          background: 'var(--workbook-canvas-bg)',
        }}>
        <div
          style={{
            position: 'absolute',
            top: range.offsetTop - scrollState.scrollTop,
            left: 0,
            right: 0,
          }}>
          {bodyLayout.bodySegments.map((segment, segmentIndex) => {
            if (segment.kind !== 'rows') {
              return (
                <div
                  key={`fast-${side}-placeholder-${segmentIndex}`}
                  style={{
                    position: 'absolute',
                    top: segment.top,
                    left: 0,
                    right: 0,
                    height: segment.height,
                    background: 'var(--workbook-cell-bg)',
                    borderBottom: '1px solid var(--border)',
                  }}
                />
              );
            }
            return (
              <div
                key={`fast-${side}-tile-${segmentIndex}`}
                style={{
                  position: 'absolute',
                  top: segment.top,
                  left: 0,
                  right: 0,
                  height: segment.height,
                  overflow: 'hidden',
                }}>
                <WorkbookPaneCanvasStrip {...panes[side]} rows={segment.rows} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <div
      className="workbook-fast-scroll-layer"
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        gridTemplateColumns: paneGridTemplateColumns,
        zIndex: 30,
        pointerEvents: 'none',
        opacity: scrollState.settling ? 0 : 1,
        willChange: 'opacity',
      }}>
      {renderPane('left')}
      {renderPane('right')}
    </div>
  );
}
