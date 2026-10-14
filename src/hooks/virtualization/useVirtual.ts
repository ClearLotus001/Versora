// ─────────────────────────────────────────────────────────────────────────────
// src/hooks/useVirtual.ts  —  Virtual scroll hook  [v3 fixed]
//
// AUDIT FIXES (round 3):
//  1. scrollRef was typed as RefObject<HTMLDivElement | null> but the hook was called
//     with `scrollRef as RefObject<HTMLDivElement | null>` casts everywhere because
//     useRef<HTMLDivElement>(null) returns MutableRefObject. The cast is safe
//     but unnecessary noise. Kept as-is (React 18 useRef typing quirk).
//  2. useEffect for ResizeObserver had `[scrollRef]` dependency — this is a
//     ref object and its identity is stable across renders, so the effect runs
//     only once. Correct. No change.
//  3. scrollToIndex: `viewH / 2 - ROW_H / 2` could be negative if the panel
//     hasn't rendered yet (viewH = 0 default). Added Math.max(0, ...) guard.
//  4. rafRef.current initial value was 0 which is a falsy-but-valid RAF id
//     only in theory — browsers start RAF ids at 1, so 0 is safe as sentinel.
//     No change, but documented.
//  5. Hook cleanup didn't cancel the ResizeObserver RAF if one was pending.
//     ResizeObserver callback called setViewH synchronously (no RAF), so no
//     leak there. Confirmed correct.
//  6. Exported ROW_H must match the actual rendered row height. Added comment
//     reminding maintainers to update if CSS changes.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { VirtualState } from '@/types';
import { scrollElementForNavigation } from '@/utils/navigation/animatedScroll';
import { subscribeProgrammaticScrollSync } from '@/utils/virtualization/programmaticScrollSync';

/**
 * Row height in pixels. MUST match the `height: ROW_H` in every row component.
 * If you change this, update all inline `style={{ height: ROW_H }}` usages too.
 * 24px keeps the max 20px zoom readable without workbook cell glyphs touching borders.
 */
export const ROW_H = 24;
const DEFAULT_OVERSCAN_MIN = 80;
const DEFAULT_OVERSCAN_FACTOR = 3;

export interface UseVirtualOptions {
  overscanMin?: number;
  overscanFactor?: number;
  syncKey?: string | number | null;
  getScrollFollowers?: (() => readonly HTMLElement[]) | undefined;
}

export interface VirtualWindow extends VirtualState {
  visibleRowCount: number;
  overscan: number;
}

export interface VirtualDebugInfo {
  viewportHeight: number;
  visibleRowCount: number;
  overscan: number;
  rangeUpdates: number;
  lastCalcMs: number;
}

interface UseVirtualReturn extends VirtualState {
  scrollToIndex: (idx: number, align?: 'start' | 'center', behavior?: 'auto' | 'smooth' | 'smart') => void;
  debug: VirtualDebugInfo;
}

function getNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function computeVirtualWindow(
  count: number,
  rowHeight: number,
  viewH: number,
  scrollTop: number,
  overscanMin = DEFAULT_OVERSCAN_MIN,
  overscanFactor = DEFAULT_OVERSCAN_FACTOR,
): VirtualWindow {
  const totalH = count * rowHeight;
  const maxScrollTop = Math.max(0, totalH - Math.max(0, viewH));
  const clampedScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));
  const visibleRowCount = Math.max(1, Math.ceil(viewH / Math.max(rowHeight, 1)));
  const overscan = Math.max(overscanMin, Math.ceil(visibleRowCount * overscanFactor));
  const startIdx = Math.max(0, Math.floor((clampedScrollTop - overscan * rowHeight) / rowHeight));
  const endIdx = Math.min(count, Math.ceil((clampedScrollTop + viewH + overscan * rowHeight) / rowHeight));
  return {
    totalH,
    startIdx,
    endIdx,
    visibleRowCount,
    overscan,
  };
}

