import { expect, test, type Page } from '@playwright/test';
import '../../src/utils/app/e2eBridge';
import '../../src/utils/app/perfBridge';
import {
  createWorkbookRowLine,
  createWorkbookSheetLine,
  WORKBOOK_CELL_WIDTH,
} from '../../src/utils/workbook/workbookDisplay';

type WorkbookLayout = 'unified' | 'split-v' | 'split-h';

interface PanePaint {
  scrollTop: number;
  scrollLeft: number;
  markers: string[];
  inkPixels: number;
}

declare global {
  interface Window {
    __workbookColumnRestorationProbe?: { read(column: number): PanePaint[] };
  }
}

const POSITIONS = [
  { layout: 'unified', scrollTop: 600, scrollLeft: 6_000 },
  { layout: 'split-v', scrollTop: 1_200, scrollLeft: 12_000 },
  { layout: 'split-h', scrollTop: 1_800, scrollLeft: 9_000 },
] as const;

function scrollerSelector(layout: WorkbookLayout) {
  return layout === 'split-h'
    ? '.overflow-auto.relative'
    : '.overflow-y-auto.overflow-x-auto.relative.min-w-0.min-h-0';
}

async function installColumnPaintProbe(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('versora.locale', 'en-US');
    localStorage.setItem('versora.settings', JSON.stringify({
      themeKey: 'light', collapseCtx: false, showOnlyDifferences: false,
      botEnabled: false, settingsSchemaVersion: 4,
    }));
    window.versora = { getLaunchContext: () => new Promise(() => {}) } as NonNullable<typeof window.versora>;

    type TextDraw = { text: string; x: number; y: number };
    const drawnText = new WeakMap<object, TextDraw[]>();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Originals receive explicit drawing contexts below.
    const { fillText: originalFillText, clearRect: originalClearRect, drawImage: originalDrawImage } = CanvasRenderingContext2D.prototype;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...args) {
      if (/^R\d+C\d+$/.test(text)) {
        const transform = this.getTransform();
        const records = drawnText.get(this.canvas) ?? [];
        records.push({ text, x: transform.a * x + transform.e, y: transform.d * y + transform.f });
        drawnText.set(this.canvas, records);
      }
      Reflect.apply(originalFillText, this, [text, x, y, ...args]);
    };
    CanvasRenderingContext2D.prototype.clearRect = function (x, y, width, height) {
      // Every repaint starts a new observed generation, including partial scroll redraws.
      drawnText.delete(this.canvas);
      originalClearRect.call(this, x, y, width, height);
    };
    CanvasRenderingContext2D.prototype.drawImage = function (
      this: CanvasRenderingContext2D,
      source: CanvasImageSource,
      ...args: number[]
    ) {
      const records = drawnText.get(source);
      if (records) drawnText.set(this.canvas, [...records]);
      Reflect.apply(originalDrawImage, this, [source, ...args]);
    };
    const originalCreateImageBitmap = window.createImageBitmap.bind(window);
    window.createImageBitmap = function (...args: unknown[]) {
      // Bitmap restores must carry the text generation captured when the bitmap was made.
      const records = drawnText.get(args[0] as object);
      const snapshot = records ? [...records] : undefined;
      const created = Reflect.apply(originalCreateImageBitmap, window, args) as Promise<ImageBitmap>;
      return created.then((bitmap) => {
        if (snapshot) drawnText.set(bitmap, snapshot);
        return bitmap;
      });
    };

    window.__workbookColumnRestorationProbe = {
      read(column) {
        const layout = window.__SVN_DIFF_PERF__?.getSnapshot().layout;
        const selector = layout === 'split-h'
          ? '.overflow-auto.relative'
          : '.overflow-y-auto.overflow-x-auto.relative.min-w-0.min-h-0';
        return [...document.querySelectorAll<HTMLElement>(selector)].map((scroller) => {
          const viewport = scroller.getBoundingClientRect();
          const markers = new Set<string>();
          let inkPixels = 0;
          for (const canvas of scroller.querySelectorAll<HTMLCanvasElement>('[data-workbook-cell-canvas="true"]')) {
            const rect = canvas.getBoundingClientRect();
            if (!canvas.width || !canvas.height || !rect.width || !rect.height) continue;
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            for (const record of drawnText.get(canvas) ?? []) {
              if (!record.text.endsWith(`C${String(column).padStart(3, '0')}`)) continue;
              const screenX = rect.left + record.x / scaleX;
              const screenY = rect.top + record.y / scaleY;
              // Inspect data text below both frozen header rows, inside the current pane.
              if (screenX < viewport.left + 90 || screenX + 90 > viewport.right
                || screenY < viewport.top + 60 || screenY > viewport.bottom - 8) continue;
              const x = Math.max(0, Math.floor(record.x));
              const y = Math.max(0, Math.floor(record.y - 14 * scaleY));
              const width = Math.min(canvas.width - x, Math.ceil(90 * scaleX));
              const height = Math.min(canvas.height - y, Math.ceil(16 * scaleY));
              if (width <= 0 || height <= 0) continue;
              const pixels = canvas.getContext('2d')!.getImageData(x, y, width, height).data;
              let ink = 0;
              for (let index = 0; index < pixels.length; index += 4) {
                const luminance = pixels[index]! * 0.2126 + pixels[index + 1]! * 0.7152 + pixels[index + 2]! * 0.0722;
                if (pixels[index + 3]! > 220 && luminance < 180) ink++;
              }
              if (ink > 20) markers.add(record.text);
              inkPixels += ink;
            }
          }
          return { scrollTop: scroller.scrollTop, scrollLeft: scroller.scrollLeft, markers: [...markers].sort(), inkPixels };
        });
      },
    };
  });
}

