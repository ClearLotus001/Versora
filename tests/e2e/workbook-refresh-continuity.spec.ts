import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import '../../src/utils/app/e2eBridge';
import '../../src/utils/app/perfBridge';
import { selectDiffTypeFilter } from './helpers/diffTypeFilter';
import { assertWorkbookCompositedPaint, createWorkbookPaintProbe, type WorkbookPaintProbe } from './helpers/workbookPaintProbe';

const CELL_MARKERS = ['ALPHA', 'BRAVO', 'ADDONLY', 'DELONLY', 'STABLE'];

interface CanvasFrame {
  id: number;
  width: number;
  height: number;
  visibleWidth: number;
  visibleHeight: number;
  opacity: number;
  opaquePixels: number;
  inkPixels: number;
  markers: string[];
  animations: string[];
  animationSources: Array<{ element: string; animations: string[] }>;
}

interface RefreshFrame {
  beforeCallbacks?: RefreshFrame;
  at: number;
  wallTime: number;
  layout: string;
  sheet: string | null;
  pending: number;
  rootId: number;
  rootOpacity: number;
  rootAnimations: string[];
  surfaceOpacity: number | null;
  surfaceAnimations: string[];
  loadingVisible: boolean;
  fastScrollLayers: Array<{ id: number; opacity: number }>;
  activeScrollSessions: number;
  scrollers: Array<{ id: number; scrollTop: number; scrollLeft: number; scrollHeight: number; clientHeight: number }>;
  scrollEvents: Array<{ type: 'setter' | 'event'; wallTime: number; id: number; before?: number; scrollTop: number }>;
  canvases: CanvasFrame[];
}

declare global {
  interface Window {
    __workbookRefreshFrames?: {
      start(): void;
      stop(): RefreshFrame[];
      peek(): RefreshFrame;
    };
  }
}

