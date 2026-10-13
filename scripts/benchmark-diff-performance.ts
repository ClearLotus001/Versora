import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { zipSync, strToU8 } from 'fflate';
import { _electron as electron } from 'playwright';

type LayoutMode = 'unified' | 'split-h' | 'split-v';
type WorkbookCompareMode = 'strict' | 'content';
type LoadPhase = 'bootstrapping' | 'idle' | 'loading' | 'ready' | 'error';

interface DiffPerformanceMetrics {
  source: 'cli' | 'revision-switch' | 'local-dev';
  mainLoadMs?: number;
  baseReadMs?: number;
  mineReadMs?: number;
  baseBytes?: number;
  mineBytes?: number;
  textResolveMs?: number;
  metadataMs?: number;
  diffMs?: number;
  rustDiffMs?: number;
  rendererApplyMs?: number;
  requestToCommitMs?: number;
  diffLineCount?: number;
}

interface PerfBridgeSnapshot {
  hasLoadedDiff: boolean;
  isLoadingDiff: boolean;
  loadPhase: LoadPhase;
  layout: LayoutMode;
  isWorkbookMode: boolean;
  compareMode: WorkbookCompareMode;
  fileName: string;
  activeWorkbookSheetName: string | null;
  viewReadyToken: number;
  loadPerfMetrics: DiffPerformanceMetrics | null;
  workbookArtifact?: {
    artifactId: string; sessionId: string; mode: WorkbookCompareMode;
    sheets: Array<{ id: number; name: string; displayRows: number; maxColumns: number;
      changedCells: number; baseRows: number; mineRows: number }>;
    sourceCounts: { base: { rowCount: number; cellCount: number }; mine: { rowCount: number; cellCount: number } };
    changedCells: number;
    cache: { bytes: number; windows: number; cells: number; pending: number; errors?: number };
  } | null;
}

type PerfBridgeEventName =
  | 'layout-change:start'
  | 'workbook-compare-mode:start'
  | 'diff-payload:request'
  | 'diff-payload:ready'
  | 'apply-diff-data:start'
  | 'apply-diff-data:commit'
  | 'view-ready';

interface PerfBridgeEvent {
  id: number;
  at: number;
  name: PerfBridgeEventName;
  details?: Record<string, unknown>;
}

interface TransitionBreakdown {
  bridgeTotalMs?: number;
  payloadWaitMs?: number;
  applyMs?: number;
  commitToViewReadyMs?: number;
}

interface BenchMeasurement {
  launchReadyMs: number;
  splitHReadyMs?: number;
  contentModeReadyMs?: number;
  initialLayout: LayoutMode;
  initialCompareMode: WorkbookCompareMode;
  normalizationToUnifiedMs?: number;
  normalizationToStrictMs?: number;
  initialReadyBreakdown?: TransitionBreakdown;
  normalizationToUnifiedBreakdown?: TransitionBreakdown;
  splitHBreakdown?: TransitionBreakdown;
  contentModeBreakdown?: TransitionBreakdown;
  snapshot: PerfBridgeSnapshot;
  nativeTimingEvents?: unknown[];
  launchEvents?: PerfBridgeEvent[];
  rendererLongTasks?: Array<{ at: number; durationMs: number }>;
  paintedWorkbookCanvasCount?: number;
  rendererCpuProfilePath?: string;
  workbookLayoutTransitions?: Array<{ layout: LayoutMode; readyMs: number }>;
  workbookVerification?: Record<string, unknown>;
  initialPaintBreakdown?: {
    requestToPaintMs?: number;
    commitToPaintMs?: number;
    viewReadyToPaintMs?: number;
  };
}

interface ScenarioResult {
  name: string;
  iterations: BenchMeasurement[];
}

interface SummaryMetric {
  avg: number;
  min: number;
  max: number;
}

interface WorkbookExpectation {
  physicalRows: number;
  minimumDiffLineCount: number;
  manifestPath?: string;
  sheetName?: string;
  columnCount?: number;
  nonEmptyCells?: number;
  changedCells?: number;
  lastAddress?: string;
  lastBaseValue?: string;
  lastMineValue?: string;
}

const repoRoot = path.resolve(__dirname, '..');
const rootDir = path.resolve(readOption('app-root') ?? repoRoot);
const benchmarkStartedAt = Date.now();
let failureReportSaved = false;
let workbookExpectation: WorkbookExpectation | null = null;
const rendererIndexPath = path.join(rootDir, 'dist', 'index.html');
const electronMainPath = path.join(rootDir, 'dist-electron', 'electron', 'main.js');
const electronPreloadPath = path.join(rootDir, 'dist-electron', 'electron', 'preload.js');
const rustParserName = process.platform === 'win32' ? 'svn_excel_parser.exe' : 'svn_excel_parser';
const rustParserPath = path.join(rootDir, 'rust', 'target', 'release', rustParserName);
const layoutTestIds: Record<LayoutMode, string> = {
  unified: 'toolbar-layout-unified',
  'split-h': 'toolbar-layout-split-h',
  'split-v': 'toolbar-layout-split-v',
};
const compareModeTestIds: Record<WorkbookCompareMode, string> = {
  strict: 'toolbar-compare-strict',
  content: 'toolbar-compare-content',
};

const CI_PERFORMANCE_BUDGETS = {
  'large-text': {
    launchReadyMs: 6_000,
    initialBridgeMs: 1_200,
    transitionBridgeMs: 300,
  },
  'large-workbook': {
    launchReadyMs: 4_000,
    initialBridgeMs: 1_200,
    transitionBridgeMs: 300,
  },
} as const;

function readOption(name: string): string | undefined {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function getObservationTimeoutMs(): number {
  const option = readOption('timeout-ms');
  if (option == null) return 120_000;
  const value = Number(option);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Use a positive integer for --timeout-ms.');
  return value;
}

function getReportPath(): string {
  const option = readOption('report');
  return option ? path.resolve(option) : path.join(repoRoot, 'logs', `perf-benchmark-${benchmarkStartedAt}.json`);
}

function parseNativeTimingLog(log: string): unknown[] {
  return log.split(/\r?\n/).filter(Boolean).map((line): unknown => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return { unparsedLine: line };
    }
  });
}

async function saveFailureReport(error: unknown, diagnostics: Record<string, unknown> = {}): Promise<void> {
  const reportPath = getReportPath();
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    status: 'failed',
    appRoot: rootDir,
    arguments: process.argv.slice(2),
    workbookExpectation,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    ...diagnostics,
  }, null, 2), 'utf-8');
  failureReportSaved = true;
  process.stdout.write(`\n[benchmark] failure report written: ${reportPath}\n`);
}

