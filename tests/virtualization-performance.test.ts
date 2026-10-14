import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeVirtualWindow,
  doesVirtualWindowCoverViewport,
  shouldRetainVirtualWindow,
} from '../src/hooks/virtualization/useVirtual';
import {
  computeVariableRange,
  doesVariableVirtualRangeCoverViewport,
  shouldRetainVariableVirtualRange,
} from '../src/hooks/virtualization/useVariableVirtual';
import {
  buildHorizontalColumnLayoutBase,
  buildHorizontalVirtualColumnsLayout,
  computeHorizontalWindow,
  createFullHorizontalWindow,
  doesHorizontalWindowCoverViewport,
  overlayFrozenHorizontalColumnLayout,
  preparePositionedMergedColumnRanges,
  resolveStableHorizontalColumnEntries,
} from '../src/hooks/virtualization/useHorizontalVirtualColumns';

test('computeVirtualWindow keeps the rendered range stable for tiny scroll deltas', () => {
  const atTop = computeVirtualWindow(1000, 21, 600, 0, 24, 2);
  const slightScroll = computeVirtualWindow(1000, 21, 600, 1, 24, 2);

  assert.equal(atTop.startIdx, slightScroll.startIdx);
  assert.equal(atTop.visibleRowCount, slightScroll.visibleRowCount);
  assert.ok(Math.abs(atTop.endIdx - slightScroll.endIdx) <= 1);
});

test('computeVirtualWindow clamps overscrolled viewports back into the available row range', () => {
  const window = computeVirtualWindow(10, 21, 84, 9999, 0, 0);

  assert.equal(window.startIdx, 6);
  assert.equal(window.endIdx, 10);
});

test('fixed-height virtualization retains its overscan window until the viewport nears an edge', () => {
  const count = 10_000;
  const rowHeight = 24;
  const viewportHeight = 600;
  const initial = computeVirtualWindow(count, rowHeight, viewportHeight, 0, 12, 1.5);

  assert.equal(shouldRetainVirtualWindow(
    initial,
    count,
    rowHeight,
    viewportHeight,
    rowHeight * 10,
    12,
    1.5,
  ), true);
  assert.equal(shouldRetainVirtualWindow(
    initial,
    count,
    rowHeight,
    viewportHeight,
    rowHeight * 20,
    12,
    1.5,
  ), false);
});

test('fixed-height virtualization detects fast jumps outside the prepared window', () => {
  const current = computeVirtualWindow(10_000, 24, 600, 0, 12, 1.5);

  assert.equal(doesVirtualWindowCoverViewport(current, 10_000, 24, 600, 240), true);
  assert.equal(doesVirtualWindowCoverViewport(current, 10_000, 24, 600, 24_000), false);
});

test('fixed-height virtualization avoids rebuilding the window for every scrolled row', () => {
  const count = 10_000;
  const rowHeight = 24;
  const viewportHeight = 600;
  let current = computeVirtualWindow(count, rowHeight, viewportHeight, 0, 12, 1.5);
  let updates = 1;

  for (let row = 1; row <= 80; row += 1) {
    const scrollTop = row * rowHeight;
    if (!shouldRetainVirtualWindow(current, count, rowHeight, viewportHeight, scrollTop, 12, 1.5)) {
      current = computeVirtualWindow(count, rowHeight, viewportHeight, scrollTop, 12, 1.5);
      updates += 1;
    }

    const visibleStart = Math.floor(scrollTop / rowHeight);
    const visibleEnd = Math.ceil((scrollTop + viewportHeight) / rowHeight);
    assert.ok(current.startIdx <= visibleStart);
    assert.ok(current.endIdx >= visibleEnd);
  }

  assert.ok(updates <= 6, `expected at most 6 window updates, got ${updates}`);
});

