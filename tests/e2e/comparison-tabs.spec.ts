import { expect, test, type Page } from '@playwright/test';
import type { DiffData, SvnRevisionInfo } from '../../src/types';
import type { E2ELoadTextDiffPayload } from '../../src/utils/app/e2eBridge';
import type { WorkbookArtifactDescriptor, WorkbookArtifactWindowRequest } from '../../shared/workbookArtifactProtocol';
import { expectDiffTypeFilter, selectDiffTypeFilter } from './helpers/diffTypeFilter';

type ExternalComparisonHarness = {
  enqueue: (data: DiffData, delayMs?: number) => void;
  requestedSessions: string[];
  releasedSessions: Array<string | undefined>;
};

type RevisionComparisonHarness = {
  enqueue: (data: DiffData) => void;
  resolveAlphaBlame: () => void;
  querySessions: Array<string | undefined>;
  revisionLoads: Array<{ sessionId?: string | undefined; baseId: string; mineId: string }>;
  blameSessions: Array<string | undefined>;
};

type WorkbookComparisonHarness = {
  enqueue: (fileName: string, marker: string) => void;
  requestedSessions: string[];
  releasedSessions: Array<string | undefined>;
};

declare global {
  interface Window {
    __comparisonHarness?: ExternalComparisonHarness;
    __comparisonRevisionHarness?: RevisionComparisonHarness;
    __comparisonWorkbookHarness?: WorkbookComparisonHarness;
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('versora.locale', 'en-US');
    localStorage.setItem('versora.settings', JSON.stringify({
      themeKey: 'light',
      showOnlyDifferences: false,
      diffTypeFilter: 'all',
      settingsSchemaVersion: 4,
    }));
    window.versora = {
      getLaunchContext: async () => ({
        hasDiffRequest: false,
        pendingDiffRequestCount: 0,
        isDevMode: true,
        usesNativeWindowControls: false,
        windowFrameState: { isMaximized: true },
        launchedAfterUpdate: false,
        updateState: {
          status: 'disabled',
          platform: 'win32',
          supportsAutoUpdate: false,
          currentVersion: 'test',
          availableVersion: null,
          downloadPercent: 0,
          releaseName: null,
          releaseNotes: null,
          publishedAt: null,
          lastCheckedAt: null,
          errorMessage: null,
        },
      }),
    } as NonNullable<typeof window.versora>;
  });
});

