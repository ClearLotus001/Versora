import { synchronizeProgrammaticScroll } from '@/utils/virtualization/programmaticScrollSync';

export type NavigationScrollBehavior = 'auto' | 'smooth' | 'smart';

export interface NavigationScrollOptions {
  top?: number;
  left?: number;
  behavior?: NavigationScrollBehavior;
  linkedElements?: readonly HTMLElement[] | undefined;
}

type ScrollAxis = 'top' | 'left';

interface AxisAnimation {
  from: number;
  to: number;
  startedAt: number;
  duration: number;
  easing: (progress: number) => number;
  behavior: 'smart' | 'smooth';
  linkedElements: readonly HTMLElement[];
}

interface ElementScrollAnimation {
  top: AxisAnimation | null;
  left: AxisAnimation | null;
  frameId: number;
  removeInterruptListeners: (() => void) | null;
  interruptElements: readonly HTMLElement[];
}

const activeAnimations = new WeakMap<HTMLElement, ElementScrollAnimation>();
const SCROLL_AXES = ['top', 'left'] as const;
const MIN_SCROLL_DURATION_MS = 180;
const MAX_SCROLL_DURATION_MS = 420;
const SCROLL_DURATION_STEP_MS = 56;
const MIN_FOCUS_SCROLL_DURATION_MS = 150;
const MAX_FOCUS_SCROLL_DURATION_MS = 300;
const FOCUS_SCROLL_DURATION_STEP_MS = 42;

function getNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function easeNavigationScroll(progress: number): number {
  const t = clamp(progress, 0, 1);
  // Smootherstep starts and ends with zero velocity and acceleration. This
  // avoids the sharp take-off and final snap that are especially visible in
  // dense workbook grids.
  return t * t * t * (t * ((t * 6) - 15) + 10);
}

export function easeResponsiveFocusScroll(progress: number): number {
  const t = clamp(progress, 0, 1);
  // Smoothstep keeps the same soft spatial continuity as hunk navigation,
  // while leaving less time in the near-zero-velocity phase for rapid cells.
  return t * t * (3 - (2 * t));
}

export function getNavigationScrollDuration(distance: number, viewportSize: number): number {
  const safeViewportSize = Math.max(1, viewportSize);
  const viewportCount = Math.max(0, distance) / safeViewportSize;
  return clamp(
    MIN_SCROLL_DURATION_MS + (Math.log2(viewportCount + 1) * SCROLL_DURATION_STEP_MS),
    MIN_SCROLL_DURATION_MS,
    MAX_SCROLL_DURATION_MS,
  );
}

export function getResponsiveFocusScrollDuration(distance: number, viewportSize: number): number {
  const safeViewportSize = Math.max(1, viewportSize);
  const viewportCount = Math.max(0, distance) / safeViewportSize;
  return clamp(
    MIN_FOCUS_SCROLL_DURATION_MS + (Math.log2(viewportCount + 1) * FOCUS_SCROLL_DURATION_STEP_MS),
    MIN_FOCUS_SCROLL_DURATION_MS,
    MAX_FOCUS_SCROLL_DURATION_MS,
  );
}

function getAxisPosition(element: HTMLElement, axis: ScrollAxis) {
  return axis === 'top' ? element.scrollTop : element.scrollLeft;
}

function setAxisPosition(
  element: HTMLElement,
  axis: ScrollAxis,
  value: number,
  linkedElements: readonly HTMLElement[] = [],
) {
  if (axis === 'top') {
    element.scrollTop = value;
    linkedElements.forEach((linkedElement) => {
      if (linkedElement !== element) linkedElement.scrollTop = value;
    });
  } else {
    element.scrollLeft = value;
    linkedElements.forEach((linkedElement) => {
      if (linkedElement !== element) linkedElement.scrollLeft = value;
    });
  }
  synchronizeProgrammaticScroll(element);
  linkedElements.forEach((linkedElement) => {
    if (linkedElement !== element) synchronizeProgrammaticScroll(linkedElement);
  });
}

function getAxisTarget(element: HTMLElement, axis: ScrollAxis, requestedTarget: number) {
  const maximum = axis === 'top'
    ? Math.max(0, element.scrollHeight - element.clientHeight)
    : Math.max(0, element.scrollWidth - element.clientWidth);
  return clamp(requestedTarget, 0, maximum);
}

function getAxisViewportSize(element: HTMLElement, axis: ScrollAxis) {
  return axis === 'top' ? element.clientHeight : element.clientWidth;
}

function clearAnimationIfIdle(element: HTMLElement, animation: ElementScrollAnimation) {
  if (animation.top || animation.left) return;
  if (animation.frameId) {
    cancelAnimationFrame(animation.frameId);
    animation.frameId = 0;
  }
  animation.removeInterruptListeners?.();
  animation.removeInterruptListeners = null;
  animation.interruptElements = [];
  activeAnimations.delete(element);
}

function cancelElementScrollAnimation(element: HTMLElement) {
  const animation = activeAnimations.get(element);
  if (!animation) return;
  animation.top = null;
  animation.left = null;
  clearAnimationIfIdle(element, animation);
}

