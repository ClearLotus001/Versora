import test from 'node:test';
import assert from 'node:assert/strict';

import { getThemeTokensSnapshot } from '../src/theme';
import { paintWorkbookCanvasBackdrop } from '../src/utils/workbook/workbookCanvasSurface';
import { resolveWorkbookCompareCellVisual } from '../src/utils/workbook/workbookCompareVisuals';
import { resolveWorkbookRowSurfaceBackground } from '../src/utils/workbook/workbookRowVisuals';

type Pixel = [number, number, number];

function parsePaint(color: string): { rgb: Pixel; alpha: number } {
  if (color === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
  if (color.startsWith('#')) {
    return {
      rgb: [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16)) as Pixel,
      alpha: color.length === 9 ? Number.parseInt(color.slice(7, 9), 16) / 255 : 1,
    };
  }
  const values = color.match(/[\d.]+/g)?.map(Number);
  assert.ok(values && values.length >= 3, `Unsupported test paint: ${color}`);
  return { rgb: values.slice(0, 3) as Pixel, alpha: values[3] ?? 1 };
}

function createPixelContext(width = 8, height = 2) {
  const pixels: Pixel[] = Array.from({ length: width * height }, () => [240, 20, 80]);
  let fillStyle = '#000000';
  const ctx = {
    get fillStyle() { return fillStyle; },
    set fillStyle(value: string) { fillStyle = value; },
    fillRect(left: number, top: number, rectWidth: number, rectHeight: number) {
      const { rgb, alpha } = parsePaint(fillStyle);
      for (let y = Math.max(0, top); y < Math.min(height, top + rectHeight); y += 1) {
        for (let x = Math.max(0, left); x < Math.min(width, left + rectWidth); x += 1) {
          const previous = pixels[(y * width) + x]!;
          pixels[(y * width) + x] = previous.map((channel, index) => (
            (channel * (1 - alpha)) + (rgb[index]! * alpha)
          )) as Pixel;
        }
      }
    },
  } as unknown as CanvasRenderingContext2D;
  return {
    ctx,
    pixel: (x: number, y = 0) => pixels[(y * width) + x]!.map(Math.round),
  };
}

test('frozen and scrolling high-contrast differences blend a search state once over the same opaque surface', () => {
  const theme = getThemeTokensSnapshot('hc');
  const rowBackground = resolveWorkbookRowSurfaceBackground({
    theme, isGuided: false, isActiveSearch: true, isSearchMatch: true,
  });
  const frozen = { left: 0, top: 0, width: 4, height: 2 };
  const scrolling = { left: 4, top: 0, width: 4, height: 2 };

  for (const kind of ['add', 'delete', 'modify'] as const) {
    const { ctx, pixel } = createPixelContext();
    // Simulate a surface already painted by row chrome before the cell layers.
    ctx.fillStyle = theme.workbookCanvasBg;
    ctx.fillRect(0, 0, 8, 2);
    ctx.fillStyle = rowBackground;
    ctx.fillRect(0, 0, 8, 2);
    paintWorkbookCanvasBackdrop(ctx, frozen, theme.workbookCanvasBg, rowBackground);
    paintWorkbookCanvasBackdrop(ctx, scrolling, theme.workbookCanvasBg, rowBackground);
    const visual = resolveWorkbookCompareCellVisual({
      theme,
      compareCell: {
        column: 0, changed: true, masked: false, kind,
        baseCell: { value: kind === 'add' ? '' : 'before', formula: '' },
        mineCell: { value: kind === 'delete' ? '' : 'after', formula: '' },
      },
      side: 'mine', hasEntry: true, hasContent: true,
      hasBaseRow: true, hasMineRow: true, defaultTextColor: theme.t0,
    });
    ctx.fillStyle = visual.background;
    ctx.fillRect(0, 0, 8, 2);

    assert.deepEqual(pixel(1), [0, 97, 97], `${kind} frozen background must retain one search overlay`);
    assert.deepEqual(pixel(5), pixel(1), `${kind} differs across the freeze boundary`);
  }
});

test('repainting a scrolling viewport keeps its state color stable and preserves frozen selection pixels', () => {
  for (const themeId of ['light', 'dark', 'hc'] as const) {
    const theme = getThemeTokensSnapshot(themeId);
    const { ctx, pixel } = createPixelContext();
    const scrolling = { left: 4, top: 0, width: 4, height: 2 };
    const rowBackground = resolveWorkbookRowSurfaceBackground({
      theme, isGuided: false, isActiveSearch: false, isSearchMatch: true,
    });
    ctx.fillStyle = theme.versionBase;
    ctx.fillRect(0, 0, 4, 2);
    const frozenSelection = pixel(1);

    paintWorkbookCanvasBackdrop(ctx, scrolling, theme.workbookCanvasBg, rowBackground);
    const firstDraw = pixel(5);
    for (let repaint = 0; repaint < 3; repaint += 1) {
      paintWorkbookCanvasBackdrop(ctx, scrolling, theme.workbookCanvasBg, rowBackground);
    }
    assert.deepEqual(pixel(5), firstDraw, `${themeId} scroll redraw accumulated state tint`);
    assert.deepEqual(pixel(1), frozenSelection, `${themeId} scroll redraw changed the frozen layer`);
  }
});

test('stacked row backdrops leave intervening bands and neighboring columns intact', () => {
  const theme = getThemeTokensSnapshot('dark');
  const { ctx, pixel } = createPixelContext(8, 3);
  const untouched = pixel(0, 0);
  const rowBackground = resolveWorkbookRowSurfaceBackground({
    theme, isGuided: true, isActiveSearch: false, isSearchMatch: false,
  });
  paintWorkbookCanvasBackdrop(
    ctx, { left: 2, top: 1, width: 4, height: 1 }, theme.workbookCanvasBg, rowBackground,
  );

  assert.notDeepEqual(pixel(3, 1), untouched);
  assert.deepEqual(pixel(3, 0), untouched);
  assert.deepEqual(pixel(3, 2), untouched);
  assert.deepEqual(pixel(1, 1), untouched);
  assert.deepEqual(pixel(6, 1), untouched);
});