async function installFrameProbe(page: Page) {
  await page.addInitScript(({ markers }) => {
    localStorage.setItem('versora.locale', 'en-US');
    localStorage.setItem('versora.settings', JSON.stringify({
      themeKey: 'light', showOnlyDifferences: false, collapseCtx: false,
      botEnabled: false, settingsSchemaVersion: 4,
    }));
    window.versora = { getLaunchContext: () => new Promise(() => {}) } as NonNullable<typeof window.versora>;

    // Observe the actual canvas drawing API, including bitmap restores, without production hooks.
    const drawnText = new WeakMap<object, string[]>();
    const originalFillText = CanvasRenderingContext2D.prototype.fillText;
    const originalClearRect = CanvasRenderingContext2D.prototype.clearRect;
    const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      const texts = drawnText.get(this.canvas) ?? [];
      texts.push(text);
      drawnText.set(this.canvas, texts);
      Reflect.apply(originalFillText, this, [text, ...args]);
    };
    CanvasRenderingContext2D.prototype.clearRect = function (x, y, width, height) {
      const transform = this.getTransform();
      if (x === 0 && y === 0
        && width * transform.a >= this.canvas.width - 1
        && height * transform.d >= this.canvas.height - 1) drawnText.set(this.canvas, []);
      originalClearRect.call(this, x, y, width, height);
    };
    CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, source, ...args) {
      const texts = drawnText.get(source);
      if (texts) drawnText.set(this.canvas, [...texts]);
      Reflect.apply(originalDrawImage, this, [source, ...args]);
    } as typeof originalDrawImage;
    const originalCreateImageBitmap = window.createImageBitmap;
    window.createImageBitmap = function (...args: unknown[]) {
      const texts = drawnText.get(args[0] as object);
      // createImageBitmap snapshots synchronously; preserve that same generation of text.
      const snapshot = texts ? [...texts] : undefined;
      return (Reflect.apply(originalCreateImageBitmap, window, args) as Promise<ImageBitmap>).then((bitmap) => {
        if (snapshot) drawnText.set(bitmap, snapshot);
        return bitmap;
      });
    } as typeof originalCreateImageBitmap;

    const ids = new WeakMap<object, number>();
    let nextId = 1;
    const objectId = (element: object | null) => {
      if (!element) return 0;
      const previous = ids.get(element);
      if (previous) return previous;
      const id = nextId++;
      ids.set(element, id);
      return id;
    };
    const activeAnimations = (element: Element) => element.getAnimations()
      .filter((animation) => animation.playState === 'running')
      .map((animation) => animation.id || (animation instanceof CSSAnimation ? animation.animationName : 'transition'));
    let scrollEvents: RefreshFrame['scrollEvents'] = [];
    const scrollTopProperty = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
    Object.defineProperty(Element.prototype, 'scrollTop', {
      ...scrollTopProperty,
      set(this: Element, value: number) {
        const before = scrollTopProperty.get!.call(this) as number;
        scrollTopProperty.set!.call(this, value);
        if (this.querySelector('[data-workbook-cell-canvas="true"]')) scrollEvents.push({
          type: 'setter', wallTime: performance.timeOrigin + performance.now(), id: objectId(this),
          before, scrollTop: scrollTopProperty.get!.call(this) as number,
        });
      },
    });
    document.addEventListener('scroll', (event) => {
      const target = event.target;
      if (target instanceof Element && target.querySelector('[data-workbook-cell-canvas="true"]')) scrollEvents.push({
        type: 'event', wallTime: performance.timeOrigin + performance.now(), id: objectId(target), scrollTop: target.scrollTop,
      });
    }, true);
    const sample = (): RefreshFrame => {
      const root = document.querySelector('[data-testid="comparison-content"]');
      const surface = document.querySelector('[data-testid="workbook-table-surface"]');
      const snapshot = window.__SVN_DIFF_PERF__?.getSnapshot();
      const at = performance.now();
      const wallTime = performance.timeOrigin + at;
      const canvases: CanvasFrame[] = [];
      // Header flags describe any header in the run, not a header-only canvas.
      // Semantic markers below require an actual data row even when the run includes a header.
      for (const canvas of document.querySelectorAll<HTMLCanvasElement>('[data-workbook-cell-canvas="true"]')) {
        const rect = canvas.getBoundingClientRect();
        let left = Math.max(0, rect.left);
        let right = Math.min(innerWidth, rect.right);
        let top = Math.max(0, rect.top);
        let bottom = Math.min(innerHeight, rect.bottom);
        let opacity = 1;
        const animations: string[] = [];
        const animationSources: CanvasFrame['animationSources'] = [];
        let visible = true;
        for (let ancestor: Element | null = canvas; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (style.display === 'none' || style.visibility === 'hidden') visible = false;
          opacity *= Number(style.opacity);
          const ancestorAnimations = activeAnimations(ancestor);
          animations.push(...ancestorAnimations);
          if (ancestorAnimations.length) animationSources.push({
            element: ancestor.getAttribute('data-testid') ?? `${ancestor.tagName}.${ancestor.getAttribute('class') ?? ''}`,
            animations: ancestorAnimations,
          });
          const clip = ancestor.getBoundingClientRect();
          if (/(hidden|auto|scroll|clip)/.test(style.overflowX)) {
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
          }
          if (/(hidden|auto|scroll|clip)/.test(style.overflowY)) {
            top = Math.max(top, clip.top);
            bottom = Math.min(bottom, clip.bottom);
          }
        }
        if (!visible || right - left < 4 || bottom - top < 4 || !canvas.width || !canvas.height) continue;
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const sampleLeft = Math.max(0, Math.floor((left - rect.left) * scaleX));
        const sampleTop = Math.max(0, Math.floor((top - rect.top) * scaleY));
        const sampleWidth = Math.max(1, Math.min(canvas.width - sampleLeft, Math.ceil(Math.min(400, right - left) * scaleX)));
        const sampleHeight = Math.max(1, Math.min(canvas.height - sampleTop, Math.ceil(Math.min(120, bottom - top) * scaleY)));
        const pixels = canvas.getContext('2d')!.getImageData(sampleLeft, sampleTop, sampleWidth, sampleHeight).data;
        let opaquePixels = 0;
        let inkPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3]! < 220) continue;
          opaquePixels++;
          // Colored deletion text can have a high red channel while remaining dark ink.
          const luminance = pixels[index]! * 0.2126 + pixels[index + 1]! * 0.7152 + pixels[index + 2]! * 0.0722;
          if (luminance < 180) inkPixels++;
        }
        const text = (drawnText.get(canvas) ?? []).join('');
        canvases.push({
          id: objectId(canvas), width: canvas.width, height: canvas.height,
          visibleWidth: right - left, visibleHeight: bottom - top, opacity,
          opaquePixels, inkPixels, markers: markers.filter((marker) => text.includes(marker)),
          animations: [...new Set(animations)], animationSources,
        });
      }
      return {
        at, wallTime,
        layout: snapshot?.layout ?? '', sheet: snapshot?.activeWorkbookSheetName ?? null,
        pending: snapshot?.workbookArtifact?.cache.pending ?? 0,
        rootId: objectId(root), rootOpacity: root ? Number(getComputedStyle(root).opacity) : 0,
        rootAnimations: root ? activeAnimations(root) : [],
        surfaceOpacity: surface ? Number(getComputedStyle(surface).opacity) : null,
        surfaceAnimations: surface ? activeAnimations(surface) : [],
        loadingVisible: Boolean(document.querySelector('[data-testid="diff-loading-state"], [data-testid="diff-loading-overlay"]')),
        fastScrollLayers: [...document.querySelectorAll('.workbook-fast-scroll-layer')].map((layer) => ({
          id: objectId(layer), opacity: Number(getComputedStyle(layer).opacity),
        })),
        activeScrollSessions: document.querySelectorAll('[data-virtual-fast-scroll-active="true"]').length,
        scrollers: [...new Set([...document.querySelectorAll('[data-workbook-cell-canvas="true"]')]
          .map((canvas) => canvas.closest('.overflow-auto, .overflow-y-auto.overflow-x-auto'))
          .filter((scroller): scroller is HTMLElement => scroller instanceof HTMLElement))]
          .map((scroller) => ({ id: objectId(scroller), scrollTop: scroller.scrollTop, scrollLeft: scroller.scrollLeft,
            scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight })),
        scrollEvents: scrollEvents.slice(-10),
        canvases,
      };
    };
    let running = false;
    let frameId = 0;
    let sampleTimer = 0;
    let frames: RefreshFrame[] = [];
    const tick = () => {
      if (!running) return;
      const beforeCallbacks = sample();
      // Head and timer snapshots diagnose DOM state. The timer is a separate task;
      // actual presentation is asserted against independent compositor screenshots.
      sampleTimer = window.setTimeout(() => {
        if (!running) return;
        frames.push({ ...sample(), beforeCallbacks });
        frameId = requestAnimationFrame(tick);
      }, 0);
    };
    window.__workbookRefreshFrames = {
      start() {
        cancelAnimationFrame(frameId); clearTimeout(sampleTimer);
        scrollEvents = []; frames = [sample()]; running = true; frameId = requestAnimationFrame(tick);
      },
      stop() { running = false; cancelAnimationFrame(frameId); clearTimeout(sampleTimer); return frames; },
      peek: sample,
    };
  }, { markers: CELL_MARKERS });
}

