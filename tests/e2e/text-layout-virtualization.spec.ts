import { expect, test, type Locator } from '@playwright/test';
import '../../src/utils/app/e2eBridge';

async function scrollToBottom(scroller: Locator) {
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(scroller.locator('[data-line-idx]').last()).toContainText('stable line 1200');
}

test('text virtualization tracks large scrolls after switching between split layouts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?__e2e=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await page.evaluate(async () => {
    const baseLines = Array.from({ length: 1200 }, (_, index) => `stable line ${index + 1}`);
    const mineLines = [...baseLines];
    mineLines[600] = 'stable line 601 changed';
    await window.__SVN_DIFF_E2E__!.loadTextDiff({
      fileName: 'layout-virtualization.txt',
      baseContent: baseLines.join('\n'),
      mineContent: mineLines.join('\n'),
      layout: 'split-h',
      collapseCtx: false,
    });
  });

  const horizontalPanes = page.locator('.overflow-auto').filter({ has: page.locator('[data-line-idx]') });
  await expect(horizontalPanes).toHaveCount(2);
  await scrollToBottom(horizontalPanes.first());
  await expect(horizontalPanes.last().locator('[data-line-idx]').last()).toContainText('stable line 1200');

  await page.getByTestId('toolbar-layout-split-v').click();
  const verticalScroller = page.locator('.overflow-y-auto.overflow-x-auto').filter({ has: page.locator('[data-line-idx]') });
  await expect(verticalScroller).toHaveCount(1);
  await scrollToBottom(verticalScroller);
  await verticalScroller.evaluate((element) => { element.scrollTop = 0; });
  await expect(verticalScroller.locator('[data-line-idx]').first()).toContainText('stable line 1');

  await page.getByTestId('toolbar-layout-split-h').click();
  await expect(horizontalPanes).toHaveCount(2);
  await scrollToBottom(horizontalPanes.first());

  await page.getByTestId('toolbar-layout-split-v').click();
  await expect(verticalScroller).toHaveCount(1);
  await scrollToBottom(verticalScroller);
});
