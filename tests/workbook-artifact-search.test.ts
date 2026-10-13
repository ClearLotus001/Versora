import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import * as fs from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { WorkbookArtifactSearchRequest, WorkbookArtifactSearchResult, WorkbookArtifactWindowRow } from '../shared/workbookArtifactProtocol';
import { createWorkbookRowLine } from '../src/utils/workbook/workbookDisplay';
import { resolveWorkbookSearchMatchColumnIndex } from '../src/utils/workbook/workbookNavigation';
import { writeWorkbookSearchArtifact } from './fixtures/workbookSearchArtifactFixture';
import { WorkbookSearchSource } from '../electron/main/workbookSearchSource';

type SearchRow = WorkbookArtifactWindowRow & { sheetId: number; baseColumnCount: number; mineColumnCount: number; searchBothSides: boolean };

async function search(query: string, rows: SearchRow[], extra: Partial<WorkbookArtifactSearchRequest> = {}, heapMb = 256): Promise<WorkbookArtifactSearchResult> {
  const request: WorkbookArtifactSearchRequest = { artifactId: 'fixture', requestId: 'query', compareMode: 'strict', query, isRegex: false, isCaseSensitive: false, ...extra };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-search-'));
  const manifest = await writeWorkbookSearchArtifact(root, rows);
  const worker = new Worker(`require(${JSON.stringify(require.resolve('tsx/cjs'))}); require(${JSON.stringify(path.resolve('electron/main/workbookSearchWorker.ts'))});`, {
    eval: true, execArgv: [], workerData: { request, manifest, root }, resourceLimits: { maxOldGenerationSizeMb: heapMb },
  });
  try {
    return await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.on('message', message => {
        if (message.type === 'result') resolve(message);
        else if (message.type === 'error') reject(new Error(message.error));
      });
    });
  } finally { await worker.terminate(); await fs.rm(root, { recursive: true, force: true }); }
}

const changed: SearchRow = {
  rowIndex: 4, sheetId: 1, baseRowNumber: 7, mineRowNumber: 8, baseColumnCount: 3, mineColumnCount: 3, searchBothSides: true,
  baseCells: [{ column: 0, value: 'Old price', formula: '' }, { column: 1, value: '5', formula: 'SUM(A1:A2)' }, { column: 2, value: 'tail', formula: '' }],
  mineCells: [{ column: 0, value: 'New price', formula: '' }, { column: 1, value: '6', formula: 'SUM(A1:A3)' }, { column: 2, value: 'tail', formula: '' }],
  changedColumnRuns: [{ start: 0, end: 2, kind: 'modify', strictOnly: false, hasBaseContent: true, hasMineContent: true }],
};

test('replacement rows search base then mine while aligned anchors search only mine', async () => {
  const both = await search('price|SUM', [changed], { isRegex: true });
  assert.deepEqual(both.matches.map(match => [match.side, match.rowNumber, match.column]), [['base', 7, 0], ['base', 7, 1], ['mine', 8, 0], ['mine', 8, 1]]);
  const matched = await search('price|SUM', [{ ...changed, searchBothSides: false }], { isRegex: true });
  assert.deepEqual(matched.matches.map(match => match.side), ['mine', 'mine']);
});

test('formula, cross-cell tab, backreference and zero-width regex retain legacy column and offset semantics', async () => {
  const row = { ...changed, searchBothSides: false };
  const line = createWorkbookRowLine(8, row.mineCells.map(cell => ({ value: cell.value, formula: cell.formula })));
  for (const query of ['(?<=\\u001f)SUM', 'price\\t6', '(t)ai\\1', '(?=New|tail)', '\\t']) {
    const result = await search(query, [row], { isRegex: true });
    const contentStart = line.indexOf('\t', line.indexOf('\t') + 1) + 1;
    const pattern = new RegExp(query, 'gi');
    const expected: Array<{ start: number; end: number; column: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line.slice(contentStart))) !== null) {
      const start = contentStart + match.index;
      const end = start + match[0].length;
      expected.push({ start, end, column: resolveWorkbookSearchMatchColumnIndex({ type: 'equal', base: line, mine: line, baseLineNo: null, mineLineNo: null, baseCharSpans: null, mineCharSpans: null }, { start, end })! });
      if (!match[0].length) pattern.lastIndex += 1;
    }
    assert.deepEqual(result.matches.map(({ start, end, column }) => ({ start, end, column })), expected, query);
  }
});