test('revision requests and late blame results remain associated with the selected file', async ({ page }) => {
  await page.addInitScript(() => {
    const queue: DiffData[] = [];
    const comparisons = new Map<string, DiffData>();
    let listener: (() => void) | null = null;
    let resolveAlphaBlame!: () => void;
    const alphaBlameReady = new Promise<void>((resolve) => { resolveAlphaBlame = resolve; });
    const originalBridge = window.versora!;
    const revisions = (fileName: string): SvnRevisionInfo[] => [12, 11, 10].map((revision) => ({
      id: `r${revision}`, revision: String(revision), title: `r${revision}`,
      author: fileName, date: '2026-10-13 10:00',
      message: `${fileName} revision ${revision}`, kind: 'revision',
    }));
    window.__comparisonRevisionHarness = {
      querySessions: [], revisionLoads: [], blameSessions: [],
      resolveAlphaBlame,
      enqueue(data) {
        queue.push(data);
        comparisons.set(data.comparisonSessionId!, data);
        listener?.();
      },
    };
    window.versora = {
      ...originalBridge,
      getLaunchContext: async () => ({
        ...await originalBridge.getLaunchContext(),
        hasDiffRequest: queue.length > 0, pendingDiffRequestCount: queue.length,
      }),
      onCliArgsUpdated: (callback) => { listener = callback; return () => { listener = null; }; },
      getDiffData: async () => {
        const next = queue.shift();
        if (!next) throw new Error('No queued revision comparison.');
        return next;
      },
      queryRevisionOptions: async (_query, sessionId) => {
        window.__comparisonRevisionHarness!.querySessions.push(sessionId);
        const data = comparisons.get(sessionId!)!;
        return {
          items: revisions(data.fileName), hasMore: false, nextBeforeRevisionId: null,
          anchorRevisionId: null, queryDateTime: null,
        };
      },
      loadRevisionDiff: async (baseId, mineId, _mode, sessionId) => {
        window.__comparisonRevisionHarness!.revisionLoads.push({ sessionId, baseId, mineId });
        const data = comparisons.get(sessionId!)!;
        const options = revisions(data.fileName);
        const result = {
          ...data, baseContent: `${data.fileName} at ${baseId}`, mineContent: `${data.fileName} at ${mineId}`,
          sourceIdentity: `${data.svnUrl}::${baseId}::${mineId}`,
          baseRevisionInfo: options.find((option) => option.id === baseId)!,
          mineRevisionInfo: options.find((option) => option.id === mineId)!, revisionOptions: options,
        };
        comparisons.set(sessionId!, result);
        return result;
      },
      loadLineBlame: async (_baseId, _mineId, sessionId) => {
        window.__comparisonRevisionHarness!.blameSessions.push(sessionId);
        if (sessionId === 'revision-alpha') await alphaBlameReady;
        const author = sessionId === 'revision-alpha' ? 'AlphaAuthor' : 'BetaAuthor';
        return {
          base: [{ lineNo: 1, revision: 'r10', author, date: '2026-10-13', uncommitted: false }],
          mine: [{ lineNo: 1, revision: 'r11', author, date: '2026-10-13', uncommitted: false }],
        };
      },
    } as NonNullable<typeof window.versora>;
  });
  await openApp(page);
  await page.evaluate(() => {
    for (const fileName of ['alpha', 'beta']) {
      const revision = (id: number): SvnRevisionInfo => ({
        id: `r${id}`, revision: String(id), title: `r${id}`, author: fileName,
        date: '2026-10-13', message: `${fileName} revision ${id}`, kind: 'revision',
      });
      window.__comparisonRevisionHarness!.enqueue({
        comparisonSessionId: `revision-${fileName}`,
        source: { kind: 'svn', label: 'SVN' }, sourceIdentity: `svn://repo/${fileName}.txt`,
        svnUrl: `svn://repo/${fileName}.txt`, fileName: `${fileName}-revisions.txt`,
        baseName: `${fileName}.r10`, mineName: `${fileName}.r11`,
        baseContent: `${fileName} before`, mineContent: `${fileName} after`,
        compareContext: 'revision_vs_revision_compare', canSwitchRevisions: true,
        baseRevisionInfo: revision(10), mineRevisionInfo: revision(11), revisionOptions: null,
      });
    }
  });
  await expect(page.getByTestId('comparison-tab')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => window.__comparisonRevisionHarness!.blameSessions)).toEqual([
    'revision-alpha', 'revision-beta',
  ]);
  await expect(page.locator('button[aria-label*="BetaAuthor"]')).toHaveCount(2);
  await page.evaluate(() => window.__comparisonRevisionHarness!.resolveAlphaBlame());
  await selectComparison(page, 'alpha-revisions.txt');
  await expect(page.locator('button[aria-label*="AlphaAuthor"]')).toHaveCount(2);
  await expect(page.locator('button[aria-label*="BetaAuthor"]')).toHaveCount(0);

  for (const fileName of ['alpha', 'beta']) {
    await selectComparison(page, `${fileName}-revisions.txt`);
    await page.getByTestId('revision-picker-trigger-right').click();
    await page.getByTestId('revision-picker-list').getByText(`${fileName}-revisions.txt revision 12`, { exact: true }).click();
    await expect(page.getByTestId('revision-picker-trigger-right')).toContainText('12');
    await expect(page.locator('[data-line-idx]')).toContainText([`${fileName}-revisions.txt at r12`]);
  }
  expect(await page.evaluate(() => window.__comparisonRevisionHarness!.querySessions)).toEqual([
    'revision-alpha', 'revision-beta',
  ]);
  expect(await page.evaluate(() => window.__comparisonRevisionHarness!.revisionLoads)).toEqual([
    { sessionId: 'revision-alpha', baseId: 'r10', mineId: 'r12' },
    { sessionId: 'revision-beta', baseId: 'r10', mineId: 'r12' },
  ]);
  await selectComparison(page, 'alpha-revisions.txt');
  await expect(page.getByTestId('revision-picker-trigger-right')).toContainText('12');
  await expect(page.locator('[data-line-idx]')).toContainText(['alpha-revisions.txt at r12']);
  await expect(page.getByTestId('comparison-tab')).toHaveCount(2);
});

