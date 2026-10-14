import test from 'node:test';
import assert from 'node:assert/strict';

import { subscribeWorkbookCanvasScrollFrame, subscribeWorkbookCanvasScrollRefFrame } from '../src/utils/workbook/workbookCanvasFrameScheduler';

test('workbook canvas subscribers share one scroll listener and one animation frame', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };

  const listeners = new Set<EventListener>();
  let addCount = 0;
  let removeCount = 0;
  const scroller = {
    scrollTop: 0,
    scrollLeft: 0,
    addEventListener: (_type: string, listener: EventListener) => {
      addCount += 1;
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: EventListener) => {
      removeCount += 1;
      listeners.delete(listener);
    },
  } as unknown as HTMLElement;
  const received: string[] = [];

  try {
    const unsubscribeFirst = subscribeWorkbookCanvasScrollFrame(
      scroller,
      frame => received.push(`first:${frame.scrollTop}:${frame.scrollLeft}`),
    );
    const unsubscribeSecond = subscribeWorkbookCanvasScrollFrame(
      scroller,
      frame => received.push(`second:${frame.scrollTop}:${frame.scrollLeft}`),
    );
    assert.equal(addCount, 1);

    scroller.scrollTop = 120;
    scroller.scrollLeft = 48;
    listeners.forEach(listener => listener(new Event('scroll')));
    scroller.scrollTop = 240;
    listeners.forEach(listener => listener(new Event('scroll')));
    assert.equal(frames.size, 1);
    const scheduledFrame = [...frames][0];
    assert.ok(scheduledFrame);
    const [frameId, callback] = scheduledFrame;
    frames.delete(frameId);
    callback(16);
    assert.deepEqual(received, ['first:240:48', 'second:240:48']);

    unsubscribeFirst();
    assert.equal(removeCount, 0);
    unsubscribeSecond();
    assert.equal(removeCount, 1);
  } finally {
    if (originalRequestAnimationFrame) globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    if (originalCancelAnimationFrame) globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  }
});

test('canvas subscriptions wait for ancestor refs and synchronize their initial offsets', async () => {
  const received: number[] = [];
  let addCount = 0;
  let removeCount = 0;
  const scroller = { scrollTop: 10, scrollLeft: 50,
    addEventListener: () => { addCount++; },
    removeEventListener: () => { removeCount++; },
  } as unknown as HTMLElement;
  const scrollRef: { current: HTMLElement | null } = { current: null };
  const unsubscribe = subscribeWorkbookCanvasScrollRefFrame(scrollRef, frame => received.push(frame.scrollLeft));
  scrollRef.current = scroller;
  try {
    assert.deepEqual([...received], []);
    await Promise.resolve();
    assert.deepEqual([...received], [50]);
    assert.equal(addCount, 1);
  } finally { unsubscribe(); }
  assert.equal(removeCount, 1);

  const cancelBeforeCommit = subscribeWorkbookCanvasScrollRefFrame(scrollRef, frame => received.push(frame.scrollLeft));
  cancelBeforeCommit();
  await Promise.resolve();
  assert.deepEqual([...received], [50]);
  assert.equal(addCount, 1);
});
