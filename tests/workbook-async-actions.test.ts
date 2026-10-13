import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { translate, type TranslationFn } from '../src/i18n/core';
import useWorkbookActions, { type UseWorkbookActionsResult } from '../src/hooks/app/useWorkbookActions';
import { createWorkbookArtifactFixture } from '../src/utils/app/workbookArtifactFixture';
import { WorkbookArtifactProvider, registerWorkbookArtifactFixture } from '../src/utils/workbook/workbookArtifactProvider';
import { createWorkbookSelectionState } from '../src/utils/workbook/workbookSelectionState';
import type { DiffData, WorkbookSelectedCell } from '../src/types';
import type { WorkbookUiController } from '../src/hooks/app/contracts';
import type { WorkbookArtifactIO } from '../src/utils/workbook/workbookArtifactProvider';
import type { WorkbookArtifactSourceRowsRequest, WorkbookArtifactSourceRowsResult } from '../shared/workbookArtifactProtocol';

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
const t: TranslationFn = (key, ...args) => translate('en-US', key, ...args);

function harness(kind: 'cell' | 'column', overrides: Partial<WorkbookArtifactIO> = {}) {
  const content = '@@sheet\tSheet\n@@row\t1\theader';
  const descriptor = createWorkbookArtifactFixture(content, content);
  registerWorkbookArtifactFixture(descriptor.artifactId, {
    getWorkbookArtifactView: async () => descriptor,
    readWorkbookArtifactWindow: async () => { throw new Error('Unexpected viewport read'); },
    readWorkbookArtifactCells: async (request) => ({ ...request, cells: request.cells.map((cell) => ({ ...cell, exists: true, value: 'complete value', formula: '=1' })) }),
    readWorkbookArtifactSourceRows: async () => { throw new Error('Unexpected auto-fit read'); },
    searchWorkbookArtifact: async (request) => ({ artifactId: request.artifactId, requestId: request.requestId, matches: [], totalCount: 0, truncated: false }),
    cancelWorkbookArtifactSearch: async () => undefined,
    ...overrides,
  });
  const provider = new WorkbookArtifactProvider(descriptor);
  const rows = provider.getRows('Sheet')!;
  const selected: WorkbookSelectedCell = { ...provider.makeSelection(rows[0]!.workbookArtifactRow!, 0, 'base', 'mine'), kind };
  const selection = createWorkbookSelectionState(selected);
  const errors: string[] = []; const copied: string[] = []; const widths: unknown[] = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  Object.assign(globalThis, { window: { versora: { writeClipboardText: (text: string) => { copied.push(text); } } } });
  const currentDiffDataRef = { current: { comparisonSessionId: 'first', workbookArtifact: descriptor } as DiffData | null };
  const workbookUi: WorkbookUiController = {
    state: { selection, hiddenStateBySheet: {}, contextMenu: { selection, anchorPoint: { x: 0, y: 0 } }, freezeBySheet: {}, columnWidthBySheet: {}, activeSheetName: 'Sheet', showHiddenColumns: false, showOnlyDifferences: false },
    actions: {
      setSelection: () => {}, setHiddenStateBySheet: () => {}, setContextMenu: () => {}, setFreezeBySheet: () => {},
      setColumnWidthBySheet: (next) => { widths.push(typeof next === 'function' ? next({}) : next); },
      setActiveSheetName: () => {}, setShowHiddenColumns: () => {}, setShowOnlyDifferences: () => {},
    },
  };
  let actions!: UseWorkbookActionsResult;
  function Subject() {
    actions = useWorkbookActions({
      t, selectedCell: selected, fontSize: 12, workbookCompareMode: 'strict',
      workbookSections: provider.getSections(), workbookSectionRowIndex: { artifactProvider: provider, get: () => ({ rows }) },
      baseWorkbookMetadata: descriptor.baseMetadata, mineWorkbookMetadata: descriptor.mineMetadata,
      workbookUi, workbookDiffRegions: provider.getRegions('base', 'mine'), isWorkbookMode: true,
      setHunkIdx: () => {}, onError: (message) => { errors.push(message); }, currentDiffDataRef,
    });
    return null;
  }
  renderToString(createElement(Subject));
  const run = (id: string) => {
    const item = actions.workbookContextMenuSections.flatMap((section) => section.items).find((item) => item.id === id);
    assert.ok(item, `Missing action ${id}`);
    item.onSelect?.();
  };
  return { run, actions, currentDiffDataRef, errors, copied, widths };
}

test('copy reports a failed cell read and never replaces clipboard with a pending blank value', async () => {
  const h = harness('cell', { readWorkbookArtifactCells: async () => { throw new Error('disk read failed'); } });
  h.run('copy-value');
  await drain();
  assert.deepEqual(h.errors, ['disk read failed']);
  assert.deepEqual(h.copied, []);
});

test('copy uses the complete canonical value and formula after the cell read finishes', async () => {
  const h = harness('cell');
  h.run('copy-value');
  await drain();
  h.run('copy-formula');
  await drain();
  assert.deepEqual(h.copied, ['complete value', '=1']);
  assert.deepEqual(h.errors, []);
});

test('a copy completion from a closed or replaced comparison cannot update the clipboard', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const h = harness('cell', { readWorkbookArtifactCells: async (request) => {
    await pending;
    return { ...request, cells: request.cells.map((cell) => ({ ...cell, exists: true, value: 'old revision', formula: '' })) };
  } });
  h.run('copy-value');
  h.currentDiffDataRef.current = null;
  release();
  await drain();
  assert.deepEqual(h.copied, []);
  assert.deepEqual(h.errors, []);
});

function sourcePage(request: WorkbookArtifactSourceRowsRequest): WorkbookArtifactSourceRowsResult {
  return { artifactId: request.artifactId, compareMode: request.compareMode, sheetId: request.sheetId,
    startRow: request.startRow, columnRanges: [{ start: 0, end: 1 }], nextRow: null,
    rows: [{ rowIndex: 0, baseRowNumber: 1, mineRowNumber: 1, baseCells: [], mineCells: [{ column: 0, value: 'short', formula: '' }], changedColumnRuns: [] }] };
}

for (const change of ['comparison', 'manual-width'] as const) {
  test(`auto-fit discards a pending result after ${change} changes`, async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const h = harness('column', { readWorkbookArtifactSourceRows: async (request) => { await pending; return sourcePage(request); } });
    h.run('auto-fit-columns');
    if (change === 'comparison') h.currentDiffDataRef.current = { comparisonSessionId: 'second' } as DiffData;
    else h.actions.handleWorkbookColumnWidthChange('Sheet', 0, 210);
    release();
    await drain();
    assert.deepEqual(h.widths, change === 'comparison' ? [] : [{ Sheet: { 0: 210 } }]);
    assert.deepEqual(h.errors, []);
  });
}

test('successful auto-fit applies the canonical source measurement', async () => {
  const h = harness('column', { readWorkbookArtifactSourceRows: async (request) => sourcePage(request) });
  h.run('auto-fit-columns');
  await drain();
  assert.deepEqual(h.widths, [{ Sheet: { 0: 72 } }]);
  assert.deepEqual(h.errors, []);
});

test('auto-fit failure is visible and leaves existing widths intact', async () => {
  const h = harness('column', { readWorkbookArtifactSourceRows: async () => { throw new Error('artifact closed'); } });
  h.run('auto-fit-columns');
  await drain();
  assert.deepEqual(h.errors, ['artifact closed']);
  assert.deepEqual(h.widths, []);
});
