import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { getRustArtifactPaths, runRustReleaseBuild } from './rustArtifacts';

const rootDir = path.resolve(__dirname, '..');
const devServerHost = '127.0.0.1';
const viteCliPath = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');
const tscCliPath = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
const tsxCliPath = path.join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const rustArtifactPaths = getRustArtifactPaths(rootDir);
const devAppLockHash = createHash('sha1').update(rootDir).digest('hex').slice(0, 10);
const devAppLockDir = path.join(os.tmpdir(), 'Versora-dev');
const devAppLockPath = path.join(devAppLockDir, `dev-app-${devAppLockHash}.lock.json`);

const processes: ChildProcess[] = [];
let shuttingDown = false;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseDevAppLock() {
  try {
    if (!fs.existsSync(devAppLockPath)) return;
    const raw = fs.readFileSync(devAppLockPath, 'utf-8');
    const parsed = JSON.parse(raw) as { pid?: number };
    if (parsed.pid !== process.pid) return;
    fs.rmSync(devAppLockPath, { force: true });
  } catch {
    // Ignore best-effort lock cleanup failures.
  }
}

function acquireDevAppLock() {
  fs.mkdirSync(devAppLockDir, { recursive: true });

  if (fs.existsSync(devAppLockPath)) {
    try {
      const raw = fs.readFileSync(devAppLockPath, 'utf-8');
      const parsed = JSON.parse(raw) as { pid?: number; startedAt?: string; cwd?: string };
      const existingPid = Number(parsed.pid ?? 0);
      if (isProcessAlive(existingPid) && existingPid !== process.pid) {
        throw new Error(
          `Another 'npm run dev:app' is already running (pid ${existingPid}). ` +
          'Please stop the existing dev session before starting a new one.',
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Another 'npm run dev:app'")) {
        throw error;
      }
    }

    try {
      fs.rmSync(devAppLockPath, { force: true });
    } catch {
      // Ignore stale lock cleanup failures; write below will surface issues.
    }
  }

  fs.writeFileSync(devAppLockPath, JSON.stringify({
    pid: process.pid,
    cwd: rootDir,
    startedAt: new Date().toISOString(),
  }), 'utf-8');
}

function startChild(command: string, args: string[], label: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env,
    stdio: 'inherit',
  });

  processes.push(child);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;

    const normalizedCode = code ?? (signal ? 1 : 0);
    console.error(`[dev-app] ${label} exited with code ${normalizedCode}${signal ? ` (signal: ${signal})` : ''}`);
    shutdown(normalizedCode);
  });
}

function ensureRustArtifacts() {
  if (fs.existsSync(rustArtifactPaths.parserPath)) return;

  if (process.env.SVN_DIFF_SKIP_RUST_BUILD === '1') {
    throw new Error(
      `Rust workbook parser is missing: ${rustArtifactPaths.parserPath}. ` +
      'Run "npm run build:rust" before starting the development app.',
    );
  }

  console.log('[dev-app] Rust workbook parser is missing; building it before Electron starts.');
  const result = runRustReleaseBuild({ repoRoot: rootDir, stdio: 'inherit' });
  if (result.ok && fs.existsSync(rustArtifactPaths.parserPath)) {
    console.log('[dev-app] Rust workbook parser is ready.');
    return;
  }

  throw new Error(result.ok
    ? `Rust build completed but parser artifact was not found: ${rustArtifactPaths.parserPath}`
    : result.message);
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of processes) {
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        // ignore child shutdown failure
      }
    }
  }

  releaseDevAppLock();
  setTimeout(() => process.exit(exitCode), 50);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  acquireDevAppLock();
  ensureRustArtifacts();
  if (process.env.SVN_DIFF_DEV_RUST_CHECK_ONLY === '1') {
    console.log('[dev-app] Rust artifact check completed.');
    releaseDevAppLock();
    return;
  }

  const devServerPort = await findAvailablePort(5173);
  const devServerUrl = `http://${devServerHost}:${devServerPort}`;
  const devBuildEpochMs = Date.now();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    DEV_SERVER_URL: devServerUrl,
    VERSORA_DEV_BUILD_EPOCH_MS: String(devBuildEpochMs),
  };

  console.log(`[dev-app] renderer url: ${devServerUrl}`);

  startChild(process.execPath, [viteCliPath, '--host', devServerHost, '--port', String(devServerPort), '--strictPort'], 'vite', childEnv);
  startChild(process.execPath, [tscCliPath, '-p', 'tsconfig.electron.json', '--watch', '--preserveWatchOutput'], 'tsc', childEnv);
  startChild(process.execPath, [tsxCliPath, 'scripts/dev-electron-runner.ts'], 'electron', childEnv);
}

async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort;
  while (true) {
    const available = await canListen(port);
    if (available) return port;
    port += 1;
  }
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen(port, devServerHost, () => {
      server.close(() => resolve(true));
    });
  });
}

void main().catch((error) => {
  console.error('[dev-app] failed to start', error);
  releaseDevAppLock();
  shutdown(1);
});
