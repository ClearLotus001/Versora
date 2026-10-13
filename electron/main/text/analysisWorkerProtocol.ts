import type { PreparedTextAnalysis } from '../types.js';

export interface TextAnalysisWorkerRequest {
  baseText: string;
  mineText: string;
}

export type TextAnalysisWorkerResponse =
  | { ok: true; analysis: PreparedTextAnalysis }
  | { ok: false; error: string };
