import * as path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

export function resolveElectronAppRoot(currentDir: string): string {
  const appRootCandidate = path.resolve(currentDir, '..', '..');
  return path.basename(appRootCandidate) === 'dist-electron'
    ? path.dirname(appRootCandidate)
    : appRootCandidate;
}

export const APP_ROOT = resolveElectronAppRoot(__dirname);
export const RENDERER_DIST = path.join(APP_ROOT, 'dist');
export const PRELOAD_PATH = path.join(__dirname, '..', 'preload.js');
export const DEV_SERVER_URL = process.env.DEV_SERVER_URL?.trim() || 'http://localhost:5173';
export const WORKBOOK_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xltx', '.xltm', '.xlsb', '.xls']);
export const RUST_PARSER_NAME = process.platform === 'win32' ? 'svn_excel_parser.exe' : 'svn_excel_parser';
export const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  trimValues: false,
});
export const SPECIAL_BASE_ID = '__base_input__';
export const SPECIAL_MINE_ID = '__mine_input__';
export const REMOTE_HEAD_ID = '__remote_head__';
export const TRAILING_PAREN_VERSION = /\(([^)]+)\)\s*$/;
export const KEYWORD_VERSION = /\b(?:r|rev|revision|ver|version|v)\s*[:#-]?\s*([0-9][\w.-]*)\b/i;
const configuredRustCommandTimeoutMs = Number(process.env.SVN_DIFF_RUST_TIMEOUT_MS ?? 120_000);
export const RUST_COMMAND_TIMEOUT_MS = Number.isFinite(configuredRustCommandTimeoutMs)
  ? Math.max(1_000, configuredRustCommandTimeoutMs)
  : 120_000;
export const SVN_TEXT_MAX_BUFFER = 64 * 1024 * 1024;
export const SVN_BINARY_MAX_BUFFER = 256 * 1024 * 1024;
const configuredSvnCommandTimeoutMs = Number(process.env.VERSORA_SVN_TIMEOUT_MS ?? 60_000);
const configuredSvnCommandConcurrency = Number(process.env.VERSORA_SVN_MAX_CONCURRENCY ?? 4);
const configuredSvnCommandQueue = Number(process.env.VERSORA_SVN_MAX_QUEUE ?? 12);
export const SVN_COMMAND_TIMEOUT_MS = Number.isFinite(configuredSvnCommandTimeoutMs)
  ? Math.max(1_000, configuredSvnCommandTimeoutMs)
  : 60_000;
export const SVN_COMMAND_MAX_CONCURRENCY = Number.isFinite(configuredSvnCommandConcurrency)
  ? Math.max(1, Math.min(16, Math.floor(configuredSvnCommandConcurrency)))
  : 4;
export const SVN_COMMAND_MAX_QUEUE = Number.isFinite(configuredSvnCommandQueue)
  ? Math.max(0, Math.min(64, Math.floor(configuredSvnCommandQueue)))
  : 12;
export const FILE_PAYLOAD_CACHE_LIMIT = 12;
export const REVISION_PAYLOAD_CACHE_LIMIT = 24;
export const FILE_PAYLOAD_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const REVISION_PAYLOAD_CACHE_MAX_BYTES = 128 * 1024 * 1024;
export const DEV_PROFILE_ROOT = process.env.ELECTRON_DEV_PROFILE_DIR?.trim() || '';
export const AUTO_EXIT_AFTER_LOAD_MS = Number(process.env.SVN_DIFF_AUTO_EXIT_AFTER_LOAD_MS ?? '0');
export const DEFAULT_REVISION_QUERY_LIMIT = 50;
export const MAX_REVISION_QUERY_LIMIT = 100;
export const USE_NATIVE_WINDOW_CONTROLS = process.env.SVN_DIFF_NATIVE_WINDOW_CONTROLS === '1';
export const DEFAULT_LAUNCH_MAXIMIZED = true;
export const REVISION_OPTION_PAGES_CACHE_LIMIT = 24;
