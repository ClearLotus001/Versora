import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiffLine, WorkbookCellDelta, WorkbookRowDelta } from '../src/types';
import { buildWorkbookRowDelta, buildWorkbookSplitRowDelta } from '../src/utils/workbook/workbookDelta';
import { createWorkbookRowLine, parseWorkbookDiffLine, parseWorkbookDisplayLine } from '../src/utils/workbook/workbookDisplay';

function line(content: string): DiffLine {
  return { type: 'equal', base: content, mine: content, baseLineNo: 1, mineLineNo: 1, baseCharSpans: null, mineCharSpans: null };
}

function normalized(delta: WorkbookRowDelta) {
  return { ...delta, cellDeltas: [...delta.cellDeltas] };
}

test('lazy equal row deltas match eager parsed equality for values, formulas, blank cells and selected columns', () => {
  for (const mode of ['strict', 'content'] as const) {
    for (const columns of [undefined, [], [0, 2], [4, 1, 1, -1, 7]]) {
      for (const cells of [[], [''], [' ', 'value', '', '  '], [{ value: 'value', formula: '=A1' }, { value: '', formula: '=SUM(A1)' }, '']]) {
        const content = createWorkbookRowLine(1, cells);
        // A different row-number spelling keeps the cells identical while
        // exercising the general comparison path for the reference result.
        const eager = buildWorkbookRowDelta(line(content), line(content.replace('@@row\t1\t', '@@row\t01\t')), columns, mode);
        const deferred = buildWorkbookRowDelta(line(content), line(content), columns, mode);
        assert.deepEqual(normalized(deferred), normalized(eager));
      }
    }
  }
});

test('unchanged precomputed subsets retain exact cell values and column order', () => {
  for (const columns of [[0, 2], [3, 1], [1, 1, -1, 10]]) {
    const content = createWorkbookRowLine(1, ['A', ' ', 'C', 'D']);
    const source = buildWorkbookRowDelta(line(content), line(content));
    const subset = buildWorkbookSplitRowDelta({ left: line(content), right: line(content), workbookRowDelta: source }, columns);
    const expectedEntries = [...new Map(columns.flatMap((column) => {
      const delta = source.cellDeltas.get(column);
      return delta ? [[column, delta] as const] : [];
    }))];
    assert.deepEqual([...subset.cellDeltas], expectedEntries);
    assert.deepEqual(subset.changedColumns, []);
    assert.equal(subset.hasChanges, false);
  }
});

test('deferred equal cell maps preserve Map observations, mutations and iterator behavior', () => {
  const make = () => buildWorkbookRowDelta(line('@@row\t1\tA\t\tC'), line('@@row\t1\tA\t\tC')).cellDeltas;
  const expected = new Map(make());
  assert.ok(make() instanceof Map);
  assert.deepEqual(Object.keys(make()), []);
  const serialized = make();
  assert.equal(JSON.stringify(serialized), '{}');
  serialized.get(0);
  assert.equal(JSON.stringify(serialized), '{}');
  assert.equal(make().size, expected.size);
  assert.equal(make().has(0), true);
  assert.equal(make().has(1), false);
  assert.deepEqual([...make().keys()], [...expected.keys()]);
  assert.deepEqual([...make().values()], [...expected.values()]);
  assert.deepEqual([...make().entries()], [...expected.entries()]);
  const added: WorkbookCellDelta = { column: 4, baseCell: { value: 'E', formula: '' }, mineCell: { value: 'E', formula: '' }, changed: false, masked: true };
  const inserted = make();
  assert.equal(inserted.set(4, added), inserted);
  assert.deepEqual([...inserted], [...new Map([...expected, [4, added]])]);
  const deleted = make();
  assert.equal(deleted.delete(0), true);
  assert.equal(deleted.delete(1), false);
  assert.deepEqual([...deleted.keys()], [2]);
  const cleared = make();
  cleared.clear();
  assert.equal(cleared.size, 0);
  cleared.set(4, added);
  assert.deepEqual([...cleared], [[4, added]]);
  const iterated = make();
  const visited: number[] = [];
  const context = { value: 'context' };
  iterated.forEach(function (this: typeof context, delta, column, map) {
    assert.equal(this, context);
    assert.equal(map, iterated);
    assert.equal(delta.column, column);
    visited.push(column);
    if (column === 0) map.set(4, added);
  }, context);
  assert.deepEqual(visited, [0, 2, 4]);
});

test('owned diff-line parse cache survives large string-cache scans and invalidates changed content', () => {
  const owned = line('@@row\t1\tOriginal');
  const parsed = parseWorkbookDiffLine(owned, 'base');
  for (let row = 2; row < 5005; row++) parseWorkbookDisplayLine(`@@row\t${row}\tOther`);
  assert.equal(parseWorkbookDiffLine(owned, 'base'), parsed);
  assert.equal(parseWorkbookDiffLine(owned, 'mine'), parsed);
  owned.mine = '@@row\t1\tChanged';
  assert.deepEqual(parseWorkbookDiffLine(owned, 'mine'), { kind: 'row', rowNumber: 1, cells: [{ value: 'Changed', formula: '' }] });
  assert.deepEqual(parseWorkbookDiffLine(owned, 'base'), parsed);
  assert.equal(parseWorkbookDiffLine(null), null);
  assert.equal(parseWorkbookDiffLine({ base: null, mine: '@@row\t2\tMine' }, 'base'), null);
  assert.equal(parseWorkbookDiffLine({ base: '', mine: '@@row\t2\tMine' }), null);
});
