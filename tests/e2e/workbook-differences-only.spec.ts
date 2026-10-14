import { expect, test } from '@playwright/test';

import { LN_W } from '../../src/constants/layout';
import { ROW_H } from '../../src/hooks/virtualization/useVirtual';
import { WORKBOOK_CELL_WIDTH } from '../../src/utils/workbook/workbookDisplay';
import { expectDiffTypeFilter } from './helpers/diffTypeFilter';

test('workbook display menu can persist the differences-only view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.setItem('versora.locale', 'en-US');
    window.localStorage.setItem('versora.settings', JSON.stringify({
      themeKey: 'light',
      showOnlyDifferences: false,
    }));
    window.versora = { getLaunchContext: () => new Promise(() => {}) } as NonNullable<typeof window.versora>;
  });
  await page.goto('/?__e2e=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await page.evaluate(async () => {
    await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
      fileName: 'differences-only.xlsx',
      baseName: 'base-differences.xlsx',
      mineName: 'mine-differences.xlsx',
      layout: 'split-h',
      collapseCtx: false,
      showOnlyDifferences: false,
      baseContent: [
        '@@sheet\tSheet1',
        '@@row\t1\tID\tName\tStatus',
        '@@row\t2\t1\tAlpha\tsame',
        '@@row\t3\t2\tBeta\told',
        '@@row\t4\t3\tGamma\tsame',
      ].join('\n'),
      mineContent: [
        '@@sheet\tSheet1',
        '@@row\t1\tID\tName\tStatus',
        '@@row\t2\t1\tAlpha\tsame',
        '@@row\t3\t2\tBeta\tnew',
        '@@row\t4\t3\tGamma\tsame',
      ].join('\n'),
    });
  });
  await page.waitForFunction(() => window.__SVN_DIFF_E2E__?.getSnapshot().isWorkbookMode === true);

  await page.getByTestId('toolbar-view-menu').click();
  const toggle = page.getByRole('menuitemcheckbox', { name: 'Differences only', exact: true });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => toggle.evaluate((button) => {
    const label = button.querySelector('span');
    if (!label) return false;
    return label.scrollHeight <= label.clientHeight && label.scrollWidth <= label.clientWidth;
  })).toBe(true);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => page.evaluate(() => (
    JSON.parse(window.localStorage.getItem('versora.settings') ?? '{}').showOnlyDifferences
  ))).toBe(true);

  await page.keyboard.press('Escape');
  await expectDiffTypeFilter(page, 'all');
  const quickToggle = page.getByTestId('toolbar-diff-only');
  await expect(quickToggle).toHaveAttribute('aria-pressed', 'true');
  await quickToggle.click();
  await expect(quickToggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => page.evaluate(() => (
    JSON.parse(window.localStorage.getItem('versora.settings') ?? '{}').showOnlyDifferences
  ))).toBe(false);
});

test('differences-only view removes unchanged worksheet tabs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.setItem('versora.locale', 'en-US');
    window.localStorage.setItem('versora.settings', JSON.stringify({
      themeKey: 'light',
      showOnlyDifferences: true,
      settingsSchemaVersion: 2,
    }));
    window.versora = { getLaunchContext: () => new Promise(() => {}) } as NonNullable<typeof window.versora>;
  });
  await page.goto('/?__e2e=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await page.evaluate(async () => {
    await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
      fileName: 'differences-only-sheets.xlsx',
      layout: 'split-h',
      collapseCtx: false,
      showOnlyDifferences: true,
      baseContent: [
        '@@sheet\tStable',
        '@@row\t1\tID\tName',
        '@@row\t2\t1\tSame',
        '@@sheet\tChanged',
        '@@row\t1\tID\tName',
        '@@row\t2\t2\tBefore',
      ].join('\n'),
      mineContent: [
        '@@sheet\tStable',
        '@@row\t1\tID\tName',
        '@@row\t2\t1\tSame',
        '@@sheet\tChanged',
        '@@row\t1\tID\tName',
        '@@row\t2\t2\tAfter',
      ].join('\n'),
    });
  });
  await page.waitForFunction(() => window.__SVN_DIFF_E2E__?.getSnapshot().isWorkbookMode === true);

  const tabs = page.getByTestId('workbook-sheet-tab');
  await expect(tabs).toHaveCount(1);
  await expect(tabs).toContainText('Changed');
  await expect(page.getByTestId('workbook-sheet-menu-trigger')).toHaveAttribute(
    'aria-label',
    'Open worksheet list, 1 worksheets',
  );
});

