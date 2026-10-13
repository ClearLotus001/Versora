import { expect, test, type Page } from '@playwright/test';
import '../../src/utils/app/e2eBridge';
import type { LayoutMode } from '../../src/types';

async function loadBlameDiff(page: Page, layout: LayoutMode) {
  const baseUrl = process.env.VERSORA_E2E_BASE_URL?.trim() || '';
  await page.goto(`${baseUrl}/?__e2e=1`);
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await page.evaluate(async (targetLayout) => {
    await window.__SVN_DIFF_E2E__!.loadTextDiff({
      fileName: 'blame-sample.ts',
      baseName: 'blame-base.ts',
      mineName: 'blame-mine.ts',
      layout: targetLayout,
      collapseCtx: false,
      baseContent: 'const answer = 41;\nconst local = false;',
      mineContent: 'const answer = 42;\nconst local = true;',
      baseBlame: [
        { lineNo: 1, revision: 'a1b2c3d4e5', author: 'alice', date: '2026-08-20 11:04', uncommitted: false },
        { lineNo: 2, revision: 'r11', author: 'bob', date: '2026-08-19 10:00', uncommitted: false },
      ],
      mineBlame: [
        { lineNo: 1, revision: 'r13', author: 'carol', date: '2026-08-20 12:30', uncommitted: false },
        { lineNo: 2, revision: '', author: '', date: '', uncommitted: true },
      ],
    });
  }, layout);
  await page.waitForFunction(() => window.__SVN_DIFF_E2E__?.getSnapshot().hasLoadedDiff === true);
}

for (const layout of ['unified', 'split-h', 'split-v'] as const) {
  test(`${layout} line gutters expose version attribution and hover details`, async ({ page }) => {
    await loadBlameDiff(page, layout);

    const committedLine = page.locator('button[aria-label*="alice"]');
    await expect(committedLine).toHaveCount(1);
    await expect(committedLine.getByText('a1b2c3d', { exact: true })).toBeVisible();

    await committedLine.hover();
    const committedTooltip = page.getByRole('tooltip');
    await expect(committedTooltip).toContainText('a1b2c3d4e5');
    await expect(committedTooltip).toContainText('alice');
    await expect(committedTooltip).toContainText('2026-08-20 11:04');

    const mineLine = page.locator('button[aria-label*="carol"]');
    await expect(mineLine).toHaveCount(1);
    const baseBadge = committedLine.locator('[data-line-blame-badge="true"]');
    const mineBadge = mineLine.locator('[data-line-blame-badge="true"]');
    const [baseBadgeStyle, mineBadgeStyle] = await Promise.all([
      baseBadge.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          shape: [style.height, style.padding, style.borderRadius, style.borderStyle].join('|'),
          color: style.color,
          background: style.backgroundColor,
        };
      }),
      mineBadge.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          shape: [style.height, style.padding, style.borderRadius, style.borderStyle].join('|'),
          color: style.color,
          background: style.backgroundColor,
        };
      }),
    ]);
    expect(mineBadgeStyle.shape).toBe(baseBadgeStyle.shape);
    expect(mineBadgeStyle.color).not.toBe(baseBadgeStyle.color);
    expect(mineBadgeStyle.background).not.toBe(baseBadgeStyle.background);

    const uncommittedLine = page.locator('button').filter({ hasText: 'WC*' });
    await expect(uncommittedLine).toHaveCount(1);
    await uncommittedLine.hover();
    await expect(page.getByRole('tooltip')).toContainText(/Uncommitted|未提交/);
  });

  test(`${layout} prepared text analysis picks up background line attribution`, async ({ page }) => {
    await page.goto('/?__e2e=1');
    await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
    await page.evaluate(async (targetLayout) => {
      const attribution = {
        base: [{ lineNo: 1, revision: 'r41', author: 'background-alice', date: '2026-10-13', uncommitted: false }],
        mine: [{ lineNo: 1, revision: 'r42', author: 'background-bob', date: '2026-10-13', uncommitted: false }],
      };
      let resolveAttribution: ((payload: typeof attribution) => void) | undefined;
      window.versora = {
        loadLineBlame: () => new Promise((resolve) => { resolveAttribution = resolve; }),
      } as NonNullable<typeof window.versora>;
      window.addEventListener('versora-test-deliver-attribution', () => resolveAttribution?.(attribution), { once: true });
      const sharedLines = Array.from({ length: 8100 }, (_, index) => `stable line ${index + 2}`);
      await window.__SVN_DIFF_E2E__!.loadTextDiff({
        fileName: 'large-background-blame.txt',
        layout: targetLayout,
        collapseCtx: true,
        baseContent: ['const answer = 41;', ...sharedLines].join('\n'),
        mineContent: ['const answer = 42;', ...sharedLines].join('\n'),
      });
    }, layout);

    await expect(page.locator('button[aria-label*="background-alice"]')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('versora-test-deliver-attribution')));
    const baseLine = page.locator('button[aria-label*="background-alice"]');
    const mineLine = page.locator('button[aria-label*="background-bob"]');
    await expect(baseLine).toHaveCount(1);
    await expect(mineLine).toHaveCount(1);
    await expect(baseLine.getByText('r41', { exact: true })).toBeVisible();
    await expect(mineLine.getByText('r42', { exact: true })).toBeVisible();
    await baseLine.hover();
    await expect(page.getByRole('tooltip')).toContainText('background-alice');
  });
}
