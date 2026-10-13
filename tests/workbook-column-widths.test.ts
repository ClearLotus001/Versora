import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import useWorkbookColumnAutoFit from '../src/hooks/workbook/useWorkbookColumnAutoFit';
import { createWorkbookArtifactFixture } from '../src/utils/app/workbookArtifactFixture';
import { WorkbookArtifactProvider, registerWorkbookArtifactFixture, type WorkbookArtifactIO } from '../src/utils/workbook/workbookArtifactProvider';
import { measureWorkbookAutoFitColumnWidthsAsync } from '../src/utils/workbook/workbookColumnWidths';
import type { WorkbookArtifactSourceRowsRequest } from '../shared/workbookArtifactProtocol';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
const originalMessageChannel = Object.getOwnPropertyDescriptor(globalThis, 'MessageChannel');
test.afterEach(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalPerformance) Object.defineProperty(globalThis, 'performance', originalPerformance);
  if (originalMessageChannel) Object.defineProperty(globalThis, 'MessageChannel', originalMessageChannel);
});

function canvasHarness() {
  const measurements: string[] = [];
  const fonts = Object.assign(new EventTarget(), { status: 'loaded', ready: Promise.resolve() });
  const viewport = { scale: 1 };
  const browser = { devicePixelRatio: 1, visualViewport: viewport };
  let fontWrites = 0;
  let widthFactor = 1;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    fonts,
    createElement: () => ({ getContext: () => {
      let font = '';
      return {
        set font(value: string) { font = value; fontWrites += 1; },
        measureText: (text: string) => {
          measurements.push(text);
          return { width: [...text].reduce((sum, char) => sum + (char === 'W' ? 10 : char === '中' ? 11 : char === 'i' ? 2 : 7), 0) * parseFloat(font) / 12 * widthFactor };
        },
      };
    } }),
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  return { measurements, fonts, browser, get fontWrites() { return fontWrites; }, setWidthFactor: (factor: number) => { widthFactor = factor; } };
}

function sourceHarness(base: string[][], mine = base, pageRows = 256, beforeRead?: (request: WorkbookArtifactSourceRowsRequest) => Promise<void> | void) {
  const descriptor = createWorkbookArtifactFixture('@@sheet\tSheet\n@@row\t1\tfirst\tsecond', '@@sheet\tSheet\n@@row\t1\tfirst\tsecond');
  descriptor.sheets[0]!.pairCount = Math.max(base.length, mine.length);
  descriptor.sheets[0]!.maxColumnCount = [...base, ...mine].reduce((maximum, row) => Math.max(maximum, row.length), 0);
  const requests: WorkbookArtifactSourceRowsRequest[] = [];
  const adapter = {
    getWorkbookArtifactView: async () => descriptor,
    readWorkbookArtifactWindow: async () => { throw new Error('Unexpected viewport read'); },
    readWorkbookArtifactCells: async () => { throw new Error('Unexpected cell read'); },
    searchWorkbookArtifact: async () => { throw new Error('Unexpected search'); },
    cancelWorkbookArtifactSearch: async () => {},
    readWorkbookArtifactSourceRows: async (request: WorkbookArtifactSourceRowsRequest) => {
      requests.push(request);
      await beforeRead?.(request);
      const end = Math.min(descriptor.sheets[0]!.pairCount, request.startRow + Math.min(pageRows, request.rowCount));
      const cells = (source: string[][], row: number) => (request.columns ?? [0, 1]).filter((column) => source[row]?.[column] !== undefined).map((column) => ({ column, value: source[row]![column]!, formula: '' }));
      return { ...request, columnRanges: [], nextRow: end < descriptor.sheets[0]!.pairCount ? end : null,
        rows: Array.from({ length: end - request.startRow }, (_, index) => {
          const row = request.startRow + index;
          return { rowIndex: row, baseRowNumber: row + 1, mineRowNumber: row + 1,
            baseCells: cells(base, row), mineCells: cells(mine, row), changedColumnRuns: [] };
        }) };
    },
  } satisfies WorkbookArtifactIO;
  registerWorkbookArtifactFixture(descriptor.artifactId, adapter);
  const provider = new WorkbookArtifactProvider(descriptor);
  return { provider, requests };
}

test('empty artifact sheets measure their column labels exactly without source reads', async () => {
  const canvas = canvasHarness();
  const source = sourceHarness([]);
  source.provider.descriptor.sheets[0]!.maxColumnCount = 16384;
  assert.deepEqual(await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0, 16383], 48), [72, 108]);
  assert.equal(source.requests.length, 0);
  assert.deepEqual(canvas.measurements, ['A', 'XFD']);
  assert.deepEqual(await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [16383, 0], 48), [108, 72]);
  assert.equal(canvas.fontWrites, 1);
});