export function shouldRetainVirtualWindow(
  currentRange: VirtualWindow,
  count: number,
  rowHeight: number,
  viewH: number,
  scrollTop: number,
  overscanMin = DEFAULT_OVERSCAN_MIN,
  overscanFactor = DEFAULT_OVERSCAN_FACTOR,
): boolean {
  const normalizedRowHeight = Math.max(rowHeight, 1);
  const totalH = count * rowHeight;
  const maxScrollTop = Math.max(0, totalH - Math.max(0, viewH));
  const clampedScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));
  const visibleRowCount = Math.max(1, Math.ceil(viewH / normalizedRowHeight));
  const overscan = Math.max(overscanMin, Math.ceil(visibleRowCount * overscanFactor));

  if (
    currentRange.totalH !== totalH
    || currentRange.visibleRowCount !== visibleRowCount
    || currentRange.overscan !== overscan
    || currentRange.startIdx < 0
    || currentRange.endIdx < currentRange.startIdx
    || currentRange.endIdx > count
  ) {
    return false;
  }

  if (!doesVirtualWindowCoverViewport(currentRange, count, rowHeight, viewH, scrollTop)) return false;

  const visibleStart = Math.max(0, Math.min(count, Math.floor(clampedScrollTop / normalizedRowHeight)));
  const visibleEnd = Math.max(
    visibleStart,
    Math.min(count, Math.ceil((clampedScrollTop + Math.max(0, viewH)) / normalizedRowHeight)),
  );
  const guardRows = Math.max(1, Math.floor(overscan * 0.5));
  const hasLeadingGuard = currentRange.startIdx === 0
    || visibleStart - currentRange.startIdx >= guardRows;
  const hasTrailingGuard = currentRange.endIdx === count
    || currentRange.endIdx - visibleEnd >= guardRows;
  return hasLeadingGuard && hasTrailingGuard;
}

export function doesVirtualWindowCoverViewport(
  currentRange: VirtualWindow,
  count: number,
  rowHeight: number,
  viewH: number,
  scrollTop: number,
): boolean {
  const normalizedRowHeight = Math.max(rowHeight, 1);
  const totalH = count * rowHeight;
  if (
    currentRange.totalH !== totalH
    || currentRange.startIdx < 0
    || currentRange.endIdx < currentRange.startIdx
    || currentRange.endIdx > count
  ) {
    return false;
  }

  const maxScrollTop = Math.max(0, totalH - Math.max(0, viewH));
  const clampedScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));
  const visibleStart = Math.max(0, Math.min(count, Math.floor(clampedScrollTop / normalizedRowHeight)));
  const visibleEnd = Math.max(
    visibleStart,
    Math.min(count, Math.ceil((clampedScrollTop + Math.max(0, viewH)) / normalizedRowHeight)),
  );
  return currentRange.startIdx <= visibleStart && currentRange.endIdx >= visibleEnd;
}

