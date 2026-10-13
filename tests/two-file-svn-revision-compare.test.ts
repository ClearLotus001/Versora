import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

import { REMOTE_HEAD_ID } from '../electron/main/constants';
import {
  buildDevWorkingCopyDiffData,
  buildDiffData,
  buildLocalDiffData,
  buildTwoFileRevisionDiffData,
  loadWorkbookCompareModeData,
  loadWorkbookMetadataData,
} from '../electron/main/diffBuilder';
import { loadSvnLineBlame, queryRevisionOptions } from '../electron/main/svnOperations';
import { loadWorkingCopyLineBlame } from '../electron/main/workingCopyLineBlame';
import { setActiveCliArgs } from '../electron/main/state';
import { EMPTY_CLI_ARGS } from '../electron/cliArgs';
import { getWorkbookArtifactReader, releaseWorkbookArtifacts } from '../electron/main/workbookArtifactService';
import {
  cleanupManagedTempFilesOnExitSync,
  configureRuntimePaths,
} from '../electron/runtimePaths';

type MockApp = Parameters<typeof configureRuntimePaths>[0];

function createMockApp(sandboxDir: string): MockApp {
  const knownPaths = new Map<string, string>();
  return {
    commandLine: { appendSwitch() {} },
    setPath(name: string, targetPath: string) {
      knownPaths.set(name, targetPath);
    },
    getPath(name: string) {
      return knownPaths.get(name) ?? path.join(sandboxDir, name);
    },
  } as unknown as MockApp;
}

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function haveSvnTools(): boolean {
  return spawnSync('svn', ['--version', '--quiet'], { windowsHide: true }).status === 0
    && spawnSync('svnadmin', ['--version', '--quiet'], { windowsHide: true }).status === 0;
}

