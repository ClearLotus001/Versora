import { flushSync } from 'react-dom';

type ScrollSyncPhase = 'range' | 'paint';
type ScrollSyncSubscriber = () => void;
interface ScrollSyncState {
  range: Set<ScrollSyncSubscriber>;
  paint: Set<ScrollSyncSubscriber>;
}

const subscribersByScroller = new WeakMap<HTMLElement, ScrollSyncState>();
const pendingScrollers = new WeakSet<HTMLElement>();

export function subscribeProgrammaticScrollSync(
  scroller: HTMLElement,
  phase: ScrollSyncPhase,
  subscriber: ScrollSyncSubscriber,
): () => void {
  let state = subscribersByScroller.get(scroller);
  if (!state) {
    state = { range: new Set(), paint: new Set() };
    subscribersByScroller.set(scroller, state);
  }
  state[phase].add(subscriber);
  return () => {
    const current = subscribersByScroller.get(scroller);
    if (!current) return;
    current[phase].delete(subscriber);
    if (current.range.size === 0 && current.paint.size === 0) subscribersByScroller.delete(scroller);
  };
}

export function synchronizeProgrammaticScroll(scroller: HTMLElement): void {
  if (pendingScrollers.has(scroller)) return;
  pendingScrollers.add(scroller);
  // Run outside React's commit, but before the browser can paint the new offsets.
  // Native scroll events arrive later, including after an animation's rAF write.
  queueMicrotask(() => {
    pendingScrollers.delete(scroller);
    const state = subscribersByScroller.get(scroller);
    if (!state) return;
    if (state.range.size > 0) {
      flushSync(() => [...state.range].forEach(subscriber => subscriber()));
    }
    // Range commits can replace canvas subscriptions. Paint the current set.
    const current = subscribersByScroller.get(scroller);
    if (current) [...current.paint].forEach(subscriber => subscriber());
  });
}
