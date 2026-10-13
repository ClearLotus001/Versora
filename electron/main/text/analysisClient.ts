import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { PreparedTextAnalysis } from '../types.js';
import type { TextAnalysisWorkerRequest, TextAnalysisWorkerResponse } from './analysisWorkerProtocol.js';

interface TextAnalysisClientOptions {
  maxConcurrency?: number;
  maxQueue?: number;
  timeoutMs?: number;
  createWorker?: (input: TextAnalysisWorkerRequest) => Worker;
}

interface TextAnalysisJob {
  key: string;
  input: TextAnalysisWorkerRequest;
  promise: Promise<PreparedTextAnalysis>;
  resolve: (analysis: PreparedTextAnalysis) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  deadline: number;
  worker: Worker | null;
  started: boolean;
  settled: boolean;
}

function createTextAnalysisWorker(input: TextAnalysisWorkerRequest): Worker {
  const compiledPath = path.join(__dirname, 'analysisWorker.js');
  const options = {
    workerData: input,
    // CLI/test loaders must not leak into the production Electron worker.
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  };
  if (existsSync(compiledPath)) return new Worker(compiledPath, options);

  // Source-only tsx development/tests run the loader inside the worker. The
  // packaged application always uses the compiled .js file and needs no tsx.
  const sourcePath = path.join(__dirname, 'analysisWorker.ts');
  if (!existsSync(sourcePath)) throw new Error('Text analysis worker is unavailable.');
  const loaderPath = require.resolve('tsx/cjs');
  return new Worker(
    `require(${JSON.stringify(loaderPath)}); require(${JSON.stringify(sourcePath)});`,
    { ...options, eval: true },
  );
}

export class TextAnalysisClient {
  private readonly jobs = new Map<string, TextAnalysisJob>();
  private readonly queue: TextAnalysisJob[] = [];
  private active = 0;
  private clearing = false;
  private readonly maxConcurrency: number;
  private readonly maxQueue: number;
  private readonly timeoutMs: number;
  private readonly createWorker: (input: TextAnalysisWorkerRequest) => Worker;

  constructor(options: TextAnalysisClientOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 2;
    this.maxQueue = options.maxQueue ?? 4;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.createWorker = options.createWorker ?? createTextAnalysisWorker;
    if (!Number.isInteger(this.maxConcurrency) || this.maxConcurrency < 1
      || !Number.isInteger(this.maxQueue) || this.maxQueue < 0
      || !Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('Invalid text analysis worker limits.');
    }
  }

  getSnapshot() {
    return { active: this.active, queued: this.queue.length };
  }

  analyze(key: string, baseText: string, mineText: string): Promise<PreparedTextAnalysis> {
    const existing = this.jobs.get(key);
    if (existing) {
      if (existing.input.baseText !== baseText || existing.input.mineText !== mineText) {
        return Promise.reject(new Error('Text analysis request changed before it finished.'));
      }
      return existing.promise;
    }
    if (this.active >= this.maxConcurrency && this.queue.length >= this.maxQueue) {
      return Promise.reject(new Error('Too many text comparisons are already running or queued.'));
    }

    let resolve!: TextAnalysisJob['resolve'];
    let reject!: TextAnalysisJob['reject'];
    const promise = new Promise<PreparedTextAnalysis>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const job: TextAnalysisJob = {
      key,
      input: { baseText, mineText },
      promise,
      resolve,
      reject,
      // The deadline includes queue time, so a busy worker cannot leave queued
      // IPC requests pending indefinitely.
      timer: setTimeout(() => {
        this.finish(job, new Error('Text comparison timed out.'));
      }, this.timeoutMs),
      deadline: performance.now() + this.timeoutMs,
      worker: null,
      started: false,
      settled: false,
    };
    this.jobs.set(key, job);
    if (this.active < this.maxConcurrency) this.start(job);
    else this.queue.push(job);
    return promise;
  }

  clear(): void {
    this.clearing = true;
    try {
      for (const job of [...this.jobs.values()]) {
        const error = new Error('Text comparison was cancelled.');
        error.name = 'AbortError';
        this.finish(job, error);
      }
    } finally {
      this.clearing = false;
    }
  }

  private start(job: TextAnalysisJob): void {
    if (performance.now() >= job.deadline) {
      this.finish(job, new Error('Text comparison timed out.'));
      return;
    }
    job.started = true;
    this.active += 1;
    try {
      const worker = this.createWorker(job.input);
      job.worker = worker;
      worker.once('message', (response: TextAnalysisWorkerResponse) => {
        if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
          this.finish(job, new Error('Invalid text analysis worker response.'));
        } else if (!response.ok) {
          this.finish(job, new Error(response.error));
        } else if (!response.analysis || !Array.isArray(response.analysis.diffLines)
          || !Array.isArray(response.analysis.splitRowDescriptors)
          || !Array.isArray(response.analysis.replacementPairs)) {
          this.finish(job, new Error('Invalid text analysis worker result.'));
        } else {
          this.finish(job, null, response.analysis);
        }
      });
      worker.once('error', (error: unknown) => {
        this.finish(job, error instanceof Error ? error : new Error(String(error)));
      });
      worker.once('messageerror', () => {
        this.finish(job, new Error('Unable to decode text analysis worker response.'));
      });
      worker.once('exit', (code) => {
        this.finish(job, new Error(`Text analysis worker exited without a result (code ${code}).`));
      });
    } catch (error) {
      this.finish(job, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private finish(job: TextAnalysisJob, error: Error | null, analysis?: PreparedTextAnalysis): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    this.jobs.delete(job.key);
    const queueIndex = this.queue.indexOf(job);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    if (job.started) this.active -= 1;
    if (job.worker) {
      void job.worker.terminate().catch(() => undefined);
      job.worker = null;
    }
    if (error) job.reject(error);
    else job.resolve(analysis!);
    if (!this.clearing) {
      while (this.active < this.maxConcurrency && this.queue.length > 0) {
        this.start(this.queue.shift()!);
      }
    }
  }
}
