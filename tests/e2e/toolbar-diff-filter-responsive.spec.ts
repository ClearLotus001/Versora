import { expect, test, type Page } from '@playwright/test';
import type { DiffData } from '../../src/types';
import '../../src/utils/app/e2eBridge';
import '../../src/utils/app/perfBridge';
import { expectDiffTypeFilter, selectDiffTypeFilter } from './helpers/diffTypeFilter';

declare global {
  interface Window {
    __responsiveToolbarHarness?: { queue(data: DiffData): void; finish(): void };
  }
}

async function openApp(page: Page, options: { width: number; locale: 'en-US' | 'zh-CN'; nativeControls: boolean; maxDisplayOverrides?: boolean }) {
  await page.setViewportSize({ width: options.width, height: 900 });
  await page.addInitScript(({ locale, nativeControls, maxDisplayOverrides }) => {
    localStorage.setItem('versora.locale', locale);
    localStorage.setItem('versora.settings', JSON.stringify({
      themeKey: 'light', showOnlyDifferences: false, collapseCtx: false, settingsSchemaVersion: 4,
      ...(maxDisplayOverrides ? { showWhitespace: true, showHiddenColumns: true, botEnabled: false, workbookCompareMode: 'content', fontSize: 16 } : {}),
    }));
    let queued: DiffData | null = null;
    let listener: (() => void) | null = null;
    let resolveDiff: (() => void) | null = null;
    let finished = Promise.resolve();
    window.__responsiveToolbarHarness = {
      queue(data) {
        queued = data;
        finished = new Promise<void>((resolve) => { resolveDiff = resolve; });
        listener?.();
      },
      finish() { resolveDiff?.(); },
    };
    window.versora = {
      getLaunchContext: async () => ({
        hasDiffRequest: Boolean(queued), pendingDiffRequestCount: queued ? 1 : 0,
        isDevMode: true, usesNativeWindowControls: nativeControls,
        windowFrameState: { isMaximized: true }, launchedAfterUpdate: false,
        updateState: {
          status: 'disabled', platform: 'win32', supportsAutoUpdate: false, currentVersion: 'test',
          availableVersion: null, downloadPercent: 0, releaseName: null, releaseNotes: null,
          publishedAt: null, lastCheckedAt: null, errorMessage: null,
        },
      }),
      onCliArgsUpdated: (callback: () => void) => { listener = callback; return () => { listener = null; }; },
      getDiffData: async () => {
        const data = queued;
        queued = null;
        await finished;
        if (!data) throw new Error('No queued toolbar comparison.');
        return data;
      },
      setTitleBarOverlay: () => {},
      windowMinimize: () => {}, windowMaximize: () => {}, windowClose: () => {},
    } as unknown as NonNullable<typeof window.versora>;
  }, options);
  await page.goto('/?__e2e=1&__perf=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await expect(page.locator('.home-stage')).toBeVisible();
  await expect(page.getByTestId('diff-type-filter')).toHaveCount(0);
}

async function loadWorkbook(page: Page, allTypes = true) {
  await page.evaluate(async (includeAll) => {
    await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
      fileName: 'responsive-filter.xlsx', layout: 'split-h', collapseCtx: false, showOnlyDifferences: false,
      baseContent: [
        '@@sheet\tModified', '@@row\t1\tID\tValue', '@@row\t2\t1\tBefore',
        ...(includeAll ? ['@@sheet\tDeleted', '@@row\t1\tID\tValue', '@@row\t2\t1\tOld'] : []),
      ].join('\n'),
      mineContent: [
        '@@sheet\tModified', '@@row\t1\tID\tValue', '@@row\t2\t1\tAfter',
        ...(includeAll ? ['@@sheet\tAdded', '@@row\t1\tID\tValue', '@@row\t2\t1\tNew'] : []),
      ].join('\n'),
    });
  }, allTypes);
  await page.waitForFunction(() => {
    const snapshot = window.__SVN_DIFF_PERF__?.getSnapshot();
    return snapshot?.loadPhase === 'ready' && snapshot.viewReadyToken > 0
      && (snapshot.workbookArtifact?.cache.windows ?? 0) > 0 && snapshot.workbookArtifact?.cache.pending === 0;
  });
}

