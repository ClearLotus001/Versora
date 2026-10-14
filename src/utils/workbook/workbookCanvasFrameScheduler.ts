import { subscribeProgrammaticScrollSync } from '@/utils/virtualization/programmaticScrollSync';

export interface WorkbookCanvasScrollFrame {
  scrollTop: number;
  scrollLeft: number;
}

type WorkbookCanvasFrameSubscriber = (frame: WorkbookCanvasScrollFrame) => void;

interface WorkbookCanvasFrameState {
  frameId: number;
  subscribers: Set<WorkbookCanvasFrameSubscriber>;
  handleScroll: () => void;
  unsubscribeProgrammaticScroll: () => void;
}

const frameStateByScroller = new WeakMap<HTMLElement, WorkbookCanvasFrameState>();

export function subscribeWorkbookCanvasScrollFrame(
  scroller: HTMLElement,
  subscriber: WorkbookCanvasFrameSubscriber,
): () => void {
  let state = frameStateByScroller.get(scroller);
  if (!state) {
    const subscribers = new Set<WorkbookCanvasFrameSubscriber>();
    state = {
      frameId: 0,
      subscribers,
      unsubscribeProgrammaticScroll: () => {},
      handleScroll: () => {
        const current = frameStateByScroller.get(scroller);
        if (!current || current.frameId) return;
        current.frameId = requestAnimationFrame(() => {
          current.frameId = 0;
          const frame = {
            scrollTop: Math.max(0, scroller.scrollTop),
            scrollLeft: Math.max(0, scroller.scrollLeft),
          };
          [...current.subscribers].forEach(callback => callback(frame));
        });
      },
    };
    frameStateByScroller.set(scroller, state);
    state.unsubscribeProgrammaticScroll = subscribeProgrammaticScrollSync(scroller, 'paint', () => {
      const current = frameStateByScroller.get(scroller);
      if (!current) return;
      if (current.frameId) {
        cancelAnimationFrame(current.frameId);
        current.frameId = 0;
      }
      const frame = {
        scrollTop: Math.max(0, scroller.scrollTop),
        scrollLeft: Math.max(0, scroller.scrollLeft),
      };
      [...current.subscribers].forEach(callback => callback(frame));
    });
    scroller.addEventListener('scroll', state.handleScroll, { passive: true });
  }

  state.subscribers.add(subscriber);
  return () => {
    const current = frameStateByScroller.get(scroller);
    if (!current) return;
    current.subscribers.delete(subscriber);
    if (current.subscribers.size > 0) return;
    scroller.removeEventListener('scroll', current.handleScroll);
    current.unsubscribeProgrammaticScroll();
    if (current.frameId) cancelAnimationFrame(current.frameId);
    frameStateByScroller.delete(scroller);
  };
}

export function subscribeWorkbookCanvasScrollRefFrame(
  scrollRef: { readonly current: HTMLElement | null },
  subscriber: WorkbookCanvasFrameSubscriber,
): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  // Child layout effects run before ancestor DOM refs attach. Register once all
  // refs are available, and draw the actual offset before the first paint.
  queueMicrotask(() => {
    if (disposed || !scrollRef.current) return;
    const scroller = scrollRef.current;
    unsubscribe = subscribeWorkbookCanvasScrollFrame(scroller, subscriber);
    subscriber({ scrollTop: Math.max(0, scroller.scrollTop), scrollLeft: Math.max(0, scroller.scrollLeft) });
  });
  return () => {
    disposed = true;
    unsubscribe?.();
  };
}
