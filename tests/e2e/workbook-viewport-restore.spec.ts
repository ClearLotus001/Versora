import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import '../../src/utils/app/e2eBridge';
import '../../src/utils/app/perfBridge';

type Layout = 'unified' | 'split-v' | 'split-h';
const layouts: Layout[] = ['unified', 'split-v', 'split-h'];
type DiagnosticWindow = Window & {
  __viewportRestoreDiagnostic?: { stage: string; events: unknown[] };
  __SVN_DIFF_WORKBOOK_DEBUG_LOGS__?: unknown[];
};

async function settleViewport(page: Page) {
  await page.waitForFunction(() => window.__SVN_DIFF_PERF__?.getSnapshot().workbookArtifact?.cache.pending === 0
    && !document.querySelector('[data-virtual-fast-scroll-active="true"], .workbook-fast-scroll-layer'));
  // Native snapshots settle after 120 ms and the Canvas diff outline pulses
  // for 560 ms. Let both finish before comparing stable body pixels.
  await page.evaluate(() => new Promise<void>((resolve) => {
    const start = performance.now();
    const tick = () => performance.now() - start >= 620 ? resolve() : requestAnimationFrame(tick);
    requestAnimationFrame(tick);
  }));
}

async function viewportOffsets(page: Page) {
  return page.evaluate(() => [...new Set([...document.querySelectorAll('[data-workbook-cell-canvas="true"]')]
    .map((canvas) => canvas.closest('.overflow-auto, .overflow-y-auto.overflow-x-auto'))
    .filter((scroller): scroller is HTMLElement => scroller instanceof HTMLElement
      && scroller.scrollHeight > scroller.clientHeight && scroller.scrollWidth > scroller.clientWidth))]
    .map((scroller) => [scroller.scrollTop, scroller.scrollLeft]));
}

async function bodyScreenshot(page: Page) {
  const surface = (await page.getByTestId('workbook-table-surface').boundingBox())!;
  return page.screenshot({
    clip: { x: surface.x + 60, y: surface.y + 90, width: surface.width - 80, height: 300 },
    animations: 'disabled', caret: 'hide',
  });
}

async function compareBodyPixels(page: Page, baseline: Buffer, restored: Buffer) {
  return page.evaluate(async (images) => {
    const pixels = await Promise.all(images.map(async (data) => {
      const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0); bitmap.close();
      return { width: canvas.width, height: canvas.height,
        data: context.getImageData(0, 0, canvas.width, canvas.height).data };
    }));
    const [before, after] = pixels;
    let changedPixels = 0;
    let inkPixels = 0;
    for (let index = 0; index < before!.data.length; index += 4) {
      if ([0, 1, 2, 3].some((channel) => before!.data[index + channel] !== after!.data[index + channel])) changedPixels++;
      const luminance = after!.data[index]! * 0.2126 + after!.data[index + 1]! * 0.7152 + after!.data[index + 2]! * 0.0722;
      if (after!.data[index + 3]! > 220 && luminance < 180) inkPixels++;
    }
    return { before: [before!.width, before!.height], after: [after!.width, after!.height], changedPixels, inkPixels };
  }, [baseline.toString('base64'), restored.toString('base64')]);
}