test('differences-only reveals an entire masked region on pointer entry without a tooltip', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.setItem('versora.locale', 'en-US');
    window.localStorage.setItem('versora.settings', JSON.stringify({
      themeKey: 'light',
      showOnlyDifferences: true,
      settingsSchemaVersion: 2,
    }));
    window.versora = { getLaunchContext: () => new Promise(() => {}) } as NonNullable<typeof window.versora>;
  });
  await page.goto('/?__e2e=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await page.evaluate(async () => {
    await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
      fileName: 'differences-only-mask.xlsx',
      layout: 'split-v',
      collapseCtx: false,
      showOnlyDifferences: true,
      baseContent: [
        '@@sheet\tChanged',
        '@@row\t1\tID\tName\tStatus\tNotes',
        '@@row\t2\t1\tAlpha\tkeep\t',
        '@@row\t3\t2\tBeta\told\tbefore',
      ].join('\n'),
      mineContent: [
        '@@sheet\tChanged',
        '@@row\t1\tID\tName\tStatus\tNotes',
        '@@row\t2\t1\tAlpha updated\tkeep\t',
        '@@row\t3\t2\tBeta\tnew\tafter',
      ].join('\n'),
    });
  });
  await page.waitForFunction(() => window.__SVN_DIFF_E2E__?.getSnapshot().isWorkbookMode === true);

  const canvas = page.locator('[data-workbook-cell-canvas="true"]:not([data-workbook-header-row-canvas="true"])');
  await expect(canvas).toHaveCount(1);
  const targetCellRect = {
    left: LN_W + 3 + (WORKBOOK_CELL_WIDTH * 4),
    top: 0,
    width: WORKBOOK_CELL_WIDTH,
    height: ROW_H,
  };
  const siblingCellRect = {
    ...targetCellRect,
    left: LN_W + 3 + (WORKBOOK_CELL_WIDTH * 2),
  };
  const otherRegionCellRect = {
    ...targetCellRect,
    left: LN_W + 3,
    top: ROW_H,
  };
  const sampleCell = (rect: typeof targetCellRect) => canvas.evaluate((element, sampleRect) => {
    if (!(element instanceof HTMLCanvasElement)) return { hash: 0, uniqueColors: 0 };
    const context = element.getContext('2d');
    if (!context) return { hash: 0, uniqueColors: 0 };
    const scaleX = element.width / element.clientWidth;
    const scaleY = element.height / element.clientHeight;
    const data = context.getImageData(
      Math.floor((sampleRect.left + 2) * scaleX),
      Math.floor((sampleRect.top + 2) * scaleY),
      Math.max(1, Math.floor((sampleRect.width - 4) * scaleX)),
      Math.max(1, Math.floor((sampleRect.height - 4) * scaleY)),
    ).data;
    let hash = 2166136261;
    const colors = new Set<string>();
    for (let index = 0; index < data.length; index += 4) {
      hash ^= data[index] ?? 0;
      hash = Math.imul(hash, 16777619);
      hash ^= data[index + 1] ?? 0;
      hash = Math.imul(hash, 16777619);
      hash ^= data[index + 2] ?? 0;
      hash = Math.imul(hash, 16777619);
      colors.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
    }
    return { hash: hash >>> 0, uniqueColors: colors.size };
  }, rect);

  const targetMaskedSnapshot = await sampleCell(targetCellRect);
  const siblingMaskedSnapshot = await sampleCell(siblingCellRect);
  const otherRegionMaskedSnapshot = await sampleCell(otherRegionCellRect);
  expect(targetMaskedSnapshot.uniqueColors).toBeGreaterThanOrEqual(2);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Workbook canvas is not visible.');
  await page.mouse.move(
    box.x + targetCellRect.left + (targetCellRect.width / 2),
    box.y + targetCellRect.top + (targetCellRect.height / 2),
  );
  await expect.poll(async () => (await sampleCell(targetCellRect)).hash).not.toBe(targetMaskedSnapshot.hash);
  await expect.poll(async () => (await sampleCell(siblingCellRect)).hash).not.toBe(siblingMaskedSnapshot.hash);
  expect((await sampleCell(otherRegionCellRect)).hash).toBe(otherRegionMaskedSnapshot.hash);
  await expect(page.getByRole('tooltip')).toHaveCount(0);

  await page.mouse.move(0, 0);
  await expect.poll(async () => (await sampleCell(targetCellRect)).hash).toBe(targetMaskedSnapshot.hash);
  await expect.poll(async () => (await sampleCell(siblingCellRect)).hash).toBe(siblingMaskedSnapshot.hash);
});