async function resizeToolbar(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  // ResizeObserver measures the toolbar between frames before React settles its representation.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function assertFilterControlSizing(page: Page) {
  const reference = await page.getByTestId('toolbar-layout-split-h').evaluate((button) => ({
    height: button.getBoundingClientRect().height,
    fontSize: getComputedStyle(button).fontSize,
    fontWeight: getComputedStyle(button).fontWeight,
    groupHeight: button.closest('[role="group"]')!.getBoundingClientRect().height,
  }));
  const control = page.getByTestId('diff-type-filter');
  const metrics = await control.locator('button').evaluateAll((buttons) => buttons.map((button) => ({
    height: button.getBoundingClientRect().height,
    fontSize: getComputedStyle(button).fontSize,
    fontWeight: getComputedStyle(button).fontWeight,
  })));
  expect(metrics.length).toBeGreaterThan(0);
  for (const metric of metrics) expect(metric).toEqual({
    height: reference.height, fontSize: reference.fontSize, fontWeight: reference.fontWeight,
  });
  if (await control.getByRole('radiogroup').isVisible()) {
    const actualGroup = await control.getByRole('radiogroup').boundingBox();
    const probeWidth = await control.locator(':scope > [aria-hidden="true"]').evaluate((element) => element.getBoundingClientRect().width);
    expect(actualGroup!.height).toBe(reference.groupHeight);
    expect(Math.abs(actualGroup!.width - probeWidth)).toBeLessThanOrEqual(1);
  }
}

async function assertToolbarOrderAndBounds(page: Page, nativeControls: boolean) {
  const controls = [page.getByTestId('toolbar-diff-only'), page.getByTestId('diff-type-filter'), page.getByTestId('toolbar-view-menu')];
  const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
  expect(boxes.every(Boolean)).toBe(true);
  expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x + 1);
  expect(boxes[1]!.x + boxes[1]!.width).toBeLessThanOrEqual(boxes[2]!.x + 1);
  const viewport = page.viewportSize()!;
  for (const box of boxes) {
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width - (nativeControls ? 138 : 0));
  }
  await expect(page.locator('.app-toolbar').getByTestId('diff-type-filter')).toHaveCount(1);
  await expect(page.getByTestId('diff-filter-toolbar')).toHaveCount(0);
  const buttonMetrics = await page.locator('.app-toolbar button').evaluateAll((buttons) => buttons.flatMap((button) => {
    const rect = button.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return [{ label: button.getAttribute('aria-label') || button.textContent?.trim() || button.getAttribute('data-testid'),
      x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom,
      topLayer: top === button || Boolean(top && button.contains(top)) }];
  }));
  expect(buttonMetrics.length).toBeGreaterThanOrEqual(8);
  for (const button of buttonMetrics) {
    expect(button.x, `${button.label} left edge`).toBeGreaterThanOrEqual(0);
    expect(button.right, `${button.label} right edge`).toBeLessThanOrEqual(viewport.width - (nativeControls ? 138 : 0));
    expect(button.topLayer, `${button.label} pointer target`).toBe(true);
  }
}

for (const variant of [
  { locale: 'en-US' as const, nativeControls: true, labels: ['All', 'Added', 'Modified', 'Deleted'] },
  { locale: 'zh-CN' as const, nativeControls: false, labels: ['全部', '新增', '修改', '删除'] },
]) {
  test(`900px ${variant.locale} toolbar uses an accessible filter menu and preserves selection on resize`, async ({ page }, testInfo) => {
    await openApp(page, { width: 900, ...variant });
    await loadWorkbook(page);
    const trigger = page.getByTestId('diff-type-filter-trigger');
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText(variant.labels[0]!);
    await assertToolbarOrderAndBounds(page, variant.nativeControls);
    await assertFilterControlSizing(page);
    await page.screenshot({ path: testInfo.outputPath(`toolbar-${variant.locale}-900.png`), animations: 'disabled' });
    await trigger.click();
    const menu = page.getByTestId('diff-type-filter-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('role', 'menu');
    await expect(menu.getByRole('menuitemradio')).toHaveText(variant.labels);
    await expect(page.getByTestId('diff-filter-all')).toHaveAttribute('aria-checked', 'true');
    const menuMetrics = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { position: getComputedStyle(element).position, left: rect.left, right: rect.right,
        topLayer: hit === element || Boolean(hit && element.contains(hit)), inToolbar: Boolean(element.closest('.app-toolbar')) };
    });
    expect(menuMetrics).toMatchObject({ position: 'fixed', topLayer: true, inToolbar: false });
    expect(menuMetrics.left).toBeGreaterThanOrEqual(0);
    expect(menuMetrics.right).toBeLessThanOrEqual(900);
    await page.screenshot({ path: testInfo.outputPath(`toolbar-${variant.locale}-menu.png`), animations: 'disabled' });
    await page.getByTestId('diff-filter-all').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('diff-filter-add')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => ['diff-type-filter-trigger', 'diff-filter-add']
      .includes(document.activeElement?.getAttribute('data-testid') ?? ''))).toBe(true);
    await expectDiffTypeFilter(page, 'add');
    await expect(page.getByTestId('workbook-sheet-tab')).toHaveCount(1);
    await expect(page.getByTestId('workbook-sheet-tab')).toContainText('Added');

    await resizeToolbar(page, 1800);
    await expect(trigger).toHaveCount(0);
    await expect(page.getByTestId('diff-filter-add')).toBeVisible();
    await expect(page.getByTestId('diff-filter-add')).toBeFocused();
    await expectDiffTypeFilter(page, 'add');
    await assertToolbarOrderAndBounds(page, variant.nativeControls);
    await assertFilterControlSizing(page);
    await page.mouse.move(1200, 700);
    await page.screenshot({ path: testInfo.outputPath(`toolbar-${variant.locale}-1800.png`), animations: 'disabled' });
    await resizeToolbar(page, 900);
    await expect.poll(() => page.evaluate(() => ['diff-type-filter-trigger', 'diff-filter-add']
      .includes(document.activeElement?.getAttribute('data-testid') ?? ''))).toBe(true);
    // Source filters can hide navigation controls and make short labels fit at 900px.
    await expectDiffTypeFilter(page, 'add');
    await selectDiffTypeFilter(page, 'all');
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText(variant.labels[0]!);
    await trigger.click();
    await expect(page.getByTestId('diff-filter-all')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(menu).toBeVisible();
    await page.locator('.comparison-tabs').click({ position: { x: 5, y: 18 } });
    await expect(menu).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toContainText(variant.labels[0]!);
  });
}