async function framesAfterPaint(page: Page, count = 12) {
  await page.evaluate((requestedFrames) => new Promise<void>((resolve) => {
    let frames = 0;
    const tick = () => ++frames >= requestedFrames ? resolve() : requestAnimationFrame(tick);
    requestAnimationFrame(tick);
  }), count);
}

async function loadContinuityWorkbook(page: Page, installProbe = true, layout: 'unified' | 'split-v' | 'split-h' = 'split-h') {
  await page.setViewportSize({ width: 1800, height: 1000 });
  if (installProbe) await installFrameProbe(page);
  await page.goto('/?__e2e=1&__perf=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await page.evaluate(async (initialLayout) => {
    const sheet = (name: string, marker: string, changed: boolean) => [
      `@@sheet\t${name}`, '@@row\t1\tID\tValue',
      ...Array.from({ length: 220 }, (_, index) => {
        const row = index + 2;
        return `@@row\t${row}\t${marker}_${row}\t${marker}_${row}_${changed && row % 3 === 0 ? 'new' : 'old'}`;
      }),
    ].join('\n');
    await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
      fileName: 'refresh-continuity.xlsx', layout: initialLayout, collapseCtx: false, showOnlyDifferences: false,
      baseContent: [sheet('Alpha', 'ALPHA', false), sheet('Bravo', 'BRAVO', false),
        sheet('Deleted', 'DELONLY', false), sheet('Stable', 'STABLE', false)].join('\n'),
      mineContent: [sheet('Alpha', 'ALPHA', true), sheet('Bravo', 'BRAVO', true),
        sheet('Added', 'ADDONLY', false), sheet('Stable', 'STABLE', false)].join('\n'),
    });
  }, layout);
  await page.waitForFunction(() => {
    const snapshot = window.__SVN_DIFF_PERF__?.getSnapshot();
    return snapshot?.loadPhase === 'ready' && snapshot.viewReadyToken > 0
      && (snapshot.workbookArtifact?.cache.windows ?? 0) > 0 && snapshot.workbookArtifact?.cache.pending === 0;
  });
  await page.waitForFunction(() => window.__workbookRefreshFrames!.peek().canvases.some((canvas) => canvas.markers.includes('ALPHA')));
  // Let the comparison's first entry finish; the trace below measures refreshes only.
  await page.waitForFunction(() => document.querySelector('[data-testid="comparison-content"]')!.getAnimations()
    .every((animation) => animation.playState !== 'running'));
}