test('differences-only search ignores content outside the visible diff scope', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.setItem('versora.locale', 'en-US');
    window.localStorage.setItem('versora.settings', JSON.stringify({
      themeKey: 'light',
      showOnlyDifferences: true,
      settingsSchemaVersion: 2,
    }));
    window.versora = { getLaunchContext: () => new Promise(() => {}) } as NonNullable<typeof window.versora>;
  });
  await page.goto('/?__e2e=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await page.evaluate(async () => {
    await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
      fileName: 'differences-only-search.xlsx',
      layout: 'split-h',
      collapseCtx: false,
      showOnlyDifferences: true,
      baseContent: [
        '@@sheet\tStable',
        '@@row\t1\tID\tName',
        '@@row\t2\t1\tHidden needle',
        '@@sheet\tChanged',
        '@@row\t1\tID\tName',
        '@@row\t2\t2\tSame',
        '@@row\t3\t3\tBefore',
      ].join('\n'),
      mineContent: [
        '@@sheet\tStable',
        '@@row\t1\tID\tName',
        '@@row\t2\t1\tHidden needle',
        '@@sheet\tChanged',
        '@@row\t1\tID\tName',
        '@@row\t2\t2\tSame',
        '@@row\t3\t3\tAfter',
      ].join('\n'),
    });
  });
  await page.waitForFunction(() => window.__SVN_DIFF_E2E__?.getSnapshot().isWorkbookMode === true);
  await expect(page.getByTestId('workbook-sheet-tab')).toHaveCount(1);
  await expect(page.getByTestId('workbook-sheet-tab')).toContainText('Changed');

  await page.keyboard.press('Control+f');
  await page.getByRole('button', { name: 'Search across all sheets' }).click();
  await page.locator('.searchbar-input').fill('Hidden needle');
  await expect(page.getByText('No results', { exact: true })).toBeVisible();
  await expect(page.locator('[data-search-result-index]')).toHaveCount(0);
  await expect(page.getByTestId('workbook-sheet-tab')).toHaveCount(1);
  await expect(page.getByTestId('workbook-sheet-tab')).toContainText('Changed');
});

test('differences-only hides goto line controls and shortcut', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.setItem('versora.locale', 'en-US');
    window.localStorage.setItem('versora.settings', JSON.stringify({
      themeKey: 'light',
      showOnlyDifferences: true,
      settingsSchemaVersion: 2,
    }));
    window.versora = { getLaunchContext: () => new Promise(() => {}) } as NonNullable<typeof window.versora>;
  });
  await page.goto('/?__e2e=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await page.evaluate(async () => {
    await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
      fileName: 'differences-only-goto.xlsx',
      layout: 'split-h',
      collapseCtx: false,
      showOnlyDifferences: true,
      baseContent: [
        '@@sheet\tChanged',
        '@@row\t1\tID\tName',
        '@@row\t2\t2\tSame',
        '@@row\t3\t3\tBefore',
      ].join('\n'),
      mineContent: [
        '@@sheet\tChanged',
        '@@row\t1\tID\tName',
        '@@row\t2\t2\tSame',
        '@@row\t3\t3\tAfter',
      ].join('\n'),
    });
  });
  await page.waitForFunction(() => window.__SVN_DIFF_E2E__?.getSnapshot().isWorkbookMode === true);
  await expect(page.getByRole('button', { name: 'Jump to line (Ctrl+G)' })).toHaveCount(0);
  await expect(page.locator('.app-stats-bar')).not.toContainText('Ctrl+G goto');
  await page.keyboard.press('Control+g');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('differences-only disables adjacent workbook hunk navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.setItem('versora.locale', 'en-US');
    window.localStorage.setItem('versora.settings', JSON.stringify({
      themeKey: 'light',
      showOnlyDifferences: true,
      settingsSchemaVersion: 2,
    }));
    window.versora = { getLaunchContext: () => new Promise(() => {}) } as NonNullable<typeof window.versora>;
  });
  await page.goto('/?__e2e=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await page.evaluate(async () => {
    await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
      fileName: 'differences-only-hunks.xlsx',
      layout: 'split-h',
      collapseCtx: false,
      showOnlyDifferences: true,
      baseContent: [
        '@@sheet\tChanged',
        '@@row\t1\tID\tName',
        '@@row\t2\t1\tBefore A',
        '@@row\t8\t2\tSame',
        '@@row\t14\t3\tBefore B',
      ].join('\n'),
      mineContent: [
        '@@sheet\tChanged',
        '@@row\t1\tID\tName',
        '@@row\t2\t1\tAfter A',
        '@@row\t8\t2\tSame',
        '@@row\t14\t3\tAfter B',
      ].join('\n'),
    });
  });
  await page.waitForFunction(() => window.__SVN_DIFF_E2E__?.getSnapshot().isWorkbookMode === true);

  const nextHunk = page.getByRole('button', { name: 'Next hunk (F7)' });
  await expect(nextHunk).toHaveCount(0);
  await expect(page.locator('.app-stats-bar')).not.toContainText('F7 next');
  await page.keyboard.press('F7');
  await expect(nextHunk).toHaveCount(0);

  await page.getByTestId('toolbar-diff-only').click();
  await expect(nextHunk).toHaveCount(1);
  await expect(page.locator('.app-stats-bar')).toContainText('F7 next');
});