async function loadWorkbookExpectation(minePath: string | undefined): Promise<WorkbookExpectation | null> {
  const rowsOption = readOption('expected-workbook-rows');
  const manifestOption = readOption('expect-workbook-manifest');
  const sheetOption = readOption('expected-workbook-sheet');
  if (rowsOption == null && manifestOption == null) {
    if (sheetOption != null) throw new Error('Use --expected-workbook-sheet with expected rows or a manifest.');
    return null;
  }
  let physicalRows = rowsOption == null ? undefined : Number(rowsOption);
  let manifestFields: Partial<WorkbookExpectation> = {};
  if (manifestOption != null) {
    const manifestPath = path.resolve(manifestOption);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as {
      generator?: string;
      parameters?: { physical_rows?: number; columns?: number };
      fixtures?: Array<{
        filename?: string; physical_rows?: number; columns_in_every_row?: number;
        non_empty_cells?: number; changed_cells_vs_base?: number;
        last_cell?: string; last_row_values?: Record<string, string>;
      }>;
    };
    const fixture = manifest.fixtures?.find((entry) => entry.filename === (minePath ? path.basename(minePath) : ''));
    if (!fixture) throw new Error('Expected workbook manifest must contain the --mine filename.');
    const manifestRows = fixture.physical_rows ?? manifest.parameters?.physical_rows;
    if (physicalRows != null && physicalRows !== manifestRows) throw new Error('Expected workbook rows disagree with the manifest.');
    physicalRows = manifestRows;
    manifestFields = {
      manifestPath,
      ...(manifest.generator === 'scripts/generate-workbook-stress.py' ? { sheetName: 'Stress' } : {}),
      ...(fixture.columns_in_every_row != null ? { columnCount: fixture.columns_in_every_row } : {}),
      ...(fixture.non_empty_cells != null ? { nonEmptyCells: fixture.non_empty_cells } : {}),
      ...(fixture.changed_cells_vs_base != null ? { changedCells: fixture.changed_cells_vs_base } : {}),
      ...(fixture.last_cell != null ? { lastAddress: fixture.last_cell } : {}),
      ...(fixture.last_cell != null && fixture.last_row_values?.[fixture.last_cell] != null
        ? { lastMineValue: fixture.last_row_values[fixture.last_cell] } : {}),
      ...(manifest.generator === 'scripts/generate-workbook-stress.py' && manifestRows != null && fixture.columns_in_every_row != null
        ? { lastBaseValue: `value-${manifestRows - 1}-${fixture.columns_in_every_row - 1}` } : {}),
    };
  }
  if (physicalRows == null || !Number.isSafeInteger(physicalRows) || physicalRows <= 0) {
    throw new Error('Expected workbook physical rows must be a positive integer.');
  }
  return {
    ...manifestFields,
    physicalRows,
    minimumDiffLineCount: physicalRows + 1,
    ...(sheetOption != null ? { sheetName: sheetOption } : {}),
  };
}

// This catches empty/truncated results, but diff lines can contain both deleted
// and added rows. It is a sanity check, not proof of physical row/cell coverage.
function assertWorkbookMinimumDiffLines(snapshot: PerfBridgeSnapshot): void {
  if (!workbookExpectation) return;
  const artifact = snapshot.workbookArtifact;
  if (artifact) {
    const sheet = artifact.sheets.find((item) => item.name === (workbookExpectation?.sheetName ?? snapshot.activeWorkbookSheetName));
    if (!sheet || sheet.displayRows !== workbookExpectation.physicalRows
      || sheet.baseRows !== workbookExpectation.physicalRows || sheet.mineRows !== workbookExpectation.physicalRows) {
      throw new Error(`Workbook source/alignment row coverage mismatch: ${JSON.stringify(sheet)}.`);
    }
    if (workbookExpectation.columnCount != null && sheet.maxColumns !== workbookExpectation.columnCount) {
      throw new Error(`Workbook column coverage mismatch: expected ${workbookExpectation.columnCount}, got ${sheet.maxColumns}.`);
    }
    if (workbookExpectation.nonEmptyCells != null && (artifact.sourceCounts.base.cellCount !== workbookExpectation.nonEmptyCells
      || artifact.sourceCounts.mine.cellCount !== workbookExpectation.nonEmptyCells)) {
      throw new Error(`Workbook nonempty cell coverage mismatch: ${JSON.stringify(artifact.sourceCounts)}.`);
    }
    if (workbookExpectation.changedCells != null && artifact.changedCells !== workbookExpectation.changedCells) {
      throw new Error(`Workbook changed cell count mismatch: expected ${workbookExpectation.changedCells}, got ${artifact.changedCells}.`);
    }
    return;
  }
  if (workbookExpectation.manifestPath) throw new Error('Expected the unified native artifact pipeline; artifact descriptor is missing.');
  const actualLineCount = snapshot.loadPerfMetrics?.diffLineCount;
  if (actualLineCount == null || actualLineCount < workbookExpectation.minimumDiffLineCount) {
    throw new Error(`Workbook diff-line sanity check failed: expected at least ${workbookExpectation.minimumDiffLineCount} diff lines ` +
      `(fixture has ${workbookExpectation.physicalRows} physical rows), got ${actualLineCount ?? 'unknown'}.`);
  }
  if (workbookExpectation.sheetName != null && snapshot.activeWorkbookSheetName !== workbookExpectation.sheetName) {
    throw new Error(`Expected workbook sheet '${workbookExpectation.sheetName}', got '${snapshot.activeWorkbookSheetName ?? 'none'}'.`);
  }
}

async function verifyWorkbookArtifact(page: import('playwright').Page, snapshot: PerfBridgeSnapshot): Promise<Record<string, unknown> | undefined> {
  const expectation = workbookExpectation;
  const artifact = snapshot.workbookArtifact;
  if (!expectation || !artifact || expectation.columnCount == null) return undefined;
  const sheet = artifact.sheets.find((item) => item.name === (expectation.sheetName ?? snapshot.activeWorkbookSheetName));
  if (!sheet) throw new Error('Workbook verification sheet is missing.');
  const tail = await page.evaluate(async ({ sheetId, rowNumber, column }) => {
    const host = globalThis as unknown as { __SVN_DIFF_PERF__?: {
      readCells(request: { sheetId: number; side: 'base' | 'mine'; rowNumber: number; column: number }):
        Promise<{ value: string; formula: string; exists: boolean }>;
    } };
    if (!host.__SVN_DIFF_PERF__?.readCells) throw new Error('Workbook cell verification bridge is missing.');
    return { base: await host.__SVN_DIFF_PERF__.readCells({ sheetId, side: 'base', rowNumber, column }),
      mine: await host.__SVN_DIFF_PERF__.readCells({ sheetId, side: 'mine', rowNumber, column }) };
  }, { sheetId: sheet.id, rowNumber: expectation.physicalRows, column: expectation.columnCount - 1 });
  if (!tail.base.exists || !tail.mine.exists || tail.base.formula || tail.mine.formula
    || (expectation.lastBaseValue != null && tail.base.value !== expectation.lastBaseValue)
    || (expectation.lastMineValue != null && tail.mine.value !== expectation.lastMineValue)) {
    throw new Error(`Workbook tail cell mismatch: ${JSON.stringify(tail)}.`);
  }
  let tailSearchMs: number | undefined;
  if (process.argv.includes('--verify-workbook-interactions') && expectation.lastMineValue && expectation.lastAddress) {
    const started = performance.now();
    const differencesOnly = page.getByTestId('toolbar-diff-only');
    if (await differencesOnly.getAttribute('aria-pressed') === 'true') await differencesOnly.click();
    await page.keyboard.press('Control+f');
    await page.locator('input.searchbar-input').fill(expectation.lastMineValue);
    await page.waitForFunction(() => {
      const host = globalThis as unknown as { document: { querySelector(selector: string): {
        textContent: string | null; querySelector(selector: string): unknown;
      } | null } };
      const summary = host.document.querySelector('#search-pattern-status');
      return Boolean(summary && !summary.querySelector('.animate-spin') && /\/\s*1\s*$/.test(summary.textContent ?? ''));
    }, null, { timeout: getObservationTimeoutMs() });
    await page.locator('input.searchbar-input').press('ArrowDown');
    await page.waitForFunction(({ address, value }) => {
      const host = globalThis as unknown as { document: { querySelector(selector: string): { textContent: string | null } | null } };
      return host.document.querySelector('[data-testid="formula-address-field"]')?.textContent?.includes(address)
        && host.document.querySelector('[data-testid="formula-value-field"]')?.textContent?.includes(value);
    }, { address: expectation.lastAddress, value: expectation.lastMineValue }, { timeout: getObservationTimeoutMs() });
    tailSearchMs = performance.now() - started;
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const host = globalThis as unknown as { __SVN_DIFF_PERF__?: { getSnapshot(): PerfBridgeSnapshot } };
      const cache = host.__SVN_DIFF_PERF__?.getSnapshot().workbookArtifact?.cache;
      return Boolean(cache && cache.windows > 0 && cache.pending === 0 && !cache.errors);
    }, null, { timeout: getObservationTimeoutMs() });
    const settled = await getPerfSnapshot(page);
    const cache = settled.workbookArtifact?.cache;
    if (!cache || cache.bytes > 24 * 1024 * 1024 || cache.windows > 2048) {
      throw new Error(`Workbook cache exceeded its bounded budget: ${JSON.stringify(cache)}.`);
    }
  }
  return { descriptor: artifact, tail, ...(tailSearchMs != null ? { tailSearchMs, tailNavigation: 'passed' } : {}) };
}

