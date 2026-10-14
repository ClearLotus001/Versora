import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { useWorkbookArtifactWindow } from '../src/hooks/workbook/useWorkbookArtifactWindow';
import { createWorkbookArtifactFixture } from '../src/utils/app/workbookArtifactFixture';
import { WorkbookArtifactProvider } from '../src/utils/workbook/workbookArtifactProvider';

test('a one-sided off-screen merged anchor loads both comparison values and retains its change delta', async (context) => {
  // Execute the real demand effect and window projection; React scheduling is irrelevant to this IO contract.
  context.mock.method(React, 'useMemo', (compute: () => unknown) => compute());
  context.mock.method(React, 'useLayoutEffect', (effect: () => unknown) => { effect(); });
  context.mock.method(React, 'useSyncExternalStore', (_subscribe: unknown, snapshot: () => number) => snapshot());
  const content = (anchor: string) => ['@@sheet\tSheet', ...Array.from({ length: 300 }, (_, index) => `@@row\t${index + 1}\t${index === 19 ? anchor : `row-${index + 1}`}`)].join('\n');
  const descriptor = createWorkbookArtifactFixture(content('old anchor'), content('new anchor'));
  const provider = new WorkbookArtifactProvider(descriptor);
  const allRows = provider.getRows('Sheet')!;
  const anchor = allRows.find((row) => row.workbookArtifactRow!.baseRowNumber === 20)!;
  const visible = allRows.find((row) => row.workbookArtifactRow!.baseRowNumber === 200)!;
  const args = {
    rows: [visible], columns: [0], baseVersion: 'base', mineVersion: 'mine',
    baseMerges: [{ startRow: 20, endRow: 300, startCol: 0, endCol: 0 }], mineMerges: [],
    fallback: { entries: { base: new Map(), mine: new Map() }, cells: { base: new Map(), mine: new Map() }, states: new Map() },
  };
  useWorkbookArtifactWindow(args);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.getCacheStats().pending, 0);
  const result = useWorkbookArtifactWindow(args);
  assert.equal(result.entries.base.get(20)?.cells[0]?.value, 'old anchor');
  assert.equal(result.entries.mine.get(20)?.cells[0]?.value, 'new anchor');
  assert.equal(result.states.get(anchor)?.cellDeltas.get(0)?.changed, true);
  assert.equal(result.states.get(anchor)?.cellDeltas.get(0)?.kind, 'modify');
});
