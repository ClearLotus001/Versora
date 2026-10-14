import { expect, test, type Page } from '@playwright/test';
import '../../src/utils/app/e2eBridge';

import {
  createWorkbookRowLine,
  createWorkbookSheetLine,
  WORKBOOK_CELL_WIDTH,
} from '../../src/utils/workbook/workbookDisplay';

type WorkbookLayout = 'unified' | 'split-h' | 'split-v';

function workbookScrollerSelector(layout: WorkbookLayout) {
  return layout === 'split-h'
    ? '.overflow-auto.relative'
    : '.overflow-y-auto.overflow-x-auto.relative.min-w-0.min-h-0';
}

async function waitForInitialHunkFocus(page: Page, layout: WorkbookLayout) {
  const selector = workbookScrollerSelector(layout);
  const paneCount = layout === 'split-h' ? 2 : 1;
  const targetWidth = WORKBOOK_CELL_WIDTH * (layout === 'split-v' ? 2 : 1);
  // Workbook mode and the hunk counter appear before the initial guided focus
  // finishes its three animation-frame callbacks. Observe the actual target.
  await page.waitForFunction(({ scrollerSelector, expectedPanes, width }) => {
    const panes = [...document.querySelectorAll<HTMLElement>(scrollerSelector)];
    return panes.length === expectedPanes && panes.every((pane) => {
      if (pane.scrollLeft <= 0) return false;
      const canvas = pane.querySelector<HTMLCanvasElement>('[data-pulse] canvas');
      if (!canvas?.width || !canvas.height) return false;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return false;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let left = canvas.width;
      let right = -1;
      for (let index = 3; index < pixels.length; index += 4) {
        if (!pixels[index]) continue;
        const x = ((index - 3) / 4) % canvas.width;
        left = Math.min(left, x); right = Math.max(right, x);
      }
      // The one changed cell's complete outline must lie inside the viewport.
      const paintedWidth = (right - left + 1) * rect.width / canvas.width;
      return left > 0 && right < canvas.width - 1 && paintedWidth >= width - 2;
    });
  }, { scrollerSelector: selector, expectedPanes: paneCount, width: targetWidth }, { timeout: 10_000 });
  await page.evaluate(({ scrollerSelector, expectedPanes }) => new Promise<void>((resolve, reject) => {
    let previous: number[] = [];
    let stableFrames = 0;
    let frame = 0;
    const timeout = window.setTimeout(() => {
      cancelAnimationFrame(frame);
      reject(new Error('Initial workbook hunk focus did not settle'));
    }, 10_000);
    const tick = () => {
      const offsets = [...document.querySelectorAll<HTMLElement>(scrollerSelector)].map((pane) => pane.scrollLeft);
      const synchronized = offsets.length === expectedPanes && offsets.every((offset) => offset > 0
        && Math.abs(offset - offsets[0]!) <= 1);
      stableFrames = synchronized && offsets.every((offset, index) => offset === previous[index]) ? stableFrames + 1 : 0;
      previous = offsets;
      if (stableFrames >= 6) { clearTimeout(timeout); resolve(); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }), { scrollerSelector: selector, expectedPanes: paneCount });
}

async function scrollAwayFromHunk(page: Page, layout: WorkbookLayout) {
  const scrollers = page.locator(workbookScrollerSelector(layout));
  // A real wheel gesture performs manual scrolling and interrupts navigation
  // through the same input path as the user, without synthetic scroll events.
  await scrollers.first().hover();
  await page.mouse.wheel(-10_000, 0);
  await expect.poll(() => scrollers.evaluateAll((elements) => elements.map((element) => element.scrollLeft)))
    .toEqual(Array.from({ length: layout === 'split-h' ? 2 : 1 }, () => 0));
}

function buildWorkbook(rows: string[][]) {
  return [
    createWorkbookSheetLine('WideSheet'),
    ...rows.map((cells, index) => createWorkbookRowLine(index + 1, cells)),
  ].join('\n');
}

async function loadWideWorkbookDiff(
  page: Page,
  layout: WorkbookLayout = 'split-h',
) {
  const header = Array.from({ length: 20 }, (_, index) => `Column ${index + 1}`);
  const stable = Array.from({ length: 20 }, (_, index) => `Stable ${index + 1}`);
  const baseTarget = Array.from({ length: 20 }, (_, index) => `Value ${index + 1}`);
  const mineTarget = [...baseTarget];
  mineTarget[18] = 'Changed off-screen value';

  await page.goto('/?__e2e=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await page.evaluate(async ({ baseContent, mineContent, workbookLayout }) => {
    await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
      fileName: 'wide-navigation.xlsx',
      baseName: 'wide-navigation-base.xlsx',
      mineName: 'wide-navigation-mine.xlsx',
      layout: workbookLayout,
      collapseCtx: false,
      baseContent,
      mineContent,
    });
  }, {
    baseContent: buildWorkbook([header, stable, baseTarget]),
    mineContent: buildWorkbook([header, stable, mineTarget]),
    workbookLayout: layout,
  });
  await page.waitForFunction(() => window.__SVN_DIFF_E2E__?.getSnapshot().isWorkbookMode === true);
  await waitForInitialHunkFocus(page, layout);
}