async function openApp(page: Page) {
  await page.goto('/?__e2e=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await expect(page.locator('.home-stage')).toBeVisible();
}

async function loadTextComparison(page: Page, payload: E2ELoadTextDiffPayload) {
  await page.evaluate(async (fixture) => {
    await window.__SVN_DIFF_E2E__!.loadTextDiff(fixture);
  }, payload);
  await page.waitForFunction((fileName) => {
    const snapshot = window.__SVN_DIFF_E2E__?.getSnapshot();
    return snapshot?.hasLoadedDiff === true && snapshot.fileName === fileName;
  }, payload.fileName);
  await expect(page.getByTestId('diff-loading-state')).toHaveCount(0);
}

function comparisonTab(page: Page, fileName: string) {
  return page.getByTestId('comparison-tab').filter({ hasText: fileName });
}

async function selectComparison(page: Page, fileName: string) {
  await comparisonTab(page, fileName).click();
  await expect(comparisonTab(page, fileName)).toHaveAttribute('aria-selected', 'true');
  await page.waitForFunction((expectedFileName) => (
    window.__SVN_DIFF_E2E__?.getSnapshot().fileName === expectedFileName
  ), fileName);
}

function textFixture(fileName: string, marker: string): E2ELoadTextDiffPayload {
  const baseLines = Array.from({ length: 45 }, (_, index) => `stable ${marker} line ${index + 1}`);
  const mineLines = [...baseLines];
  baseLines[2] = `${marker} old first`;
  mineLines[2] = `${marker} new first`;
  baseLines[35] = `${marker} old second`;
  mineLines[35] = `${marker} new second`;
  return {
    fileName,
    baseName: `${fileName}.base`,
    mineName: `${fileName}.mine`,
    baseContent: baseLines.join('\n'),
    mineContent: mineLines.join('\n'),
    collapseCtx: false,
  };
}

test('each file retains its content, search, layout, filter and hunk navigation', async ({ page }, testInfo) => {
  await openApp(page);
  await loadTextComparison(page, { ...textFixture('alpha.txt', 'AlphaNeedle'), layout: 'split-v' });
  await page.getByRole('button', { name: 'Next hunk (F7)', exact: true }).click();
  const navigation = page.getByRole('group', { name: 'Next hunk (F7)', exact: true });
  await expect(navigation).toContainText('2/2');
  await page.keyboard.press('Control+f');
  await page.locator('.searchbar-input').fill('AlphaNeedle new');
  await expect(page.locator('#search-pattern-status')).toHaveText('1 / 2');
  await page.locator('.searchbar-input').press('ArrowDown');
  await expect(page.locator('#search-pattern-status')).toHaveText('2 / 2');

  await loadTextComparison(page, { ...textFixture('beta.txt', 'BetaNeedle'), layout: 'unified' });
  await expect(page.getByTestId('comparison-tab')).toHaveCount(2);
  await page.keyboard.press('Control+f');
  await page.locator('.searchbar-input').fill('BetaNeedle');
  await selectDiffTypeFilter(page, 'modify');
  await expectDiffTypeFilter(page, 'modify');
  await expect(page.locator('.searchbar-input')).toHaveValue('BetaNeedle');

  await selectComparison(page, 'alpha.txt');
  await expect(page.getByTestId('toolbar-layout-split-v')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.searchbar-input')).toHaveValue('AlphaNeedle new');
  await expect(page.locator('#search-pattern-status')).toHaveText('2 / 2');
  await expect(navigation).toContainText('2/2');
  await expectDiffTypeFilter(page, 'all');
  await expect(page.locator('[data-line-idx]')).toContainText(['AlphaNeedle']);

  await selectComparison(page, 'beta.txt');
  await expect(page.getByTestId('toolbar-layout-unified')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.searchbar-input')).toHaveValue('BetaNeedle');
  await expectDiffTypeFilter(page, 'modify');
  await expect(page.locator('[data-line-idx]')).toContainText(['BetaNeedle']);
  await expect(page.locator('#search-pattern-status')).toHaveText(/^[1-9]\d* \/ [1-9]\d*$/);
  await selectComparison(page, 'alpha.txt');
  await expect(page.locator('[data-split-header-side="base"]')).toContainText('alpha.txt.base');
  await expect(page.locator('[data-split-header-side="mine"]')).toContainText('alpha.txt.mine');
  await expect(page.locator('#search-pattern-status')).toHaveText('2 / 2');
  await expect(page.locator('[data-line-idx]')).toContainText(['AlphaNeedle']);
  await page.getByRole('button', { name: 'Show results list', exact: true }).click();
  await expect(page.getByTestId('search-results-scroll')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('comparison-tabs.png'), animations: 'disabled' });
});

test('switching files restores both axes of the text viewport', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page);
  const wideTail = 'wide-content '.repeat(90);
  const content = Array.from({ length: 240 }, (_, index) => `line ${index + 1} ${wideTail}`).join('\n');
  await loadTextComparison(page, {
    fileName: 'scroll-alpha.txt', baseContent: content, mineContent: `${content}\nalpha added`,
    layout: 'unified', collapseCtx: false,
  });
  const scroller = page.locator('.overflow-y-auto.overflow-x-auto').first();
  await expect(scroller).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await scroller.evaluate((element) => { element.scrollTop = 650; element.scrollLeft = 180; });
  await expect.poll(() => scroller.evaluate((element) => [element.scrollTop, element.scrollLeft])).toEqual([650, 180]);
  // Allow the scroll snapshot's animation frame to complete before loading the next file.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  await loadTextComparison(page, {
    fileName: 'scroll-beta.txt', baseContent: content, mineContent: `${content}\nbeta added`,
    layout: 'unified', collapseCtx: false,
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await scroller.evaluate((element) => { element.scrollTop = 1250; element.scrollLeft = 320; });
  await expect.poll(() => scroller.evaluate((element) => [element.scrollTop, element.scrollLeft])).toEqual([1250, 320]);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  await selectComparison(page, 'scroll-alpha.txt');
  await expect.poll(() => scroller.evaluate((element) => [element.scrollTop, element.scrollLeft])).toEqual([650, 180]);
  await selectComparison(page, 'scroll-beta.txt');
  await expect.poll(() => scroller.evaluate((element) => [element.scrollTop, element.scrollLeft])).toEqual([1250, 320]);
});

