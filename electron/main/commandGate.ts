import { AsyncLocalStorage } from 'node:async_hooks';

interface QueuedCommand {
  start: () => void;
}

export interface CommandGateSnapshot {
  active: number;
  queued: number;
  maxConcurrency: number;
  maxQueue: number;
}

export class BoundedCommandGate {
  private active = 0;
  private readonly queue: QueuedCommand[] = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxQueue: number,
    private readonly overloadMessage: string,
  ) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error('Command gate concurrency must be a positive integer.');
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 0) {
      throw new Error('Command gate queue size must be a non-negative integer.');
    }
  }

  getSnapshot(): CommandGateSnapshot {
    return {
      active: this.active,
      queued: this.queue.length,
      maxConcurrency: this.maxConcurrency,
      maxQueue: this.maxQueue,
    };
  }

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    const boundTask = AsyncLocalStorage.bind(task);
    return new Promise<T>((resolve, reject) => {
      let started = false;
      let queued: QueuedCommand | null = null;
      const cancelQueued = () => {
        if (started) return;
        const index = queued ? this.queue.indexOf(queued) : -1;
        if (index >= 0) this.queue.splice(index, 1);
        signal?.removeEventListener('abort', cancelQueued);
        const reason: unknown = signal?.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      };
      signal?.addEventListener('abort', cancelQueued, { once: true });
      const start = () => {
        started = true;
        signal?.removeEventListener('abort', cancelQueued);
        this.active += 1;
        void Promise.resolve()
          .then(boundTask)
          .then(
            (value) => {
              this.release();
              resolve(value);
            },
            (error: unknown) => {
              this.release();
              reject(error instanceof Error ? error : new Error(String(error ?? 'Command failed.')));
            },
          );
      };

      if (this.active < this.maxConcurrency) {
        start();
        return;
      }
      if (this.queue.length >= this.maxQueue) {
        signal?.removeEventListener('abort', cancelQueued);
        reject(new Error(this.overloadMessage));
        return;
      }
      queued = { start };
      this.queue.push(queued);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.queue.shift()?.start();
  }
}
