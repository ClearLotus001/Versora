import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { scrollElementForNavigation } from '@/utils/navigation/animatedScroll';
import { subscribeProgrammaticScrollSync } from '@/utils/virtualization/programmaticScrollSync';
import {
  VIRTUAL_FAST_SCROLL_END_EVENT,
  beginVirtualFastScrollSession,
  endVirtualFastScrollSession,
  getVirtualFastScrollOwner,
  isVirtualFastScrollSessionActive,
} from '@/utils/virtualization/fastScrollSession';

export interface VariableVirtualDebugInfo {
  viewportHeight: number;
  overscan: number;
  rangeUpdates: number;
  lastCalcMs: number;
}

export interface VariableVirtualResult {
  totalH: number;
  startIdx: number;
  endIdx: number;
  offsetTop: number;
  syncViewport: () => void;
  scrollToIndex: (idx: number, align?: 'start' | 'center', behavior?: 'auto' | 'smooth' | 'smart') => void;
  debug: VariableVirtualDebugInfo;
}

interface UseVariableVirtualOptions {
  enabled?: boolean;
  overscanMin?: number;
  overscanFactor?: number;
  syncKey?: string | number | null;
  getScrollFollowers?: (() => readonly HTMLElement[]) | undefined;
  enableFastScrollSession?: boolean;
}

const DEFAULT_OVERSCAN_MIN = 12;
const DEFAULT_OVERSCAN_FACTOR = 1.5;

function getNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function findIndexForOffset(prefixSums: number[], offset: number): number {
  let low = 0;
  let high = prefixSums.length - 1;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((prefixSums[mid] ?? 0) <= offset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return Math.max(0, low - 1);
}

export interface ComputeVariableRangeParams {
  heightsLength: number;
  prefixSums: number[];
  totalH: number;
  averageHeight: number;
  scrollTop: number;
  viewH: number;
  overscanMin: number;
  overscanFactor: number;
}

export interface VariableVirtualRange {
  startIdx: number;
  endIdx: number;
  offsetTop: number;
  overscan: number;
}

export function computeVariableRange(params: ComputeVariableRangeParams): VariableVirtualRange {
  const {
    heightsLength,
    prefixSums,
    totalH,
    averageHeight,
    scrollTop,
    viewH,
    overscanMin,
    overscanFactor,
  } = params;
  const maxScrollTop = Math.max(0, totalH - Math.max(0, viewH));
  const clampedScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));
  const visibleItemCount = Math.max(1, Math.ceil(viewH / Math.max(averageHeight, 1)));
  const overscan = Math.max(overscanMin, Math.ceil(visibleItemCount * overscanFactor));
  const overscanPx = overscan * averageHeight;
  const startOffset = Math.max(0, clampedScrollTop - overscanPx);
  const endOffset = Math.min(totalH, clampedScrollTop + viewH + overscanPx);
  const startIdx = Math.max(0, Math.min(heightsLength, findIndexForOffset(prefixSums, startOffset)));
  const endIdx = Math.max(
    startIdx,
    Math.min(heightsLength, findIndexForOffset(prefixSums, endOffset) + 1),
  );
  const offsetTop = prefixSums[startIdx] ?? 0;

  return {
    startIdx,
    endIdx,
    offsetTop,
    overscan,
  };
}

export function shouldRetainVariableVirtualRange(
  currentRange: VariableVirtualRange,
  params: ComputeVariableRangeParams,
): boolean {
  const {
    heightsLength,
    prefixSums,
    totalH,
    averageHeight,
    scrollTop,
    viewH,
    overscanMin,
    overscanFactor,
  } = params;
  const maxScrollTop = Math.max(0, totalH - Math.max(0, viewH));
  const clampedScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));
  const visibleBottom = Math.min(totalH, clampedScrollTop + Math.max(0, viewH));
  const visibleItemCount = Math.max(1, Math.ceil(viewH / Math.max(averageHeight, 1)));
  const overscan = Math.max(overscanMin, Math.ceil(visibleItemCount * overscanFactor));

  if (
    currentRange.overscan !== overscan
    || currentRange.startIdx < 0
    || currentRange.endIdx < currentRange.startIdx
    || currentRange.endIdx > heightsLength
  ) {
    return false;
  }

  if (!doesVariableVirtualRangeCoverViewport(currentRange, params)) return false;

  const rangeTop = prefixSums[currentRange.startIdx] ?? 0;
  const rangeBottom = prefixSums[currentRange.endIdx] ?? totalH;

  const guardPx = Math.max(1, overscan * Math.max(averageHeight, 1) * 0.5);
  const hasLeadingGuard = currentRange.startIdx === 0
    || clampedScrollTop - rangeTop >= guardPx;
  const hasTrailingGuard = currentRange.endIdx === heightsLength
    || rangeBottom - visibleBottom >= guardPx;
  return hasLeadingGuard && hasTrailingGuard;
}