async function captureDiagnostic<T>(capture: () => Promise<T>): Promise<T | { unavailable: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      capture(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Diagnostic capture timed out.')), 3_000);
      }),
    ]);
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getScenario(): 'all' | 'text' | 'workbook' {
  const scenario = readOption('scenario') ?? 'all';
  if (scenario !== 'all' && scenario !== 'text' && scenario !== 'workbook') {
    throw new Error('Use --scenario=all, text, or workbook.');
  }
  return scenario;
}

function getWorkbookProfile(): 'standard' | 'large' | 'wide' | 'dense' | 'merged' {
  const profile = readOption('workbook-profile') ?? 'standard';
  if (profile !== 'standard' && profile !== 'large' && profile !== 'wide' && profile !== 'dense' && profile !== 'merged') {
    throw new Error('Use --workbook-profile=standard, large, wide, dense, or merged.');
  }
  return profile;
}

function parseIterations(): number {
  const raw = process.argv.find((argument) => argument.startsWith('--iterations='))?.split('=')[1]
    ?? process.argv[process.argv.indexOf('--iterations') + 1]
    ?? '3';
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 3;
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function summarize(values: number[]): SummaryMetric {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    avg: total / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function summarizeOptional(values: Array<number | undefined>): SummaryMetric | undefined {
  const filtered = values.filter((value): value is number => typeof value === 'number');
  return filtered.length > 0 ? summarize(filtered) : undefined;
}

function buildWorkbookZip(sheetName: string, rows: string[][], mergeEvery = 0): Uint8Array {
  const sheetRows = rows.map((cells, rowIndex) => {
    const cellXml = cells.map((value, columnIndex) => {
      if (mergeEvery > 0 && rowIndex > 0 && (rowIndex - 1) % mergeEvery === 0 && columnIndex === 1) return '';
      const columnLabel = toColumnLabel(columnIndex + 1);
      return `<c r="${columnLabel}${rowIndex + 1}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cellXml}</row>`;
  }).join('');
  const mergeRanges = mergeEvery > 0
    ? rows.flatMap((_, index) => index > 0 && (index - 1) % mergeEvery === 0
      ? [`<mergeCell ref="A${index + 1}:B${index + 1}"/>`]
      : [])
    : [];
  const mergeXml = mergeRanges.length > 0 ? `<mergeCells count="${mergeRanges.length}">${mergeRanges.join('')}</mergeCells>` : '';

  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
        <Default Extension="xml" ContentType="application/xml" />
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" />
        <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" />
      </Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml" />
      </Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1" />
        </sheets>
      </workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml" />
      </Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <worksheet><sheetData>${sheetRows}</sheetData>${mergeXml}</worksheet>`),
  });
}

function toColumnLabel(column: number): string {
  let current = column;
  let label = '';
  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }
  return label;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;');
}

async function ensureBuiltArtifacts() {
  const candidates = [rendererIndexPath, electronMainPath, electronPreloadPath];
  if (getScenario() !== 'text') candidates.push(rustParserPath);
  const available = await Promise.all(candidates.map(async (targetPath) => ({
    targetPath,
    exists: await fileExists(targetPath),
  })));
  const missing = available
    .filter((entry) => !entry.exists)
    .map((entry) => entry.targetPath);
  if (missing.length > 0) {
    throw new Error(
      `Missing built artifacts:\n${missing.map((targetPath) => `- ${targetPath}`).join('\n')}\n` +
      'Please run "npm run build:renderer && npm run build:electron && npm run build:rust" first.',
    );
  }
}

function hasCiFlag(): boolean {
  return process.argv.includes('--ci');
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function createBenchmarkSamples(tempDir: string) {
  const textBasePath = path.join(tempDir, 'large-base.ts');
  const textMinePath = path.join(tempDir, 'large-mine.ts');
  const profile = getWorkbookProfile();
  const workbookBasePath = path.join(tempDir, `${profile}-base.xlsx`);
  const workbookMinePath = path.join(tempDir, `${profile}-mine.xlsx`);

  const textBaseLines = Array.from({ length: 24_000 }, (_, index) => (
    index % 40 === 0
      ? `export function feature_${index}(input: string) {`
      : index % 40 === 1
        ? `  return input + '-${index % 11}';`
        : index % 40 === 2
          ? '}'
          : `const value_${index} = 'line-${index % 97}';`
  ));
  const textMineLines = [...textBaseLines];
  for (let index = 300; index < textMineLines.length; index += 900) {
    textMineLines[index] = `const value_${index} = 'updated-${index % 113}';`;
    if (textMineLines[index + 1]) {
      textMineLines[index + 1] = `const derived_${index} = value_${index}.toUpperCase();`;
    }
  }
  textMineLines.splice(5_000, 0, ...Array.from({ length: 120 }, (_, index) => `const inserted_${index} = ${index};`));

  await fs.writeFile(textBasePath, textBaseLines.join('\n'), 'utf-8');
  await fs.writeFile(textMinePath, textMineLines.join('\n'), 'utf-8');

  const workbookBaseRows = buildWorkbookRows({ changed: false });
  const workbookMineRows = buildWorkbookRows({ changed: true });
  const mergeEvery = profile === 'merged' ? 12 : 0;
  await fs.writeFile(workbookBasePath, Buffer.from(buildWorkbookZip('Bench', workbookBaseRows, mergeEvery)));
  await fs.writeFile(workbookMinePath, Buffer.from(buildWorkbookZip('Bench', workbookMineRows, mergeEvery)));

  return {
    textBasePath,
    textMinePath,
    workbookBasePath,
    workbookMinePath,
  };
}

function buildWorkbookRows(options: { changed: boolean }): string[][] {
  const profile = getWorkbookProfile();
  if (profile !== 'standard') {
    const rowCount = profile === 'large' ? 20_000 : profile === 'wide' ? 5_000 : profile === 'dense' ? 600 : 4_000;
    const columnCount = profile === 'dense' || profile === 'wide' ? 200 : 12;
    const rows = [Array.from({ length: columnCount }, (_, column) => `Column-${column + 1}`)];
    for (let row = 1; row <= rowCount; row += 1) {
      rows.push(Array.from({ length: columnCount }, (_, column) => {
        const changed = options.changed && (profile === 'dense' ? column > 0 : row % 125 === 0 && column === 5);
        return column === 0 ? `ID-${row}` : `${changed ? 'updated' : 'value'}-${row}-${column}`;
      }));
    }
    return rows;
  }
  const rows: string[][] = [['ID', 'Category', 'Owner', 'Status', 'Amount', 'UpdatedAt', 'Notes', 'Flag']];
  for (let rowIndex = 1; rowIndex <= 2_200; rowIndex += 1) {
    rows.push([
      `ID-${rowIndex.toString().padStart(5, '0')}`,
      `Category-${rowIndex % 18}`,
      `Owner-${rowIndex % 23}`,
      options.changed && rowIndex % 170 === 0 ? 'In Review' : (rowIndex % 5 === 0 ? 'Closed' : 'Open'),
      String((rowIndex * 17) % 10_000),
      `2026-04-${((rowIndex % 28) + 1).toString().padStart(2, '0')}`,
      options.changed && rowIndex % 125 === 0
        ? `Updated workbook note ${rowIndex}`
        : `Workbook note ${rowIndex % 37}`,
      options.changed && rowIndex % 250 === 0 ? 'Y' : 'N',
    ]);
  }
  return rows;
}

async function writeExternalDiffRequest(
  tempDir: string,
  basePath: string,
  minePath: string,
): Promise<string> {
  const requestPath = path.join(tempDir, `external-diff-request-${Date.now()}.json`);
  await fs.writeFile(requestPath, JSON.stringify({
    version: 1,
    basePath,
    minePath,
    baseName: path.basename(basePath),
    mineName: path.basename(minePath),
    fileName: path.basename(minePath || basePath),
  }), 'utf-8');
  return requestPath;
}

async function getPerfSnapshot(page: import('playwright').Page): Promise<PerfBridgeSnapshot> {
  const snapshot = await page.evaluate<PerfBridgeSnapshot | null>(() => {
    const bridgeHost = globalThis as unknown as {
      __SVN_DIFF_PERF__?: { getSnapshot(): PerfBridgeSnapshot | null };
    };
    return bridgeHost.__SVN_DIFF_PERF__?.getSnapshot() ?? null;
  });
  if (!snapshot) {
    throw new Error('Performance bridge snapshot is unavailable.');
  }
  return snapshot as PerfBridgeSnapshot;
}

async function getPerfEvents(page: import('playwright').Page): Promise<PerfBridgeEvent[]> {
  return page.evaluate<PerfBridgeEvent[]>(() => {
    const bridgeHost = globalThis as unknown as {
      __SVN_DIFF_PERF__?: { getEvents?(): PerfBridgeEvent[] };
    };
    return bridgeHost.__SVN_DIFF_PERF__?.getEvents?.() ?? [];
  });
}

async function clearPerfEvents(page: import('playwright').Page): Promise<void> {
  await page.evaluate(() => {
    const bridgeHost = globalThis as unknown as {
      __SVN_DIFF_PERF__?: { clearEvents?(): void };
    };
    bridgeHost.__SVN_DIFF_PERF__?.clearEvents?.();
  });
}

async function getCompareMenuDiagnostics(page: import('playwright').Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const browserGlobal = globalThis as unknown as {
      document: {
        querySelectorAll(selector: string): { length: number };
        body: { innerText: string };
      };
    };
    const { document: pageDocument } = browserGlobal;
    return {
      viewMenuButtons: pageDocument.querySelectorAll('[data-testid="toolbar-view-menu"]').length,
      contentButtons: pageDocument.querySelectorAll('[data-testid="toolbar-compare-content"]').length,
      strictButtons: pageDocument.querySelectorAll('[data-testid="toolbar-compare-strict"]').length,
      bodyTextSample: pageDocument.body.innerText.slice(0, 800),
    };
  });
}

async function getPageNow(page: import('playwright').Page): Promise<number> {
  return page.evaluate(() => globalThis.performance?.now() ?? Date.now());
}

function findEvent(
  events: PerfBridgeEvent[],
  name: PerfBridgeEventName,
  predicate?: (event: PerfBridgeEvent) => boolean,
): PerfBridgeEvent | null {
  for (const event of events) {
    if (event.name !== name) continue;
    if (predicate && !predicate(event)) continue;
    return event;
  }
  return null;
}

function findEventAfter(
  events: PerfBridgeEvent[],
  name: PerfBridgeEventName,
  afterId: number,
  predicate?: (event: PerfBridgeEvent) => boolean,
): PerfBridgeEvent | null {
  return findEvent(
    events,
    name,
    (event) => event.id >= afterId && (!predicate || predicate(event)),
  );
}

function durationBetween(start: PerfBridgeEvent | null, end: PerfBridgeEvent | null): number | undefined {
  if (!start || !end) return undefined;
  return end.at - start.at;
}

function buildLaunchBreakdown(events: PerfBridgeEvent[]): TransitionBreakdown | undefined {
  const payloadRequest = findEvent(events, 'diff-payload:request', (event) => event.details?.reason === 'launch');
  const payloadReady = findEventAfter(events, 'diff-payload:ready', payloadRequest?.id ?? 0, (event) => event.details?.reason === 'launch');
  const applyStart = findEvent(events, 'apply-diff-data:start');
  const applyCommit = findEventAfter(events, 'apply-diff-data:commit', applyStart?.id ?? 0);
  const viewReady = findEventAfter(events, 'view-ready', applyCommit?.id ?? applyStart?.id ?? 0);

  const breakdown: TransitionBreakdown = {};
  const payloadWaitMs = durationBetween(payloadRequest, payloadReady);
  const applyMs = durationBetween(applyStart, applyCommit);
  const commitToViewReadyMs = durationBetween(applyCommit, viewReady);
  const bridgeTotalMs = durationBetween(applyStart, viewReady);

  if (typeof payloadWaitMs === 'number') breakdown.payloadWaitMs = payloadWaitMs;
  if (typeof applyMs === 'number') breakdown.applyMs = applyMs;
  if (typeof commitToViewReadyMs === 'number') breakdown.commitToViewReadyMs = commitToViewReadyMs;
  if (typeof bridgeTotalMs === 'number') breakdown.bridgeTotalMs = bridgeTotalMs;

  return Object.keys(breakdown).length > 0 ? breakdown : undefined;
}

function buildLayoutBreakdown(events: PerfBridgeEvent[]): TransitionBreakdown | undefined {
  const layoutStart = findEvent(events, 'layout-change:start');
  const viewReady = findEventAfter(events, 'view-ready', layoutStart?.id ?? 0);
  const bridgeTotalMs = durationBetween(layoutStart, viewReady);
  if (typeof bridgeTotalMs !== 'number') return undefined;
  return { bridgeTotalMs };
}

function buildWorkbookCompareBreakdown(events: PerfBridgeEvent[]): TransitionBreakdown | undefined {
  const compareStart = findEvent(events, 'workbook-compare-mode:start');
  const payloadRequest = findEventAfter(
    events,
    'diff-payload:request',
    compareStart?.id ?? 0,
    (event) => event.details?.reason === 'workbook-compare-mode',
  );
  const payloadReady = findEventAfter(
    events,
    'diff-payload:ready',
    payloadRequest?.id ?? compareStart?.id ?? 0,
    (event) => event.details?.reason === 'workbook-compare-mode',
  );
  const applyStart = findEventAfter(events, 'apply-diff-data:start', compareStart?.id ?? 0);
  const applyCommit = findEventAfter(events, 'apply-diff-data:commit', applyStart?.id ?? 0);
  const viewReady = findEventAfter(events, 'view-ready', applyCommit?.id ?? applyStart?.id ?? compareStart?.id ?? 0);

  const breakdown: TransitionBreakdown = {};
  const payloadWaitMs = durationBetween(payloadRequest, payloadReady);
  const applyMs = durationBetween(applyStart, applyCommit);
  const commitToViewReadyMs = durationBetween(applyCommit, viewReady);
  const bridgeTotalMs = durationBetween(compareStart, viewReady);

  if (typeof payloadWaitMs === 'number') breakdown.payloadWaitMs = payloadWaitMs;
  if (typeof applyMs === 'number') breakdown.applyMs = applyMs;
  if (typeof commitToViewReadyMs === 'number') breakdown.commitToViewReadyMs = commitToViewReadyMs;
  if (typeof bridgeTotalMs === 'number') breakdown.bridgeTotalMs = bridgeTotalMs;

  return Object.keys(breakdown).length > 0 ? breakdown : undefined;
}

async function waitForReadySnapshot(
  page: import('playwright').Page,
  minimumToken: number,
  expected: Partial<Pick<PerfBridgeSnapshot, 'layout' | 'compareMode' | 'isWorkbookMode'>>,
): Promise<PerfBridgeSnapshot> {
  await page.waitForFunction(
    ({ token, expectedSnapshot }: {
      token: number;
      expectedSnapshot: Partial<Pick<PerfBridgeSnapshot, 'layout' | 'compareMode' | 'isWorkbookMode'>>;
    }) => {
      const bridgeHost = globalThis as unknown as {
        __SVN_DIFF_PERF__?: { getSnapshot(): PerfBridgeSnapshot | null };
      };
      const snapshot = bridgeHost.__SVN_DIFF_PERF__?.getSnapshot() ?? null;
      if (!snapshot) return false;
      if (snapshot.loadPhase === 'error') throw new Error(`Diff load failed: ${JSON.stringify(snapshot)}`);
      if (!snapshot.hasLoadedDiff || snapshot.isLoadingDiff || snapshot.loadPhase !== 'ready') return false;
      if (snapshot.viewReadyToken <= token) return false;
      const cache = snapshot.workbookArtifact?.cache;
      if (cache?.errors) throw new Error(`Workbook window read failed: ${JSON.stringify(cache)}`);
      if (cache && (!cache.windows || cache.pending)) return false;

      if (typeof expectedSnapshot.isWorkbookMode === 'boolean' && snapshot.isWorkbookMode !== expectedSnapshot.isWorkbookMode) {
        throw new Error(`Unexpected diff type: ${JSON.stringify(snapshot)}`);
      }

      if (expectedSnapshot.layout && snapshot.layout !== expectedSnapshot.layout) return false;
      if (expectedSnapshot.compareMode && snapshot.compareMode !== expectedSnapshot.compareMode) return false;
      return true;
    },
    { token: minimumToken, expectedSnapshot: expected },
    { timeout: getObservationTimeoutMs() },
  );
  return getPerfSnapshot(page);
}

async function measureTransition(
  page: import('playwright').Page,
  snapshot: PerfBridgeSnapshot,
  expected: Partial<Pick<PerfBridgeSnapshot, 'layout' | 'compareMode' | 'isWorkbookMode'>>,
  action: () => Promise<void>,
): Promise<{ durationMs: number; snapshot: PerfBridgeSnapshot }> {
  const transitionStart = await getPageNow(page);
  await action();
  const readySnapshot = await waitForReadySnapshot(page, snapshot.viewReadyToken, expected);
  const transitionEnd = await getPageNow(page);
  return {
    durationMs: transitionEnd - transitionStart,
    snapshot: readySnapshot,
  };
}

async function switchLayout(
  page: import('playwright').Page,
  snapshot: PerfBridgeSnapshot,
  targetLayout: LayoutMode,
): Promise<{ durationMs: number; snapshot: PerfBridgeSnapshot }> {
  if (snapshot.layout === targetLayout) {
    return {
      durationMs: 0,
      snapshot,
    };
  }

  return measureTransition(
    page,
    snapshot,
    {
      layout: targetLayout,
      isWorkbookMode: snapshot.isWorkbookMode,
    },
    async () => {
      await page.getByTestId(layoutTestIds[targetLayout]).click();
    },
  );
}

async function switchWorkbookCompareMode(
  page: import('playwright').Page,
  snapshot: PerfBridgeSnapshot,
  targetCompareMode: WorkbookCompareMode,
): Promise<{ durationMs: number; snapshot: PerfBridgeSnapshot }> {
  if (snapshot.compareMode === targetCompareMode) {
    return {
      durationMs: 0,
      snapshot,
    };
  }

  await page.getByTestId('toolbar-view-menu').click();
  try {
    return await measureTransition(
      page,
      snapshot,
      {
        compareMode: targetCompareMode,
        isWorkbookMode: true,
      },
      async () => {
        await page.getByTestId(compareModeTestIds[targetCompareMode]).click({ timeout: 5_000 });
      },
    );
  } catch (error) {
    const currentSnapshot = await getPerfSnapshot(page).catch(() => null);
    const diagnostics = await getCompareMenuDiagnostics(page).catch(() => null);
    throw new Error(
      `Failed to open workbook compare mode '${targetCompareMode}'. ` +
      `snapshot=${JSON.stringify(currentSnapshot)} diagnostics=${JSON.stringify(diagnostics)} ` +
      `cause=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function measureLaunchAndReady(
  basePath: string,
  minePath: string,
  isWorkbookMode: boolean,
  action: (
    page: import('playwright').Page,
    snapshot: PerfBridgeSnapshot,
    launchEvents: PerfBridgeEvent[],
  ) => Promise<BenchMeasurement>,
): Promise<BenchMeasurement> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'svn-diff-bench-'));
  const requestPath = await writeExternalDiffRequest(tempDir, basePath, minePath);
  const profileDir = path.join(tempDir, 'profile');
  const launchStart = performance.now();
  const rawEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_DEV_PROFILE_DIR: profileDir,
    SVN_DIFF_PERF_BRIDGE: '1',
    SVN_DIFF_DEBUG_LOG: '1',
    SVN_DIFF_DEBUG_TIMING: '1',
    SVN_DIFF_AUTO_EXIT_AFTER_LOAD_MS: '0',
  };
  delete rawEnv.ELECTRON_RUN_AS_NODE;
  const childEnv = Object.fromEntries(
    Object.entries(rawEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

  let app: import('playwright').ElectronApplication | null = null;
  let page: import('playwright').Page | null = null;
  let phase = 'launch';
  let appStderr = '';
  let appStdout = '';
  const errors: Array<{ source: string; message: string; at: number }> = [];
  const recordError = (source: string, message: string) => {
    errors.push({ source, message, at: performance.now() - launchStart });
    if (errors.length > 200) errors.splice(0, errors.length - 200);
  };
  let rejectFatalRenderer: (error: Error) => void = () => {};
  let fatalRendererError: { message: string } | null = null;
  const fatalRendererFailure = new Promise<never>((_, reject) => { rejectFatalRenderer = reject; });
  // A fatal event may arrive between waits; retain its rejection for the next
  // race without creating an unhandled rejection in the benchmark process.
  void fatalRendererFailure.catch(() => {});
  const failRenderer = (message: string) => {
    if (fatalRendererError) return;
    fatalRendererError = { message };
    rejectFatalRenderer(new Error(message));
  };

  try {
    app = await electron.launch({
      args: [electronMainPath, `--external-diff-request=${requestPath}`],
      cwd: rootDir,
      env: childEnv,
      timeout: getObservationTimeoutMs(),
    });
    app.on('console', (message) => {
      if (message.type() === 'error') recordError('main-console', message.text());
    });
    app.process().stderr?.on('data', (chunk: Buffer) => { appStderr = (appStderr + chunk.toString()).slice(-65_536); });
    app.process().stdout?.on('data', (chunk: Buffer) => { appStdout = (appStdout + chunk.toString()).slice(-65_536); });
    app.process().on('exit', (code, signal) => recordError('app-exit', `code=${code} signal=${signal}`));
    phase = 'first-window';
    page = await app.firstWindow({ timeout: getObservationTimeoutMs() });
    page.on('pageerror', (error) => recordError('renderer-pageerror', error.stack ?? error.message));
    page.on('crash', () => {
      recordError('renderer-crash', 'Renderer process crashed.');
      failRenderer('Renderer process crashed.');
    });
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error') recordError('renderer-console', text);
      if (text.startsWith('[app-error-boundary]')) failRenderer(`Fatal React render error: ${text}`);
    });
    const cpuProfileDir = readOption('cpu-profile-dir');
    const profiler = cpuProfileDir ? await page.context().newCDPSession(page) : null;
    if (profiler) {
      await profiler.send('Profiler.enable');
      await profiler.send('Profiler.start');
    }
    phase = 'dom-content-loaded';
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: getObservationTimeoutMs() }),
      fatalRendererFailure,
    ]);
    await page.evaluate(() => {
      const host = globalThis as unknown as {
        __VERSORA_BENCH_LONG_TASKS__?: Array<{ at: number; durationMs: number }>;
        PerformanceObserver?: new (callback: (list: { getEntries(): Array<{ startTime: number; duration: number }> }) => void) => {
          observe(options: { type: string; buffered: boolean }): void;
        };
      };
      host.__VERSORA_BENCH_LONG_TASKS__ = [];
      if (host.PerformanceObserver) {
        const observer = new host.PerformanceObserver((list) => {
          const tasks = host.__VERSORA_BENCH_LONG_TASKS__!;
          for (const entry of list.getEntries()) tasks.push({ at: entry.startTime, durationMs: entry.duration });
          if (tasks.length > 200) tasks.splice(0, tasks.length - 200);
        });
        observer.observe({ type: 'longtask', buffered: true });
      }
    });
    phase = 'performance-bridge';
    await Promise.race([page.waitForFunction(() => {
      const bridgeHost = globalThis as unknown as {
        __SVN_DIFF_PERF__?: { getSnapshot(): PerfBridgeSnapshot | null };
      };
      return typeof bridgeHost.__SVN_DIFF_PERF__?.getSnapshot === 'function';
    }, null, { timeout: getObservationTimeoutMs() }), fatalRendererFailure]);

    phase = 'initial-ready';
    const initialSnapshot = await Promise.race([
      waitForReadySnapshot(page, 0, { isWorkbookMode }),
      fatalRendererFailure,
    ]);
    if (initialSnapshot.isWorkbookMode) {
      phase = 'initial-workbook-minimum-diff-lines';
      assertWorkbookMinimumDiffLines(initialSnapshot);
      phase = 'initial-canvas-paint';
      await Promise.race([page.waitForFunction(() => {
        const host = globalThis as unknown as {
          document: { querySelectorAll(selector: string): ArrayLike<{
            width: number; height: number;
            getContext(kind: string): { getImageData(x: number, y: number, width: number, height: number): { data: ArrayLike<number> } } | null;
          }> };
        };
        const canvases = host.document.querySelectorAll('[data-workbook-cell-canvas="true"]:not([data-workbook-header-row-canvas="true"])');
        for (const canvas of Array.from(canvases)) {
          if (canvas.width <= 0 || canvas.height <= 0) continue;
          const context = canvas.getContext('2d');
          const pixels = context?.getImageData(0, 0, Math.min(canvas.width, 128), Math.min(canvas.height, 128)).data;
          if (pixels) for (let index = 3; index < pixels.length; index += 4) if ((pixels[index] ?? 0) > 0) return true;
        }
        return false;
      }, null, { timeout: getObservationTimeoutMs() }), fatalRendererFailure]);
    }
    const launchEvents = await getPerfEvents(page);
    const launchReadyMs = performance.now() - launchStart;
    const rendererDiagnostics = await page.evaluate(() => {
      const host = globalThis as unknown as {
        __VERSORA_BENCH_LONG_TASKS__?: Array<{ at: number; durationMs: number }>;
        document: { querySelectorAll(selector: string): ArrayLike<unknown> };
        performance: { now(): number };
      };
      return {
        paintedAt: host.performance.now(),
        rendererLongTasks: host.__VERSORA_BENCH_LONG_TASKS__ ?? [],
        paintedWorkbookCanvasCount: host.document.querySelectorAll('[data-workbook-cell-canvas="true"]').length,
      };
    });
    const requestEvent = launchEvents.find((event) => event.name === 'diff-payload:request');
    const commitEvent = launchEvents.find((event) => event.name === 'apply-diff-data:commit');
    const readyEvent = launchEvents.find((event) => event.name === 'view-ready');
    const initialPaintBreakdown = {
      ...(requestEvent ? { requestToPaintMs: rendererDiagnostics.paintedAt - requestEvent.at } : {}),
      ...(commitEvent ? { commitToPaintMs: rendererDiagnostics.paintedAt - commitEvent.at } : {}),
      ...(readyEvent ? { viewReadyToPaintMs: rendererDiagnostics.paintedAt - readyEvent.at } : {}),
    };
    let rendererCpuProfilePath: string | undefined;
    if (profiler && cpuProfileDir) {
      const { profile } = await profiler.send('Profiler.stop');
      await fs.mkdir(cpuProfileDir, { recursive: true });
      rendererCpuProfilePath = path.resolve(cpuProfileDir, `renderer-${Date.now()}.cpuprofile`);
      await fs.writeFile(rendererCpuProfilePath, JSON.stringify(profile));
      await profiler.detach();
    }
    phase = 'scenario-validation-and-transitions';
    const measurement = await Promise.race([action(page, initialSnapshot, launchEvents), fatalRendererFailure]);
    phase = 'native-timing-log';
    const timingLog = await fs.readFile(path.join(profileDir, 'logs', 'external-diff-debug.log'), 'utf-8').catch(() => '');
    const nativeTimingEvents = parseNativeTimingLog(timingLog);
    return {
      ...measurement,
      launchReadyMs,
      nativeTimingEvents,
      launchEvents,
      rendererLongTasks: rendererDiagnostics.rendererLongTasks,
      paintedWorkbookCanvasCount: rendererDiagnostics.paintedWorkbookCanvasCount,
      initialPaintBreakdown,
      ...(rendererCpuProfilePath ? { rendererCpuProfilePath } : {}),
    };
  } catch (error) {
    const failedPage = page;
    const reportPath = getReportPath();
    const failureScreenshotPath = path.join(path.dirname(reportPath), `${path.parse(reportPath).name}.failure.png`);
    const [snapshot, perfEvents, pageDiagnostics, nativeLog, failureScreenshot] = await Promise.all([
      failedPage ? captureDiagnostic(() => getPerfSnapshot(failedPage)) : null,
      failedPage ? captureDiagnostic(() => getPerfEvents(failedPage)) : [],
      failedPage ? captureDiagnostic(() => getCompareMenuDiagnostics(failedPage)) : null,
      fs.readFile(path.join(profileDir, 'logs', 'external-diff-debug.log'), 'utf-8').catch(() => ''),
      failedPage && !failedPage.isClosed() ? captureDiagnostic(async () => {
        await fs.mkdir(path.dirname(failureScreenshotPath), { recursive: true });
        await failedPage.screenshot({ path: failureScreenshotPath, timeout: 3_000 });
        return failureScreenshotPath;
      }) : null,
    ]);
    await saveFailureReport(error, {
      phase, basePath, minePath, elapsedMs: performance.now() - launchStart,
      snapshot, perfEvents, pageDiagnostics, nativeLog,
      nativeTimingEvents: parseNativeTimingLog(nativeLog),
      appExitCode: app?.process().exitCode ?? null,
      appSignalCode: app?.process().signalCode ?? null,
      appStderr, appStdout, errors, failureScreenshot, fatalRendererError,
    });
    if (typeof failureScreenshot === 'string') process.stdout.write(`[benchmark] failure screenshot written: ${failureScreenshot}\n`);
    throw error;
  } finally {
    await app?.close().catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true }).catch((error) => {
      console.error('[benchmark] could not clean temporary app profile:', error);
    });
  }
}