function buildWorkbookZip(value: string): Uint8Array {
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
        <sheets><sheet name="Thing" sheetId="1" r:id="rId1" /></sheets>
      </workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml" />
      </Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${value}</t></is></c></row></sheetData></worksheet>`),
  });
}

test('two working-copy files default to their independent latest revisions and remain switchable', {
  skip: !haveSvnTools(),
}, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'svn-diff-two-wc-'));
  const repositoryPath = path.join(tempDir, 'repository');
  const importPath = path.join(tempDir, 'import');
  const trunkImportPath = path.join(importPath, 'trunk');
  const releaseImportPath = path.join(importPath, 'release');
  const trunkWorkingCopy = path.join(tempDir, 'wc-trunk');
  const releaseWorkingCopy = path.join(tempDir, 'wc-release');
  const repositoryUrl = pathToFileURL(repositoryPath).href;
  const trunkUrl = `${repositoryUrl}/trunk`;
  const releaseUrl = `${repositoryUrl}/release`;

  try {
    if (!process.resourcesPath) {
      Object.defineProperty(process, 'resourcesPath', {
        value: '',
        configurable: true,
      });
    }
    configureRuntimePaths(createMockApp(tempDir), path.join(tempDir, 'runtime'), null);
    run('svnadmin', ['create', repositoryPath]);
    await fs.mkdir(trunkImportPath, { recursive: true });
    await fs.mkdir(releaseImportPath, { recursive: true });
    await fs.writeFile(path.join(trunkImportPath, 'sample.txt'), 'shared initial\n', 'utf8');
    await fs.writeFile(path.join(releaseImportPath, 'sample.txt'), 'shared initial\n', 'utf8');
    await fs.writeFile(path.join(trunkImportPath, 'sample.xlsx'), buildWorkbookZip('shared initial'));
    await fs.writeFile(path.join(releaseImportPath, 'sample.xlsx'), buildWorkbookZip('shared initial'));
    run('svn', ['import', importPath, repositoryUrl, '-m', 'initial layout']);
    run('svn', ['checkout', trunkUrl, trunkWorkingCopy]);
    run('svn', ['checkout', releaseUrl, releaseWorkingCopy]);

    const trunkFile = path.join(trunkWorkingCopy, 'sample.txt');
    const releaseFile = path.join(releaseWorkingCopy, 'sample.txt');
    await fs.writeFile(trunkFile, 'trunk latest\n', 'utf8');
    run('svn', ['commit', trunkFile, '-m', 'update trunk']);
    await fs.writeFile(releaseFile, 'release latest\n', 'utf8');
    run('svn', ['commit', releaseFile, '-m', 'update release']);

    await fs.writeFile(trunkFile, 'trunk local only\n', 'utf8');
    await fs.writeFile(releaseFile, 'release local only\n', 'utf8');

    const workingCopyPairBlame = await loadWorkingCopyLineBlame(trunkFile, releaseFile);
    assert.equal(workingCopyPairBlame.base[0]?.uncommitted, true);
    assert.equal(workingCopyPairBlame.mine[0]?.uncommitted, true);

    const latest = await buildLocalDiffData(trunkFile, releaseFile, 'strict');
    assert.equal(latest.source?.baseKind, 'svn');
    assert.equal(latest.source?.targetKind, 'svn');
    assert.equal(latest.compareContext, 'literal_two_file_compare');
    assert.equal(latest.canSwitchRevisions, true);
    assert.equal(latest.workingCopyAvailable, true);
    assert.equal(latest.baseContent, 'trunk latest\n');
    assert.equal(latest.mineContent, 'release latest\n');
    assert.equal(latest.baseRevisionInfo?.revision, 'r2');
    assert.equal(latest.mineRevisionInfo?.revision, 'r3');
    assert.equal(latest.baseRevisionInfo?.message, 'update trunk');
    assert.equal(latest.mineRevisionInfo?.message, 'update release');
    assert.deepEqual(latest.resetPair, {
      baseRevisionId: REMOTE_HEAD_ID,
      mineRevisionId: REMOTE_HEAD_ID,
    });
    const latestBlame = await loadSvnLineBlame(
      latest.baseRevisionInfo?.id,
      latest.mineRevisionInfo?.id,
    );
    assert.equal(latestBlame.base[0]?.revision, 'r2');
    assert.equal(latestBlame.mine[0]?.revision, 'r3');
    assert.ok(latestBlame.base[0]?.author);
    assert.ok(latestBlame.mine[0]?.date);

    const [baseHistory, mineHistory] = await Promise.all([
      queryRevisionOptions({ limit: 10, targetSide: 'base' }),
      queryRevisionOptions({ limit: 10, targetSide: 'mine' }),
    ]);
    assert.deepEqual(baseHistory.items.map((item) => item.id), ['r2', 'r1']);
    assert.deepEqual(mineHistory.items.map((item) => item.id), ['r3', 'r1']);

    const switched = await buildTwoFileRevisionDiffData('r1', 'r3', 'strict');
    assert.equal(switched.baseContent, 'shared initial\n');
    assert.equal(switched.mineContent, 'release latest\n');
    assert.equal(switched.baseRevisionInfo?.revision, 'r1');
    assert.equal(switched.mineRevisionInfo?.revision, 'r3');
    assert.equal(switched.baseRevisionInfo?.message, 'initial layout');
    assert.equal(switched.mineRevisionInfo?.message, 'update release');
    const switchedBlame = await loadSvnLineBlame(
      switched.baseRevisionInfo?.id,
      switched.mineRevisionInfo?.id,
    );
    assert.equal(switchedBlame.base[0]?.revision, 'r1');
    assert.equal(switchedBlame.mine[0]?.revision, 'r3');

    setActiveCliArgs({
      ...EMPTY_CLI_ARGS,
      basePath: trunkFile,
      minePath: trunkFile,
      baseName: 'sample.txt Revision 1',
      mineName: 'sample.txt Revision 2',
      baseUrl: `${trunkUrl}/sample.txt`,
      mineUrl: `${trunkUrl}/sample.txt`,
      baseRevision: '1',
      mineRevision: '2',
      pegRevision: '2',
      fileName: 'sample.txt',
    });
    const cliRevisionCompare = await buildDiffData();
    assert.equal(cliRevisionCompare.baseRevisionInfo?.message, 'initial layout');
    assert.equal(cliRevisionCompare.mineRevisionInfo?.message, 'update trunk');
    assert.ok(cliRevisionCompare.baseRevisionInfo?.author);
    assert.ok(cliRevisionCompare.mineRevisionInfo?.date);

    setActiveCliArgs({
      ...EMPTY_CLI_ARGS,
      basePath: trunkFile,
      minePath: releaseFile,
    });

    const trunkWorkbook = path.join(trunkWorkingCopy, 'sample.xlsx');
    const releaseWorkbook = path.join(releaseWorkingCopy, 'sample.xlsx');
    await fs.writeFile(trunkWorkbook, buildWorkbookZip('trunk workbook latest'));
    run('svn', ['commit', trunkWorkbook, '-m', 'update trunk workbook']);
    await fs.writeFile(releaseWorkbook, buildWorkbookZip('release workbook latest'));
    run('svn', ['commit', releaseWorkbook, '-m', 'update release workbook']);

    const workbookDiff = await buildLocalDiffData(trunkWorkbook, releaseWorkbook, 'strict');
    assert.equal(workbookDiff.baseRevisionInfo?.revision, 'r4');
    assert.equal(workbookDiff.mineRevisionInfo?.revision, 'r5');
    assert.ok(workbookDiff.workbookArtifact);
    assert.equal(workbookDiff.workbookArtifact.stats.changedCells, 1);
    const artifactWindow = await getWorkbookArtifactReader(workbookDiff.workbookArtifact.artifactId).readWindow({
      artifactId: workbookDiff.workbookArtifact.artifactId, compareMode: 'strict', sheetId: 0, startRow: 0, rowCount: 1, columnRanges: [{ start: 0, end: 1 }],
    });
    assert.equal(artifactWindow.rows[0]?.baseCells[0]?.value, 'trunk workbook latest');
    assert.equal(artifactWindow.rows[0]?.mineCells[0]?.value, 'release workbook latest');
    const contentMode = await loadWorkbookCompareModeData(
      'content',
      workbookDiff.baseRevisionInfo?.id,
      workbookDiff.mineRevisionInfo?.id,
    );
    const metadata = await loadWorkbookMetadataData(
      workbookDiff.baseRevisionInfo?.id,
      workbookDiff.mineRevisionInfo?.id,
    );
    assert.equal(contentMode.workbookArtifact?.artifactId, workbookDiff.workbookArtifact.artifactId);
    assert.equal(contentMode.workbookArtifact?.stats.changedCells, 1);
    assert.deepEqual(Object.keys(metadata.base?.sheets ?? {}), ['Thing']);
    assert.deepEqual(Object.keys(metadata.mine?.sheets ?? {}), ['Thing']);

    const workingCopyDiff = await buildDevWorkingCopyDiffData(trunkFile, 'strict');
    const workingCopyBlame = await loadSvnLineBlame(
      workingCopyDiff.baseRevisionInfo?.id,
      workingCopyDiff.mineRevisionInfo?.id,
    );
    assert.equal(workingCopyBlame.base[0]?.revision, 'r2');
    assert.equal(workingCopyBlame.mine[0]?.uncommitted, true);
  } finally {
    await releaseWorkbookArtifacts();
    setActiveCliArgs(EMPTY_CLI_ARGS);
    cleanupManagedTempFilesOnExitSync();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