test('workbook sheet selection survives visiting another comparison', async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
      fileName: 'budget.xlsx', layout: 'split-h', collapseCtx: false,
      baseContent: '@@sheet\tSummary\n@@row\t1\tID\tValue\n@@row\t2\t1\tBefore summary\n@@sheet\tDetails\n@@row\t1\tID\tValue\n@@row\t2\t1\tBefore details',
      mineContent: '@@sheet\tSummary\n@@row\t1\tID\tValue\n@@row\t2\t1\tAfter summary\n@@sheet\tDetails\n@@row\t1\tID\tValue\n@@row\t2\t1\tAfter details',
    });
  });
  const detailsSheet = page.getByTestId('workbook-sheet-tab').filter({ hasText: 'Details' });
  await detailsSheet.click();
  await expect(detailsSheet).toHaveAttribute('aria-current', 'page');
  const bodyCanvas = page.locator('[data-testid="workbook-pane-canvas-base"]:not([data-workbook-header-row-canvas="true"])');
  await bodyCanvas.click({ position: { x: 260, y: 12 } });
  await expect(page.getByTestId('formula-value-field')).toContainText('Before details');
  await loadTextComparison(page, { ...textFixture('notes.txt', 'Notes'), layout: 'unified' });
  await expect(page.getByTestId('workbook-sheet-tabs')).toHaveCount(0);
  await selectComparison(page, 'budget.xlsx');
  await expect(detailsSheet).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('toolbar-layout-split-h')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('formula-value-field')).toContainText('Before details');
});