async function measureTextScenario(basePath: string, minePath: string): Promise<BenchMeasurement> {
  return measureLaunchAndReady(basePath, minePath, false, async (page, initialSnapshot, launchEvents) => {
    const initialLayout = initialSnapshot.layout;
    const initialCompareMode = initialSnapshot.compareMode;
    const initialReadyBreakdown = buildLaunchBreakdown(launchEvents);

    await clearPerfEvents(page);
    const unifiedTransition = await switchLayout(page, initialSnapshot, 'unified');
    const normalizationEvents = await getPerfEvents(page);
    const normalizationToUnifiedBreakdown = buildLayoutBreakdown(normalizationEvents);

    await clearPerfEvents(page);
    const splitTransition = await switchLayout(page, unifiedTransition.snapshot, 'split-h');
    const splitEvents = await getPerfEvents(page);
    const splitHBreakdown = buildLayoutBreakdown(splitEvents);

    return {
      snapshot: splitTransition.snapshot,
      splitHReadyMs: splitTransition.durationMs,
      launchReadyMs: 0,
      initialLayout,
      initialCompareMode,
      ...(initialReadyBreakdown ? { initialReadyBreakdown } : {}),
      ...(normalizationToUnifiedBreakdown ? { normalizationToUnifiedBreakdown } : {}),
      ...(splitHBreakdown ? { splitHBreakdown } : {}),
      ...(unifiedTransition.durationMs > 0 ? { normalizationToUnifiedMs: unifiedTransition.durationMs } : {}),
    };
  });
}

