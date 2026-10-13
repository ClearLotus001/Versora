import { expect, test, type Locator, type Page } from '@playwright/test';
import { FONT_UI } from '../../src/constants/typography';
import { WORKBOOK_CONTENT_LEFT } from '../../src/constants/layout';
import { WORKBOOK_CELL_WIDTH, createWorkbookRowLine, createWorkbookSheetLine } from '../../src/utils/workbook/workbookDisplay';

const FONT_SIZE = 14;

async function expectResizeEdge(page: Page, header: Locator, edge: number) {
  const box = await header.boundingBox();
  expect(box).not.toBeNull();
  // The resize hit zone occupies precisely the last six CSS pixels of a column.
  const cursorAt = async (offset: number) => {
    await page.mouse.move(box!.x + edge + offset, box!.y + 12);
    return header.evaluate((element) => getComputedStyle(element).cursor);
  };
  await expect.poll(() => cursorAt(-8)).toBe('pointer');
  await expect.poll(() => cursorAt(-2)).toBe('col-resize');
  await expect.poll(() => cursorAt(2)).not.toBe('col-resize');
}

for (const layout of ['split-h', 'split-v', 'unified'] as const) {
  test(`menu batch and header double-click use complete source auto-fit in ${layout}`, async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.addInitScript((fontSize) => {
      window.localStorage.setItem('versora.locale', 'en-US');
      window.localStorage.setItem('versora.settings', JSON.stringify({ themeKey: 'light', fontSize }));
      window.versora = { getLaunchContext: () => new Promise(() => {}) } as NonNullable<typeof window.versora>;
    }, FONT_SIZE);
    await page.goto('/?__e2e=1&__perf=1');
    await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
    const base = Array.from({ length: 520 }, () => ['id', 'label', 'extra']);
    const mine = base.map((row) => [...row]);
    base[519]![0] = 'WWWW WWWW late base widest';
    mine[519]![1] = '最后一行的完整列宽验证中文数据';
    const serialize = (rows: string[][]) => [createWorkbookSheetLine('Widths'), ...rows.map((row, index) => createWorkbookRowLine(index + 1, row))].join('\n');
    await page.evaluate(async (payload) => { await window.__SVN_DIFF_E2E__!.loadWorkbookDiff(payload); }, {
      fileName: 'column-autofit.xlsx', layout, collapseCtx: false, showOnlyDifferences: false,
      baseContent: serialize(base), mineContent: serialize(mine),
    });
    await page.waitForFunction(() => {
      const snapshot = window.__SVN_DIFF_PERF__?.getSnapshot();
      return snapshot?.isWorkbookMode && snapshot.viewReadyToken > 0 && snapshot.workbookArtifact?.cache.pending === 0;
    });
    const expected = await page.evaluate(async ({ font, fontSize, texts }) => {
      await document.fonts.ready;
      const context = document.createElement('canvas').getContext('2d')!;
      context.font = `${fontSize}px ${font}`;
      return texts.map((column, index) => Math.max(72, Math.min(420, Math.round(
        Math.max(context.measureText(String.fromCharCode(65 + index)).width, ...column.map((text) => context.measureText(text).width)) + 24,
      ))));
    }, { font: FONT_UI, fontSize: FONT_SIZE, texts: [base.map((row) => row[0]!).concat(mine.map((row) => row[0]!)), base.map((row) => row[1]!).concat(mine.map((row) => row[1]!))] });
    expect(expected.every((width) => width > WORKBOOK_CELL_WIDTH && width < 420)).toBe(true);
    const factor = layout === 'split-v' ? 2 : 1;
    const header = page.locator('[data-workbook-column-header-canvas="true"]').first();
    await expect(header).toBeVisible();
    await header.click({ position: { x: WORKBOOK_CONTENT_LEFT + WORKBOOK_CELL_WIDTH * factor / 2, y: 12 } });
    await header.click({ position: { x: WORKBOOK_CONTENT_LEFT + WORKBOOK_CELL_WIDTH * factor * 1.5, y: 12 }, modifiers: ['Shift'] });
    await expect(page.getByTestId('formula-address-field')).toHaveText('A:B');
    await header.click({ position: { x: WORKBOOK_CONTENT_LEFT + WORKBOOK_CELL_WIDTH * factor * 1.5, y: 12 }, button: 'right' });
    await page.getByRole('menuitem', { name: 'Auto-fit 2 selected columns', exact: true }).click();
    await expectResizeEdge(page, header, WORKBOOK_CONTENT_LEFT + expected[0]! * factor);
    await expectResizeEdge(page, header, WORKBOOK_CONTENT_LEFT + (expected[0]! + expected[1]!) * factor);

    const manualWidth = 190;
    const box = await header.boundingBox();
    const oldEdge = WORKBOOK_CONTENT_LEFT + expected[0]! * factor - 2;
    await page.mouse.move(box!.x + oldEdge, box!.y + 12);
    await page.mouse.down();
    await page.mouse.move(box!.x + oldEdge + manualWidth - expected[0]!, box!.y + 12);
    await page.mouse.up();
    await expectResizeEdge(page, header, WORKBOOK_CONTENT_LEFT + manualWidth * factor);
    await header.dblclick({ position: { x: WORKBOOK_CONTENT_LEFT + manualWidth * factor - 2, y: 12 } });
    await expectResizeEdge(page, header, WORKBOOK_CONTENT_LEFT + expected[0]! * factor);
    await expectResizeEdge(page, header, WORKBOOK_CONTENT_LEFT + (expected[0]! + expected[1]!) * factor);
  });
}
