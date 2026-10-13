import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildCargoEnv, getRustArtifactPaths, resolveCargoExecutable } from './rustArtifacts';

type RustLintTask = 'all' | 'fmt' | 'clippy';

const repoRoot = path.resolve(__dirname, '..');
const task = (process.argv[2] ?? 'all') as RustLintTask;
const validTasks = new Set<RustLintTask>(['all', 'fmt', 'clippy']);

if (!validTasks.has(task)) {
  console.error(`Unknown Rust lint task "${task}". Use all, fmt, or clippy.`);
  process.exit(1);
}

const probe = resolveCargoExecutable();
if (!probe.ok) {
  console.error(probe.message);
  console.error('Download Rust from https://rustup.rs/ or set CARGO to a working cargo executable.');
  process.exit(1);
}

const { manifestPath } = getRustArtifactPaths(repoRoot);
const env = buildCargoEnv(process.env, process.platform);
const cargoPath = probe.cargoPath;

function runCargo(args: string[]): void {
  const result = spawnSync(cargoPath, args, {
    cwd: repoRoot,
    env,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });

  if (result.error) {
    console.error(`Failed to run Rust cargo executable "${cargoPath}": ${result.error.message}`);
    process.exit(1);
  }

  if (typeof result.status === 'number') {
    process.exitCode = result.status;
    return;
  }

  console.error(`Rust lint command was terminated${result.signal ? ` by signal ${result.signal}` : ''}.`);
  process.exit(1);
}

if (task === 'all' || task === 'fmt') {
  runCargo(['fmt', '--manifest-path', manifestPath, '--all', '--check']);
  if (process.exitCode) process.exit(process.exitCode);
}

if (task === 'all' || task === 'clippy') {
  runCargo(['clippy', '--manifest-path', manifestPath, '--workspace', '--all-targets', '--', '-D', 'warnings']);
  if (process.exitCode) process.exit(process.exitCode);
}