test('clicking a single workbook hunk again scrolls both panes to its off-screen column', async ({ page }) => {
  await loadWideWorkbookDiff(page);

  const paneScrollers = page.locator('.overflow-auto.relative');
  await expect(paneScrollers).toHaveCount(2);
  await expect(page.getByText('1/1', { exact: true })).toBeVisible();

  await scrollAwayFromHunk(page, 'split-h');

  await page.getByRole('button', { name: /^(?:下一个差异块|Next hunk) \(F7\)$/ }).click();

  await expect.poll(() => paneScrollers.first().evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const scrollLefts = await paneScrollers.evaluateAll((elements) => (
    elements.map((element) => element.scrollLeft)
  ));
  expect(Math.abs((scrollLefts[0] ?? 0) - (scrollLefts[1] ?? 0))).toBeLessThanOrEqual(1);
});

test('F7 immediately refocuses an off-screen workbook hunk in both horizontal panes', async ({ page }) => {
  await loadWideWorkbookDiff(page);

  const paneScrollers = page.locator('.overflow-auto.relative');
  await expect(paneScrollers).toHaveCount(2);
  await expect(page.getByText('1/1', { exact: true })).toBeVisible();
  await scrollAwayFromHunk(page, 'split-h');

  await page.keyboard.press('F7');

  await expect.poll(() => paneScrollers.first().evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const scrollLefts = await paneScrollers.evaluateAll((elements) => elements.map((element) => element.scrollLeft));
  expect(Math.abs((scrollLefts[0] ?? 0) - (scrollLefts[1] ?? 0))).toBeLessThanOrEqual(1);
});

for (const layout of ['split-v', 'unified'] as const) {
  test(`F7 refocuses a single off-screen workbook hunk in ${layout}`, async ({ page }) => {
    await loadWideWorkbookDiff(page, layout);

    const scroller = page.locator('.overflow-y-auto.overflow-x-auto.relative.min-w-0.min-h-0');
    await expect(scroller).toHaveCount(1);
    await expect(page.getByText('1/1', { exact: true }).first()).toBeVisible();
    await scrollAwayFromHunk(page, layout);

    await page.keyboard.press('F7');
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  });
}

test('switching distant workbook hunks updates focus, viewport, and active overlay together', async ({ page }) => {
  const baseRows = Array.from({ length: 200 }, (_, index) => [
    `Row ${index + 1}`,
    `Stable ${index + 1}`,
  ]);
  const mineRows = baseRows.map((row) => [...row]);
  mineRows[9]![1] = 'Changed row 10';
  mineRows[179]![1] = 'Changed row 180';

  await page.goto('/?__e2e=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await page.evaluate(async ({ baseContent, mineContent }) => {
    await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
      fileName: 'distant-navigation.xlsx',
      baseName: 'distant-base.xlsx',
      mineName: 'distant-mine.xlsx',
      layout: 'split-h',
      collapseCtx: false,
      baseContent,
      mineContent,
    });
  }, {
    baseContent: buildWorkbook(baseRows),
    mineContent: buildWorkbook(mineRows),
  });
  await page.waitForFunction(() => window.__SVN_DIFF_E2E__?.getSnapshot().isWorkbookMode === true);

  const paneScrollers = page.locator('.overflow-auto.relative');
  await expect(paneScrollers).toHaveCount(2);
  await expect(page.getByText('1/2', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /^(?:涓嬩竴涓樊寮傚潡|Next hunk) \(F7\)$/ }).click();
  await expect(page.getByText('2/2', { exact: true }).first()).toBeVisible();
  await expect.poll(() => paneScrollers.first().evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const overlayCanvases = page.locator('[data-pulse] canvas');
  await expect(overlayCanvases).toHaveCount(2);
  await expect.poll(() => overlayCanvases.first().evaluate((canvas) => {
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const context = canvas.getContext('2d');
    if (!context || canvas.width <= 0 || canvas.height <= 0) return false;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < pixels.length; index += 4) {
      if ((pixels[index] ?? 0) > 0) return true;
    }
    return false;
  })).toBe(true);
});

