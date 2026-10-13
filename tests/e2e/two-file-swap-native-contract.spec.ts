import { expect, test } from '@playwright/test';
import type { DiffData, SvnRevisionInfo } from '../../src/types';

type NativeSwapCall = { baseId: string | null; mineId: string | null; compareMode?: string | undefined; sessionId?: string | undefined };
type NativeSwapHarness = { calls: NativeSwapCall[]; failNext: boolean };
declare global {
  interface Window { __nativeSwapHarness?: NativeSwapHarness }
}

test('native two-file swapping preserves selected historical revisions and the comparison session', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('versora.locale', 'en-US');
    localStorage.setItem('versora.settings', JSON.stringify({ themeKey: 'light', showOnlyDifferences: false, collapseCtx: false, settingsSchemaVersion: 4 }));
    const revision = (id: string): SvnRevisionInfo => ({ id, revision: id, title: id, author: id, date: '', message: '', kind: 'revision' });
    let pending = true;
    let current: DiffData = {
      comparisonSessionId: 'selected-history-session', svnUrl: '', sourceIdentity: 'selected-history-pair',
      fileName: 'right.txt', baseName: 'left.txt', mineName: 'right.txt', basePath: 'C:\\left.txt', minePath: 'C:\\right.txt',
      launchBaseName: 'left.txt', launchMineName: 'right.txt', compareContext: 'literal_two_file_compare',
      baseContent: 'selected git history', mineContent: 'selected svn history',
      baseRevisionInfo: revision('git-selected-commit'), mineRevisionInfo: revision('svn-selected-204'),
      canSwitchRevisions: true, revisionSwitchableSides: { base: true, mine: true },
      resetPair: { baseRevisionId: 'default-base', mineRevisionId: 'default-mine' },
      source: { kind: 'local', label: 'Historical sources', baseKind: 'git', targetKind: 'svn' },
    };
    const harness: NativeSwapHarness = { calls: [], failNext: false };
    window.__nativeSwapHarness = harness;
    const bridge: Pick<NonNullable<Window['versora']>, 'getLaunchContext' | 'getDiffData' | 'loadLocalFileDiff' | 'swapTwoFileDiff'> = {
      getLaunchContext: async () => ({
        hasDiffRequest: pending, pendingDiffRequestCount: pending ? 1 : 0, isDevMode: false,
        usesNativeWindowControls: false, windowFrameState: { isMaximized: true }, launchedAfterUpdate: false,
        updateState: { status: 'disabled', platform: 'win32', supportsAutoUpdate: false, currentVersion: 'test', availableVersion: null,
          downloadPercent: 0, releaseName: null, releaseNotes: null, publishedAt: null, lastCheckedAt: null, errorMessage: null },
      }),
      getDiffData: async () => { pending = false; return current; },
      loadLocalFileDiff: async () => { throw new Error('Swap discarded the selected historical revisions.'); },
      swapTwoFileDiff: async (baseId, mineId, compareMode, sessionId) => {
        harness.calls.push({ baseId, mineId, compareMode, sessionId });
        if (harness.failNext) { harness.failNext = false; throw new Error('Native swap failed'); }
        current = { ...current, fileName: current.baseName, baseName: current.mineName, mineName: current.baseName,
          basePath: current.minePath!, minePath: current.basePath!, launchBaseName: current.launchMineName!, launchMineName: current.launchBaseName!,
          baseContent: current.mineContent, mineContent: current.baseContent, baseRevisionInfo: current.mineRevisionInfo!, mineRevisionInfo: current.baseRevisionInfo!,
          source: { kind: 'local', label: 'Historical sources', baseKind: current.source!.targetKind!, targetKind: current.source!.baseKind! } };
        return current;
      },
    };
    window.versora = bridge as NonNullable<typeof window.versora>;
  });
  await page.goto('/?__perf=1');
  const base = page.locator('[data-split-header-side="base"]');
  const mine = page.locator('[data-split-header-side="mine"]');
  await expect(base).toContainText('left.txt');
  await expect(base).toContainText('git-selected-commit');
  await expect(mine).toContainText('svn-selected-204');

  await page.getByTestId('split-header-swap').click();
  await expect(base).toContainText('right.txt');
  await expect(base).toContainText('svn-selected-204');
  await expect(mine).toContainText('left.txt');
  await expect(mine).toContainText('git-selected-commit');
  await expect(page.getByTestId('source-badge-base')).toHaveText('SVN');
  await expect(page.getByTestId('source-badge-mine')).toHaveText('GIT');
  await expect(page.getByTestId('comparison-tab')).toHaveCount(1);

  await page.getByTestId('split-header-swap').click();
  await expect(base).toContainText('git-selected-commit');
  await expect(mine).toContainText('svn-selected-204');
  expect(await page.evaluate(() => window.__nativeSwapHarness!.calls)).toEqual([
    { baseId: 'git-selected-commit', mineId: 'svn-selected-204', compareMode: 'strict', sessionId: 'selected-history-session' },
    { baseId: 'svn-selected-204', mineId: 'git-selected-commit', compareMode: 'strict', sessionId: 'selected-history-session' },
  ]);

  await page.evaluate(() => { window.__nativeSwapHarness!.failNext = true; });
  await page.getByTestId('split-header-swap').click();
  await expect(page.getByRole('alert')).toContainText('Native swap failed');
  await expect(base).toContainText('git-selected-commit');
  await expect(mine).toContainText('svn-selected-204');
  await expect(page.getByTestId('comparison-tab')).toHaveCount(1);
});
