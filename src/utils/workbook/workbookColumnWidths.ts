import { FONT_UI } from '@/constants/typography';
import type { WorkbookArtifactProvider } from '@/utils/workbook/workbookArtifactProvider';
import { WORKBOOK_CELL_WIDTH } from '@/utils/workbook/workbookDisplay';
import { getWorkbookColumnLabel } from '@/utils/workbook/workbookSections';

export type WorkbookColumnWidthBySheet = Record<string, Record<number, number>>;

const MIN_WORKBOOK_COLUMN_WIDTH = 72;
const MAX_WORKBOOK_COLUMN_WIDTH = 420;
const AUTO_FIT_HORIZONTAL_PADDING = 24;
const TEXT_WIDTH_CACHE_BYTES = 2 * 1024 * 1024;
const TEXT_WIDTH_CACHE_ENTRIES = 8192;
const MEASUREMENT_SLICE_MS = 8;
const fontEpochs = new WeakMap<FontFaceSet, number>();

export function clampWorkbookColumnWidth(value: number): number {
  if (!Number.isFinite(value)) return WORKBOOK_CELL_WIDTH;
  return Math.max(MIN_WORKBOOK_COLUMN_WIDTH, Math.min(MAX_WORKBOOK_COLUMN_WIDTH, Math.round(value)));
}

export function getWorkbookColumnWidth(
  columnWidthBySheet: WorkbookColumnWidthBySheet,
  sheetName: string,
  column: number,
): number {
  return clampWorkbookColumnWidth(
    columnWidthBySheet[sheetName]?.[column] ?? WORKBOOK_CELL_WIDTH,
  );
}

function approximateTextWidth(text: string, fontSize: number): number {
  if (!text) return 0;
  return text.length * Math.max(6, fontSize * 0.62);
}

function normalizeCellDisplayText(value: string): string {
  return value
    .replace(/\u001F/g, ' ')
    .replace(/\r\n/g, ' / ')
    .replace(/\r/g, ' / ')
    .replace(/\n/g, ' / ');
}

function measurementIdentity(fontSize: number): string {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts;
  if (fonts && !fontEpochs.has(fonts)) {
    fontEpochs.set(fonts, 0);
    const changed = () => fontEpochs.set(fonts, fontEpochs.get(fonts)! + 1);
    fonts.addEventListener('loadingdone', changed);
    fonts.addEventListener('loadingerror', changed);
  }
  const scale = typeof window === 'undefined' ? 1 : window.visualViewport?.scale ?? 1;
  const density = typeof window === 'undefined' ? 1 : window.devicePixelRatio ?? 1;
  return `${fontSize}px ${FONT_UI}:${fonts?.status ?? 'none'}:${fonts ? fontEpochs.get(fonts) : 0}:${density}:${scale}`;
}

function createTextMeasurer(fontSize: number) {
  // A private context keeps concurrent measurements at different font sizes independent.
  const context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (context) context.font = `${fontSize}px ${FONT_UI}`;
  let widths = new Map<string, number>();
  let previousWidths = new Map<string, number>();
  let bytes = 0;
  return (value: string): number => {
    if (!value) return 0;
    const cached = widths.get(value) ?? previousWidths.get(value);
    if (cached !== undefined) return cached;
    const normalized = normalizeCellDisplayText(value);
    const width = context ? context.measureText(normalized).width : approximateTextWidth(normalized, fontSize);
    const size = 64 + value.length * 2;
    if (size <= TEXT_WIDTH_CACHE_BYTES / 2) {
      // Two bounded generations avoid a per-cell Map eviction cost on mostly unique columns.
      if (bytes + size > TEXT_WIDTH_CACHE_BYTES / 2 || widths.size >= TEXT_WIDTH_CACHE_ENTRIES / 2) {
        previousWidths = widths;
        widths = new Map();
        bytes = 0;
      }
      widths.set(value, width);
      bytes += size;
    }
    return width;
  };
}

export interface WorkbookAutoFitOptions {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

async function waitForFonts(fonts: FontFaceSet, signal?: AbortSignal): Promise<void> {
  if (!signal) { await fonts.ready; return; }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cancelled = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException('Workbook column measurement cancelled', 'AbortError'));
    signal.addEventListener('abort', cancelled, { once: true });
    void fonts.ready.then(() => resolve(), reject).finally(() => signal.removeEventListener('abort', cancelled));
  });
}

