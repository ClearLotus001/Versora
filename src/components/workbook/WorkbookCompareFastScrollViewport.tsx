import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';

import WorkbookColumnsCanvasStrip from '@/components/workbook/WorkbookColumnsCanvasStrip';
import WorkbookStackedCanvasStrip from '@/components/workbook/WorkbookStackedCanvasStrip';
import { useWorkbookCompareBodyLayout } from '@/hooks/workbook/useWorkbookCompareBodyLayout';
import type {
  CompareMode,
  WorkbookCompareRenderItem,
  WorkbookStackedVirtualItem,
} from '@/hooks/workbook/useWorkbookCompareDerivedState';
import { computeVariableRange } from '@/hooks/virtualization/useVariableVirtual';
import { ROW_H } from '@/hooks/virtualization/useVirtual';
import type { Hunk } from '@/types';
import { subscribeWorkbookCanvasScrollFrame } from '@/utils/workbook/workbookCanvasFrameScheduler';
import {
  VIRTUAL_FAST_SCROLL_END_EVENT,
  VIRTUAL_FAST_SCROLL_START_EVENT,
  isVirtualFastScrollSessionActive,
} from '@/utils/virtualization/fastScrollSession';

const EMPTY_STACKED_RUNS: [] = [];
const FAST_STACKED_TILE_HEIGHT = ROW_H * 4;

function splitFastStackedItems(items: WorkbookStackedVirtualItem[]): WorkbookStackedVirtualItem[] {
  return items.flatMap(item => {
    if (item.kind !== 'rows' || item.hasVerticalMerge || item.height <= FAST_STACKED_TILE_HEIGHT) {
      return [item];
    }

    const chunks: WorkbookStackedVirtualItem[] = [];
    let chunkStart = 0;
    let chunkHeight = 0;
    const flush = (chunkEnd: number) => {
      const rows = item.rows.slice(chunkStart, chunkEnd);
      if (rows.length === 0) return;
      const sourceStartItemIndex = item.sourceStartItemIndex + chunkStart;
      const sourceEndItemIndex = sourceStartItemIndex + rows.length - 1;
      chunks.push({
        ...item,
        rows,
        height: rows.reduce((sum, row) => sum + row.height, 0),
        sourceStartItemIndex,
        sourceEndItemIndex,
        groupKey: `${item.groupKey}:fast:${chunkStart}:${chunkEnd - 1}`,
        baseTrack: item.baseTrack
          .filter(track => track.sourceRowIndex >= chunkStart && track.sourceRowIndex < chunkEnd)
          .map(track => ({ ...track, sourceRowIndex: track.sourceRowIndex - chunkStart })),
        mineTrack: item.mineTrack
          .filter(track => track.sourceRowIndex >= chunkStart && track.sourceRowIndex < chunkEnd)
          .map(track => ({ ...track, sourceRowIndex: track.sourceRowIndex - chunkStart })),
      });
    };

    item.rows.forEach((row, index) => {
      if (index > chunkStart && chunkHeight + row.height > FAST_STACKED_TILE_HEIGHT) {
        flush(index);
        chunkStart = index;
        chunkHeight = 0;
      }
      chunkHeight += row.height;
    });
    flush(item.rows.length);
    return chunks;
  });
}

interface WorkbookCompareFastScrollViewportProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  viewportWidth: number;
  viewportHeight: number;
  stickyHeaderHeight: number;
  minBodyWidth: number;
  mode: CompareMode;
  items: WorkbookCompareRenderItem[];
  itemHeights: number[];
  stackedVirtualItems: WorkbookStackedVirtualItem[];
  guidedHunkRange: Hunk | null;
  activeSearchLineIdx: number;
  searchMatchSet: ReadonlySet<number>;
  columnsCanvasProps: Omit<ComponentProps<typeof WorkbookColumnsCanvasStrip>, 'rows'>;
  stackedCanvasProps: Omit<ComponentProps<typeof WorkbookStackedCanvasStrip>, 'groups'>;
}

interface FastScrollViewportState {
  active: boolean;
  settling: boolean;
  scrollTop: number;
}