test('differences-only search rejects matches outside changed cells and excludes display prefixes', async () => {
  const difference = await search('tail|price|SUM', [{ ...changed, searchBothSides: false }], { isRegex: true, visibleRowIndexes: Uint32Array.of(4) });
  assert.deepEqual(difference.matches.map(match => match.column), [0, 1]);
  const prefix = await search('@@row|^8\\t', [changed], { isRegex: true });
  assert.equal(prefix.totalCount, 0);
});

test('visibility skips unselected rows, deduplicates ordinals and retains sheet, side and column order', async () => {
  const rows = [0, 1, 2].map(rowIndex => ({ ...changed, rowIndex, sheetId: rowIndex < 2 ? 9 : 3, baseRowNumber: rowIndex + 1, mineRowNumber: rowIndex + 1 }));
  const result = await search('price|SUM', rows, { isRegex: true, visibleRowIndexes: Uint32Array.of(2, 0, 2) });
  assert.deepEqual(result.matches.map(match => [match.rowIndex, match.sheetId, match.side, match.column]), [
    [0, 9, 'base', 0], [0, 9, 'base', 1], [0, 9, 'mine', 0], [0, 9, 'mine', 1],
    [2, 3, 'base', 0], [2, 3, 'base', 1], [2, 3, 'mine', 0], [2, 3, 'mine', 1],
  ]);
  const selectedSheet = await search('tail', rows, { sheetId: 3 });
  assert.deepEqual(selectedSheet.matches.map(match => [match.rowIndex, match.side, match.column]), [[2, 'base', 2], [2, 'mine', 2]]);
  assert.equal((await search('price', rows, { visibleRowIndexes: new Uint32Array() })).totalCount, 0);
});

test('one-sided rows, case-sensitive literal metacharacters and hidden columns remain searchable', async () => {
  const rows = [
    { ...changed, rowIndex: 0, baseRowNumber: 0, baseCells: [], baseColumnCount: 0, searchBothSides: false, mineCells: [{ column: 1, value: 'A.*+?()[]中文', formula: 'SUM(B2)' }] },
    { ...changed, rowIndex: 1, mineRowNumber: 0, mineCells: [], mineColumnCount: 0, searchBothSides: false, baseCells: [{ column: 1, value: 'a.*+?()[]中文', formula: 'SUM(B2)' }] },
  ];
  const insensitive = await search('a.*+?()[]中文', rows);
  assert.deepEqual(insensitive.matches.map(match => [match.rowIndex, match.side, match.column]), [[0, 'mine', 1], [1, 'base', 1]]);
  const sensitive = await search('A.*+?()[]中文', rows, { isCaseSensitive: true });
  assert.deepEqual(sensitive.matches.map(match => match.side), ['mine']);
  assert.equal((await search('[', rows, { isRegex: true })).totalCount, 0);
  assert.equal((await search('  ', rows)).totalCount, 0);
});

test('retained match cap does not truncate the exact count or change ordered offsets', async () => {
  const row = { ...changed, searchBothSides: false, mineCells: [{ column: 1, value: 'a'.repeat(100_003), formula: '' }] };
  const result = await search('a', [row]);
  assert.equal(result.totalCount, 100_003);
  assert.equal(result.matches.length, 100_000);
  assert.equal(result.truncated, true);
  assert.equal(result.matches[0]?.start, '@@row\t8\t'.length + 1);
  assert.equal(result.matches.at(-1)?.end, '@@row\t8\t'.length + 100_001);
});

