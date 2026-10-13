import { parentPort, workerData } from 'node:worker_threads';
import { prepareTextDiffAnalysis } from './diff.js';
import type { TextAnalysisWorkerRequest, TextAnalysisWorkerResponse } from './analysisWorkerProtocol.js';

if (!parentPort) throw new Error('Text analysis must run in a worker thread.');

const input = workerData as TextAnalysisWorkerRequest;
let response: TextAnalysisWorkerResponse;
try {
  if (typeof input?.baseText !== 'string' || typeof input?.mineText !== 'string') {
    throw new Error('Invalid text analysis request.');
  }
  response = { ok: true, analysis: prepareTextDiffAnalysis(input.baseText, input.mineText) };
} catch (error) {
  response = { ok: false, error: error instanceof Error ? error.message : String(error) };
}
parentPort.postMessage(response);
parentPort.close();