export default function WorkbookCompareFastScrollViewport({
  scrollRef,
  viewportWidth,
  viewportHeight,
  stickyHeaderHeight,
  minBodyWidth,
  mode,
  items,
  itemHeights,
  stackedVirtualItems,
  guidedHunkRange,
  activeSearchLineIdx,
  searchMatchSet,
  columnsCanvasProps,
  stackedCanvasProps,
}: WorkbookCompareFastScrollViewportProps) {
  const [viewportState, setViewportState] = useState<FastScrollViewportState>({
    active: false,
    settling: false,
    scrollTop: 0,
  });
  const hideTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const readViewportState = (active: boolean, settling = false): FastScrollViewportState => ({
      active,
      settling,
      scrollTop: Math.max(0, scroller.scrollTop),
    });
    const onStart = () => {
      if (hideTimeoutRef.current != null) {
        window.clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
      setViewportState(readViewportState(true));
    };
    const unsubscribeScroll = subscribeWorkbookCanvasScrollFrame(scroller, ({ scrollTop }) => {
      if (!isVirtualFastScrollSessionActive(scroller)) return;
      flushSync(() => {
        setViewportState({ active: true, settling: false, scrollTop });
      });
    });
    const onEnd = () => {
      setViewportState(readViewportState(true, true));
      if (hideTimeoutRef.current != null) window.clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = window.setTimeout(() => {
        hideTimeoutRef.current = null;
        setViewportState(previous => ({ ...previous, active: false }));
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
  }, [scrollRef]);

  const fastStackedItems = useMemo(
    () => (mode === 'stacked' ? splitFastStackedItems(stackedVirtualItems) : stackedVirtualItems),
    [mode, stackedVirtualItems],
  );
  const fastStackedHeights = useMemo(
    () => fastStackedItems.map(item => item.height),
    [fastStackedItems],
  );
  const activeHeights = mode === 'stacked' ? fastStackedHeights : itemHeights;
  const prefixSums = useMemo(() => {
    const sums = new Array<number>(activeHeights.length + 1).fill(0);
    activeHeights.forEach((height, index) => {
      sums[index + 1] = sums[index]! + height;
    });
    return sums;
  }, [activeHeights]);
  const totalH = prefixSums[prefixSums.length - 1] ?? 0;
  const bodyViewportHeight = Math.max(1, viewportHeight - stickyHeaderHeight);
  const averageHeight = activeHeights.length > 0 ? totalH / activeHeights.length : 24;
  const range = useMemo(() => computeVariableRange({
    heightsLength: activeHeights.length,
    prefixSums,
    totalH,
    averageHeight,
    scrollTop: viewportState.scrollTop,
    viewH: bodyViewportHeight,
    overscanMin: mode === 'stacked' ? 0 : 2,
    overscanFactor: mode === 'stacked' ? 0 : 0.25,
  }), [activeHeights.length, averageHeight, bodyViewportHeight, mode, prefixSums, totalH, viewportState.scrollTop]);

  const bodyLayout = useWorkbookCompareBodyLayout({
    mode,
    stackedVirtualItems: fastStackedItems,
    startIdx: viewportState.active ? range.startIdx : 0,
    endIdx: viewportState.active ? range.endIdx : 0,
    items,
    guidedHunkRange,
    activeSearchLineIdx,
    searchMatchSet,
    visibleFrozenStackedCanvasRuns: EMPTY_STACKED_RUNS,
  });

  if (!viewportState.active || viewportWidth <= 0 || viewportHeight <= stickyHeaderHeight) return null;

  return (
    <div
      data-workbook-fast-scroll-viewport={mode}
      className="workbook-fast-scroll-layer"
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: stickyHeaderHeight,
        left: 0,
        width: viewportWidth,
        height: bodyViewportHeight,
        overflow: 'hidden',
        pointerEvents: 'none',
        background: 'var(--workbook-canvas-bg)',
        opacity: viewportState.settling ? 0 : 1,
        willChange: 'opacity',
        zIndex: 30,
      }}>
      <div
        style={{
          position: 'absolute',
          top: range.offsetTop - viewportState.scrollTop,
          left: 0,
          minWidth: minBodyWidth,
        }}>
        {mode === 'stacked' ? bodyLayout.bodySegments.map((segment, segmentIndex) => {
          if (segment.kind !== 'rows') {
            return (
              <div
                key={`fast-stacked-placeholder-${segmentIndex}`}
                style={{
                  position: 'absolute',
                  top: segment.top,
                  left: 0,
                  width: viewportWidth,
                  height: segment.height,
                  background: 'var(--workbook-cell-bg)',
                  borderBottom: '1px solid var(--border)',
                }}
              />
            );
          }
          return (
            <div
              key={`fast-stacked-tile-${segmentIndex}`}
              style={{
                position: 'absolute',
                top: segment.top,
                left: 0,
                width: viewportWidth,
                height: segment.height,
                overflow: 'hidden',
              }}>
              <WorkbookStackedCanvasStrip {...stackedCanvasProps} groups={[segment.group]} />
            </div>
          );
        }) : (bodyLayout.columnsBodySegments ?? []).map((segment, segmentIndex) => {
          if (segment.kind !== 'rows') {
            return (
              <div
                key={`fast-columns-placeholder-${segmentIndex}`}
                style={{
                  position: 'absolute',
                  top: segment.top,
                  left: 0,
                  width: viewportWidth,
                  height: segment.height,
                  background: 'var(--workbook-cell-bg)',
                  borderBottom: '1px solid var(--border)',
                }}
              />
            );
          }

          return (
            <div
              key={`fast-columns-tile-${segmentIndex}`}
              style={{
                position: 'absolute',
                top: segment.top,
                left: 0,
                width: viewportWidth,
                height: segment.height,
                overflow: 'hidden',
              }}>
              <WorkbookColumnsCanvasStrip {...columnsCanvasProps} rows={segment.rows} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
