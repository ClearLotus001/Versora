import type { SearchScanResult } from '@/engine/text/search';
import { createLatestWorkerClient } from '@/utils/async/latestWorkerClient';

interface SearchOptions {
  query: string;
  isRegex: boolean;
  isCaseSensitive: boolean;
}

interface TextSearchWorkerSetLinesRequest {
  type: 'set-lines';
  lines: string[];
  lineStartOffsets: number[] | null;
}

interface TextSearchWorkerSearchRequest {
  type: 'search';
  requestId: number;
  query: string;
  isRegex: boolean;
  isCaseSensitive: boolean;
}

interface TextSearchWorkerSuccess {
  ok: true;
  requestId: number;
  result: SearchScanResult;
}

interface TextSearchWorkerFailure {
  ok: false;
  requestId: number;
  error: string;
}

type TextSearchWorkerResponse = TextSearchWorkerSuccess | TextSearchWorkerFailure;

interface TextSearchRequestInput {
  searchableLines: string[];
  lineStartOffsets: number[] | null;
  options: SearchOptions;
}

let workerSearchableLines: string[] | null = null;
let workerLineStartOffsets: number[] | null = null;

const textSearchWorkerClient = createLatestWorkerClient<
  TextSearchRequestInput,
  TextSearchWorkerSearchRequest,
  TextSearchWorkerResponse,
  SearchScanResult
>({
  createWorker: () => new Worker(
    new URL('../../workers/text/textSearchWorker.ts', import.meta.url),
    { type: 'module' },
  ),
  beforeRequest: (worker, input) => {
    if (
      workerSearchableLines === input.searchableLines
      && workerLineStartOffsets === input.lineStartOffsets
    ) return;

    worker.postMessage({
      type: 'set-lines',
      lines: input.searchableLines,
      lineStartOffsets: input.lineStartOffsets,
    } satisfies TextSearchWorkerSetLinesRequest);
    workerSearchableLines = input.searchableLines;
    workerLineStartOffsets = input.lineStartOffsets;
  },
  buildRequest: (requestId, input) => ({
    type: 'search',
    requestId,
    query: input.options.query,
    isRegex: input.options.isRegex,
    isCaseSensitive: input.options.isCaseSensitive,
  } satisfies TextSearchWorkerSearchRequest),
  parseResponse: (response) => (
    response.ok
      ? { ok: true, result: response.result }
      : { ok: false, error: response.error }
  ),
  supersededMessage: 'Superseded search request.',
  staleMessage: 'Discarded stale search result.',
  workerErrorMessage: 'Failed to compute search matches in worker.',
  workerMessageErrorMessage: 'Failed to receive search worker result.',
  onDispose: () => {
    workerSearchableLines = null;
    workerLineStartOffsets = null;
  },
});

export function disposeTextSearchWorker(): void {
  textSearchWorkerClient.dispose();
}

export function computeSearchMatchesAsync(
  searchableLines: string[],
  options: SearchOptions,
  lineStartOffsets: number[] | null = null,
): Promise<SearchScanResult> {
  if (!options.query) {
    if (workerSearchableLines || workerLineStartOffsets) disposeTextSearchWorker();
    return Promise.resolve({ matches: [], totalCount: 0, truncated: false });
  }
  return textSearchWorkerClient.compute({ searchableLines, lineStartOffsets, options });
}