/** Share one exact source scan across selected columns; completed widths belong to the immutable artifact. */
export async function measureWorkbookAutoFitColumnWidthsAsync(
  provider: WorkbookArtifactProvider | undefined,
  sheetName: string,
  columns: number[],
  fontSize: number,
  options: WorkbookAutoFitOptions = {},
): Promise<number[]> {
  if (!provider) throw new Error('Workbook artifact is unavailable');
  const sheet = provider.descriptor.sheets.find((item) => item.name === sheetName);
  if (!sheet) throw new Error('Workbook sheet is unavailable');
  const operation = provider.beginColumnMeasurement();
  const scanSignal = options.signal ? AbortSignal.any([operation.signal, options.signal]) : operation.signal;
  const checkCurrent = () => {
    scanSignal.throwIfAborted();
    if (options.isCurrent?.() === false) throw new DOMException('Workbook column measurement is obsolete', 'AbortError');
  };
  let scheduler: MessageChannel | undefined;
  const yieldToHost = () => new Promise<void>((resolve, reject) => {
    scheduler ??= new MessageChannel();
    const cleanup = () => {
      scheduler!.port1.onmessage = null;
      scanSignal.removeEventListener('abort', cancelled);
    };
    const cancelled = () => {
      cleanup();
      reject(scanSignal.reason instanceof Error ? scanSignal.reason : new DOMException('Workbook column measurement cancelled', 'AbortError'));
    };
    scheduler.port1.onmessage = () => { cleanup(); resolve(); };
    scanSignal.addEventListener('abort', cancelled, { once: true });
    scheduler.port2.postMessage(null);
  });
  // Font loading and zoom changes invalidate completed measurements, including changes during a scan.
  try {
    for (;;) {
      checkCurrent();
      if (typeof document !== 'undefined' && document.fonts?.status === 'loading') await waitForFonts(document.fonts, scanSignal);
      checkCurrent();
      const identity = measurementIdentity(fontSize);
      const measured = new Map<number, number>();
      const maxima = new Map<number, number>();
      for (const column of columns) {
        const cached = provider.getMeasuredColumnWidth(sheet.id, column, identity);
        if (cached !== undefined) measured.set(column, cached);
        else maxima.set(column, 0);
      }
      if (!maxima.size) return columns.map((column) => measured.get(column)!);
      const measure = createTextMeasurer(fontSize);
      for (const column of maxima.keys()) maxima.set(column, measure(getWorkbookColumnLabel(column)));
      const include = (column: number, value: string) => {
        const maximum = maxima.get(column);
        if (maximum === undefined) return;
        const width = Math.max(maximum, measure(value));
        if (width + AUTO_FIT_HORIZONTAL_PADDING >= MAX_WORKBOOK_COLUMN_WIDTH) {
          measured.set(column, MAX_WORKBOOK_COLUMN_WIDTH);
          maxima.delete(column);
        } else maxima.set(column, width);
      };
      let yieldedAt = performance.now();
      const yieldIfNeeded = async () => {
        if (performance.now() - yieldedAt < MEASUREMENT_SLICE_MS) return;
        await yieldToHost();
        checkCurrent();
        yieldedAt = performance.now();
      };
      let cursor = 0;
      while (cursor < sheet.pairCount && maxima.size) {
        checkCurrent();
        const page = await provider.readSourceRows({
          artifactId: provider.descriptor.artifactId, compareMode: provider.descriptor.compareMode,
          sheetId: sheet.id, startRow: cursor, rowCount: Math.min(256, sheet.pairCount - cursor), columns: [...maxima.keys()],
        }, scanSignal);
        checkCurrent();
        for (const row of page.rows) {
          for (const cell of row.baseCells) include(cell.column, cell.value);
          for (const cell of row.mineCells) include(cell.column, cell.value);
          await yieldIfNeeded();
        }
        const next = page.nextRow;
        if (next == null || !maxima.size) break;
        if (next <= cursor) throw new Error('Workbook column scan did not advance');
        cursor = next;
      }
      checkCurrent();
      if (identity !== measurementIdentity(fontSize)) continue;
      for (const [column, width] of maxima) measured.set(column, clampWorkbookColumnWidth(width + AUTO_FIT_HORIZONTAL_PADDING));
      provider.cacheMeasuredColumnWidths(sheet.id, identity, measured);
      return columns.map((column) => measured.get(column)!);
    }
  } finally {
    scheduler?.port1.close();
    scheduler?.port2.close();
    operation.complete();
  }
}