export function doesVariableVirtualRangeCoverViewport(
  currentRange: VariableVirtualRange,
  params: Pick<
    ComputeVariableRangeParams,
    'heightsLength' | 'prefixSums' | 'totalH' | 'scrollTop' | 'viewH'
  >,
): boolean {
  const {
    heightsLength,
    prefixSums,
    totalH,
    scrollTop,
    viewH,
  } = params;
  if (
    currentRange.startIdx < 0
    || currentRange.endIdx < currentRange.startIdx
    || currentRange.endIdx > heightsLength
  ) {
    return false;
  }

  const maxScrollTop = Math.max(0, totalH - Math.max(0, viewH));
  const clampedScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));
  const visibleBottom = Math.min(totalH, clampedScrollTop + Math.max(0, viewH));
  const rangeTop = prefixSums[currentRange.startIdx] ?? 0;
  const rangeBottom = prefixSums[currentRange.endIdx] ?? totalH;
  return currentRange.offsetTop === rangeTop
    && rangeTop <= clampedScrollTop
    && rangeBottom >= visibleBottom;
}

export function useVariableVirtual(
  heights: number[],
  scrollRef: RefObject<HTMLDivElement | null>,
  options: UseVariableVirtualOptions = {},
): VariableVirtualResult {
  const enabled = options.enabled ?? true;
  const overscanMin = options.overscanMin ?? DEFAULT_OVERSCAN_MIN;
  const overscanFactor = options.overscanFactor ?? DEFAULT_OVERSCAN_FACTOR;
  const syncKey = options.syncKey ?? null;
  const getScrollFollowers = options.getScrollFollowers;
  const enableFastScrollSession = options.enableFastScrollSession ?? false;
  const [viewH, setViewH] = useState(600);
  const [rangeState, setRangeState] = useState<VariableVirtualRange>({ startIdx: 0, endIdx: 0, offsetTop: 0, overscan: overscanMin });
  const latestScrollTopRef = useRef(0);
  const viewHRef = useRef(600);
  const rafRef = useRef<number>(0);
  const rangeUpdateCountRef = useRef(1);
  const lastCalcMsRef = useRef(0);
  const rangeRef = useRef(rangeState);
  const syncKeyRef = useRef(syncKey);

  const prefixSums = useMemo(() => {
    const sums = new Array<number>(heights.length + 1).fill(0);
    for (let index = 0; index < heights.length; index += 1) {
      sums[index + 1] = sums[index]! + (heights[index] ?? 0);
    }
    return sums;
  }, [heights]);

  const totalH = prefixSums[prefixSums.length - 1] ?? 0;
  const averageHeight = heights.length > 0 ? totalH / heights.length : 21;

  const applyRange = useCallback((nextScrollTop: number, nextViewH: number) => {
    if (!enabled) return;
    const calcStart = getNow();
    const params: ComputeVariableRangeParams = {
      heightsLength: heights.length,
      prefixSums,
      totalH,
      averageHeight,
      scrollTop: nextScrollTop,
      viewH: nextViewH,
      overscanMin,
      overscanFactor,
    };
    const prev = rangeRef.current;
    if (shouldRetainVariableVirtualRange(prev, params)) {
      lastCalcMsRef.current = getNow() - calcStart;
      return;
    }

    const next = computeVariableRange(params);
    lastCalcMsRef.current = getNow() - calcStart;

    if (
      prev.startIdx === next.startIdx
      && prev.endIdx === next.endIdx
      && prev.offsetTop === next.offsetTop
      && prev.overscan === next.overscan
    ) {
      return;
    }

    rangeRef.current = next;
    rangeUpdateCountRef.current += 1;
    setRangeState(next);
  }, [averageHeight, enabled, heights.length, overscanFactor, overscanMin, prefixSums, totalH]);

  const syncViewport = useCallback(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    const nextViewH = Math.max(0, el.clientHeight);
    viewHRef.current = nextViewH;
    latestScrollTopRef.current = Math.max(0, Math.round(el.scrollTop));
    setViewH(prev => (prev === nextViewH ? prev : nextViewH));
    applyRange(latestScrollTopRef.current, nextViewH);
  }, [applyRange, enabled, scrollRef]);

  useLayoutEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      const nextViewH = Math.max(0, Math.round(entries[0]?.contentRect.height ?? el.clientHeight));
      viewHRef.current = nextViewH;
      setViewH(prev => (prev === nextViewH ? prev : nextViewH));
      applyRange(latestScrollTopRef.current, nextViewH);
    });
    ro.observe(el);

    syncViewport();

    return () => ro.disconnect();
  }, [applyRange, enabled, scrollRef, syncViewport]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!enabled || !el) return;
    return subscribeProgrammaticScrollSync(el, 'range', () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      latestScrollTopRef.current = Math.max(0, Math.round(el.scrollTop));
      if (!isVirtualFastScrollSessionActive(el)) {
        applyRange(latestScrollTopRef.current, viewHRef.current);
      }
    });
  }, [applyRange, enabled, scrollRef]);

  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;
    let implicitFastScrollTimeout: number | null = null;

    const scheduleImplicitFastScrollEnd = () => {
      if (implicitFastScrollTimeout != null) window.clearTimeout(implicitFastScrollTimeout);
      implicitFastScrollTimeout = window.setTimeout(() => {
        implicitFastScrollTimeout = null;
        endVirtualFastScrollSession(el, 'implicit');
      }, 96);
    };

    const onScroll = () => {
      latestScrollTopRef.current = Math.max(0, Math.round(el.scrollTop));
      if (isVirtualFastScrollSessionActive(el)) {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        if (getVirtualFastScrollOwner(el) === 'implicit') scheduleImplicitFastScrollEnd();
        return;
      }
      if (!doesVariableVirtualRangeCoverViewport(rangeRef.current, {
        heightsLength: heights.length,
        prefixSums,
        totalH,
        scrollTop: latestScrollTopRef.current,
        viewH: viewHRef.current,
      })) {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        if (enableFastScrollSession) {
          beginVirtualFastScrollSession(el, 'implicit');
          scheduleImplicitFastScrollEnd();
          return;
        }
        flushSync(() => {
          applyRange(latestScrollTopRef.current, viewHRef.current);
        });
        return;
      }
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        applyRange(latestScrollTopRef.current, viewHRef.current);
      });
    };
    const onFastScrollEnd = () => {
      latestScrollTopRef.current = Math.max(0, Math.round(el.scrollTop));
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      flushSync(() => {
        applyRange(latestScrollTopRef.current, viewHRef.current);
      });
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener(VIRTUAL_FAST_SCROLL_END_EVENT, onFastScrollEnd);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener(VIRTUAL_FAST_SCROLL_END_EVENT, onFastScrollEnd);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (implicitFastScrollTimeout != null) window.clearTimeout(implicitFastScrollTimeout);
      endVirtualFastScrollSession(el, 'implicit');
    };
  }, [applyRange, enabled, enableFastScrollSession, heights.length, prefixSums, scrollRef, totalH]);

  useLayoutEffect(() => {
    applyRange(latestScrollTopRef.current, viewHRef.current);
  }, [applyRange]);

  useLayoutEffect(() => {
    if (!enabled) return;
    if (syncKeyRef.current === syncKey) return;
    syncKeyRef.current = syncKey;
    latestScrollTopRef.current = 0;
    const el = scrollRef.current;
    if (el && el.scrollTop !== 0) {
      scrollElementForNavigation(el, {
        top: 0,
        behavior: 'auto',
        linkedElements: getScrollFollowers?.(),
      });
    }
    applyRange(0, viewHRef.current);
  }, [applyRange, enabled, getScrollFollowers, scrollRef, syncKey]);

  const effectiveRangeState = useMemo(() => {
    const resetViewport = syncKeyRef.current !== syncKey;
    const params: ComputeVariableRangeParams = {
      heightsLength: heights.length,
      prefixSums,
      totalH,
      averageHeight,
      scrollTop: resetViewport ? 0 : latestScrollTopRef.current,
      viewH,
      overscanMin,
      overscanFactor,
    };
    // New layouts and filtered row sets need a valid window in this render,
    // before effects synchronize the measured viewport and stored range.
    return resetViewport || !doesVariableVirtualRangeCoverViewport(rangeState, params)
      ? computeVariableRange(params)
      : rangeState;
  }, [averageHeight, heights.length, overscanFactor, overscanMin, prefixSums, rangeState, syncKey, totalH, viewH]);

  const scrollToIndex = useCallback((idx: number, align: 'start' | 'center' = 'start', behavior: 'auto' | 'smooth' | 'smart' = 'smart') => {
    const el = scrollRef.current;
    if (!el) return;

    const itemTop = prefixSums[Math.max(0, Math.min(idx, heights.length))] ?? 0;
    const itemHeight = heights[Math.max(0, Math.min(idx, heights.length - 1))] ?? averageHeight;
    const offset = align === 'center'
      ? Math.max(0, (viewH / 2) - (itemHeight / 2))
      : 60;
    const nextTop = Math.max(0, itemTop - offset);
    scrollElementForNavigation(el, {
      top: nextTop,
      behavior,
      linkedElements: getScrollFollowers?.(),
    });
  }, [averageHeight, getScrollFollowers, heights, prefixSums, scrollRef, viewH]);

  return {
    totalH,
    startIdx: effectiveRangeState.startIdx,
    endIdx: effectiveRangeState.endIdx,
    offsetTop: effectiveRangeState.offsetTop,
    syncViewport,
    scrollToIndex,
    debug: {
      viewportHeight: viewH,
      overscan: effectiveRangeState.overscan,
      rangeUpdates: rangeUpdateCountRef.current,
      lastCalcMs: lastCalcMsRef.current,
    },
  };
}
