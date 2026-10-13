import test from 'node:test';
import assert from 'node:assert/strict';
import { buildE2EWorkbookDiffData, swapE2EWorkbookDiffData } from '../src/utils/app/e2eBridge';
import { activateWorkbookArtifact, releaseWorkbookArtifactSession, resolveWorkbookArtifactView } from '../src/utils/workbook/workbookArtifactProvider';
import { swapDiffDataSides } from '../src/utils/diff/swapDiffSides';

test('browser workbook swapping rebuilds canonical cells in both modes and preserves the comparison owner', async () => {
  const data = buildE2EWorkbookDiffData({
    baseContent: '@@sheet\tSheet\n@@row\t1\tbefore', mineContent: '@@sheet\tSheet\n@@row\t1\tafter',
    baseName: 'left.xlsx', mineName: 'right.xlsx',
  });
  assert.throws(() => swapDiffDataSides(data), /preparing a new artifact/);
  const swapped = swapE2EWorkbookDiffData(data);
  assert.equal(swapped.baseName, 'right.xlsx');
  assert.equal(swapped.mineName, 'left.xlsx');
  assert.notEqual(swapped.workbookArtifact!.artifactId, data.workbookArtifact!.artifactId);
  assert.equal(swapped.workbookArtifact!.comparisonSessionId, data.workbookArtifact!.comparisonSessionId);
  for (const compareMode of ['strict', 'content'] as const) {
    const descriptor = await resolveWorkbookArtifactView({ artifactId: swapped.workbookArtifact!.artifactId, compareMode });
    const provider = activateWorkbookArtifact(descriptor);
    assert.equal((await provider.readCell({ sheetId: 0, side: 'base', rowNumber: 1, column: 0 }))?.value, 'after');
    assert.equal((await provider.readCell({ sheetId: 0, side: 'mine', rowNumber: 1, column: 0 }))?.value, 'before');
  }
  releaseWorkbookArtifactSession(data.workbookArtifact!.comparisonSessionId);
});

test('closing a fixture comparison removes its adapter and does not serve released data', async () => {
  const data = buildE2EWorkbookDiffData({ baseContent: '@@sheet\tSheet', mineContent: '@@sheet\tSheet' });
  const descriptor = data.workbookArtifact!;
  activateWorkbookArtifact(descriptor);
  releaseWorkbookArtifactSession(descriptor.comparisonSessionId);
  Object.assign(globalThis, { window: { versora: { getWorkbookArtifactView: async () => { throw new Error('Fixture no longer registered'); } } } });
  await assert.rejects(resolveWorkbookArtifactView({ artifactId: descriptor.artifactId, compareMode: 'strict' }), /no longer registered/);
});

test('closing a swapped fixture also removes adapters whose providers were previously evicted', async () => {
  const original = buildE2EWorkbookDiffData({ baseContent: '@@sheet\tSheet\n@@row\t1\tbefore', mineContent: '@@sheet\tSheet\n@@row\t1\tafter' });
  const swapped = swapE2EWorkbookDiffData(original);
  const descriptor = swapped.workbookArtifact!;
  activateWorkbookArtifact(descriptor);
  const others = Array.from({ length: 5 }, () => buildE2EWorkbookDiffData({ baseContent: '@@sheet\tSheet', mineContent: '@@sheet\tSheet' }).workbookArtifact!);
  for (const other of others) activateWorkbookArtifact(other);
  assert.equal(await resolveWorkbookArtifactView({ artifactId: descriptor.artifactId, compareMode: 'strict' }), descriptor);
  releaseWorkbookArtifactSession(descriptor.comparisonSessionId);
  Object.assign(globalThis, { window: { versora: { getWorkbookArtifactView: async () => { throw new Error('Fixture no longer registered'); } } } });
  await assert.rejects(resolveWorkbookArtifactView({ artifactId: descriptor.artifactId, compareMode: 'strict' }), /no longer registered/);
  for (const other of others) releaseWorkbookArtifactSession(other.comparisonSessionId);
});