test('switching hunks after expanding collapsed rows uses the rebuilt virtual layout', async ({ page }) => {
  const baseRows = Array.from({ length: 1_600 }, (_, index) => [
    `Row ${index + 1}`,
    `Stable ${index + 1}`,
  ]);
  const mineRows = baseRows.map((row) => [...row]);
  mineRows[9]![1] = 'Changed row 10';
  mineRows[1_399]![1] = 'Changed row 1400';

  await page.goto('/?__e2e=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await page.evaluate(async ({ baseContent, mineContent }) => {
    await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
      fileName: 'expanded-hunk-navigation.xlsx',
      baseName: 'expanded-hunk-base.xlsx',
      mineName: 'expanded-hunk-mine.xlsx',
      layout: 'split-h',
      collapseCtx: true,
      baseContent,
      mineContent,
    });
  }, {
    baseContent: buildWorkbook(baseRows),
    mineContent: buildWorkbook(mineRows),
  });
  await page.waitForFunction(() => window.__SVN_DIFF_E2E__?.getSnapshot().isWorkbookMode === true);

  const paneScrollers = page.locator('.overflow-auto.relative');
  await expect(paneScrollers).toHaveCount(2);
  await expect(page.getByText('1/2', { exact: true }).first()).toBeVisible();
  const expandButton = page.getByRole('button', {
    name: /(?:expand \d+ lines|展开 \d+ 行)/i,
  }).first();
  await expect(expandButton).toBeVisible();
  await expandButton.click();
  await page.keyboard.press('F7');

  await expect(page.getByText('2/2', { exact: true }).first()).toBeVisible();
  await expect.poll(() => paneScrollers.first().evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => page.locator('[data-workbook-cell-canvas="true"]')
    .evaluateAll((elements) => elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0
        && rect.height > 0
        && rect.bottom > 0
        && rect.top < window.innerHeight;
    }).length)).toBeGreaterThan(0);
});

test('workbook minimap markers stay aligned when the table leaves bottom whitespace', async ({ page }) => {
  await loadWideWorkbookDiff(page);

  const thumb = page.locator('.minimap-viewport-frosted');
  await expect(thumb).toBeVisible();

  const metrics = await thumb.evaluate((element) => {
    const rail = element.parentElement;
    const scroller = document.querySelector('.overflow-auto.relative');
    const content = scroller?.firstElementChild;
    const overlay = rail?.querySelectorAll('canvas')[1];
    if (!(rail instanceof HTMLElement) || !(scroller instanceof HTMLElement) || !(content instanceof HTMLElement) || !(overlay instanceof HTMLCanvasElement)) {
      throw new Error('workbook minimap elements are unavailable');
    }

    const context = overlay.getContext('2d');
    if (!context) throw new Error('workbook minimap overlay context is unavailable');
    const pixels = context.getImageData(0, 0, overlay.width, overlay.height).data;
    let markerTop = -1;
    let markerBottom = -1;
    for (let y = 0; y < overlay.height; y += 1) {
      let hasPaint = false;
      for (let x = 0; x < overlay.width; x += 1) {
        if ((pixels[((y * overlay.width) + x) * 4 + 3] ?? 0) > 0) {
          hasPaint = true;
          break;
        }
      }
      if (!hasPaint) continue;
      if (markerTop < 0) markerTop = y;
      markerBottom = y + 1;
    }

    return {
      contentHeight: content.getBoundingClientRect().height,
      viewportHeight: scroller.clientHeight,
      railHeight: rail.clientHeight,
      markerTop,
      markerBottom,
    };
  });

  expect(metrics.contentHeight).toBeLessThan(metrics.viewportHeight);
  expect(metrics.railHeight).toBeGreaterThan(metrics.contentHeight);
  expect(metrics.markerTop).toBeGreaterThanOrEqual(0);
  expect(metrics.markerBottom).toBeLessThanOrEqual(metrics.contentHeight + 2);
});

test('workbook minimap viewport remains transparent in high contrast mode', async ({ page }) => {
  await loadWideWorkbookDiff(page);

  await page.evaluate(() => {
    document.documentElement.classList.remove('theme-light', 'theme-dark', 'theme-hc');
    document.documentElement.classList.add('theme-hc');
  });

  const thumb = page.locator('.minimap-viewport-frosted');
  await expect(thumb).toBeVisible();

  const alphas = await thumb.evaluate((element) => {
    const readAlpha = () => {
      const backgroundColor = getComputedStyle(element).backgroundColor;
      const colorAlpha = backgroundColor.match(/\/\s*([\d.]+)\s*\)$/)?.[1];
      if (colorAlpha) return Number(colorAlpha);
      const rgbaAlpha = backgroundColor.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/)?.[1];
      if (rgbaAlpha) return Number(rgbaAlpha);
      return backgroundColor === 'transparent' ? 0 : 1;
    };

    const idle = readAlpha();
    element.setAttribute('data-dragging', 'true');
    const dragging = readAlpha();
    element.removeAttribute('data-dragging');
    return {
      idle,
      dragging,
      backdropFilter: getComputedStyle(element).backdropFilter,
    };
  });

  expect(alphas.idle).toBe(0);
  expect(alphas.dragging).toBeGreaterThan(alphas.idle);
  expect(alphas.dragging).toBeLessThanOrEqual(0.1);
  expect(alphas.backdropFilter).toBe('none');
});
