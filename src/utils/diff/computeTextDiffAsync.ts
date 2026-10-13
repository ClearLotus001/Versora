import type { DiffLine } from '@/types';
import { createLatestWorkerClient } from '@/utils/async/latestWorkerClient';

interface TextDiffWorkerRequest {
  requestId: number;
  baseText: string;
  mineText: string;
}

interface TextDiffWorkerSuccess {
  ok: true;
  requestId: number;
  diffLines: DiffLine[];
}

interface TextDiffWorkerFailure {
  ok: false;
  requestId: number;
  error: string;
}

type TextDiffWorkerResponse = TextDiffWorkerSuccess | TextDiffWorkerFailure;

interface TextDiffRequestInput {
  baseText: string;
  mineText: string;
}

const textDiffWorkerClient = createLatestWorkerClient<
  TextDiffRequestInput,
  TextDiffWorkerRequest,
  TextDiffWorkerResponse,
  DiffLine[]
>({
  createWorker: () => new Worker(
    new URL('../../workers/text/textDiffWorker.ts', import.meta.url),
    { type: 'module' },
  ),
  buildRequest: (requestId, input) => ({
    requestId,
    baseText: input.baseText,
    mineText: input.mineText,
  } satisfies TextDiffWorkerRequest),
  parseResponse: (response) => (
    response.ok
      ? { ok: true, result: response.diffLines }
      : { ok: false, error: response.error }
  ),
  supersededMessage: 'Superseded text diff request.',
  staleMessage: 'Discarded stale text diff result.',
  workerErrorMessage: 'Failed to compute text diff in worker.',
  workerMessageErrorMessage: 'Failed to receive text diff worker result.',
});

export function warmTextDiffWorker(): void {
  textDiffWorkerClient.warmup();
}

export function computeTextDiffAsync(
  baseText: string,
  mineText: string,
): Promise<DiffLine[]> {
  return textDiffWorkerClient.compute({ baseText, mineText });
}
