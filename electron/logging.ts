export type MainConsoleLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

function isEnvFlagEnabled(name: string): boolean {
  return process.env[name]?.trim() === '1';
}

function isMainDebugLoggingEnabled(): boolean {
  return isEnvFlagEnabled('SVN_DIFF_DEBUG_LOG') || isEnvFlagEnabled('SVN_DIFF_DEBUG_TIMING');
}

function emitMainLog(level: MainConsoleLogLevel, scope: string, values: unknown[]): void {
  if (level === 'debug' && !isMainDebugLoggingEnabled()) return;

  const consoleMethod = (console[level] ?? console.log).bind(console);
  const prefix = `[${scope}]`;
  if (values.length === 0) {
    consoleMethod(prefix);
    return;
  }

  consoleMethod(prefix, ...values);
}

export function logMain(scope: string, ...values: unknown[]): void {
  emitMainLog('log', scope, values);
}

export function logMainWarn(scope: string, ...values: unknown[]): void {
  emitMainLog('warn', scope, values);
}

export function logMainError(scope: string, ...values: unknown[]): void {
  emitMainLog('error', scope, values);
}

export function logMainDebug(scope: string, ...values: unknown[]): void {
  emitMainLog('debug', scope, values);
}