test('missing artifacts and sheet identities report an error without entering a source scan', async () => {
  const canvas = canvasHarness();
  const source = sourceHarness([['W']]);
  await assert.rejects(measureWorkbookAutoFitColumnWidthsAsync(undefined, 'Sheet', [0], 12), /Workbook artifact is unavailable/);
  await assert.rejects(measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Missing', [0], 12), /Workbook sheet is unavailable/);
  assert.equal(source.requests.length, 0);
  assert.equal(canvas.fontWrites, 0);
});

test('an already closed artifact cancels measurement before fonts or source IO', async () => {
  const canvas = canvasHarness();
  const source = sourceHarness([['W']]);
  source.provider.dispose();
  await assert.rejects(measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12), { name: 'AbortError' });
  assert.equal(source.requests.length, 0);
  assert.equal(canvas.fontWrites, 0);
});

test('multi-column auto-fit shares a complete scan and includes a late maximum on either side', async () => {
  const canvas = canvasHarness();
  const base = Array.from({ length: 1025 }, () => ['iiii', 'same']);
  const mine = base.map((row) => [...row]);
  base[1024]![0] = 'W'.repeat(10);
  mine[1024]![1] = '中'.repeat(12);
  const source = sourceHarness(base, mine);
  assert.deepEqual(await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0, 1], 12), [124, 156]);
  assert.equal(source.requests.length, 5);
  assert.ok(source.requests.every((request) => request.columns?.join(',') === '0,1'));
  assert.equal(canvas.fontWrites, 1);
  assert.equal(canvas.measurements.filter((value) => value === 'iiii').length, 1);
  const priorReads = source.requests.length;
  assert.deepEqual(await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [1, 0], 12), [156, 124]);
  assert.equal(source.requests.length, priorReads);
});

test('auto-fit preserves display normalization and the existing clamp rules', async () => {
  const canvas = canvasHarness();
  const source = sourceHarness([['WW\u001FWW\r\nWW\rWW\nWW', 'W'.repeat(100)]]);
  assert.deepEqual(await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0, 1], 12), [194, 420]);
  assert.ok(canvas.measurements.includes('WW WW / WW / WW / WW'));
});

test('a saturated column stops contributing IO while other columns scan their remaining rows', async () => {
  canvasHarness();
  const source = sourceHarness([['W'.repeat(100), 'i'], ['W', 'i'], ['W', 'W'.repeat(20)]], undefined, 1);
  assert.deepEqual(await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0, 1], 12), [420, 224]);
  assert.deepEqual(source.requests.map((request) => request.columns), [[0, 1], [1], [1]]);
});

test('600 selected columns retain all 300 unsaturated interleaved columns on later pages', async () => {
  canvasHarness();
  const first = Array.from({ length: 600 }, (_, column) => column % 2 === 0 ? 'W'.repeat(100) : 'i');
  const last = Array.from({ length: 600 }, (_, column) => column % 2 === 0 ? 'i' : 'W'.repeat(10 + column % 3));
  const source = sourceHarness([first, last], undefined, 1);
  const columns = Array.from({ length: 600 }, (_, column) => column);
  const widths = await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', columns, 12);
  assert.deepEqual(widths, columns.map((column) => column % 2 === 0 ? 420 : 124 + column % 3 * 10));
  assert.equal(source.requests.length, 2);
  assert.equal(source.requests[0]!.columns!.length, 600);
  assert.deepEqual(source.requests[1]!.columns, columns.filter((column) => column % 2 === 1));
});

test('completed widths are isolated by font size, loaded font generation, density and viewport scale', async () => {
  const canvas = canvasHarness();
  const source = sourceHarness([['W'.repeat(10)]]);
  assert.deepEqual(await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12), [124]);
  assert.deepEqual(await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 18), [174]);
  canvas.setWidthFactor(2);
  canvas.fonts.dispatchEvent(new Event('loadingdone'));
  assert.deepEqual(await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12), [224]);
  canvas.browser.devicePixelRatio = 2;
  await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12);
  canvas.browser.visualViewport.scale = 1.5;
  await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12);
  assert.equal(source.requests.length, 5);
});