test('large UTF-8 rows preserve formula, trailing empty columns and complete cross-cell regex offsets', async () => {
  const value = '中'.repeat(1_400_000);
  const row = { ...changed, searchBothSides: false, mineColumnCount: 4, mineCells: [{ column: 0, value, formula: 'SUM(A1)' }, { column: 2, value: 'TAIL', formula: '' }] };
  const result = await search('(?<=\\u001f)SUM\\(A1\\)\\t\\tTAIL\\t$', [row], { isRegex: true, isCaseSensitive: true });
  assert.equal(result.totalCount, 1);
  assert.equal(result.matches[0]?.column, 0);
  assert.equal(result.matches[0]?.start, '@@row\t8\t'.length + value.length + 1);
  assert.equal(result.matches[0]?.end, '@@row\t8\t'.length + value.length + 1 + 'SUM(A1)\t\tTAIL\t'.length);
});

test('snippets copy complete UTF-16 units even when the 240-character boundary splits emoji pairs', async () => {
  const value = `${'x'.repeat(80)}😀${'x'.repeat(79)}Q${'x'.repeat(159)}😀`;
  const row = { ...changed, searchBothSides: false, mineCells: [{ column: 0, value, formula: '' }] };
  const result = await search('Q', [row]);
  assert.equal(result.matches[0]?.snippet, value.slice(81, 322));
  assert.equal(result.matches[0]?.snippet.charCodeAt(0), 0xde00);
  assert.equal(result.matches[0]?.snippet.charCodeAt(240), 0xd83d);
});

test('one snippet per wide source row stays within a small worker heap without retaining entire rows', async () => {
  const value = `MATCH-${'x'.repeat(10_000)}`;
  const rows = Array.from({ length: 10_000 }, (_, rowIndex) => ({ ...changed, rowIndex, baseRowNumber: 0, baseCells: [], baseColumnCount: 0, searchBothSides: false,
    mineRowNumber: rowIndex + 1, mineColumnCount: 1, mineCells: [{ column: 0, value, formula: '' }] }));
  const result = await search('^MATCH-', rows, { isRegex: true }, 64);
  assert.equal(result.totalCount, rows.length);
  assert.equal(result.matches.length, rows.length);
  assert.equal(result.matches.at(-1)?.rowNumber, rows.length);
  assert.equal(result.matches.at(-1)?.snippet.length, 166);
});

test('search source rejects out-of-lease files and malformed canonical rows and closes opened handles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-search-invalid-'));
  const request: WorkbookArtifactSearchRequest = { artifactId: 'fixture', requestId: 'query', compareMode: 'strict', query: 'x', isRegex: false, isCaseSensitive: false };
  let source: WorkbookSearchSource | undefined;
  try {
    const manifest = await writeWorkbookSearchArtifact(root, [changed]);
    assert.throws(() => new WorkbookSearchSource({ ...manifest, files: { ...manifest.files, mineRows: path.resolve(root, 'mine.rows.bin') } }, root, request), /filename/);
    const parentFile = path.join(path.dirname(root), `${path.basename(root)}-outside.bin`);
    await fs.writeFile(parentFile, 'VWRROW01');
    try { assert.throws(() => new WorkbookSearchSource({ ...manifest, files: { ...manifest.files, mineRows: `../${path.basename(parentFile)}` } }, root, request), /outside its lease/); }
    finally { await fs.rm(parentFile); }
    const file = await fs.open(path.join(root, 'mine.rows.bin'), 'r+');
    try { const bad = Buffer.alloc(4); bad.writeUInt32LE(0xffff_ffff); await file.write(bad, 0, 4, 20); }
    finally { await file.close(); }
    source = new WorkbookSearchSource(manifest, root, request);
    const pair = [...source.alignedRows()].find(row => row.rowIndex === changed.rowIndex)!;
    assert.throws(() => source!.readLine(pair, 'mine'), /cell record/);
  } finally { source?.close(); await fs.rm(root, { recursive: true, force: true }); }
});
