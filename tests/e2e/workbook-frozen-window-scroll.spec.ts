import { expect, test } from '@playwright/test';

import {
  createWorkbookRowLine,
  createWorkbookSheetLine,
} from '../../src/utils/workbook/workbookDisplay';

test('wide frozen-column window scrolls without losing workbook canvas content', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.setItem('versora.locale', 'en-US');
    window.localStorage.setItem('versora.settings', JSON.stringify({ themeKey: 'light' }));
    window.versora = { getLaunchContext: () => new Promise(() => {}) } as NonNullable<typeof window.versora>;
  });
  await page.goto('/?__e2e=1&__perf=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));

  const columns = Array.from({ length: 40 }, (_, index) => `Column ${index + 1}`);
  const baseContent = [
    createWorkbookSheetLine('FrozenWindow'),
    createWorkbookRowLine(1, columns),
    createWorkbookRowLine(2, columns.map((_, index) => `Base ${index + 1}`)),
  ].join('\n');
  const mineContent = [
    createWorkbookSheetLine('FrozenWindow'),
    createWorkbookRowLine(1, columns),
    createWorkbookRowLine(2, columns.map((_, index) => (index === 38 ? 'Changed' : `Base ${index + 1}`))),
  ].join('\n');
  await page.evaluate(async ({ baseContent: base, mineContent: mine }) => {
    await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
      fileName: 'frozen-window.xlsx',
      baseName: 'frozen-window-base.xlsx',
      mineName: 'frozen-window-mine.xlsx',
      layout: 'split-v',
      collapseCtx: false,
      baseContent: base,
      mineContent: mine,
    });
  }, { baseContent, mineContent });
  await page.waitForFunction(() => {
    const snapshot = window.__SVN_DIFF_PERF__?.getSnapshot();
    return snapshot?.isWorkbookMode && snapshot.viewReadyToken > 0;
  });

  const bodyScroller = page.locator('.overflow-y-auto.overflow-x-auto.relative.min-w-0.min-h-0');
  await bodyScroller.evaluate((element) => {
    element.scrollLeft = Math.min(2_400, element.scrollWidth - element.clientWidth);
  });
  await bodyScroller.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const bodyCanvas = page.locator('[data-workbook-cell-canvas="true"]:not([data-workbook-header-row-canvas="true"])');
  await expect(bodyCanvas).toHaveCount(1);
  await bodyCanvas.click({ position: { x: 960, y: 12 } });
  const freezeButton = page.getByRole('button', { name: 'Freeze to column', exact: true });
  await expect(freezeButton).toBeEnabled();
  await freezeButton.click();

  const frozenWindowScroller = page.locator('.overflow-x-auto.overflow-y-hidden.rounded-b-xl');
  await expect(frozenWindowScroller).toHaveCount(1);
  await expect.poll(() => frozenWindowScroller.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(200);
  const maxFrozenScrollLeft = await frozenWindowScroller.evaluate(element => element.scrollWidth - element.clientWidth);
  await frozenWindowScroller.evaluate(async (element) => {
    const maxScrollLeft = element.scrollWidth - element.clientWidth;
    for (let step = 1; step <= 24; step += 1) {
      element.scrollLeft = maxScrollLeft * (step / 24);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  });
  await expect.poll(() => frozenWindowScroller.evaluate(element => Math.round(element.scrollLeft)))
    .toBe(Math.round(maxFrozenScrollLeft));

  const paintStats = await bodyCanvas.evaluate((canvas) => {
    const workbookCanvas = canvas as HTMLCanvasElement;
    const context = workbookCanvas.getContext('2d');
    if (!context) return { opaque: 0, colors: 0 };
    const colors = new Set<string>();
    let opaque = 0;
    for (let xIndex = 1; xIndex <= 12; xIndex += 1) {
      const x = Math.min(workbookCanvas.width - 1, Math.floor((workbookCanvas.width * xIndex) / 13));
      const y = Math.min(workbookCanvas.height - 1, Math.floor(workbookCanvas.height / 2));
      const pixel = context.getImageData(x, y, 1, 1).data;
      if ((pixel[3] ?? 0) > 0) opaque += 1;
      colors.add(`${pixel[0]},${pixel[1]},${pixel[2]},${pixel[3]}`);
    }
    return { opaque, colors: colors.size };
  });
  expect(paintStats.opaque).toBeGreaterThan(0);
  expect(paintStats.colors).toBeGreaterThan(1);
});