async function recordRefresh(
  page: Page, testInfo: TestInfo, paintProbe: WorkbookPaintProbe,
  label: string, marker: string, reducedMotion: boolean, action: () => Promise<unknown>,
) {
  const surface = (await page.getByTestId('workbook-table-surface').boundingBox())!;
  // Establish a clock-correlated state before Chromium can send its first frame.
  await page.evaluate(() => window.__workbookRefreshFrames!.start());
  await paintProbe.start();
  let frames: RefreshFrame[] = [];
  try {
    await action();
    await page.waitForFunction((expected) => {
      const sample = window.__workbookRefreshFrames!.peek();
      return sample.pending === 0 && sample.canvases.some((canvas) => canvas.markers.includes(expected));
    }, marker, { timeout: 5_000 });
    await framesAfterPaint(page);
    await page.waitForFunction(() => {
      const sample = window.__workbookRefreshFrames!.peek();
      return sample.fastScrollLayers.length === 0 && sample.activeScrollSessions === 0;
    }, undefined, { timeout: 1_000 });
    await framesAfterPaint(page, 2);
  } finally {
    frames = await page.evaluate(() => window.__workbookRefreshFrames!.stop());
    const paintFrames = await paintProbe.stop();
    const tracePath = testInfo.outputPath(`${label}-frames.json`);
    await writeFile(tracePath, JSON.stringify(frames, null, 2));
    await testInfo.attach(`${label}-frames`, { path: tracePath, contentType: 'application/json' });
    await assertWorkbookCompositedPaint(page, testInfo, label, paintFrames,
      frames.flatMap((frame) => frame.beforeCallbacks ? [frame.beforeCallbacks, frame] : [frame]), surface);
  }
  const outerFadeFrames = frames.filter((frame) => frame.rootOpacity < 0.99 || frame.rootAnimations.length > 0);
  expect.soft(outerFadeFrames, `${label}: refresh animates the entire comparison shell`).toEqual([]);
  if (reducedMotion) {
    expect.soft(frames.flatMap((frame) => frame.canvases.flatMap((canvas) => canvas.animations)), `${label}: reduced motion`).toEqual([]);
    expect.soft(frames.flatMap((frame) => frame.surfaceAnimations), `${label}: reduced table motion`).toEqual([]);
  } else if (!label.startsWith('deep-scroll-')) {
    expect.soft(frames.some((frame) => frame.surfaceAnimations.includes('workbook-view-transition')), `${label}: table transition is local`).toBe(true);
    expect.soft(frames.filter((frame) => frame.surfaceOpacity !== null && frame.surfaceOpacity < 0.959), `${label}: table remains visible`).toEqual([]);
  }
  const finalFrame = frames.at(-1)!;
  expect.soft([...new Set(finalFrame.canvases.flatMap((canvas) => canvas.markers))], `${label}: stale worksheet content`).toEqual([marker]);
  expect.soft(finalFrame.fastScrollLayers, `${label}: fast scroll overlay survives its session`).toEqual([]);
  expect.soft(finalFrame.activeScrollSessions, `${label}: scroll session has not ended`).toBe(0);
}