function ensureInterruptListeners(element: HTMLElement, animation: ElementScrollAnimation) {
  const nextElements = [...new Set([
    element,
    ...(animation.top?.linkedElements ?? []),
    ...(animation.left?.linkedElements ?? []),
  ])];
  if (
    animation.removeInterruptListeners
    && nextElements.length === animation.interruptElements.length
    && nextElements.every((nextElement) => animation.interruptElements.includes(nextElement))
  ) {
    return;
  }

  animation.removeInterruptListeners?.();

  const handleUserInterrupt = () => cancelElementScrollAnimation(element);
  nextElements.forEach((interruptElement) => {
    interruptElement.addEventListener('wheel', handleUserInterrupt, { passive: true });
    interruptElement.addEventListener('touchstart', handleUserInterrupt, { passive: true });
    interruptElement.addEventListener('pointerdown', handleUserInterrupt, { passive: true });
  });
  animation.interruptElements = nextElements;
  animation.removeInterruptListeners = () => {
    nextElements.forEach((interruptElement) => {
      interruptElement.removeEventListener('wheel', handleUserInterrupt);
      interruptElement.removeEventListener('touchstart', handleUserInterrupt);
      interruptElement.removeEventListener('pointerdown', handleUserInterrupt);
    });
  };
}

function runAnimationFrame(element: HTMLElement, animation: ElementScrollAnimation, timestamp: number) {
  animation.frameId = 0;

  SCROLL_AXES.forEach((axis) => {
    const axisAnimation = animation[axis];
    if (!axisAnimation) return;

    const progress = Math.min(1, (timestamp - axisAnimation.startedAt) / axisAnimation.duration);
    const easedProgress = axisAnimation.easing(progress);
    setAxisPosition(
      element,
      axis,
      axisAnimation.from + ((axisAnimation.to - axisAnimation.from) * easedProgress),
      axisAnimation.linkedElements,
    );

    if (progress >= 1) {
      setAxisPosition(element, axis, axisAnimation.to, axisAnimation.linkedElements);
      animation[axis] = null;
    }
  });

  if (!animation.top && !animation.left) {
    clearAnimationIfIdle(element, animation);
    return;
  }

  animation.frameId = requestAnimationFrame((nextTimestamp) => {
    runAnimationFrame(element, animation, nextTimestamp);
  });
}

function getOrCreateAnimation(element: HTMLElement) {
  const existing = activeAnimations.get(element);
  if (existing) return existing;

  const animation: ElementScrollAnimation = {
    top: null,
    left: null,
    frameId: 0,
    removeInterruptListeners: null,
    interruptElements: [],
  };
  activeAnimations.set(element, animation);
  return animation;
}

/**
 * Smoothly scroll an element without letting a horizontal cell-focus update
 * cancel an in-flight vertical row jump (or vice versa). Repeated calls only
 * replace the requested axis, so rapid search and hunk navigation remains
 * responsive instead of queueing animations.
 */
export function scrollElementForNavigation(
  element: HTMLElement,
  options: NavigationScrollOptions,
): void {
  const requestedAxes = SCROLL_AXES.filter((axis) => options[axis] != null);
  if (requestedAxes.length === 0) return;

  const behavior = options.behavior ?? 'smart';
  const linkedElements = [...new Set(options.linkedElements ?? [])];
  const shouldAnimate = behavior !== 'auto'
    && !prefersReducedMotion()
    && typeof requestAnimationFrame === 'function';
  const animation = getOrCreateAnimation(element);

  if (!shouldAnimate) {
    requestedAxes.forEach((axis) => {
      animation[axis] = null;
      setAxisPosition(
        element,
        axis,
        getAxisTarget(element, axis, options[axis]!),
        linkedElements,
      );
    });
    clearAnimationIfIdle(element, animation);
    if (animation.top || animation.left) ensureInterruptListeners(element, animation);
    return;
  }

  const startedAt = getNow();
  requestedAxes.forEach((axis) => {
    const from = getAxisPosition(element, axis);
    const to = getAxisTarget(element, axis, options[axis]!);
    if (Math.abs(to - from) < 0.5) {
      animation[axis] = null;
      setAxisPosition(element, axis, to, linkedElements);
      return;
    }

    const currentAxisAnimation = animation[axis];
    if (currentAxisAnimation && Math.abs(currentAxisAnimation.to - to) < 0.5) {
      currentAxisAnimation.linkedElements = linkedElements;
      return;
    }
    animation[axis] = {
      from,
      to,
      startedAt,
      linkedElements,
      duration: behavior === 'smart'
        ? getResponsiveFocusScrollDuration(
          Math.abs(to - from),
          getAxisViewportSize(element, axis),
        )
        : getNavigationScrollDuration(
          Math.abs(to - from),
          getAxisViewportSize(element, axis),
        ),
      easing: behavior === 'smart'
        ? easeResponsiveFocusScroll
        : easeNavigationScroll,
      behavior: behavior === 'smart' ? 'smart' : 'smooth',
    };
  });

  const topAnimation = animation.top;
  const leftAnimation = animation.left;
  if (
    topAnimation?.behavior === 'smart'
    && leftAnimation?.behavior === 'smart'
    && Math.abs(topAnimation.startedAt - leftAnimation.startedAt) <= 8
  ) {
    const synchronizedStart = Math.max(topAnimation.startedAt, leftAnimation.startedAt);
    const synchronizedDuration = Math.max(topAnimation.duration, leftAnimation.duration);
    topAnimation.startedAt = synchronizedStart;
    leftAnimation.startedAt = synchronizedStart;
    topAnimation.duration = synchronizedDuration;
    leftAnimation.duration = synchronizedDuration;
  }

  if (!animation.top && !animation.left) {
    clearAnimationIfIdle(element, animation);
    return;
  }

  ensureInterruptListeners(element, animation);
  if (!animation.frameId) {
    animation.frameId = requestAnimationFrame((timestamp) => {
      runAnimationFrame(element, animation, timestamp);
    });
  }
}