async function measureWorkbookScenario(basePath: string, minePath: string): Promise<BenchMeasurement> {
  return measureLaunchAndReady(basePath, minePath, true, async (page, initialSnapshot, launchEvents) => {
    const initialLayout = initialSnapshot.layout;
    const initialCompareMode = initialSnapshot.compareMode;
    const initialReadyBreakdown = buildLaunchBreakdown(launchEvents);
    const workbookVerification = await verifyWorkbookArtifact(page, initialSnapshot);
    if (process.argv.includes('--skip-transitions')) {
      return {
        snapshot: initialSnapshot, launchReadyMs: 0, initialLayout, initialCompareMode,
        ...(workbookVerification ? { workbookVerification } : {}),
        ...(initialReadyBreakdown ? { initialReadyBreakdown } : {}),
      };
    }

    await clearPerfEvents(page);
    const strictTransition = await switchWorkbookCompareMode(page, initialSnapshot, 'strict');
    await clearPerfEvents(page);
    const contentTransition = await switchWorkbookCompareMode(page, strictTransition.snapshot, 'content');
    assertWorkbookMinimumDiffLines(contentTransition.snapshot);
    const contentEvents = await getPerfEvents(page);
    const contentModeBreakdown = buildWorkbookCompareBreakdown(contentEvents);
    let finalSnapshot = contentTransition.snapshot;
    const workbookLayoutTransitions: Array<{ layout: LayoutMode; readyMs: number }> = [];
    if (process.argv.includes('--workbook-layouts')) {
      for (const layout of ['unified', 'split-v', 'split-h'] as const) {
        const transition = await switchLayout(page, finalSnapshot, layout);
        workbookLayoutTransitions.push({ layout, readyMs: transition.durationMs });
        finalSnapshot = transition.snapshot;
      }
    }

    return {
      snapshot: finalSnapshot,
      contentModeReadyMs: contentTransition.durationMs,
      launchReadyMs: 0,
      initialLayout,
      initialCompareMode,
      ...(workbookVerification ? { workbookVerification } : {}),
      ...(initialReadyBreakdown ? { initialReadyBreakdown } : {}),
      ...(contentModeBreakdown ? { contentModeBreakdown } : {}),
      ...(strictTransition.durationMs > 0 ? { normalizationToStrictMs: strictTransition.durationMs } : {}),
      ...(workbookLayoutTransitions.length > 0 ? { workbookLayoutTransitions } : {}),
    };
  });
}