async function interruptDeepScroll(page: Page, testInfo: TestInfo, label: string, target: 'filter' | 'sheet') {
  const evidence = await page.evaluate(async (action) => {
    const scrollers = new Set([...document.querySelectorAll('[data-workbook-cell-canvas="true"]')]
      .map((canvas) => canvas.closest('.overflow-auto, .overflow-y-auto.overflow-x-auto'))
      .filter((scroller): scroller is HTMLElement => scroller instanceof HTMLElement));
    const before = [...scrollers].map((scroller) => ({
      scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
    }));
    const startedAt = performance.now();
    return new Promise<{
      before: typeof before;
      after: typeof before;
      activeSessions: Array<{ owner: string | null; scrollTop: number }>;
      elapsedMs: number;
    }>((resolve, reject) => {
      let requested = false;
      const removeListeners = () => {
        for (const scroller of scrollers) scroller.removeEventListener('versora:virtual-fast-scroll-start', onStart);
      };
      const timeout = window.setTimeout(() => {
        removeListeners(); reject(new Error('The actual scroll did not start an implicit fast scroll session'));
      }, 1_000);
      const onStart = () => {
        if (requested) return;
        requested = true;
        queueMicrotask(() => {
          window.clearTimeout(timeout); removeListeners();
          const activeSessions = [...document.querySelectorAll('[data-virtual-fast-scroll-active="true"]')]
            .map((scroller) => ({ owner: scroller.getAttribute('data-virtual-fast-scroll-owner'), scrollTop: scroller.scrollTop }));
          const after = [...scrollers].map((scroller) => ({
            scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
          }));
          const elapsedMs = performance.now() - startedAt;
          if (action === 'filter') document.querySelector<HTMLButtonElement>('[data-testid="toolbar-diff-only"]')!.click();
          else [...document.querySelectorAll<HTMLButtonElement>('[data-testid="workbook-sheet-tab"]')]
            .find((button) => button.textContent?.includes('Bravo'))!.click();
          resolve({ before, after, activeSessions, elapsedMs });
        });
      };
      for (const scroller of scrollers) {
        scroller.addEventListener('versora:virtual-fast-scroll-start', onStart);
        const bottom = scroller.scrollHeight - scroller.clientHeight;
        scroller.scrollTop = scroller.scrollTop > bottom / 2 ? 0 : bottom;
      }
    });
  }, target);
  const path = testInfo.outputPath(`${label}-interruption.json`);
  await writeFile(path, JSON.stringify(evidence, null, 2));
  await testInfo.attach(`${label}-interruption`, { path, contentType: 'application/json' });
  expect(evidence.activeSessions.some((session) => session.owner === 'implicit')).toBe(true);
}

async function selectSheet(page: Page, sheetName: string) {
  await page.getByTestId('workbook-sheet-tab').filter({ hasText: sheetName }).click();
}

async function prepareDeepScroll(page: Page, layout: 'unified' | 'split-v' | 'split-h') {
  // Reload the fixture without adding another probe. A restored window can already cover
  // both ends of a large group, so each interruption needs its own initial scroll range.
  await loadContinuityWorkbook(page, false, layout);
  await framesAfterPaint(page);
}