test('narrow filter menu skips disabled types and fits the longest selection with all display overrides', async ({ page }, testInfo) => {
  await openApp(page, { width: 900, locale: 'en-US', nativeControls: true, maxDisplayOverrides: true });
  await loadWorkbook(page, false);
  const trigger = page.getByTestId('diff-type-filter-trigger');
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await trigger.press('ArrowDown');
  await expect(page.getByTestId('diff-type-filter-menu')).toBeVisible();
  await expect(page.getByTestId('diff-filter-all')).toBeEnabled();
  await expect(page.getByTestId('diff-filter-add')).toBeDisabled();
  await expect(page.getByTestId('diff-filter-modify')).toBeEnabled();
  await expect(page.getByTestId('diff-filter-delete')).toBeDisabled();
  await page.getByTestId('diff-filter-all').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('diff-filter-modify')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('diff-filter-all')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('diff-filter-modify')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('diff-filter-all')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByTestId('diff-filter-modify')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('diff-type-filter-menu')).toHaveCount(0);
  await expect(trigger).toContainText('Modified');
  await expect(page.getByTestId('toolbar-view-menu')).toContainText('7');
  await assertToolbarOrderAndBounds(page, true);
  await assertFilterControlSizing(page);
  await page.screenshot({ path: testInfo.outputPath('toolbar-en-US-modified-900-max-overrides.png'), animations: 'disabled' });
  await expectDiffTypeFilter(page, 'modify');
  // Keep all navigation and the seven display overrides visible while testing radio keys.
  await resizeToolbar(page, 2200);
  await expect(page.getByTestId('diff-type-filter').getByRole('radiogroup')).toBeVisible();
  await expect(page.getByTestId('diff-filter-modify')).toBeVisible();
  await expect(page.getByTestId('diff-filter-modify')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('diff-filter-add')).toBeDisabled();
  await expect(page.getByTestId('diff-filter-delete')).toBeDisabled();
  await page.getByTestId('diff-filter-modify').focus();
  await page.keyboard.press('ArrowRight');
  await expectDiffTypeFilter(page, 'all');
  await page.keyboard.press('ArrowLeft');
  await expectDiffTypeFilter(page, 'modify');
});