test('variable-height virtualization retains a covered range and refreshes near its guard band', () => {
  const heights = Array.from({ length: 10_000 }, (_, index) => (index % 7 === 0 ? 48 : 24));
  const prefixSums = new Array<number>(heights.length + 1).fill(0);
  heights.forEach((height, index) => {
    prefixSums[index + 1] = prefixSums[index]! + height;
  });
  const totalH = prefixSums[prefixSums.length - 1] ?? 0;
  const averageHeight = totalH / heights.length;
  const viewportHeight = 600;
  const params = {
    heightsLength: heights.length,
    prefixSums,
    totalH,
    averageHeight,
    viewH: viewportHeight,
    overscanMin: 12,
    overscanFactor: 1.5,
  };
  let current = computeVariableRange({ ...params, scrollTop: 0 });
  let updates = 1;

  assert.equal(doesVariableVirtualRangeCoverViewport(current, { ...params, scrollTop: 240 }), true);
  assert.equal(doesVariableVirtualRangeCoverViewport(current, { ...params, scrollTop: 24_000 }), false);

  for (let row = 1; row <= 80; row += 1) {
    const scrollTop = prefixSums[row] ?? 0;
    if (!shouldRetainVariableVirtualRange(current, { ...params, scrollTop })) {
      current = computeVariableRange({ ...params, scrollTop });
      updates += 1;
    }

    const visibleBottom = Math.min(totalH, scrollTop + viewportHeight);
    assert.ok((prefixSums[current.startIdx] ?? 0) <= scrollTop);
    assert.ok((prefixSums[current.endIdx] ?? totalH) >= visibleBottom);
  }

  assert.ok(updates <= 7, `expected at most 7 variable window updates, got ${updates}`);
});

test('computeHorizontalWindow expands the virtual range to fully cover merged columns', () => {
  const columns = Array.from({ length: 20 }, (_, index) => index);
  const mergedRanges = preparePositionedMergedColumnRanges(columns, [
    { startRow: 1, endRow: 1, startCol: 5, endCol: 7 },
  ]);
  const widths = Array.from({ length: 19 }, () => 148);

  const window = computeHorizontalWindow(
    widths,
    1,
    6 * 148,
    600,
    148,
    mergedRanges,
    2,
    1,
  );

  assert.ok(window.startIndex <= 4);
  assert.ok(window.endIndex >= 7);
});

test('virtual ranges reject empty initial windows and stale windows after filtering', () => {
  const oldFixedWindow = computeVirtualWindow(10_000, 24, 600, 24_000, 12, 1.5);
  assert.equal(doesVirtualWindowCoverViewport(oldFixedWindow, 3, 24, 600, 24_000), false);
  const nextFixedWindow = computeVirtualWindow(3, 24, 600, 24_000, 12, 1.5);
  assert.deepEqual([nextFixedWindow.startIdx, nextFixedWindow.endIdx, nextFixedWindow.totalH], [0, 3, 72]);
  assert.equal(doesVirtualWindowCoverViewport(nextFixedWindow, 3, 24, 600, 24_000), true);
  const prefixSums = [0, 24, 48, 96];
  const params = { heightsLength: 3, prefixSums, totalH: 96, averageHeight: 32,
    scrollTop: 24_000, viewH: 600, overscanMin: 12, overscanFactor: 1.5 };
  const initial = { startIdx: 0, endIdx: 0, offsetTop: 0, overscan: 12 };
  const oldDeepWindow = { startIdx: 900, endIdx: 980, offsetTop: 21_600, overscan: 38 };
  assert.equal(doesVariableVirtualRangeCoverViewport(initial, params), false);
  assert.equal(doesVariableVirtualRangeCoverViewport(oldDeepWindow, params), false);
  const next = computeVariableRange(params);
  assert.deepEqual([next.startIdx, next.endIdx, next.offsetTop], [0, 3, 0]);
  assert.equal(doesVariableVirtualRangeCoverViewport(next, params), true);
  assert.equal(doesVariableVirtualRangeCoverViewport(initial, {
    heightsLength: 0, prefixSums: [0], totalH: 0, scrollTop: 0, viewH: 600,
  }), true);
});

test('column windows cover current geometry before first paint and after column changes', () => {
  const empty = { startIndex: 0, endIndex: 0, visibleColumnCount: 0, overscan: 12 };
  const short = { startIndex: 0, endIndex: 1, visibleColumnCount: 1, overscan: 12 };
  const prefix = [0, 100, 280, 420];
  assert.equal(doesHorizontalWindowCoverViewport(prefix, empty, 0, 600, 100), false);
  assert.equal(doesHorizontalWindowCoverViewport(prefix, short, 0, 600, 100), false);
  const full = createFullHorizontalWindow(3);
  assert.equal(doesHorizontalWindowCoverViewport(prefix, full, 24_000, 600, 100), true);
  assert.equal(doesHorizontalWindowCoverViewport([0, 100], full, 0, 600, 100), false);
  assert.equal(doesHorizontalWindowCoverViewport([0], empty, 0, 600, 100), true);
});

test('computeHorizontalWindow uses prefix sums for variable column widths', () => {
  const window = computeHorizontalWindow(
    [80, 240, 100],
    1,
    100,
    260,
    100,
    [],
    0,
    0,
  );

  assert.equal(window.startIndex, 1);
  assert.equal(window.endIndex, 2);
  assert.equal(window.visibleColumnCount, 1);
});