const fixture = { name: 'small offsets', columns: 32, offsets: [[10, 50], [20, 100], [30, 150]] };
test(`workbook layouts restore both viewport axes and painted cells (${fixture.name})`, async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('versora.locale', 'en-US');
    localStorage.setItem('svndiff:workbook-debug', '1');
    localStorage.setItem('versora.settings', JSON.stringify({
      themeKey: 'light', showOnlyDifferences: false, collapseCtx: false,
      botEnabled: false, settingsSchemaVersion: 4,
    }));
    window.versora = { getLaunchContext: () => new Promise(() => {}) } as NonNullable<typeof window.versora>;
    const diagnostic = { stage: 'load', events: [] as unknown[] };
    (window as DiagnosticWindow).__viewportRestoreDiagnostic = diagnostic;
    for (const property of ['scrollTop', 'scrollLeft'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, property)!;
      Object.defineProperty(Element.prototype, property, {
        ...descriptor,
        set(this: Element, value: number) {
          const before = descriptor.get!.call(this) as number;
          descriptor.set!.call(this, value);
          if (this.querySelector('[data-workbook-cell-canvas="true"]')) diagnostic.events.push({
            stage: diagnostic.stage, property, before, after: descriptor.get!.call(this),
            wallTime: performance.timeOrigin + performance.now(),
            snapshot: window.__SVN_DIFF_PERF__?.getSnapshot(),
          });
        },
      });
    }
  });
  try {
    await page.goto('/?__e2e=1&__perf=1');
    await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
    await page.evaluate(async (columns) => {
      const content = (changed: boolean) => ['@@sheet\tViewport',
        ...Array.from({ length: 220 }, (_, row) => `@@row\t${row + 1}\t${Array.from({ length: columns }, (_, column) =>
          row === 0 ? `Column ${column + 1}` : `R${row + 1}C${column + 1}_${changed && row % 3 === 0 ? 'new' : 'old'}`).join('\t')}`),
      ].join('\n');
      await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
        fileName: `viewport-${columns}.xlsx`, layout: 'unified', collapseCtx: false, showOnlyDifferences: false,
        baseContent: content(false), mineContent: content(true),
      });
    }, fixture.columns);
    await page.waitForFunction(() => {
      const snapshot = window.__SVN_DIFF_PERF__?.getSnapshot();
      return snapshot?.loadPhase === 'ready' && snapshot.viewReadyToken > 0
        && (snapshot.workbookArtifact?.cache.windows ?? 0) > 0 && snapshot.workbookArtifact?.cache.pending === 0;
    });
    const baseline = new Map<Layout, Buffer>();
    for (const [index, layout] of layouts.entries()) {
      await page.evaluate((stage) => { (window as DiagnosticWindow).__viewportRestoreDiagnostic!.stage = stage; }, `save-${layout}`);
      await page.getByTestId(`toolbar-layout-${layout}`).click();
      await settleViewport(page);
      const offset = fixture.offsets[index]!;
      await page.evaluate(([top, left]) => {
        const scrollers = new Set([...document.querySelectorAll('[data-workbook-cell-canvas="true"]')]
          .map((canvas) => canvas.closest('.overflow-auto, .overflow-y-auto.overflow-x-auto'))
          .filter((scroller): scroller is HTMLElement => scroller instanceof HTMLElement
            && scroller.scrollHeight > scroller.clientHeight && scroller.scrollWidth > scroller.clientWidth));
        for (const scroller of scrollers) { scroller.scrollTop = top!; scroller.scrollLeft = left!; }
      }, offset);
      const expected = Array.from({ length: layout === 'split-h' ? 2 : 1 }, () => offset);
      await expect.poll(() => viewportOffsets(page), `${layout}: fixture can scroll on both axes`).toEqual(expected);
      await settleViewport(page);
      const offsetsBeforeCapture = await viewportOffsets(page);
      expect(offsetsBeforeCapture, `${layout}: saved coordinates remain stable before baseline capture`).toEqual(expected);
      const image = await bodyScreenshot(page);
      const offsetsAfterCapture = await viewportOffsets(page);
      expect(offsetsAfterCapture, `${layout}: saved coordinates remain stable after baseline capture`).toEqual(expected);
      await page.evaluate((offsets) => (window as DiagnosticWindow).__viewportRestoreDiagnostic!.events.push({
        stage: (window as DiagnosticWindow).__viewportRestoreDiagnostic!.stage,
        capture: 'baseline', wallTime: performance.timeOrigin + performance.now(), ...offsets,
      }), { offsetsBeforeCapture, offsetsAfterCapture });
      baseline.set(layout, image);
      const path = testInfo.outputPath(`${layout}-body-before.png`);
      await writeFile(path, image);
      await testInfo.attach(`${layout}-body-before`, { path, contentType: 'image/png' });
    }
    for (const [index, layout] of layouts.entries()) {
      await page.evaluate((stage) => { (window as DiagnosticWindow).__viewportRestoreDiagnostic!.stage = stage; }, `restore-${layout}`);
      await page.getByTestId(`toolbar-layout-${layout}`).click();
      const expected = Array.from({ length: layout === 'split-h' ? 2 : 1 }, () => fixture.offsets[index]!);
      await expect.poll(() => viewportOffsets(page), `${layout}: saved coordinates restore`).toEqual(expected);
      await settleViewport(page);
      const restored = await bodyScreenshot(page);
      const path = testInfo.outputPath(`${layout}-body-restored.png`);
      await writeFile(path, restored);
      await testInfo.attach(`${layout}-body-restored`, { path, contentType: 'image/png' });
      const pixels = await compareBodyPixels(page, baseline.get(layout)!, restored);
      const reportPath = testInfo.outputPath(`${layout}-restore.json`);
      await writeFile(reportPath, JSON.stringify({ offsets: await viewportOffsets(page), ...pixels }, null, 2));
      await testInfo.attach(`${layout}-restore`, { path: reportPath, contentType: 'application/json' });
      expect.soft(pixels.after, `${layout}: body crop dimensions restore`).toEqual(pixels.before);
      expect.soft(pixels.inkPixels, `${layout}: restored body contains text`).toBeGreaterThan(100);
      expect.soft(pixels.changedPixels, `${layout}: saved body pixels restore`).toBe(0);
    }
  } finally {
    const currentBodyPath = testInfo.outputPath('body-at-test-end.png');
    await writeFile(currentBodyPath, await bodyScreenshot(page));
    await testInfo.attach('body-at-test-end', { path: currentBodyPath, contentType: 'image/png' });
    const diagnostic = await page.evaluate(() => ({
      ...((window as DiagnosticWindow).__viewportRestoreDiagnostic),
      workbookLogs: (window as DiagnosticWindow).__SVN_DIFF_WORKBOOK_DEBUG_LOGS__,
      snapshot: window.__SVN_DIFF_PERF__?.getSnapshot(), settings: localStorage.getItem('versora.settings'),
    }));
    const path = testInfo.outputPath('viewport-restore-diagnostic.json');
    await writeFile(path, JSON.stringify(diagnostic, null, 2));
    await testInfo.attach('viewport-restore-diagnostic', { path, contentType: 'application/json' });
  }
});