test('consecutive native XLSM artifacts restore their loaded content across tabs and home', async ({ page }) => {
  await page.addInitScript(() => {
    const queue: DiffData[] = [];
    const markers = new Map<string, string>();
    const descriptors = new Map<string, WorkbookArtifactDescriptor>();
    let listener: (() => void) | null = null;
    const bridge = window.versora!;
    window.__comparisonWorkbookHarness = {
      requestedSessions: [], releasedSessions: [],
      enqueue(fileName, marker) {
        const comparisonSessionId = `native-${marker}`;
        const artifactId = `artifact-${marker}`;
        const metadata = { sheets: { Sheet1: { name: 'Sheet1', rowCount: 2, maxColumns: 1, hiddenColumns: [], mergeRanges: [] } } };
        const descriptor: WorkbookArtifactDescriptor = {
          version: 1, artifactId, comparisonSessionId, compareMode: 'strict',
          sheets: [{
            id: 0, sheetId: 0, name: 'Sheet1', hasBaseSide: true, hasMineSide: true,
            pairStart: 0, pairCount: 2, maxColumnCount: 1, baseUsedColumns: [0], mineUsedColumns: [0],
            baseRowCount: 2, mineRowCount: 2, baseCellCount: 2, mineCellCount: 2,
            equalRows: 1, addedRows: 0, deletedRows: 0, modifiedRows: 1, changedCellCount: 1, changedColumns: [0],
          }],
          rows: {
            sheetIds: new Uint32Array([0, 0]), baseOrdinals: new Uint32Array([0, 1]), mineOrdinals: new Uint32Array([0, 1]),
            baseRowNumbers: new Uint32Array([1, 2]), mineRowNumbers: new Uint32Array([1, 2]),
            kinds: new Uint8Array([0, 3]), toneMasks: new Uint8Array([0, 4]), searchBothSides: new Uint8Array([0, 0]),
            changedCellCounts: new Uint32Array([0, 1]), baseColumnCounts: new Uint32Array([1, 1]), mineColumnCounts: new Uint32Array([1, 1]),
            runOffsets: new Uint32Array([0, 0, 1]),
          },
          runs: { starts: new Uint32Array([0]), ends: new Uint32Array([1]), flags: new Uint32Array([27]), regionIds: new Uint32Array([0]) },
          regions: {
            sheetIds: new Uint32Array([0]), startRows: new Uint32Array([1]), endRows: new Uint32Array([2]),
            startColumns: new Uint32Array([0]), endColumns: new Uint32Array([1]),
            anchorRows: new Uint32Array([1]), anchorColumns: new Uint32Array([0]), changedCellCounts: new Float64Array([1]),
          },
          regionCount: 1, baseMetadata: metadata, mineMetadata: metadata,
          stats: { equalRows: 1, addedRows: 0, deletedRows: 0, modifiedRows: 1, changedCells: 1 },
          sourceCounts: { base: { rowCount: 2, cellCount: 2 }, mine: { rowCount: 2, cellCount: 2 } },
          perf: { ingestMs: 0, alignmentMs: 0, totalMs: 0 },
        };
        markers.set(artifactId, marker);
        descriptors.set(artifactId, descriptor);
        queue.push({
          comparisonSessionId, source: { kind: 'local', label: 'Local' }, sourceIdentity: fileName,
          svnUrl: '', fileName, baseName: `${marker}.base.xlsm`, mineName: `${marker}.mine.xlsm`,
          baseContent: '', mineContent: '',
          compareContext: 'literal_two_file_compare', canSwitchRevisions: false, workbookArtifact: descriptor,
        });
        listener?.();
      },
    };
    const readWindow = (request: WorkbookArtifactWindowRequest) => {
      const marker = markers.get(request.artifactId)!;
      const includesColumn = request.columnRanges.some(({ start, end }) => start <= 0 && end > 0);
      return {
        ...request,
        rows: Array.from({ length: 2 }, (_, rowIndex) => ({
          rowIndex, baseRowNumber: rowIndex + 1, mineRowNumber: rowIndex + 1,
          baseCells: includesColumn ? [{ column: 0, value: rowIndex === 0 ? 'Header' : `Before ${marker}`, formula: '' }] : [],
          mineCells: includesColumn ? [{ column: 0, value: rowIndex === 0 ? 'Header' : `After ${marker}`, formula: '' }] : [], changedColumnRuns: [],
        })).slice(request.startRow, request.startRow + request.rowCount),
        nextRow: null,
      };
    };
    window.versora = {
      ...bridge,
      getLaunchContext: async () => ({
        ...await bridge.getLaunchContext(), hasDiffRequest: queue.length > 0, pendingDiffRequestCount: queue.length,
      }),
      onCliArgsUpdated: (callback) => { listener = callback; return () => { listener = null; }; },
      getDiffData: async () => {
        const data = queue.shift();
        if (!data) throw new Error('No queued native workbook comparison.');
        window.__comparisonWorkbookHarness!.requestedSessions.push(data.comparisonSessionId!);
        return data;
      },
      getWorkbookArtifactView: async ({ artifactId, compareMode }) => ({ ...descriptors.get(artifactId)!, compareMode }),
      readWorkbookArtifactWindow: async (request) => readWindow(request),
      readWorkbookArtifactCells: async (request) => ({
        ...request,
        cells: request.cells.map(({ rowNumber, column }) => ({
          rowNumber, column, exists: rowNumber >= 1 && rowNumber <= 2 && column === 0, formula: '',
          value: rowNumber === 1 ? 'Header' : `${request.side === 'base' ? 'Before' : 'After'} ${markers.get(request.artifactId)!}`,
        })),
      }),
      releaseSessionResources: async (sessionId?: string) => {
        window.__comparisonWorkbookHarness!.releasedSessions.push(sessionId);
      },
    } as NonNullable<typeof window.versora>;
  });
  await openApp(page);
  const assertWorkbookContent = async (fileName: string, marker: string) => {
    await expect(comparisonTab(page, fileName)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => page.evaluate(() => window.__SVN_DIFF_E2E__!.getSnapshot())).toMatchObject({
      hasLoadedDiff: true, isWorkbookMode: true, fileName,
    });
    await expect(page.locator('.home-stage')).toHaveCount(0);
    await expect(page.getByTestId('diff-loading-state')).toHaveCount(0);
    const canvas = page.locator('[data-testid="workbook-pane-canvas-base"]:not([data-workbook-header-row-canvas="true"])').first();
    await expect(canvas).toBeVisible();
    await canvas.click({ position: { x: 140, y: 12 } });
    await expect(page.getByTestId('formula-address-field')).toHaveText('A2');
    await expect(page.getByTestId('formula-value-field')).toContainText(`Before ${marker}`);
  };
  // Awaiting each loaded file reproduces the native batching path without rapid clicks.
  for (const marker of ['Alpha', 'Beta']) {
    await page.evaluate((name) => window.__comparisonWorkbookHarness!.enqueue(`${name}.xlsm`, name), marker);
    await assertWorkbookContent(`${marker}.xlsm`, marker);
  }
  expect(await page.evaluate(() => window.__comparisonWorkbookHarness!.requestedSessions)).toEqual(['native-Alpha', 'native-Beta']);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const marker of ['Alpha', 'Beta']) {
      await selectComparison(page, `${marker}.xlsm`);
      await assertWorkbookContent(`${marker}.xlsm`, marker);
    }
  }
  for (const marker of ['Alpha', 'Beta']) {
    await page.getByTestId('toolbar-home').click();
    await expect(page.locator('.home-stage')).toBeVisible();
    await selectComparison(page, `${marker}.xlsm`);
    await assertWorkbookContent(`${marker}.xlsm`, marker);
  }
  expect(await page.evaluate(() => window.__comparisonWorkbookHarness!.releasedSessions)).toEqual([]);
  await page.getByRole('button', { name: 'Close comparison: Beta.xlsm', exact: true }).click();
  await expect(page.getByTestId('comparison-tab')).toHaveCount(1);
  await assertWorkbookContent('Alpha.xlsm', 'Alpha');
  await expect.poll(() => page.evaluate(() => window.__comparisonWorkbookHarness!.releasedSessions)).toEqual(['native-Beta']);
  await page.getByRole('button', { name: 'Close comparison: Alpha.xlsm', exact: true }).click();
  await expect(page.getByTestId('comparison-tab')).toHaveCount(0);
  await expect(page.locator('.home-stage')).toBeVisible();
});