async function runScenario(
  name: string,
  iterations: number,
  run: () => Promise<BenchMeasurement>,
): Promise<ScenarioResult> {
  const measurements: BenchMeasurement[] = [];
  for (let index = 0; index < iterations; index += 1) {
    process.stdout.write(`[benchmark] ${name} (${index + 1}/${iterations})...\n`);
    measurements.push(await run());
  }
  return {
    name,
    iterations: measurements,
  };
}

function printScenarioSummary(result: ScenarioResult) {
  const launchSummary = summarize(result.iterations.map((entry) => entry.launchReadyMs));
  process.stdout.write(`\n[${result.name}] initial ready: avg ${formatMs(launchSummary.avg)} | min ${formatMs(launchSummary.min)} | max ${formatMs(launchSummary.max)}\n`);

  const startingLayouts = Array.from(new Set(result.iterations.map((entry) => entry.initialLayout)));
  process.stdout.write(`[${result.name}] initial layout(s): ${startingLayouts.join(', ')}\n`);

  const initialBridgeSummary = summarizeOptional(result.iterations.map((entry) => entry.initialReadyBreakdown?.bridgeTotalMs));
  if (initialBridgeSummary) {
    process.stdout.write(
      `[${result.name}] initial renderer ready: avg ${formatMs(initialBridgeSummary.avg)} | min ${formatMs(initialBridgeSummary.min)} | max ${formatMs(initialBridgeSummary.max)}\n`,
    );
  }

  const initialPayloadSummary = summarizeOptional(result.iterations.map((entry) => entry.initialReadyBreakdown?.payloadWaitMs));
  if (initialPayloadSummary) {
    process.stdout.write(
      `[${result.name}] initial payload wait: avg ${formatMs(initialPayloadSummary.avg)} | min ${formatMs(initialPayloadSummary.min)} | max ${formatMs(initialPayloadSummary.max)}\n`,
    );
  }

  const initialApplySummary = summarizeOptional(result.iterations.map((entry) => entry.initialReadyBreakdown?.applyMs));
  if (initialApplySummary) {
    process.stdout.write(
      `[${result.name}] initial apply commit: avg ${formatMs(initialApplySummary.avg)} | min ${formatMs(initialApplySummary.min)} | max ${formatMs(initialApplySummary.max)}\n`,
    );
  }

  const initialPaintSummary = summarizeOptional(result.iterations.map((entry) => entry.initialReadyBreakdown?.commitToViewReadyMs));
  if (initialPaintSummary) {
    process.stdout.write(
      `[${result.name}] initial commit -> view-ready: avg ${formatMs(initialPaintSummary.avg)} | min ${formatMs(initialPaintSummary.min)} | max ${formatMs(initialPaintSummary.max)}\n`,
    );
  }

  const requestToPaintSummary = summarizeOptional(result.iterations.map((entry) => entry.initialPaintBreakdown?.requestToPaintMs));
  if (requestToPaintSummary) {
    process.stdout.write(
      `[${result.name}] initial request -> painted content: avg ${formatMs(requestToPaintSummary.avg)} | min ${formatMs(requestToPaintSummary.min)} | max ${formatMs(requestToPaintSummary.max)}\n`,
    );
  }

  const splitValues = result.iterations
    .map((entry) => entry.splitHReadyMs)
    .filter((value): value is number => typeof value === 'number');
  if (splitValues.length > 0) {
    const splitSummary = summarize(splitValues);
    process.stdout.write(`[${result.name}] split-h ready: avg ${formatMs(splitSummary.avg)} | min ${formatMs(splitSummary.min)} | max ${formatMs(splitSummary.max)}\n`);
  }

  const normalizationLayoutValues = result.iterations
    .map((entry) => entry.normalizationToUnifiedMs)
    .filter((value): value is number => typeof value === 'number');
  if (normalizationLayoutValues.length > 0) {
    const normalizationLayoutSummary = summarize(normalizationLayoutValues);
    process.stdout.write(
      `[${result.name}] normalize -> unified: avg ${formatMs(normalizationLayoutSummary.avg)} | min ${formatMs(normalizationLayoutSummary.min)} | max ${formatMs(normalizationLayoutSummary.max)}\n`,
    );
  }

  const normalizationBridgeSummary = summarizeOptional(result.iterations.map((entry) => entry.normalizationToUnifiedBreakdown?.bridgeTotalMs));
  if (normalizationBridgeSummary) {
    process.stdout.write(
      `[${result.name}] normalize bridge total: avg ${formatMs(normalizationBridgeSummary.avg)} | min ${formatMs(normalizationBridgeSummary.min)} | max ${formatMs(normalizationBridgeSummary.max)}\n`,
    );
  }

  const splitBridgeSummary = summarizeOptional(result.iterations.map((entry) => entry.splitHBreakdown?.bridgeTotalMs));
  if (splitBridgeSummary) {
    process.stdout.write(
      `[${result.name}] split-h bridge total: avg ${formatMs(splitBridgeSummary.avg)} | min ${formatMs(splitBridgeSummary.min)} | max ${formatMs(splitBridgeSummary.max)}\n`,
    );
  }

  const compareValues = result.iterations
    .map((entry) => entry.contentModeReadyMs)
    .filter((value): value is number => typeof value === 'number');
  if (compareValues.length > 0) {
    const compareSummary = summarize(compareValues);
    process.stdout.write(`[${result.name}] content mode ready: avg ${formatMs(compareSummary.avg)} | min ${formatMs(compareSummary.min)} | max ${formatMs(compareSummary.max)}\n`);
  }

  const startingCompareModes = Array.from(new Set(result.iterations.map((entry) => entry.initialCompareMode)));
  process.stdout.write(`[${result.name}] initial compare mode(s): ${startingCompareModes.join(', ')}\n`);

  const normalizationCompareValues = result.iterations
    .map((entry) => entry.normalizationToStrictMs)
    .filter((value): value is number => typeof value === 'number');
  if (normalizationCompareValues.length > 0) {
    const normalizationCompareSummary = summarize(normalizationCompareValues);
    process.stdout.write(
      `[${result.name}] normalize -> strict: avg ${formatMs(normalizationCompareSummary.avg)} | min ${formatMs(normalizationCompareSummary.min)} | max ${formatMs(normalizationCompareSummary.max)}\n`,
    );
  }

  const compareBridgeSummary = summarizeOptional(result.iterations.map((entry) => entry.contentModeBreakdown?.bridgeTotalMs));
  if (compareBridgeSummary) {
    process.stdout.write(
      `[${result.name}] content bridge total: avg ${formatMs(compareBridgeSummary.avg)} | min ${formatMs(compareBridgeSummary.min)} | max ${formatMs(compareBridgeSummary.max)}\n`,
    );
  }

  const comparePayloadSummary = summarizeOptional(result.iterations.map((entry) => entry.contentModeBreakdown?.payloadWaitMs));
  if (comparePayloadSummary) {
    process.stdout.write(
      `[${result.name}] content payload wait: avg ${formatMs(comparePayloadSummary.avg)} | min ${formatMs(comparePayloadSummary.min)} | max ${formatMs(comparePayloadSummary.max)}\n`,
    );
  }

  const compareApplySummary = summarizeOptional(result.iterations.map((entry) => entry.contentModeBreakdown?.applyMs));
  if (compareApplySummary) {
    process.stdout.write(
      `[${result.name}] content apply commit: avg ${formatMs(compareApplySummary.avg)} | min ${formatMs(compareApplySummary.min)} | max ${formatMs(compareApplySummary.max)}\n`,
    );
  }

  const comparePaintSummary = summarizeOptional(result.iterations.map((entry) => entry.contentModeBreakdown?.commitToViewReadyMs));
  if (comparePaintSummary) {
    process.stdout.write(
      `[${result.name}] content commit -> view-ready: avg ${formatMs(comparePaintSummary.avg)} | min ${formatMs(comparePaintSummary.min)} | max ${formatMs(comparePaintSummary.max)}\n`,
    );
  }

  for (const layout of ['unified', 'split-v', 'split-h'] as const) {
    const values = result.iterations.flatMap((entry) => (
      entry.workbookLayoutTransitions?.filter((transition) => transition.layout === layout).map((transition) => transition.readyMs) ?? []
    ));
    if (values.length === 0) continue;
    const summary = summarize(values);
    process.stdout.write(`[${result.name}] workbook ${layout} ready: avg ${formatMs(summary.avg)} | min ${formatMs(summary.min)} | max ${formatMs(summary.max)}\n`);
  }

  const latestMetrics = result.iterations.at(-1)?.snapshot.loadPerfMetrics ?? null;
  if (latestMetrics) {
    process.stdout.write(
      `[${result.name}] latest perf: main=${formatMs(latestMetrics.mainLoadMs ?? 0)} ` +
      `diff=${formatMs(latestMetrics.diffMs ?? latestMetrics.rustDiffMs ?? 0)} ` +
      `apply=${formatMs(latestMetrics.rendererApplyMs ?? 0)} ` +
      `requestToCommit=${latestMetrics.requestToCommitMs == null ? 'n/a' : formatMs(latestMetrics.requestToCommitMs)} ` +
      `lines=${latestMetrics.diffLineCount ?? 'n/a'}\n`,
    );
  }
}

