import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(__dirname, '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

test('development preflight requires a native parser and releases its lock after failure', () => {
  const taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'versora-dev-preflight-'));
  try {
    const scriptsDir = path.join(taskRoot, 'scripts');
    fs.mkdirSync(scriptsDir);
    for (const name of ['dev-app.ts', 'rustArtifacts.ts']) {
      fs.copyFileSync(path.join(repoRoot, 'scripts', name), path.join(scriptsDir, name));
    }
    const run = () => spawnSync(process.execPath, [tsxCli, path.join(scriptsDir, 'dev-app.ts')], {
      cwd: taskRoot,
      env: { ...process.env, SVN_DIFF_SKIP_RUST_BUILD: '1', SVN_DIFF_DEV_RUST_CHECK_ONLY: '1' },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });

    const missing = run();
    assert.ifError(missing.error);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Rust workbook parser is missing/);

    const parserName = process.platform === 'win32' ? 'svn_excel_parser.exe' : 'svn_excel_parser';
    const parserPath = path.join(taskRoot, 'rust', 'target', 'release', parserName);
    fs.mkdirSync(path.dirname(parserPath), { recursive: true });
    fs.writeFileSync(parserPath, 'preflight existence fixture');

    const ready = run();
    assert.ifError(ready.error);
    assert.equal(ready.status, 0, ready.stderr);
    assert.match(ready.stdout, /Rust artifact check completed/);
  } finally {
    fs.rmSync(taskRoot, { recursive: true, force: true });
  }
});