test('fonts that finish loading during the scan restart measurement before committing any width', async () => {
  const canvas = canvasHarness();
  let changed = false;
  const source = sourceHarness([['W'.repeat(10)], ['W'.repeat(15)]], undefined, 1, () => {
    if (changed) return;
    changed = true;
    canvas.setWidthFactor(2);
    canvas.fonts.dispatchEvent(new Event('loadingdone'));
  });
  assert.deepEqual(await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12), [324]);
  assert.deepEqual(source.requests.map((request) => request.startRow), [0, 1, 0, 1]);
  await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12);
  assert.equal(source.requests.length, 4);
});

test('cancelling a pending read returns immediately and cannot populate the completed-width cache', async () => {
  canvasHarness();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let blocked = true;
  const source = sourceHarness([['W'.repeat(10)]], undefined, 1, () => blocked ? pending : undefined);
  const controller = new AbortController();
  const task = measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12, { signal: controller.signal });
  controller.abort();
  await assert.rejects(task, { name: 'AbortError' });
  release();
  blocked = false;
  assert.deepEqual(await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12), [124]);
  assert.equal(source.requests.length, 2);
});

test('obsolete action context stops at a page boundary without reading or caching later rows', async () => {
  canvasHarness();
  let current = true;
  const source = sourceHarness([['W'], ['W'.repeat(10)]], undefined, 1, () => { current = false; });
  await assert.rejects(measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12, { isCurrent: () => current }), { name: 'AbortError' });
  assert.equal(source.requests.length, 1);
  current = true;
  assert.equal(source.provider.getMeasuredColumnWidth(0, 0, 'irrelevant'), undefined);
});

test('completed width memo stays bounded and disposing the provider releases it', () => {
  const source = sourceHarness([['i']]);
  const widths = new Map(Array.from({ length: 4100 }, (_, column) => [column, 72] as const));
  source.provider.cacheMeasuredColumnWidths(0, 'font', widths);
  assert.equal(source.provider.getMeasuredColumnWidth(0, 0, 'font'), undefined);
  assert.equal(source.provider.getMeasuredColumnWidth(0, 4, 'font'), 72);
  assert.equal(source.provider.getMeasuredColumnWidth(0, 4099, 'font'), 72);
  source.provider.dispose();
  assert.equal(source.provider.closedSignal.aborted, true);
  assert.equal(source.provider.getMeasuredColumnWidth(0, 4099, 'font'), undefined);
});

test('closing a provider cancels pending measurements even before font readiness', async () => {
  const canvas = canvasHarness();
  canvas.fonts.status = 'loading';
  canvas.fonts.ready = new Promise<void>(() => {});
  const source = sourceHarness([['W']]);
  const task = measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12);
  source.provider.dispose();
  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(source.requests.length, 0);
});

test('cancelled source reads are removed from the shared queue and never consume an IPC slot', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const source = sourceHarness([['W']], undefined, 1, () => pending);
  const request = { artifactId: source.provider.descriptor.artifactId, compareMode: 'strict' as const, sheetId: 0, startRow: 0, rowCount: 1, columns: [0] };
  const blocking = Array.from({ length: 4 }, () => source.provider.readSourceRows(request));
  const controller = new AbortController();
  const queued = source.provider.readSourceRows(request, controller.signal);
  controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(source.requests.length, 4);
  release();
  await Promise.all(blocking);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.requests.length, 4);
});

function headerHarness(source: ReturnType<typeof sourceHarness>) {
  const widths: number[] = [];
  const errors: string[] = [];
  let actions!: ReturnType<typeof useWorkbookColumnAutoFit>;
  function Subject() {
    actions = useWorkbookColumnAutoFit({
      provider: source.provider, sheet: source.provider.getSections()[0], compareMode: 'strict', fontSize: 12,
      active: true, columnWidthBySheet: {}, onColumnWidthChange: (_sheet, _column, width) => { widths.push(width); },
      onOperationError: (error) => { errors.push(error); },
    });
    return null;
  }
  renderToString(createElement(Subject));
  return { actions, widths, errors };
}

test('header manual resize cancels a pending auto-fit and preserves the manual width', async () => {
  canvasHarness();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const source = sourceHarness([['W'.repeat(10)]], undefined, 1, () => pending);
  const header = headerHarness(source);
  const task = header.actions.handleAutoFitColumn(0);
  header.actions.handleResizeColumn(0, 210);
  await task;
  release();
  assert.deepEqual(header.widths, [210]);
  assert.deepEqual(header.errors, []);
});