test('reduced motion keeps tab restoration immediate and removes loading before ready interaction', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page, { width: 900, locale: 'en-US', nativeControls: true });
  for (const marker of ['Alpha', 'Beta']) {
    await page.evaluate(async (name) => window.__SVN_DIFF_E2E__!.loadTextDiff({
      fileName: `${name}.txt`, layout: 'unified', collapseCtx: false,
      baseContent: `${name} before`, mineContent: `${name} after`,
    }), marker);
  }
  await page.getByTestId('comparison-tab').filter({ hasText: 'Alpha.txt' }).click();
  await expect(page.locator('[data-line-idx]')).toContainText(['Alpha after']);
  await expect(page.locator('.comparison-content-enter')).toHaveCount(1);
  expect(await page.locator('.comparison-content-enter').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  const selectedTab = page.locator('.comparison-tab-surface[data-active="true"]');
  expect(await selectedTab.evaluate((element) => ({
    animation: getComputedStyle(element).animationName,
    highlightTransition: getComputedStyle(element, '::after').transitionDuration,
  }))).toEqual({ animation: 'none', highlightTransition: '0s' });
  await selectDiffTypeFilter(page, 'modify');
  await page.evaluate(() => window.__responsiveToolbarHarness!.queue({
    comparisonSessionId: 'loading-gamma', svnUrl: '', fileName: 'Gamma.txt',
    baseName: 'Gamma.base.txt', mineName: 'Gamma.mine.txt',
    baseContent: 'Gamma before', mineContent: 'Gamma after',
    compareContext: 'literal_two_file_compare', canSwitchRevisions: false,
  }));
  const overlay = page.getByTestId('diff-loading-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute('role', 'status');
  await expect(overlay).toHaveAttribute('aria-live', 'polite');
  await expect(overlay).toHaveAttribute('aria-atomic', 'true');
  await expect(page.getByTestId('diff-type-filter')).toHaveCount(0);
  const loadingAnimations = await overlay.evaluate((element) => [element, ...element.querySelectorAll('.diff-loading-card, .diff-loading-indicator')]
    .map((part) => getComputedStyle(part).animationName));
  expect(loadingAnimations).toEqual(['none', 'none', 'none']);
  await page.screenshot({ path: testInfo.outputPath('loading-reduced-motion.png'), animations: 'disabled' });
  await page.evaluate(() => window.__responsiveToolbarHarness!.finish());
  await page.waitForFunction(() => {
    const s = window.__SVN_DIFF_PERF__?.getSnapshot();
    return s?.fileName === 'Gamma.txt' && s.loadPhase === 'ready' && !s.isLoadingDiff;
  });
  expect(await page.locator('[data-testid="diff-loading-state"], [data-testid="diff-loading-overlay"]').count()).toBe(0);
  await expect(page.getByTestId('diff-type-filter-trigger')).toBeVisible();
  await expect(page.locator('.comparison-content-enter')).toHaveCount(1);
  await expect(page.locator('[data-line-idx]')).toContainText(['Gamma after']);
  await expect(page.locator('[data-line-idx]').filter({ hasText: 'Alpha' })).toHaveCount(0);
  const readyLine = page.locator('[data-line-idx]').filter({ hasText: 'Gamma after' }).first();
  expect(await readyLine.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return top === element || Boolean(top && element.contains(top));
  })).toBe(true);
  await readyLine.click();
  await page.getByTestId('comparison-tab').filter({ hasText: 'Beta.txt' }).click();
  await expect(page.locator('[data-line-idx]')).toContainText(['Beta after']);
  await expect(page.locator('[data-line-idx]').filter({ hasText: 'Gamma' })).toHaveCount(0);
  await expect(page.locator('.comparison-content-enter')).toHaveCount(1);
  await expect(page.getByTestId('diff-loading-overlay')).toHaveCount(0);
  await page.getByTestId('toolbar-home').click();
  await expect(page.locator('.home-stage')).toBeVisible();
  await expect(page.getByTestId('diff-type-filter')).toHaveCount(0);
});

test('normal loading animates the card and spinner without delaying ready content', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openApp(page, { width: 900, locale: 'en-US', nativeControls: true });
  await page.evaluate(async () => window.__SVN_DIFF_E2E__!.loadTextDiff({
    fileName: 'Warm.txt', layout: 'unified', collapseCtx: false, baseContent: 'Warm before', mineContent: 'Warm after',
  }));
  await expect(page.locator('[data-line-idx]')).toContainText(['Warm after']);
  await page.evaluate(() => window.__responsiveToolbarHarness!.queue({
    comparisonSessionId: 'normal-loading', svnUrl: '', fileName: 'Ready.txt',
    baseName: 'Ready.base.txt', mineName: 'Ready.mine.txt',
    baseContent: 'Ready before', mineContent: 'Ready after',
    compareContext: 'literal_two_file_compare', canSwitchRevisions: false,
  }));
  const overlay = page.getByTestId('diff-loading-overlay');
  await expect(overlay).toBeVisible();
  await expect(page.getByTestId('diff-type-filter')).toHaveCount(0);
  const animationNames = await overlay.evaluate((element) => [
    element.querySelector('.diff-loading-card')!, element.querySelector('.diff-loading-indicator')!,
  ].map((part) => getComputedStyle(part).animationName));
  expect(animationNames).toHaveLength(2);
  expect(animationNames.every((name) => name !== 'none')).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('loading-normal-motion.png'), animations: 'disabled' });
  await page.evaluate(() => window.__responsiveToolbarHarness!.finish());
  await page.waitForFunction(() => {
    const s = window.__SVN_DIFF_PERF__?.getSnapshot();
    return s?.fileName === 'Ready.txt' && s.loadPhase === 'ready' && !s.isLoadingDiff;
  });
  expect(await page.locator('[data-testid="diff-loading-state"], [data-testid="diff-loading-overlay"]').count()).toBe(0);
  await expect(page.locator('[data-line-idx]')).toContainText(['Ready after']);
  await expect(page.locator('[data-line-idx]').filter({ hasText: 'Warm' })).toHaveCount(0);
  await expect(page.locator('.comparison-content-enter')).toHaveCount(1);
});
