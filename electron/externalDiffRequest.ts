import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EMPTY_CLI_ARGS, type CliArgs } from './cliArgs';
import { copyToManagedTempFileSync } from './runtimePaths';
import { logMainWarn } from './logging';

export interface ExternalDiffRequestPayload {
  version?: unknown;
  basePath?: unknown;
  minePath?: unknown;
  baseName?: unknown;
  mineName?: unknown;
  baseUrl?: unknown;
  mineUrl?: unknown;
  baseRevision?: unknown;
  mineRevision?: unknown;
  pegRevision?: unknown;
  fileName?: unknown;
}

export const EXTERNAL_DIFF_REQUEST_FLAG = '--external-diff-request';
const EXTERNAL_DIFF_REQUEST_VERSION = 1;

export function preserveExternalDiffTempInputsSync(cliArgs: CliArgs): CliArgs {
  const preservedPaths = new Map<string, string>();
  const preservePath = (filePath: string): string => {
    if (!filePath) return filePath;
    const resolvedPath = path.resolve(filePath);
    const relativePath = path.relative(os.tmpdir(), resolvedPath);
    if (path.isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
      return filePath;
    }
    const preservedPath = preservedPaths.get(resolvedPath);
    if (preservedPath) return preservedPath;
    try {
      const copiedPath = copyToManagedTempFileSync('external-input', resolvedPath);
      preservedPaths.set(resolvedPath, copiedPath);
      return copiedPath;
    } catch (error) {
      logMainWarn('external-diff', 'unable to preserve temporary input', { filePath, error });
      return filePath;
    }
  };
  return {
    ...cliArgs,
    basePath: preservePath(cliArgs.basePath),
    minePath: preservePath(cliArgs.minePath),
    baseName: /^base$/i.test(cliArgs.baseName) ? path.basename(cliArgs.basePath) : cliArgs.baseName,
    mineName: /^mine$/i.test(cliArgs.mineName) ? path.basename(cliArgs.minePath) : cliArgs.mineName,
    fileName: cliArgs.fileName || path.basename(cliArgs.minePath || cliArgs.basePath),
  };
}

function normalizeToken(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (!normalized) return '';
  if (normalized.toUpperCase() === 'UNSPECIFIED') return '';
  return normalized;
}

function normalizeCliArgs(input: ExternalDiffRequestPayload): CliArgs {
  return {
    basePath: normalizeToken(input.basePath),
    minePath: normalizeToken(input.minePath),
    baseName: normalizeToken(input.baseName) || EMPTY_CLI_ARGS.baseName,
    mineName: normalizeToken(input.mineName) || EMPTY_CLI_ARGS.mineName,
    baseUrl: normalizeToken(input.baseUrl),
    mineUrl: normalizeToken(input.mineUrl),
    baseRevision: normalizeToken(input.baseRevision),
    mineRevision: normalizeToken(input.mineRevision),
    pegRevision: normalizeToken(input.pegRevision),
    fileName: normalizeToken(input.fileName),
  };
}

export function findExternalDiffRequestPathFromArgv(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]?.trim() ?? '';
    if (!current) continue;

    if (current.startsWith(`${EXTERNAL_DIFF_REQUEST_FLAG}=`)) {
      const value = current.slice(`${EXTERNAL_DIFF_REQUEST_FLAG}=`.length).trim();
      return value || null;
    }

    if (current === EXTERNAL_DIFF_REQUEST_FLAG) {
      const value = argv[index + 1]?.trim() ?? '';
      return value || null;
    }
  }

  return null;
}

export function readExternalDiffRequestCliArgsSync(
  requestPath: string,
  options: { deleteAfterRead?: boolean } = {},
): CliArgs | null {
  const normalizedPath = requestPath.trim();
  if (!normalizedPath) return null;

  try {
    const raw = fs.readFileSync(normalizedPath, 'utf-8');
    const parsed = JSON.parse(raw) as ExternalDiffRequestPayload;
    const version = Number(parsed?.version ?? EXTERNAL_DIFF_REQUEST_VERSION);
    if (version !== EXTERNAL_DIFF_REQUEST_VERSION) return null;

    const cliArgs = normalizeCliArgs(parsed);
    if (!cliArgs.basePath && !cliArgs.minePath) return null;
    return cliArgs;
  } catch {
    return null;
  } finally {
    if (options.deleteAfterRead !== false) {
      try {
        fs.rmSync(normalizedPath, { force: true });
      } catch {
        // Ignore best-effort request cleanup failures.
      }
    }
  }
}

export function resolveLaunchCliArgsFromArgv(
  argv: string[],
  options: { deleteRequestAfterRead?: boolean } = {},
): CliArgs | null {
  const requestPath = findExternalDiffRequestPathFromArgv(argv);
  if (!requestPath) return null;

  return readExternalDiffRequestCliArgsSync(requestPath, {
    deleteAfterRead: options.deleteRequestAfterRead !== false,
  });
}