test('a newer header auto-fit cancels the old operation and only applies its own result', async () => {
  canvasHarness();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const source = sourceHarness([['W'.repeat(10), 'W'.repeat(20)]], undefined, 1, () => ++reads === 1 ? pending : undefined);
  const header = headerHarness(source);
  const old = header.actions.handleAutoFitColumn(0);
  const latest = header.actions.handleAutoFitColumn(1);
  await Promise.all([old, latest]);
  release();
  assert.deepEqual(header.widths, [224]);
  assert.deepEqual(header.errors, []);
});

test('header auto-fit quietly cancels when its artifact closes and reports genuine disk failures', async () => {
  canvasHarness();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const closing = sourceHarness([['W']], undefined, 1, () => pending);
  const closedHeader = headerHarness(closing);
  const task = closedHeader.actions.handleAutoFitColumn(0);
  closing.provider.dispose();
  await task;
  release();
  assert.deepEqual(closedHeader.widths, []);
  assert.deepEqual(closedHeader.errors, []);
  const failedHeader = headerHarness(sourceHarness([['W']], undefined, 1, () => { throw new Error('disk failure'); }));
  await failedHeader.actions.handleAutoFitColumn(0);
  assert.deepEqual(failedHeader.widths, []);
  assert.deepEqual(failedHeader.errors, ['disk failure']);
});

test('a header measurement supersedes a menu scan owned by the same provider', async () => {
  canvasHarness();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const source = sourceHarness([['W'.repeat(10), 'W'.repeat(20)]], undefined, 1, () => ++reads === 1 ? pending : undefined);
  const menu = measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0, 1], 12);
  const menuCancelled = assert.rejects(menu, { name: 'AbortError' });
  const header = headerHarness(source);
  await header.actions.handleAutoFitColumn(1);
  await menuCancelled;
  release();
  assert.deepEqual(header.widths, [224]);
  assert.deepEqual(header.errors, []);
});

test('the old measurement finally leaves the new owner intact for manual cancellation', async () => {
  canvasHarness();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const source = sourceHarness([['W']], undefined, 1, () => pending);
  const old = measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12);
  const oldCancelled = assert.rejects(old, { name: 'AbortError' });
  const latest = measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12);
  const latestCancelled = assert.rejects(latest, { name: 'AbortError' });
  await oldCancelled;
  source.provider.cancelColumnMeasurement();
  await latestCancelled;
  release();
});

function schedulerHarness(autoDeliver = true) {
  let time = 0;
  const channels: Array<{ closed: number; posts: number; deliver: () => void }> = [];
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => time += 10 } });
  Object.defineProperty(globalThis, 'MessageChannel', { configurable: true, value: class {
    private readonly state = { closed: 0, posts: 0, deliver: () => { this.port1.onmessage?.(); } };
    readonly port1 = { onmessage: null as (() => void) | null, close: () => { this.state.closed += 1; } };
    readonly port2 = { close: () => { this.state.closed += 1; }, postMessage: () => {
      this.state.posts += 1;
      if (autoDeliver) queueMicrotask(this.state.deliver);
    } };
    constructor() { channels.push(this.state); }
  } });
  return channels;
}

test('the measurement scheduler reuses one channel and closes both ports on success', async () => {
  canvasHarness();
  const channels = schedulerHarness();
  const source = sourceHarness([['W'], ['WW'], ['W'.repeat(10)]]);
  assert.deepEqual(await measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12), [124]);
  assert.equal(channels.length, 1);
  assert.equal(channels[0]!.posts, 3);
  assert.equal(channels[0]!.closed, 2);
});

test('cancelling while yielded closes both ports immediately and a late message cannot resume the scan', async () => {
  canvasHarness();
  const channels = schedulerHarness(false);
  const source = sourceHarness([['W'], ['W'.repeat(10)]]);
  const controller = new AbortController();
  const task = measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(channels.length, 1);
  controller.abort();
  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(channels[0]!.closed, 2);
  channels[0]!.deliver();
  assert.equal(channels[0]!.posts, 1);
});

test('disk failures after a yield still release the scheduler ports', async () => {
  canvasHarness();
  const channels = schedulerHarness();
  const source = sourceHarness([['W'], ['WW']], undefined, 1, (request) => {
    if (request.startRow === 1) throw new Error('disk failure');
  });
  await assert.rejects(measureWorkbookAutoFitColumnWidthsAsync(source.provider, 'Sheet', [0], 12), /disk failure/);
  assert.equal(channels.length, 1);
  assert.equal(channels[0]!.closed, 2);
});
