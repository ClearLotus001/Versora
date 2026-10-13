import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { buildSmartLocalFileDiffData, buildTwoFileVersionDiffData, clearActiveTwoFileVersionSession, queryTwoFileRevisionOptions } from '../electron/main/twoFileVersionOperations';
import { buildGitFileRevisionDiffData, buildSmartWorkingCopyDiffData } from '../electron/main/gitDiffBuilder';
import { clearActiveGitWorkingFileSession } from '../electron/main/gitOperations';
import { loadWorkbookCompareModeData, loadWorkbookMetadataData } from '../electron/main/diffBuilder';
import { getActiveCliArgs } from '../electron/main/state';
import { getWorkbookArtifactReader, releaseWorkbookArtifacts } from '../electron/main/workbookArtifactService';
import { configureRuntimePaths } from '../electron/runtimePaths';
import { SPECIAL_BASE_ID, SPECIAL_MINE_ID } from '../electron/main/constants';

function workbook(value: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Thing" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${value}</t></is></c></row></sheetData></worksheet>`),
  });
}
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim(); }
function configure(root: string): void {
  if (!process.resourcesPath) Object.defineProperty(process, 'resourcesPath', { value: '', configurable: true });
  const paths = new Map<string, string>();
  configureRuntimePaths({ commandLine: { appendSwitch() {} }, setPath(name: string, value: string) { paths.set(name, value); }, getPath(name: string) { return paths.get(name) ?? path.join(root, name); } } as unknown as Parameters<typeof configureRuntimePaths>[0], path.join(root, '.runtime'), null);
}
async function values(artifactId: string): Promise<string[]> {
  const window = await getWorkbookArtifactReader(artifactId).readWindow({ artifactId, compareMode: 'strict', sheetId: 0, startRow: 0, rowCount: 1, columnRanges: [{ start: 0, end: 1 }] });
  return [window.rows[0]?.baseCells[0]?.value ?? '', window.rows[0]?.mineCells[0]?.value ?? ''];
}

test('Git workbook snapshots retain independent histories, exact revision values and mode reuse', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'versora-artifact-git-'));
  const basePath = path.join(root, 'base.xlsx'); const minePath = path.join(root, 'mine.xlsx');
  configure(root);
  try {
    git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Workbook Author'); git(root, 'config', 'user.email', 'workbook@example.invalid');
    await fs.writeFile(basePath, workbook('base initial')); await fs.writeFile(minePath, workbook('mine initial'));
    git(root, 'add', 'base.xlsx', 'mine.xlsx'); git(root, 'commit', '-m', 'initial'); const firstCommit = git(root, 'rev-parse', 'HEAD');
    await fs.writeFile(basePath, workbook('base committed')); git(root, 'commit', '-am', 'base update'); const baseCommit = git(root, 'rev-parse', 'HEAD');
    await fs.writeFile(minePath, workbook('mine committed')); git(root, 'commit', '-am', 'mine update'); const mineCommit = git(root, 'rev-parse', 'HEAD');
    await fs.writeFile(basePath, workbook('base working')); await fs.writeFile(minePath, workbook('mine working'));
    const initial = await buildSmartLocalFileDiffData(basePath, minePath, 'strict');
    assert.ok(initial.workbookArtifact); assert.deepEqual(await values(initial.workbookArtifact.artifactId), ['base working', 'mine working']);
    const initialMode = await loadWorkbookCompareModeData('content', SPECIAL_BASE_ID, SPECIAL_MINE_ID);
    assert.equal(initialMode.workbookArtifact?.artifactId, initial.workbookArtifact.artifactId);
    const histories = await Promise.all([queryTwoFileRevisionOptions({ targetSide: 'base', limit: 10 }), queryTwoFileRevisionOptions({ targetSide: 'mine', limit: 10 })]);
    assert.deepEqual(histories[0].items.map(item => item.id), [baseCommit, firstCommit]);
    assert.deepEqual(histories[1].items.map(item => item.id), [mineCommit, firstCommit]);
    const switched = await buildTwoFileVersionDiffData(firstCommit, mineCommit, 'strict');
    assert.ok(switched.workbookArtifact); assert.deepEqual(await values(switched.workbookArtifact.artifactId), ['base initial', 'mine committed']);
    const mode = await loadWorkbookCompareModeData('content', firstCommit, mineCommit);
    assert.equal(mode.workbookArtifact?.artifactId, switched.workbookArtifact.artifactId);
    const metadata = await loadWorkbookMetadataData(firstCommit, mineCommit);
    assert.deepEqual(Object.keys(metadata.base?.sheets ?? {}), ['Thing']);
    clearActiveTwoFileVersionSession();
    const working = await buildSmartWorkingCopyDiffData(minePath, 'strict');
    assert.ok(working.workbookArtifact); assert.deepEqual(await values(working.workbookArtifact.artifactId), ['mine committed', 'mine working']);
    assert.equal(await fs.realpath(getActiveCliArgs().minePath), await fs.realpath(minePath));
    assert.equal((await loadWorkbookCompareModeData('content')).workbookArtifact?.artifactId, working.workbookArtifact.artifactId);
    const original = await buildGitFileRevisionDiffData(firstCommit, mineCommit, 'strict');
    assert.ok(original.workbookArtifact); assert.deepEqual(await values(original.workbookArtifact.artifactId), ['mine initial', 'mine committed']);
  } finally { await releaseWorkbookArtifacts(); clearActiveTwoFileVersionSession(); clearActiveGitWorkingFileSession(); await fs.rm(root, { recursive: true, force: true }); }
});
