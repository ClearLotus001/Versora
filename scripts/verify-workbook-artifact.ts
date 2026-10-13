/** Independent bounded verifier for the deterministic workbook stress fixtures. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { WorkbookArtifactManifest } from '../shared/workbookArtifactProtocol';

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}
function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing --${name}=…`);
  return value;
}

class Input {
  private data = Buffer.alloc(0);
  private start = 0;
  private filePosition = 0;
  position = 0;
  constructor(private file: fs.FileHandle) {}
  async take(bytes: number): Promise<Buffer> {
    assert(Number.isSafeInteger(bytes) && bytes >= 0);
    if (this.data.length - this.start < bytes) {
      const remainder = this.data.subarray(this.start);
      const next = Buffer.alloc(Math.max(1024 * 1024, bytes));
      const { bytesRead } = await this.file.read(next, 0, next.length, this.filePosition);
      this.filePosition += bytesRead;
      this.data = Buffer.concat([remainder, next.subarray(0, bytesRead)]);
      this.start = 0;
      if (this.data.length < bytes) throw new Error(`Truncated artifact at ${this.position}, need ${bytes} bytes.`);
    }
    const result = this.data.subarray(this.start, this.start + bytes);
    this.start += bytes;
    this.position += bytes;
    return result;
  }
  async magic(expected: string): Promise<void> {
    assert.equal((await this.take(8)).toString('ascii'), expected);
  }
  async end(): Promise<void> {
    assert.equal(this.position, (await this.file.stat()).size, 'Artifact has unconsumed/trailing bytes.');
  }
}

const artifactDir = path.resolve(required('artifact-dir'));
const testCase = required('case');
assert(['sparse', 'dense', 'islands', 'base'].includes(testCase), 'Unsupported case.');
const rows = Number(option('rows') ?? 100_000);
const columns = Number(option('columns') ?? 200);
const interval = Number(option('sparse-interval') ?? 125);
assert(Number.isSafeInteger(rows) && rows >= 2 && Number.isSafeInteger(columns) && columns >= 7);

function changed(rowIndex: number, column: number): boolean {
  if (rowIndex === 0 || column === 0) return false;
  return testCase === 'dense'
    || (testCase === 'sparse' && ((column === 5 && rowIndex % interval === 0)
      || (rowIndex === rows - 1 && column === columns - 1)))
    || (testCase === 'islands' && rowIndex % 3 === 1 && column % 3 === 1);
}
function expectedValue(side: 'base' | 'mine', rowIndex: number, column: number): string {
  if (rowIndex === 0) return `Field_${column}`;
  if (column === 0) return `ID-${rowIndex}`;
  return `${side === 'mine' && changed(rowIndex, column) ? 'updated' : 'value'}-${rowIndex}-${column}`;
}
function filePath(name: string): string {
  const resolved = path.resolve(artifactDir, name);
  assert.equal(path.dirname(resolved), artifactDir, 'Manifest filename must stay within artifact directory.');
  return resolved;
}
async function inputFile<T>(name: string, fn: (input: Input) => Promise<T>): Promise<T> {
  const file = await fs.open(filePath(name), 'r');
  try { return await fn(new Input(file)); } finally { await file.close(); }
}

async function prepare(): Promise<void> {
  const parser = option('parser');
  if (!parser) return;
  await fs.mkdir(artifactDir, { recursive: true });
  const stderrFile = await fs.open(path.join(artifactDir, 'prepare.stderr.log'), 'w');
  try {
    const stdout: Buffer[] = [];
    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(path.resolve(parser), ['--prepare-artifact', path.resolve(required('base')),
        path.resolve(required('mine')), artifactDir], { stdio: ['ignore', 'pipe', stderrFile.fd], windowsHide: true });
      child.stdout!.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) {
          child.kill(); reject(new Error('Manifest stdout exceeded verifier budget.'));
        } else stdout.push(chunk);
      });
      child.once('error', reject);
      child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Rust exited ${code}, signal ${signal}.`)));
    });
    await fs.writeFile(path.join(artifactDir, 'prepare.stdout.json'), Buffer.concat(stdout));
  } finally { await stderrFile.close(); }
}

interface RowIndex { offset: number; bytes: number }
async function verifySource(manifest: WorkbookArtifactManifest, side: 'base' | 'mine') {
  const indexName = side === 'base' ? manifest.files.baseIndex : manifest.files.mineIndex;
  const rowsName = side === 'base' ? manifest.files.baseRows : manifest.files.mineRows;
  const indexes = await inputFile(indexName, async (input) => {
    await input.magic('VWRIDX01');
    assert.equal(Number((await input.take(8)).readBigUInt64LE()), rows);
    const result: RowIndex[] = [];
    for (let row = 0; row < rows; row += 1) {
      const entry = await input.take(24);
      assert.equal(entry.readUInt32LE(0), 0, 'Sheet id');
      assert.equal(entry.readUInt32LE(4), row + 1, 'Physical row');
      assert.equal(entry.readUInt32LE(20), columns, 'Column coverage');
      result.push({ offset: Number(entry.readBigUInt64LE(8)), bytes: entry.readUInt32LE(16) });
    }
    await input.end();
    return result;
  });
  return inputFile(rowsName, async (input) => {
    await input.magic('VWRROW01');
    let verifiedCells = 0;
    for (let row = 0; row < rows; row += 1) {
      const entry = indexes[row]!;
      assert.equal(input.position, entry.offset, 'Row index offset');
      const header = await input.take(8);
      assert.equal(header.readUInt32LE(0), row + 1);
      assert.equal(header.readUInt32LE(4), columns);
      for (let column = 0; column < columns; column += 1) {
        const cell = await input.take(12);
        assert.equal(cell.readUInt32LE(0), column, 'Cell column');
        const valueBytes = cell.readUInt32LE(4);
        const formulaBytes = cell.readUInt32LE(8);
        assert.equal(formulaBytes, 0, 'Fixture has no formulas');
        const actual = (await input.take(valueBytes)).toString('utf8');
        assert.equal(actual, expectedValue(side, row, column), `${side}: row ${row + 1}, column ${column}`);
        verifiedCells += 1;
      }
      assert.equal(input.position - entry.offset, entry.bytes, 'Row byte length');
      if ((row + 1) % 25_000 === 0) process.stdout.write(`[verify] ${side}: ${row + 1} rows, ${verifiedCells} cells\n`);
    }
    await input.end();
    return { rows, verifiedCells, tailValue: expectedValue(side, rows - 1, columns - 1) };
  });
}

async function verifyMode(manifest: WorkbookArtifactManifest, mode: 'strict' | 'content') {
  const descriptor = manifest.modes[mode];
  assert.equal(descriptor.pairCount, rows);
  assert.equal(descriptor.runRecordBytes, 16);
  assert.equal(descriptor.sheets.length, 1);
  return inputFile(descriptor.runsFile, async (runInput) => {
    await runInput.magic('VWRRUN01');
    const pairResult = await inputFile(descriptor.pairsFile, async (pairInput) => {
      await pairInput.magic('VWRPAIR1');
      assert.equal(Number((await pairInput.take(8)).readBigUInt64LE()), rows);
      let changes = 0;
      let modifiedRows = 0;
      let runs = 0;
      for (let row = 0; row < rows; row += 1) {
        const pair = await pairInput.take(40);
        assert.equal(pair.readUInt32LE(0), 0);
        assert.equal(pair.readUInt32LE(4), row, 'Base alignment');
        assert.equal(pair.readUInt32LE(8), row, 'Mine alignment');
        assert.equal(pair.readUInt32LE(12), row + 1);
        assert.equal(pair.readUInt32LE(16), row + 1);
        const changedColumns = new Uint8Array(columns);
        const runCount = pair.readUInt32LE(28);
        if (runCount > 0) assert.equal(Number(pair.readBigUInt64LE(32)), runInput.position);
        for (let run = 0; run < runCount; run += 1) {
          const record = await runInput.take(16);
          const start = record.readUInt32LE(0);
          const end = record.readUInt32LE(4);
          const flags = record.readUInt32LE(8);
          assert(start < end && end <= columns, 'Run bounds');
          assert.equal(flags & 31, 27, 'Modify with both content, no strict-only');
          assert(record.readUInt32LE(12) < descriptor.regionCount, 'Region id');
          for (let column = start; column < end; column += 1) {
            assert.equal(changedColumns[column], 0, 'Overlapping runs');
            changedColumns[column] = 1;
          }
          runs += 1;
        }
        let rowChanges = 0;
        for (let column = 0; column < columns; column += 1) {
          assert.equal(changedColumns[column], Number(changed(row, column)), `${mode}: change row ${row + 1}, col ${column}`);
          rowChanges += changedColumns[column]!;
        }
        assert.equal(pair.readUInt32LE(24), rowChanges, 'Row changed count');
        assert.equal(pair.readUInt32LE(20) & 255, rowChanges ? 3 : 0, 'Row kind');
        assert.equal((pair.readUInt32LE(20) >>> 8) & 255, rowChanges ? 4 : 0, 'Minimap tone');
        if (rowChanges) modifiedRows += 1;
        changes += rowChanges;
      }
      await pairInput.end();
      return { changes, modifiedRows, runs };
    });
    await runInput.end();
    assert.equal(descriptor.changedCellCount, pairResult.changes);
    assert.equal(descriptor.sheets[0]!.changedCellCount, pairResult.changes);
    assert.equal(descriptor.sheets[0]!.modifiedRows, pairResult.modifiedRows);
    const regions = await inputFile(descriptor.regionsFile, async (regionInput) => {
      await regionInput.magic('VWRREG01');
      const count = Number((await regionInput.take(8)).readBigUInt64LE());
      assert.equal(count, descriptor.regionCount);
      const touchingSparseTail = testCase === 'sparse' && columns === 7 && (rows - 1) % interval === 0;
      const expectedRegions = testCase === 'dense' ? 1 : pairResult.changes - Number(touchingSparseTail);
      assert.equal(count, expectedRegions, 'Eight-neighbor region count');
      let regionChanges = 0;
      for (let region = 0; region < count; region += 1) {
        const record = await regionInput.take(40);
        assert.equal(record.readUInt32LE(0), 0);
        assert.equal(record.readUInt32LE(4), region);
        const startRow = record.readUInt32LE(8);
        const endRow = record.readUInt32LE(12);
        const startCol = record.readUInt32LE(16);
        const endCol = record.readUInt32LE(20);
        assert(startRow < endRow && endRow <= rows && startCol < endCol && endCol <= columns);
        assert(changed(record.readUInt32LE(24), record.readUInt32LE(28)), 'Region anchor must be a changed cell');
        const countChanges = Number(record.readBigUInt64LE(32));
        if (testCase === 'islands' || testCase === 'base' || (testCase === 'sparse' && !touchingSparseTail)) assert.equal(countChanges, 1);
        regionChanges += countChanges;
      }
      await regionInput.end();
      assert.equal(regionChanges, pairResult.changes, 'Complete region coverage');
      return count;
    });
    return { ...pairResult, regions };
  });
}

async function main() {
  const started = performance.now();
  await prepare();
  const prepareMs = performance.now() - started;
  const manifest = JSON.parse(await fs.readFile(path.join(artifactDir, 'manifest.json'), 'utf8')) as WorkbookArtifactManifest;
  assert.equal(manifest.kind, 'versora-workbook-artifact-v1');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.complete, true);
  for (const side of ['base', 'mine'] as const) {
    assert.equal(manifest[side].rowCount, rows);
    assert.equal(manifest[side].cellCount, rows * columns);
  }
  const sources = { base: await verifySource(manifest, 'base'), mine: await verifySource(manifest, 'mine') };
  const modes = { strict: await verifyMode(manifest, 'strict'), content: await verifyMode(manifest, 'content') };
  const report = { status: 'passed', fixture: { testCase, rows, columns, interval }, artifactDir,
    prepareMs, totalMs: performance.now() - started, nativePerf: manifest.perf, sources, modes,
    verified: 'All stored values, physical coordinates, row offsets, alignment pairs, change runs, flags, counts and region records; both modes.' };
  const reportPath = option('report') ?? path.join(artifactDir, 'verification.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
main().catch(async (error: unknown) => {
  const reportPath = option('report');
  if (reportPath) await fs.writeFile(reportPath, JSON.stringify({ status: 'failed', artifactDir,
    fixture: { testCase, rows, columns, interval }, error: error instanceof Error ? error.stack : String(error) }, null, 2));
  console.error(error);
  process.exitCode = 1;
});