test('merged-column positioning uses visible-column bounds for enormous sparse ranges', () => {
  const positioned = preparePositionedMergedColumnRanges(
    [0, 2, 5, 1_000_000_000],
    [{ startRow: 1, endRow: 1, startCol: 1, endCol: 999_999_999 }],
  );

  assert.deepEqual(positioned, [{ startPosition: 1, endPosition: 2 }]);
});

test('shared horizontal layout contains reusable width and merge metrics', () => {
  const layout = buildHorizontalVirtualColumnsLayout({
    columns: [0, 2, 5],
    cellWidth: 120,
    frozenCount: 1,
    getColumnWidth: column => column === 2 ? 180 : 120,
    mergedRanges: [{ startRow: 1, endRow: 1, startCol: 1, endCol: 4 }],
  });

  assert.deepEqual(layout.frozenPrefixSums, [0, 120]);
  assert.deepEqual(layout.nonFrozenPrefixSums, [0, 180, 300]);
  assert.equal(layout.fullFrozenWidth, 120);
  assert.equal(layout.totalNonFrozenWidth, 300);
  assert.deepEqual(layout.positionedMergedRanges, [{ startPosition: 1, endPosition: 1 }]);
});

test('createFullHorizontalWindow returns a stable all-column window for narrow workbooks', () => {
  assert.deepEqual(createFullHorizontalWindow(46), {
    startIndex: 0,
    endIndex: 46,
    visibleColumnCount: 46,
    overscan: 46,
  });
});

test('resolveStableHorizontalColumnEntries invalidates cached entries when layout identity changes', () => {
  const previousEntries = [
    { column: 0, position: 0, width: 120, displayWidth: 120, offset: 0 },
  ];
  const nextEntries = [
    { column: 0, position: 0, width: 180, displayWidth: 180, offset: 24 },
  ];
  const previousLayout = { version: 'before' };
  const nextLayout = { version: 'after' };

  const resolved = resolveStableHorizontalColumnEntries(
    {
      key: 'same-window',
      layout: previousLayout,
      entries: previousEntries,
    },
    'same-window',
    nextLayout,
    nextEntries,
  );

  assert.equal(resolved.entries, nextEntries);
  assert.equal(resolved.layout, nextLayout);
});

test('resolveStableHorizontalColumnEntries reuses cached entries for the same layout identity', () => {
  const layout = { version: 'stable' };
  const previousEntries = [
    { column: 1, position: 1, width: 96, displayWidth: 96, offset: 128 },
  ];
  const nextEntries = [
    { column: 1, position: 1, width: 144, displayWidth: 144, offset: 256 },
  ];

  const resolved = resolveStableHorizontalColumnEntries(
    {
      key: 'stable-window',
      layout,
      entries: previousEntries,
    },
    'stable-window',
    layout,
    nextEntries,
  );

  assert.equal(resolved.entries, previousEntries);
  assert.equal(resolved.layout, layout);
});

test('frozen column overlays reuse every non-frozen entry from the base layout', () => {
  const entries = Array.from({ length: 1_000 }, (_, column) => ({
    column,
    position: column,
    width: 120,
    displayWidth: 120,
    offset: column * 120,
    absoluteOffset: column * 120,
  }));
  const base = buildHorizontalColumnLayoutBase(entries, 4, 320, 480);
  const overlay = overlayFrozenHorizontalColumnLayout(base, entries.slice(0, 4), 96);

  assert.equal(overlay.size, entries.length);
  assert.equal(overlay.get(500), base.get(500));
  assert.notEqual(overlay.get(0), base.get(0));
  assert.equal(overlay.get(0)?.offset, -96);
  assert.equal(overlay.get(3)?.offset, 264);
  assert.equal(overlay.get(4)?.offset, 320);
  assert.equal([...overlay].length, entries.length);
});

test('zero frozen-column scroll reuses the complete base layout identity', () => {
  const entries = [
    { column: 0, position: 0, width: 120, displayWidth: 120, offset: 0, absoluteOffset: 0 },
    { column: 1, position: 1, width: 120, displayWidth: 120, offset: 120, absoluteOffset: 120 },
  ];
  const base = buildHorizontalColumnLayoutBase(entries, 1, 120, 120);

  assert.equal(overlayFrozenHorizontalColumnLayout(base, entries.slice(0, 1), 0), base);
});
