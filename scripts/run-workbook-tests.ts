import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const testsDir = path.join(repoRoot, 'tests');
const rustRequiredTests = new Set([
  'comparison-ipc-workbook-swap.test.ts',
  'local-diff-follow-up-loaders.test.ts',
  'rust-workbook-diff-smoke.test.ts',
  'two-file-svn-revision-compare.test.ts',
  'workbook-artifact-git-revision.test.ts',
]);
const args = process.argv.slice(2);
const skipRustRequired = args.includes('--skip-rust-required');
const onlyRustRequired = args.includes('--only-rust-required');

if (skipRustRequired && onlyRustRequired) {
  console.error('Use either --skip-rust-required or --only-rust-required, not both.');
  process.exit(1);
}

const mode = onlyRustRequired ? 'rust integration' : skipRustRequired ? 'unit' : 'all';
const testFiles = readdirSync(testsDir)
  .filter((fileName) => /\.test\.tsx?$/.test(fileName))
  .filter((fileName) => {
    const rustRequired = rustRequiredTests.has(fileName);
    if (skipRustRequired) return !rustRequired;
    if (onlyRustRequired) return rustRequired;
    return true;
  })
  .sort()
  .map((fileName) => path.join('tests', fileName));

if (testFiles.length === 0) {
  console.error('No workbook test files matched.');
  process.exit(1);
}

const tsxCliPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const failedFiles: string[] = [];
const useGithubLogGroups = process.env.GITHUB_ACTIONS === 'true';

function beginTestLog(testFile: string) {
  const title = `[workbook-tests] ${testFile}`;
  if (useGithubLogGroups) {
    console.log(`::group::${title}`);
    return;
  }
  console.log(`\n${title}`);
}

function endTestLog() {
  if (useGithubLogGroups) {
    console.log('::endgroup::');
  }
}

console.log(`[workbook-tests] Running ${testFiles.length} ${mode} test file(s) in isolated Node test processes.`);

for (const testFile of testFiles) {
  beginTestLog(testFile);
  const result = spawnSync(process.execPath, [tsxCliPath, '--test', testFile], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });

  if (result.error) {
    console.error(`Failed to run ${tsxCliPath}.`);
    console.error(result.error.message);
    endTestLog();
    process.exit(1);
  }

  if (result.status !== 0) {
    failedFiles.push(testFile);
  }

  if (result.signal) {
    console.error(`Workbook tests were terminated by signal ${result.signal}.`);
    failedFiles.push(testFile);
  }

  endTestLog();
}

if (failedFiles.length > 0) {
  console.error('\n[workbook-tests] Failed files:');
  failedFiles.forEach((fileName) => console.error(`- ${fileName}`));
  process.exit(1);
}