function assertCiPerformanceBudgets(results: ScenarioResult[]): void {
  const failures: string[] = [];
  results.forEach((result) => {
    const budgets = CI_PERFORMANCE_BUDGETS[result.name as keyof typeof CI_PERFORMANCE_BUDGETS];
    if (!budgets) return;
    result.iterations.forEach((measurement, index) => {
      const iteration = index + 1;
      if (measurement.launchReadyMs > budgets.launchReadyMs) {
        failures.push(`${result.name} iteration ${iteration} launch ${formatMs(measurement.launchReadyMs)} > ${formatMs(budgets.launchReadyMs)}`);
      }
      const initialBridgeMs = measurement.initialReadyBreakdown?.bridgeTotalMs;
      if (initialBridgeMs != null && initialBridgeMs > budgets.initialBridgeMs) {
        failures.push(`${result.name} iteration ${iteration} initial renderer ${formatMs(initialBridgeMs)} > ${formatMs(budgets.initialBridgeMs)}`);
      }
      const transitionBridgeMs = result.name === 'large-text'
        ? measurement.splitHBreakdown?.bridgeTotalMs
        : measurement.contentModeBreakdown?.bridgeTotalMs;
      if (transitionBridgeMs != null && transitionBridgeMs > budgets.transitionBridgeMs) {
        failures.push(`${result.name} iteration ${iteration} transition ${formatMs(transitionBridgeMs)} > ${formatMs(budgets.transitionBridgeMs)}`);
      }
    });
  });

  if (failures.length > 0) {
    throw new Error(`Performance budgets failed:\n${failures.map(failure => `- ${failure}`).join('\n')}`);
  }
  process.stdout.write('\n[benchmark] CI performance budgets passed.\n');
}

