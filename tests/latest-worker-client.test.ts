import assert from 'node:assert/strict';
import test from 'node:test';

import { createLatestWorkerClient } from '../src/utils/async/latestWorkerClient';

interface Request { requestId: number; input: string }
type Response = { requestId: number; ok: true; value: string } | { requestId: number; ok: false; error: string };

class FakeWorker {
  onmessage: ((event: MessageEvent<Response>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  request: Request | null = null;
  terminated = false;

  postMessage(request: Request) { this.request = request; }
  terminate() { this.terminated = true; }
  succeed(value: string) {
    assert.ok(this.request);
    this.onmessage?.({ data: { requestId: this.request.requestId, ok: true, value } } as MessageEvent<Response>);
  }
}

async function withWorkers(body: () => Promise<void>) {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    await body();
  } finally {
    if (previousWorker === undefined) Reflect.deleteProperty(globalThis, 'Worker');
    else globalThis.Worker = previousWorker;
  }
}

function makeClient(createWorker: () => Worker, requestTimeoutMs = 1_000) {
  return createLatestWorkerClient<string, Request, Response, string>({
    createWorker,
    buildRequest: (requestId, input) => ({ requestId, input }),
    parseResponse: response => response.ok
      ? { ok: true, result: response.value }
      : { ok: false, error: response.error },
    requestTimeoutMs,
    supersededMessage: 'Superseded request.',
    staleMessage: 'Stale request.',
    workerErrorMessage: 'Worker failed.',
    workerMessageErrorMessage: 'Invalid worker response.',
  });
}

test('worker startup failure rejects instead of synchronously recomputing', async () => {
  await withWorkers(async () => {
    const client = makeClient(() => { throw new Error('Cannot start worker.'); });
    await assert.rejects(client.compute('large input'), /Cannot start worker/);
    client.dispose();
  });
});

test('worker results resolve normally and disposal settles an in-flight request', async () => {
  await withWorkers(async () => {
    const worker = new FakeWorker();
    const client = makeClient(() => worker as unknown as Worker);
    const completed = client.compute('first');
    worker.succeed('first result');
    assert.equal(await completed, 'first result');
    const pending = client.compute('second');
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    client.dispose();
    await rejected;
    assert.equal(worker.terminated, true);
  });
});

test('superseded workers cannot publish stale results into the next request', async () => {
  await withWorkers(async () => {
    const workers: FakeWorker[] = [];
    const client = makeClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const first = client.compute('first');
    const rejected = assert.rejects(first, { name: 'AbortError' });
    const staleHandler = workers[0]!.onmessage;
    const staleId = workers[0]!.request!.requestId;
    const second = client.compute('second');
    await rejected;
    assert.equal(workers[0]!.terminated, true);
    staleHandler?.({ data: { requestId: staleId, ok: true, value: 'stale' } } as MessageEvent<Response>);
    workers[1]!.succeed('current');
    assert.equal(await second, 'current');
    client.dispose();
  });
});

test('unresponsive workers time out and a fresh worker can recover', async () => {
  await withWorkers(async () => {
    const workers: FakeWorker[] = [];
    const client = makeClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    }, 10);
    await assert.rejects(client.compute('hang'), { name: 'TimeoutError' });
    assert.equal(workers[0]!.terminated, true);
    const recovered = client.compute('next');
    workers[1]!.succeed('recovered');
    assert.equal(await recovered, 'recovered');
    client.dispose();
  });
});

test('worker runtime and response failures reject without leaving requests pending', async () => {
  await withWorkers(async () => {
    const workers: FakeWorker[] = [];
    const client = makeClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const runtimeFailure = client.compute('runtime');
    workers[0]!.onerror?.({ message: 'Runtime failure.' } as ErrorEvent);
    await assert.rejects(runtimeFailure, /Runtime failure/);
    const responseFailure = client.compute('response');
    const worker = workers[1]!;
    worker.onmessage?.({ data: { requestId: worker.request!.requestId, ok: false, error: 'Parse failed.' } } as MessageEvent<Response>);
    await assert.rejects(responseFailure, /Parse failed/);
    assert.equal(workers.every(current => current.terminated), true);
    client.dispose();
  });
});

test('malformed worker messages and thrown response parsers settle their requests', async () => {
  await withWorkers(async () => {
    const worker = new FakeWorker();
    const client = makeClient(() => worker as unknown as Worker);
    const pending = client.compute('malformed');
    worker.onmessage?.({ data: null } as unknown as MessageEvent<Response>);
    await assert.rejects(pending, /Invalid worker response/);
    assert.equal(worker.terminated, true);
    client.dispose();

    const parserWorker = new FakeWorker();
    const parserClient = createLatestWorkerClient<string, Request, Response, string>({
      createWorker: () => parserWorker as unknown as Worker,
      buildRequest: (requestId, input) => ({ requestId, input }),
      parseResponse: () => { throw new Error('Invalid result shape.'); },
      supersededMessage: 'Superseded.', staleMessage: 'Stale.',
      workerErrorMessage: 'Worker failed.', workerMessageErrorMessage: 'Invalid response.',
    });
    const parsed = parserClient.compute('parse');
    parserWorker.succeed('value');
    await assert.rejects(parsed, /Invalid result shape/);
    parserClient.dispose();
  });
});

test('missing Worker reports an error without trying a main-thread fallback', async () => {
  const previousWorker = globalThis.Worker;
  Reflect.deleteProperty(globalThis, 'Worker');
  try {
    const client = makeClient(() => { throw new Error('Must not construct a worker.'); });
    await assert.rejects(client.compute('input'), /Web Worker is unavailable/);
    client.dispose();
  } finally {
    if (previousWorker !== undefined) globalThis.Worker = previousWorker;
  }
});