test('home and new comparison keep existing files; closing the last file returns home', async ({ page }) => {
  await openApp(page);
  await loadTextComparison(page, { ...textFixture('keep-alpha.txt', 'Alpha'), layout: 'unified' });
  await loadTextComparison(page, { ...textFixture('keep-beta.txt', 'Beta'), layout: 'unified' });
  const fileTabs = page.locator('.comparison-tabs').getByRole('tab');
  const alphaTab = comparisonTab(page, 'keep-alpha.txt');
  const betaTab = comparisonTab(page, 'keep-beta.txt');
  await expect(fileTabs).toHaveText(['keep-alpha.txt', 'keep-beta.txt']);
  await expect(page.getByTestId('comparison-tab-home')).toHaveCount(0);
  await page.getByTestId('toolbar-home').click();
  await expect(page.locator('.home-stage')).toBeVisible();
  await expect(page.getByTestId('comparison-tab')).toHaveCount(2);
  await expect(alphaTab).toHaveAttribute('aria-selected', 'false');
  await expect(betaTab).toHaveAttribute('aria-selected', 'false');
  await expect(alphaTab).toHaveAttribute('tabindex', '0');
  await expect(betaTab).toHaveAttribute('tabindex', '-1');

  await alphaTab.focus();
  await alphaTab.press('ArrowLeft');
  await expect(betaTab).toHaveAttribute('aria-selected', 'true');
  await expect(betaTab).toBeFocused();
  await betaTab.press('ArrowRight');
  await expect(alphaTab).toHaveAttribute('aria-selected', 'true');
  await expect(alphaTab).toBeFocused();
  await alphaTab.press('End');
  await expect(betaTab).toHaveAttribute('aria-selected', 'true');
  await expect(betaTab).toBeFocused();
  await betaTab.press('Home');
  await expect(alphaTab).toHaveAttribute('aria-selected', 'true');
  await expect(alphaTab).toBeFocused();
  await page.getByTestId('toolbar-home').click();
  await expect(page.locator('.home-stage')).toBeVisible();
  await expect(alphaTab).toHaveAttribute('aria-selected', 'false');
  await expect(betaTab).toHaveAttribute('aria-selected', 'false');
  await selectComparison(page, 'keep-alpha.txt');
  await page.getByRole('button', { name: 'Close comparison: keep-beta.txt', exact: true }).click();
  await expect(page.getByTestId('comparison-tab')).toHaveCount(1);
  await expect(comparisonTab(page, 'keep-alpha.txt')).toHaveAttribute('aria-selected', 'true');

  await loadTextComparison(page, { ...textFixture('keep-gamma.txt', 'Gamma'), layout: 'unified' });
  await page.getByRole('button', { name: 'Close comparison: keep-gamma.txt', exact: true }).click();
  await expect(page.getByTestId('comparison-tab')).toHaveCount(1);
  await expect(comparisonTab(page, 'keep-alpha.txt')).toHaveAttribute('aria-selected', 'true');

  await page.getByTestId('comparison-tab-new').click();
  await expect(page.locator('.home-stage')).toBeVisible();
  await expect(page.getByTestId('comparison-tab')).toHaveCount(1);
  await selectComparison(page, 'keep-alpha.txt');
  await page.getByRole('button', { name: 'Close comparison: keep-alpha.txt', exact: true }).click();
  await expect(page.getByTestId('comparison-tab')).toHaveCount(0);
  await expect(page.getByTestId('toolbar-home-brand')).toBeVisible();
  await expect(page.locator('.home-stage')).toBeVisible();
});