async function main() {
  getObservationTimeoutMs();
  const iterations = parseIterations();
  const scenario = getScenario();
  const externalBase = readOption('base');
  const externalMine = readOption('mine');
  if (Boolean(externalBase) !== Boolean(externalMine)) throw new Error('Provide both --base and --mine.');
  if (externalBase && scenario === 'all') throw new Error('Select --scenario=text or workbook for an existing pair.');
  workbookExpectation = await loadWorkbookExpectation(externalMine);
  if (workbookExpectation && scenario === 'text') throw new Error('Expected workbook options require a workbook scenario.');
  const fixturesOnly = process.argv.includes('--fixtures-only');
  if (fixturesOnly && externalBase) throw new Error('Use --fixtures-only without an existing --base/--mine pair.');
  if (!fixturesOnly) await ensureBuiltArtifacts();

  const sampleDir = readOption('samples-dir')
    ? path.resolve(readOption('samples-dir')!)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'svn-diff-perf-samples-'));
  await fs.mkdir(sampleDir, { recursive: true });
  try {
    const samples = externalBase && externalMine
      ? { textBasePath: externalBase, textMinePath: externalMine, workbookBasePath: externalBase, workbookMinePath: externalMine }
      : await createBenchmarkSamples(sampleDir);
    if (fixturesOnly) {
      process.stdout.write(`[benchmark] fixtures written: ${sampleDir}\n`);
      return;
    }
    const scenarioResults: ScenarioResult[] = [];
    if (scenario !== 'workbook') scenarioResults.push(await runScenario(
      'large-text', iterations,
      () => measureTextScenario(externalBase ?? samples.textBasePath, externalMine ?? samples.textMinePath),
    ));
    if (scenario !== 'text') scenarioResults.push(await runScenario(
      'large-workbook', iterations,
      () => measureWorkbookScenario(externalBase ?? samples.workbookBasePath, externalMine ?? samples.workbookMinePath),
    ));
    scenarioResults.forEach(printScenarioSummary);
    const report = {
      generatedAt: new Date().toISOString(),
      status: 'passed',
      iterations,
      appRoot: rootDir,
      workbookProfile: getWorkbookProfile(),
      workbookExpectation,
      scenarios: scenarioResults,
    };
    const reportPath = getReportPath();
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    process.stdout.write(`\n[benchmark] report written: ${reportPath}\n`);
    if (hasCiFlag()) assertCiPerformanceBudgets(scenarioResults);
  } finally {
    if (!readOption('samples-dir')) await fs.rm(sampleDir, { recursive: true, force: true });
  }
}

void main().catch(async (error) => {
  if (!failureReportSaved) await saveFailureReport(error).catch((reportError) => {
    console.error('[benchmark] could not save failure report:', reportError);
  });
  console.error('[benchmark] failed:', error);
  process.exitCode = 1;
});
