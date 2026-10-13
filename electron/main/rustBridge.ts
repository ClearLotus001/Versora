import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  APP_ROOT,
  RUST_PARSER_NAME,
  SVN_BINARY_MAX_BUFFER,
  SVN_COMMAND_MAX_CONCURRENCY,
  SVN_COMMAND_MAX_QUEUE,
  SVN_COMMAND_TIMEOUT_MS,
  SVN_TEXT_MAX_BUFFER,
} from './constants.js';
import { BoundedCommandGate } from './commandGate.js';
import { streamCommandToFile } from './streamCommandToFile.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Command execution helpers
// ---------------------------------------------------------------------------

async function execFileTextCommand(
  file: string,
  args: string[],
  maxBuffer: number,
  timeout?: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(file, args, {
      encoding: 'utf-8',
      windowsHide: true,
      maxBuffer,
      ...(timeout != null ? { timeout } : {}),
    }) as { stdout: string; stderr: string };

    return {
      ok: true,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (error) {
    const execError = error as Error & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? execError.message,
    };
  }
}

async function execFileBufferCommand(
  file: string,
  args: string[],
  maxBuffer: number,
  timeout?: number,
): Promise<{ ok: boolean; stdout: Buffer; stderr: string }> {
  try {
    const result = await execFileAsync(file, args, {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer,
      ...(timeout != null ? { timeout } : {}),
    }) as { stdout: Buffer; stderr: Buffer };

    return {
      ok: true,
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ''),
      stderr: Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf-8') : String(result.stderr ?? ''),
    };
  } catch (error) {
    const execError = error as Error & { stdout?: Buffer; stderr?: Buffer | string };
    return {
      ok: false,
      stdout: Buffer.isBuffer(execError.stdout) ? execError.stdout : Buffer.alloc(0),
      stderr: Buffer.isBuffer(execError.stderr)
        ? execError.stderr.toString('utf-8')
        : typeof execError.stderr === 'string'
        ? execError.stderr
        : execError.message,
    };
  }
}

// ---------------------------------------------------------------------------
// SVN command wrappers
// ---------------------------------------------------------------------------

const svnCommandGate = new BoundedCommandGate(
  SVN_COMMAND_MAX_CONCURRENCY,
  SVN_COMMAND_MAX_QUEUE,
  'Too many SVN commands are already running or queued.',
);

export function runSvnUtf8(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return svnCommandGate
    .run(() => execFileTextCommand('svn', args, SVN_TEXT_MAX_BUFFER, SVN_COMMAND_TIMEOUT_MS))
    .catch((error: unknown) => ({
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }));
}

export function runSvnBuffer(args: string[]): Promise<{ ok: boolean; stdout: Buffer; stderr: string }> {
  return svnCommandGate
    .run(() => execFileBufferCommand('svn', args, SVN_BINARY_MAX_BUFFER, SVN_COMMAND_TIMEOUT_MS))
    .catch((error: unknown) => ({
      ok: false,
      stdout: Buffer.alloc(0),
      stderr: error instanceof Error ? error.message : String(error),
    }));
}

export function runSvnToFile(args: string[], destination: string, signal?: AbortSignal): Promise<void> {
  return svnCommandGate.run(() => streamCommandToFile('svn', args, destination, {
    ...(signal ? { signal } : {}), timeoutMs: SVN_COMMAND_TIMEOUT_MS,
  }), signal);
}

// ---------------------------------------------------------------------------
// Rust parser path resolution
// ---------------------------------------------------------------------------

export function resolveRustParserPath(): string | null {
  const candidates = [
    path.join(APP_ROOT, 'rust', 'target', 'release', RUST_PARSER_NAME),
    path.join(process.resourcesPath, 'bin', RUST_PARSER_NAME),
  ];

  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