test('consecutive SVN requests survive a slow first comparison and stay independently accessible', async ({ page }) => {
  await page.addInitScript(() => {
    const queue: Array<{ data: DiffData; delayMs: number }> = [];
    let listener: (() => void) | null = null;
    const bridge = window.versora!;
    window.__comparisonHarness = {
      requestedSessions: [],
      releasedSessions: [],
      enqueue(data, delayMs = 0) {
        queue.push({ data, delayMs });
        listener?.();
      },
    };
    window.versora = {
      ...bridge,
      getLaunchContext: async () => ({
        ...await bridge.getLaunchContext(), hasDiffRequest: queue.length > 0, pendingDiffRequestCount: queue.length,
      }),
      onCliArgsUpdated: (callback) => { listener = callback; return () => { listener = null; }; },
      getDiffData: async () => {
        const next = queue.shift();
        if (!next) throw new Error('No queued external comparison.');
        window.__comparisonHarness!.requestedSessions.push(next.data.comparisonSessionId!);
        await new Promise((resolve) => setTimeout(resolve, next.delayMs));
        return next.data;
      },
      releaseSessionResources: async (sessionId?: string) => {
        window.__comparisonHarness!.releasedSessions.push(sessionId);
      },
    } as NonNullable<typeof window.versora>;
  });
  await openApp(page);
  await page.evaluate(() => {
    for (const [index, fileName] of ['external-alpha.txt', 'external-beta.txt', 'external-gamma.txt'].entries()) {
      window.__comparisonHarness!.enqueue({
        comparisonSessionId: `svn-comparison-${index + 1}`,
        source: { kind: 'svn', label: 'SVN' },
        sourceIdentity: `svn://repo/${fileName}`,
        svnUrl: `svn://repo/${fileName}`,
        fileName,
        baseName: `${fileName}.r10`, mineName: `${fileName}.r11`,
        compareContext: 'revision_vs_revision_compare',
        baseContent: `${fileName} before`, mineContent: `${fileName} after`,
        canSwitchRevisions: false,
        sourceNoticeCode: index === 0 ? 'unversioned-working-copy' : null,
      }, index === 0 ? 350 : 0);
    }
  });

  await expect(page.getByTestId('comparison-tab')).toHaveCount(3);
  expect(await page.evaluate(() => window.__comparisonHarness!.requestedSessions)).toEqual([
    'svn-comparison-1', 'svn-comparison-2', 'svn-comparison-3',
  ]);
  for (const fileName of ['external-alpha.txt', 'external-beta.txt', 'external-gamma.txt']) {
    await selectComparison(page, fileName);
    await expect(page.locator('[data-line-idx]')).toContainText([`${fileName} after`]);
    if (fileName === 'external-alpha.txt') {
      await page.getByRole('button', { name: 'Dismiss notice', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Dismiss notice', exact: true })).toHaveCount(0);
    }
  }
  // Visiting home must keep backend resources alive for every open comparison.
  await page.getByTestId('toolbar-home').click();
  expect(await page.evaluate(() => window.__comparisonHarness!.releasedSessions)).toEqual([]);
  await page.getByRole('button', { name: 'Close comparison: external-beta.txt', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__comparisonHarness!.releasedSessions)).toEqual(['svn-comparison-2']);
  await selectComparison(page, 'external-alpha.txt');
  await expect(page.locator('[data-line-idx]')).toContainText(['external-alpha.txt after']);
  await expect(page.getByRole('button', { name: 'Dismiss notice', exact: true })).toHaveCount(0);
});
