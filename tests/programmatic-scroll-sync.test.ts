import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribeProgrammaticScrollSync, synchronizeProgrammaticScroll } from '../src/utils/virtualization/programmaticScrollSync';
import { scrollElementForNavigation } from '../src/utils/navigation/animatedScroll';

test('programmatic axis writes commit ranges once before painting their latest offsets', async () => {
  const scroller = { scrollTop: 0, scrollLeft: 0, scrollHeight: 1000, scrollWidth: 1000,
    clientHeight: 100, clientWidth: 100 } as HTMLElement;
  const received: string[] = [];
  // Registration order must not let the canvas draw with an old virtual range.
  const unsubscribePaint = subscribeProgrammaticScrollSync(scroller, 'paint', () => {
    received.push(`paint:${scroller.scrollTop}:${scroller.scrollLeft}`);
  });
  const unsubscribeRange = subscribeProgrammaticScrollSync(scroller, 'range', () => {
    received.push(`range:${scroller.scrollTop}:${scroller.scrollLeft}`);
  });
  try {
    scrollElementForNavigation(scroller, { top: 10, left: 50, behavior: 'auto' });
    scrollElementForNavigation(scroller, { top: 20, behavior: 'auto' });
    assert.deepEqual(received, []);
    await Promise.resolve();
    assert.deepEqual(received, ['range:20:50', 'paint:20:50']);
  } finally {
    unsubscribeRange(); unsubscribePaint();
  }
});

test('a range commit paints replacement canvas subscribers and ignores disposed viewports', async () => {
  const scroller = {} as HTMLElement;
  const received: string[] = [];
  const unsubscribeOldPaint = subscribeProgrammaticScrollSync(scroller, 'paint', () => received.push('old'));
  let unsubscribeNewPaint = () => {};
  const unsubscribeRange = subscribeProgrammaticScrollSync(scroller, 'range', () => {
    unsubscribeOldPaint();
    unsubscribeNewPaint = subscribeProgrammaticScrollSync(scroller, 'paint', () => received.push('current'));
  });
  try {
    synchronizeProgrammaticScroll(scroller);
    await Promise.resolve();
    assert.deepEqual(received, ['current']);
    synchronizeProgrammaticScroll(scroller);
  } finally {
    unsubscribeRange(); unsubscribeOldPaint(); unsubscribeNewPaint();
  }
  await Promise.resolve();
  assert.deepEqual(received, ['current']);
});
