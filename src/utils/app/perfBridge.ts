import type { DiffPerformanceMetrics, LayoutMode, WorkbookCompareMode } from '@/types';

export interface PerfBridgeSnapshot {
  workbookArtifact?: ReturnType<import('@/utils/workbook/workbookArtifactProvider').WorkbookArtifactProvider['getPerfSummary']>;
  hasLoadedDiff: boolean;
  isLoadingDiff: boolean;
  loadPhase: 'bootstrapping' | 'idle' | 'loading' | 'ready' | 'error';
  layout: LayoutMode;
  isWorkbookMode: boolean;
  compareMode: WorkbookCompareMode;
  fileName: string;
  activeWorkbookSheetName: string | null;
  viewReadyToken: number;
  loadPerfMetrics: DiffPerformanceMetrics | null;
}

export type PerfBridgeEventName =
  | 'layout-change:start'
  | 'workbook-compare-mode:start'
  | 'diff-payload:request'
  | 'diff-payload:ready'
  | 'apply-diff-data:start'
  | 'apply-diff-data:commit'
  | 'view-ready';

export interface PerfBridgeEvent {
  id: number;
  at: number;
  name: PerfBridgeEventName;
  details?: Record<string, unknown>;
}

export interface PerfBridge {
  readCells?(request: { sheetId: number; side: 'base' | 'mine'; rowNumber: number; column: number }): Promise<import('../../../shared/workbookArtifactProtocol').WorkbookArtifactCellsResult['cells'][number] | undefined>;
  getSnapshot(): PerfBridgeSnapshot;
  getEvents(): PerfBridgeEvent[];
  clearEvents(): void;
}

interface PerfBridgeState {
  nextId: number;
  events: PerfBridgeEvent[];
}

const PERF_EVENT_LIMIT = 200;

function getPerfBridgeState(): PerfBridgeState | null {
  if (typeof window === 'undefined' || !shouldEnablePerfBridge()) return null;
  const perfWindow = window as Window & { __SVN_DIFF_PERF_STATE__?: PerfBridgeState };
  if (!perfWindow.__SVN_DIFF_PERF_STATE__) {
    perfWindow.__SVN_DIFF_PERF_STATE__ = {
      nextId: 1,
      events: [],
    };
  }
  return perfWindow.__SVN_DIFF_PERF_STATE__;
}

export function recordPerfBridgeEvent(
  name: PerfBridgeEventName,
  details?: Record<string, unknown>,
) {
  const state = getPerfBridgeState();
  if (!state) return;

  state.events.push({
    id: state.nextId,
    at: globalThis.performance?.now() ?? Date.now(),
    name,
    ...(details ? { details } : {}),
  });
  state.nextId += 1;

  if (state.events.length > PERF_EVENT_LIMIT) {
    state.events.splice(0, state.events.length - PERF_EVENT_LIMIT);
  }
}

export function getPerfBridgeEvents(): PerfBridgeEvent[] {
  const state = getPerfBridgeState();
  return state ? [...state.events] : [];
}

export function clearPerfBridgeEvents() {
  const state = getPerfBridgeState();
  if (!state) return;
  state.events = [];
}

export function shouldEnablePerfBridge() {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('__perf') === '1';
}

declare global {
  interface Window {
    __SVN_DIFF_PERF__?: PerfBridge;
    __SVN_DIFF_PERF_STATE__?: PerfBridgeState;
  }
}
