import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';

import { BoundedCommandGate } from '../electron/main/commandGate';
import {
  SVN_COMMAND_MAX_CONCURRENCY,
  SVN_COMMAND_MAX_QUEUE,
  SVN_COMMAND_TIMEOUT_MS,
} from '../electron/main/constants';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test('SVN command limits use finite production-safe defaults', () => {
  assert.ok(SVN_COMMAND_TIMEOUT_MS >= 1_000);
  assert.ok(SVN_COMMAND_MAX_CONCURRENCY >= 1);
  assert.ok(SVN_COMMAND_MAX_QUEUE >= 0);
});

test('BoundedCommandGate caps active work and rejects queue overflow', async () => {
  const gate = new BoundedCommandGate(2, 1, 'queue full');
  const first = deferred<number>();
  const second = deferred<number>();
  const third = deferred<number>();
  const started: number[] = [];

  const run = (id: number, task: Promise<number>) => gate.run(() => {
    started.push(id);
    return task;
  });

  const firstResult = run(1, first.promise);
  const secondResult = run(2, second.promise);
  const thirdResult = run(3, third.promise);
  const rejected = run(4, Promise.resolve(4));
  await assert.rejects(rejected, /queue full/);

  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(gate.getSnapshot(), {
    active: 2,
    queued: 1,
    maxConcurrency: 2,
    maxQueue: 1,
  });

  first.resolve(1);
  assert.equal(await firstResult, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [1, 2, 3]);

  second.resolve(2);
  third.resolve(3);
  assert.equal(await secondResult, 2);
  assert.equal(await thirdResult, 3);
  assert.equal(gate.getSnapshot().active, 0);
  assert.equal(gate.getSnapshot().queued, 0);
});

test('BoundedCommandGate releases capacity after command failure', async () => {
  const gate = new BoundedCommandGate(1, 1, 'queue full');
  const blocker = deferred<void>();
  const failed = gate.run(async () => {
    await blocker.promise;
    throw new Error('command failed');
  });
  const next = gate.run(async () => 42);

  blocker.resolve();
  await assert.rejects(failed, /command failed/);
  assert.equal(await next, 42);
  assert.deepEqual(gate.getSnapshot(), {
    active: 0,
    queued: 0,
    maxConcurrency: 1,
    maxQueue: 1,
  });
});

test('queued cancellation immediately frees capacity and never starts the cancelled task', async () => {
  const gate = new BoundedCommandGate(1, 1, 'queue full');
  const first = deferred<number>();
  const blocking = gate.run(() => first.promise);
  const controller = new AbortController();
  let started = false;
  const cancelled = gate.run(async () => { started = true; return 2; }, controller.signal);
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.equal(gate.getSnapshot().queued, 0);
  const replacement = gate.run(async () => 3);
  first.resolve(1);
  assert.equal(await blocking, 1);
  assert.equal(await replacement, 3);
  assert.equal(started, false);
});

for (const firstFails of [false, true]) {
  test(`queued commands retain each caller's async context after ${firstFails ? 'failure' : 'success'}`, async () => {
    const contexts = new AsyncLocalStorage<string>();
    const gate = new BoundedCommandGate(1, 2, 'queue full');
    const blocker = deferred<void>();
    const seen: string[] = [];
    const first = contexts.run('first', () => gate.run(async () => {
      await blocker.promise;
      seen.push(contexts.getStore()!);
      if (firstFails) throw new Error('first failed');
      return 1;
    }));
    const checkedFirst = firstFails ? assert.rejects(first, /first failed/) : first;
    const next = ['second', 'third'].map(name => contexts.run(name, () => gate.run(async () => {
      const beforeAwait = contexts.getStore();
      await Promise.resolve();
      assert.equal(contexts.getStore(), beforeAwait);
      seen.push(contexts.getStore()!);
      return name;
    })));
    blocker.resolve();
    await checkedFirst;
    assert.deepEqual(await Promise.all(next), ['second', 'third']);
    assert.deepEqual(seen, ['first', 'second', 'third']);
  });
}
