import { expect, test } from '@playwright/test';

import {
  createWorkbookRowLine,
  createWorkbookSheetLine,
} from '../../src/utils/workbook/workbookDisplay';

const ROW_COUNT = 64_000;
const CHANGED_ROW = 60_701;

function buildLongWorkbook(changed: boolean): string {
  return [
    createWorkbookSheetLine('LongVisual'),
    createWorkbookRowLine(1, ['ID', 'Value']),
    ...Array.from({ length: ROW_COUNT }, (_, index) => {
      const rowNumber = index + 2;
      return createWorkbookRowLine(rowNumber, [
        String(rowNumber),
        changed && rowNumber === CHANGED_ROW ? 'changed' : 'same',
      ]);
    }),
  ].join('\n');
}

test('ultra-long workbook marker is visually centered without changing scroll behavior', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.setItem('versora.locale', 'en-US');
    window.localStorage.setItem('versora.settings', JSON.stringify({ themeKey: 'light', showOnlyDifferences: false }));
    window.versora = { getLaunchContext: () => new Promise(() => {}) } as NonNullable<typeof window.versora>;
  });
  await page.goto('/?__e2e=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await page.evaluate(async ({ baseContent, mineContent }) => {
    await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
      fileName: 'long-visual.xlsx',
      baseName: 'long-visual-base.xlsx',
      mineName: 'long-visual-mine.xlsx',
      layout: 'split-v',
      collapseCtx: false,
      showOnlyDifferences: false,
      baseContent,
      mineContent,
    });
  }, {
    baseContent: buildLongWorkbook(false),
    mineContent: buildLongWorkbook(true),
  });
  await page.waitForFunction(() => window.__SVN_DIFF_E2E__?.getSnapshot().isWorkbookMode === true);

  const miniMap = page.getByRole('navigation', { name: 'Worksheet diff mini map; use arrow and page keys to scroll' });
  await expect(miniMap).toBeVisible();
  const centerError = await miniMap.evaluate((element, changedRow) => {
    const overlay = element.querySelector('canvas.pointer-events-none');
    const scroller = document.querySelector<HTMLDivElement>(
      '.overflow-y-auto.overflow-x-auto.relative.min-w-0.min-h-0',
    );
    if (!(overlay instanceof HTMLCanvasElement) || !scroller) throw new Error('Mini map surface missing');
    const context = overlay.getContext('2d');
    if (!context) throw new Error('Mini map context missing');
    let alphaMass = 0;
    let alphaMoment = 0;
    for (let y = 0; y < overlay.height; y += 1) {
      const pixels = context.getImageData(0, y, overlay.width, 1).data;
      for (let index = 3; index < pixels.length; index += 4) {
        const alpha = pixels[index] ?? 0;
        alphaMass += alpha;
        alphaMoment += alpha * (y + 0.5);
      }
    }
    if (alphaMass === 0) throw new Error('Mini map diff marker missing');
    // Fractional canvas edges have unequal alpha; their visual center is the coverage centroid.
    const actualCenter = alphaMoment / alphaMass;
    const sourceCenter = 24 + ((changedRow - 2) * 24) + 12;
    const expectedCenter = (sourceCenter / scroller.scrollHeight) * overlay.height;
    return Math.abs(actualCenter - expectedCenter);
  }, CHANGED_ROW);

  expect(centerError).toBeLessThan(0.25);
});