for (const reducedMotion of [false, true]) {
  test(`workbook refresh retains painted cells across layouts and filters (${reducedMotion ? 'reduced' : 'normal'} motion)`, async ({ page }, testInfo) => {
    // Decoding every captured PNG adds probe work on CI; the individual action,
    // animation, cache and scroll-settling deadlines remain unchanged.
    test.setTimeout(75_000);
    await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
    await loadContinuityWorkbook(page);
    const paintProbe = await createWorkbookPaintProbe(page);
    try {
      const refresh = (label: string, marker: string, action: () => Promise<unknown>) => recordRefresh(page, testInfo, paintProbe, label, marker, reducedMotion, action);
      for (const layout of ['unified', 'split-v', 'split-h'] as const) {
        await refresh(`layout-${layout}`, 'ALPHA', () => page.getByTestId(`toolbar-layout-${layout}`).click());
        await refresh(`deep-scroll-${layout}`, 'ALPHA', () => page.evaluate(() => {
          for (const canvas of document.querySelectorAll('[data-workbook-cell-canvas="true"]')) {
            const scroller = canvas.closest('.overflow-auto, .overflow-y-auto.overflow-x-auto');
            if (scroller) scroller.scrollTop = 1800;
          }
        }));
        await refresh(`differences-only-${layout}`, 'ALPHA', () => page.getByTestId('toolbar-diff-only').click());
        await refresh(`all-rows-${layout}`, 'ALPHA', () => page.getByTestId('toolbar-diff-only').click());
      }
      await refresh('sheet-bravo', 'BRAVO', () => selectSheet(page, 'Bravo'));
      await refresh('sheet-alpha', 'ALPHA', () => selectSheet(page, 'Alpha'));
      await refresh('type-modified', 'ALPHA', () => selectDiffTypeFilter(page, 'modify'));
      await refresh('type-added', 'ADDONLY', () => selectDiffTypeFilter(page, 'add'));
      await refresh('type-deleted', 'DELONLY', () => selectDiffTypeFilter(page, 'delete'));
      await refresh('type-all', 'ALPHA', () => selectDiffTypeFilter(page, 'all'));
      for (const layout of ['unified', 'split-v', 'split-h'] as const) {
        await prepareDeepScroll(page, layout);
        const filterLabel = `active-scroll-filter-${layout}`;
        await refresh(filterLabel, 'ALPHA', () => interruptDeepScroll(page, testInfo, filterLabel, 'filter'));
        await prepareDeepScroll(page, layout);
        const sheetLabel = `active-scroll-sheet-${layout}`;
        await refresh(sheetLabel, 'BRAVO', () => interruptDeepScroll(page, testInfo, sheetLabel, 'sheet'));
      }
      await refresh('rapid-sheet-layout-filter', 'BRAVO', () => page.evaluate(async () => {
        // Successive real DOM clicks leave no artificial settling delay between requests.
        const click = (testId: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click();
        const sheet = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="workbook-sheet-tab"]')]
          .find((button) => button.textContent?.includes(name))!.click();
        const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const filter = async (value: string) => {
          if (!document.querySelector(`[data-testid="diff-filter-${value}"]`)) {
            click('diff-type-filter-trigger');
            await nextFrame();
          }
          click(`diff-filter-${value}`);
        };
        click('toolbar-layout-unified');
        await nextFrame();
        sheet('Bravo');
        await filter('modify');
        click('toolbar-layout-split-v');
        await nextFrame();
        sheet('Alpha');
        await filter('all');
        click('toolbar-layout-split-h');
        await nextFrame();
        sheet('Bravo');
      }));
      await page.screenshot({ path: testInfo.outputPath(`refresh-${reducedMotion ? 'reduced' : 'normal'}-ready.png`), animations: 'disabled' });
    } finally { await paintProbe.dispose(); }
  });
}
