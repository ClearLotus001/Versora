import { createAbortError, createLatestRequestTracker } from './latestRequest';

interface WorkerResponseWithRequestId {
  requestId: number;
}

type WorkerResponseResult<TResult> =
  | { ok: true; result: TResult }
  | { ok: false; error: unknown };

interface PendingWorkerRequest<TResult> {
  resolve: (result: TResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface LatestWorkerClientOptions<
  TInput,
  TRequest,
  TResponse extends WorkerResponseWithRequestId,
  TResult,
> {
  createWorker: () => Worker;
  buildRequest: (requestId: number, input: TInput) => TRequest;
  parseResponse: (response: TResponse) => WorkerResponseResult<TResult>;
  beforeRequest?: (worker: Worker, input: TInput) => void;
  requestTimeoutMs?: number;
  supersededMessage: string;
  staleMessage: string;
  workerErrorMessage: string;
  workerMessageErrorMessage: string;
  workerUnavailableMessage?: string;
  onDispose?: () => void;
}

export interface LatestWorkerClient<TInput, TResult> {
  compute: (input: TInput) => Promise<TResult>;
  warmup: () => void;
  dispose: () => void;
}

function normalizeError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error || fallbackMessage);
  return new Error(String(error ?? fallbackMessage));
}

export function createLatestWorkerClient<
  TInput,
  TRequest,
  TResponse extends WorkerResponseWithRequestId,
  TResult,
>(
  options: LatestWorkerClientOptions<TInput, TRequest, TResponse, TResult>,
): LatestWorkerClient<TInput, TResult> {
  let worker: Worker | null = null;
  const requestTracker = createLatestRequestTracker();
  const pending = new Map<number, PendingWorkerRequest<TResult>>();
  const configuredTimeout = options.requestTimeoutMs ?? 30_000;
  const requestTimeoutMs = Number.isFinite(configuredTimeout) ? Math.max(1, configuredTimeout) : 30_000;

  const stopWorker = () => {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      worker = null;
    }
    options.onDispose?.();
  };

  const failPendingRequests = (error: Error) => {
    const pendingEntries = [...pending.values()];
    pending.clear();
    stopWorker();
    pendingEntries.forEach((entry) => {
      clearTimeout(entry.timeout);
      entry.reject(error);
    });
  };

  const dispose = () => {
    requestTracker.begin();
    failPendingRequests(createAbortError(options.supersededMessage));
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;

    const nextWorker = options.createWorker();
    nextWorker.onmessage = (event: MessageEvent<TResponse>) => {
      if (worker !== nextWorker) return;
      const response = event.data;
      if (!response || typeof response.requestId !== 'number') {
        failPendingRequests(new Error(options.workerMessageErrorMessage));
        return;
      }
      const entry = pending.get(response.requestId);
      if (!entry) return;

      pending.delete(response.requestId);
      clearTimeout(entry.timeout);
      if (!requestTracker.isCurrent(response.requestId)) {
        entry.reject(createAbortError(options.staleMessage));
        return;
      }

      try {
        const result = options.parseResponse(response);
        if (result.ok) {
          entry.resolve(result.result);
        } else {
          stopWorker();
          entry.reject(normalizeError(result.error, options.workerErrorMessage));
        }
      } catch (error) {
        stopWorker();
        entry.reject(normalizeError(error, options.workerMessageErrorMessage));
      }
    };
    nextWorker.onerror = (event) => {
      if (worker !== nextWorker) return;
      failPendingRequests(
        normalizeError(
          event.message || options.workerErrorMessage,
          options.workerErrorMessage,
        ),
      );
    };
    nextWorker.onmessageerror = () => {
      if (worker !== nextWorker) return;
      failPendingRequests(new Error(options.workerMessageErrorMessage));
    };

    worker = nextWorker;
    return nextWorker;
  };

  return {
    compute: (input: TInput): Promise<TResult> => {
      if (pending.size > 0) dispose();
      if (typeof Worker === 'undefined') {
        return Promise.reject(
          new Error(options.workerUnavailableMessage ?? 'Web Worker is unavailable.'),
        );
      }

      return new Promise((resolve, reject) => {
        const requestId = requestTracker.begin();
        const timeout = setTimeout(() => {
          if (!pending.has(requestId)) return;
          const error = new Error(`${options.workerErrorMessage} Request timed out.`);
          error.name = 'TimeoutError';
          failPendingRequests(error);
        }, requestTimeoutMs);
        pending.set(requestId, { resolve, reject, timeout });

        try {
          const activeWorker = ensureWorker();
          options.beforeRequest?.(activeWorker, input);
          activeWorker.postMessage(options.buildRequest(requestId, input));
        } catch (error) {
          failPendingRequests(normalizeError(error, options.workerErrorMessage));
        }
      });
    },
    warmup: () => {
      if (typeof Worker === 'undefined') return;
      try {
        ensureWorker();
      } catch {
        // A failed warmup is reported by the next compute request.
      }
    },
    dispose,
  };
}