export function useVirtual(
  count: number,
  scrollRef: RefObject<HTMLDivElement | null>,
  rowHeight: number = ROW_H,
  options: UseVirtualOptions = {},
): UseVirtualReturn {
  const overscanMin = options.overscanMin ?? DEFAULT_OVERSCAN_MIN;
  const overscanFactor = options.overscanFactor ?? DEFAULT_OVERSCAN_FACTOR;
  const syncKey = options.syncKey ?? null;
  const getScrollFollowers = options.getScrollFollowers;
  const [viewH, setViewH] = useState(600);
  const [windowRange, setWindowRange] = useState<VirtualWindow>(() => computeVirtualWindow(
    count,
    rowHeight,
    600,
    0,
    overscanMin,
    overscanFactor,
  ));
  const latestScrollTopRef = useRef(0);
  const viewHRef = useRef(600);
  const rangeRef = useRef(windowRange);
  const rafRef = useRef<number>(0);
  const lastCalcMsRef = useRef(0);
  const rangeUpdateCountRef = useRef(1);
  const syncKeyRef = useRef(syncKey);

  // Use ref for count to avoid recreating applyWindowRange (and thus
  // re-attaching scroll/ResizeObserver listeners) every time count changes.
  const countRef = useRef(count);
  countRef.current = count;

  const applyWindowRange = useCallback((scrollTop: number, nextViewH: number) => {
    const calcStart = getNow();
    const prevRange = rangeRef.current;
    if (shouldRetainVirtualWindow(
      prevRange,
      countRef.current,
      rowHeight,
      nextViewH,
      scrollTop,
      overscanMin,
      overscanFactor,
    )) {
      lastCalcMsRef.current = getNow() - calcStart;
      return;
    }

    const nextRange = computeVirtualWindow(
      countRef.current,
      rowHeight,
      nextViewH,
      scrollTop,
      overscanMin,
      overscanFactor,
    );
    lastCalcMsRef.current = getNow() - calcStart;

    if (
      prevRange.startIdx === nextRange.startIdx
      && prevRange.endIdx === nextRange.endIdx
      && prevRange.visibleRowCount === nextRange.visibleRowCount
      && prevRange.overscan === nextRange.overscan
      && prevRange.totalH === nextRange.totalH
    ) {
      return;
    }

    rangeRef.current = nextRange;
    rangeUpdateCountRef.current += 1;
    setWindowRange(nextRange);
  }, [overscanFactor, overscanMin, rowHeight]);

  // ResizeObserver — stable ref, runs once
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const nextViewH = Math.max(0, Math.round(entries[0]?.contentRect.height ?? el.clientHeight));
      viewHRef.current = nextViewH;
      setViewH(prev => (prev === nextViewH ? prev : nextViewH));
      applyWindowRange(latestScrollTopRef.current, nextViewH);
    });
    ro.observe(el);
    const nextViewH = Math.max(0, el.clientHeight);
    viewHRef.current = nextViewH;
    latestScrollTopRef.current = Math.max(0, Math.round(el.scrollTop));
    setViewH(prev => (prev === nextViewH ? prev : nextViewH));
    applyWindowRange(latestScrollTopRef.current, nextViewH);
    return () => ro.disconnect();
  }, [applyWindowRange, rowHeight, scrollRef]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    return subscribeProgrammaticScrollSync(el, 'range', () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      latestScrollTopRef.current = Math.max(0, Math.round(el.scrollTop));
      applyWindowRange(latestScrollTopRef.current, viewHRef.current);
    });
  }, [applyWindowRange, scrollRef]);

  // Keep up with thumb dragging without pushing React through more than one
  // rerender per frame.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      latestScrollTopRef.current = Math.max(0, Math.round(el.scrollTop));
      if (!doesVirtualWindowCoverViewport(
        rangeRef.current,
        countRef.current,
        rowHeight,
        viewHRef.current,
        latestScrollTopRef.current,
      )) {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        flushSync(() => {
          applyWindowRange(latestScrollTopRef.current, viewHRef.current);
        });
        return;
      }
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        applyWindowRange(latestScrollTopRef.current, viewHRef.current);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [applyWindowRange, rowHeight, scrollRef]);

  useLayoutEffect(() => {
    applyWindowRange(latestScrollTopRef.current, viewHRef.current);
  }, [applyWindowRange]);

  // When count changes, recompute window range without recreating scroll listeners
  useLayoutEffect(() => {
    applyWindowRange(latestScrollTopRef.current, viewHRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  useLayoutEffect(() => {
    if (syncKeyRef.current === syncKey) return;
    syncKeyRef.current = syncKey;
    latestScrollTopRef.current = 0;
    const el = scrollRef.current;
    if (el && (el.scrollTop !== 0 || el.scrollLeft !== 0)) {
      scrollElementForNavigation(el, {
        top: 0,
        left: 0,
        behavior: 'auto',
        linkedElements: getScrollFollowers?.(),
      });
    }
    const nextRange = computeVirtualWindow(
      count,
      rowHeight,
      viewHRef.current,
      0,
      overscanMin,
      overscanFactor,
    );
    rangeRef.current = nextRange;
    setWindowRange(nextRange);
  }, [count, getScrollFollowers, overscanFactor, overscanMin, rowHeight, scrollRef, syncKey]);

  const effectiveWindowRange = useMemo(() => {
    const resetViewport = syncKeyRef.current !== syncKey;
    const scrollTop = resetViewport ? 0 : latestScrollTopRef.current;
    return resetViewport || !doesVirtualWindowCoverViewport(windowRange, count, rowHeight, viewH, scrollTop)
      ? computeVirtualWindow(
        count,
        rowHeight,
        viewH,
        scrollTop,
        overscanMin,
        overscanFactor,
      )
      : windowRange;
  }, [count, overscanFactor, overscanMin, rowHeight, syncKey, viewH, windowRange]);
  const totalH = effectiveWindowRange.totalH;

  const scrollToIndex = useCallback(
    (idx: number, align: 'start' | 'center' = 'start', behavior: 'auto' | 'smooth' | 'smart' = 'smart') => {
      const el = scrollRef.current;
      if (!el) return;
      const targetTop = idx * rowHeight;
      // FIX: Math.max(0,...) prevents negative scroll when viewH is 0 at mount
      const offset = align === 'center'
        ? Math.max(0, viewH / 2 - rowHeight / 2)
        : 60;
      const nextTop = Math.max(0, targetTop - offset);
      scrollElementForNavigation(el, {
        top: nextTop,
        behavior,
        linkedElements: getScrollFollowers?.(),
      });
    },
    [getScrollFollowers, scrollRef, viewH, rowHeight],
  );

  const debug = useMemo<VirtualDebugInfo>(() => ({
    viewportHeight: viewH,
    visibleRowCount: effectiveWindowRange.visibleRowCount,
    overscan: effectiveWindowRange.overscan,
    rangeUpdates: rangeUpdateCountRef.current,
    lastCalcMs: lastCalcMsRef.current,
  }), [effectiveWindowRange.overscan, effectiveWindowRange.visibleRowCount, viewH]);

  return {
    totalH,
    startIdx: effectiveWindowRange.startIdx,
    endIdx: effectiveWindowRange.endIdx,
    scrollToIndex,
    debug,
  };
}