async function waitForLayout(page: Page, layout: WorkbookLayout) {
  await page.waitForFunction((expectedLayout) => {
    const snapshot = window.__SVN_DIFF_PERF__?.getSnapshot();
    return snapshot?.layout === expectedLayout && snapshot.loadPhase === 'ready'
      && snapshot.viewReadyToken > 0 && (snapshot.workbookArtifact?.cache.windows ?? 0) > 0
      && snapshot.workbookArtifact?.cache.pending === 0;
  }, layout);
  await expect(page.locator(scrollerSelector(layout))).toHaveCount(layout === 'split-h' ? 2 : 1);
}

async function assertPositionAndPaint(
  page: Page,
  position: typeof POSITIONS[number],
) {
  const columnWidth = WORKBOOK_CELL_WIDTH * (position.layout === 'split-v' ? 2 : 1);
  const targetColumn = Math.floor(position.scrollLeft / columnWidth) + 3;
  const paneCount = position.layout === 'split-h' ? 2 : 1;
  const expectedOffsets = Array.from({ length: paneCount }, () => [position.scrollTop, position.scrollLeft]);
  await expect.poll(() => page.locator(scrollerSelector(position.layout)).evaluateAll((elements) => (
    elements.map((element) => [Math.round(element.scrollTop), Math.round(element.scrollLeft)])
  ))).toEqual(expectedOffsets);
  await page.waitForFunction(({ column, expectedPanes }) => {
    const snapshot = window.__SVN_DIFF_PERF__?.getSnapshot();
    const panes = window.__workbookColumnRestorationProbe!.read(column);
    return snapshot?.workbookArtifact?.cache.pending === 0
      && document.querySelectorAll('[data-workbook-fast-scroll-viewport]').length === 0
      && document.querySelectorAll('[data-virtual-fast-scroll-active="true"]').length === 0
      && panes.length === expectedPanes && panes.every((pane) => pane.markers.length > 0 && pane.inkPixels > 20);
  }, { column: targetColumn, expectedPanes: paneCount });
  const paints = await page.evaluate((column) => window.__workbookColumnRestorationProbe!.read(column), targetColumn);
  for (const pane of paints) {
    expect(pane.markers.length, `${position.layout}: target column ${targetColumn} is drawn inside the body`).toBeGreaterThan(0);
    expect(pane.inkPixels, `${position.layout}: target body text is painted`).toBeGreaterThan(20);
  }
  return { ...position, targetColumn, paints };
}

test('virtualized workbook columns restore deep two-axis offsets across all layouts', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installColumnPaintProbe(page);
  await page.goto('/?__e2e=1&__perf=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  const columns = Array.from({ length: 128 }, (_, index) => `Column ${index + 1}`);
  const content = [
    createWorkbookSheetLine('VirtualColumns'),
    createWorkbookRowLine(1, columns),
    ...Array.from({ length: 220 }, (_, row) => createWorkbookRowLine(row + 2, columns.map((_, column) => (
      `R${String(row + 2).padStart(3, '0')}C${String(column + 1).padStart(3, '0')}`
    )))),
  ].join('\n');
  await page.evaluate(async (workbookContent) => {
    // The bridge builds the canonical artifact fixture and exercises the real window provider.
    await window.__SVN_DIFF_E2E__!.loadWorkbookDiff({
      fileName: 'virtual-column-restoration.xlsx', layout: 'unified',
      collapseCtx: false, showOnlyDifferences: false,
      baseContent: workbookContent, mineContent: workbookContent,
    });
  }, content);

  const saved = [];
  for (const position of POSITIONS) {
    await page.getByTestId(`toolbar-layout-${position.layout}`).click();
    await waitForLayout(page, position.layout);
    const limits = await page.locator(scrollerSelector(position.layout)).evaluateAll((elements) => (
      elements.map((element) => ({ top: element.scrollHeight - element.clientHeight, left: element.scrollWidth - element.clientWidth }))
    ));
    for (const limit of limits) {
      expect(limit.top).toBeGreaterThan(position.scrollTop);
      expect(limit.left).toBeGreaterThan(position.scrollLeft);
    }
    await page.locator(scrollerSelector(position.layout)).evaluateAll((elements, offset) => {
      elements.forEach((element) => { element.scrollTop = offset.scrollTop; element.scrollLeft = offset.scrollLeft; });
    }, position);
    saved.push(await assertPositionAndPaint(page, position));
    // Scroll snapshots intentionally settle for 120 ms; finish that product debounce before switching.
    await page.waitForTimeout(160);
  }

  const restored = [];
  for (const position of POSITIONS) {
    await page.getByTestId(`toolbar-layout-${position.layout}`).click();
    await waitForLayout(page, position.layout);
    const paint = await assertPositionAndPaint(page, position);
    const original = saved.find((entry) => entry.layout === position.layout)!;
    expect(paint.paints.map((pane) => pane.markers), `${position.layout}: restored visible rows match the saved viewport`)
      .toEqual(original.paints.map((pane) => pane.markers));
    restored.push(paint);
  }
  await testInfo.attach('virtual-column-restoration', {
    body: JSON.stringify({ columnCount: columns.length, saved, restored }, null, 2),
    contentType: 'application/json',
  });
});
