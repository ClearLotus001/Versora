import * as fs from 'node:fs';
import * as path from 'node:path';
import { getRuntimePathState } from '../runtimePaths.js';
import { logMain, logMainDebug } from '../logging.js';

function isEnvFlagEnabled(name: string): boolean {
  return process.env[name]?.trim() === '1';
}

function isExternalDiffDebugLogEnabled(): boolean {
  return isEnvFlagEnabled('SVN_DIFF_DEBUG_LOG') || isEnvFlagEnabled('SVN_DIFF_DEBUG_TIMING');
}

export function logDebugTiming(message: string, payload?: unknown): void {
  if (process.env.SVN_DIFF_DEBUG_TIMING !== '1') return;
  if (payload === undefined) {
    logMain('debug-timing', message);
    writeExternalDiffDebugLog(message);
    return;
  }
  logMain('debug-timing', message, payload);
  writeExternalDiffDebugLog(message, payload);
}

function toSerializableDebugValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ?? '',
    };
  }
  if (Array.isArray(value)) {
    return value.map(item => toSerializableDebugValue(item));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([key, entryValue]) => [key, toSerializableDebugValue(entryValue)],
      ),
    );
  }
  return String(value);
}

function resolveExternalDiffDebugLogPath(): string | null {
  const runtimePaths = getRuntimePathState();
  const logRoot = [
    runtimePaths.logsPath,
    runtimePaths.userDataPath ? path.join(runtimePaths.userDataPath, 'logs') : null,
    process.env.APPDATA?.trim()
      ? path.join(process.env.APPDATA.trim(), 'versora', 'logs')
      : null,
    path.join(process.cwd(), 'logs'),
  ].find((candidateRoot): candidateRoot is string => Boolean(candidateRoot?.trim()));

  if (!logRoot) return null;
  return path.join(logRoot, 'external-diff-debug.log');
}

export function writeExternalDiffDebugLog(event: string, payload?: unknown): void {
  if (!isExternalDiffDebugLogEnabled()) return;

  const targetPath = resolveExternalDiffDebugLogPath();
  if (!targetPath) return;

  const entry = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    event,
    payload: payload === undefined ? null : toSerializableDebugValue(payload),
  };

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.appendFileSync(targetPath, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch (error) {
    logMainDebug(
      'debug-log',
      'write skipped:',
      targetPath,
      error instanceof Error ? error.message : String(error),
    );
  }
}
