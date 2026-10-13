import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { TextAnalysisClient } from '../electron/main/text/analysisClient';
import { prepareTextDiffAnalysis } from '../electron/main/text/diff';

function waitingWorker(): Worker {
  return new Worker('setInterval(() => {}, 1_000);', { eval: true, execArgv: [] });
}

test('text analysis worker preserves line pairing, spans and statistics', async () => {
  const client = new TextAnalysisClient();
  const baseText = 'header\nconst alpha = 1;\nremoved\ntail';
  const mineText = 'header\nconst alpha = 2;\ntail\nadded';
  try {
    const actual = await client.analyze('result', baseText, mineText);
    const expected = prepareTextDiffAnalysis(baseText, mineText);
    assert.deepEqual({ ...actual, perf: null }, { ...expected, perf: null });
    assert.ok(actual.diffLines.some((line) => line.baseCharSpans?.some((span) => span.highlight)));
    assert.ok(actual.replacementPairs.length > 0);
    assert.ok((actual.perf?.diffMs ?? -1) >= 0);
    assert.deepEqual(client.getSnapshot(), { active: 0, queued: 0 });
  } finally {
    client.clear();
  }
});

test('text analysis leaves the main event loop responsive during comparison', async () => {
  const client = new TextAnalysisClient();
  const baseText = Array(30).fill(`@@${'a'.repeat(998)}`).join('\n');
  const mineText = Array(30).fill(`@@${'b'.repeat(998)}`).join('\n');
  let comparisonFinished = false;
  let heartbeatBeforeResult = false;
  const heartbeat = new Promise<void>((resolve) => {
    setTimeout(() => {
      heartbeatBeforeResult = !comparisonFinished;
      resolve();
    }, 0);
  });
  try {
    const pending = client.analyze('responsiveness', baseText, mineText);
    const result = await pending;
    comparisonFinished = true;
    await heartbeat;
    assert.equal(heartbeatBeforeResult, true, 'Main-thread timers must run before text analysis finishes.');
    assert.equal(result.stats.chg, 30);
    assert.equal(result.diffLines.length, 60);
  } finally {
    client.clear();
  }
});

test('worker client deduplicates requests, bounds its queue and cancels active work', async () => {
  let workersStarted = 0;
  const client = new TextAnalysisClient({
    maxConcurrency: 1,
    maxQueue: 1,
    createWorker: () => {
      workersStarted += 1;
      return waitingWorker();
    },
  });
  const active = client.analyze('active', 'left', 'right');
  const activeRejected = assert.rejects(active, { name: 'AbortError' });
  assert.equal(client.analyze('active', 'left', 'right'), active);
  const queued = client.analyze('queued', 'left', 'right');
  const queuedRejected = assert.rejects(queued, { name: 'AbortError' });
  try {
    assert.deepEqual(client.getSnapshot(), { active: 1, queued: 1 });
    assert.equal(workersStarted, 1);
    await assert.rejects(client.analyze('overflow', '', ''), /Too many text comparisons/);
    client.clear();
    await Promise.all([activeRejected, queuedRejected]);
    assert.equal(workersStarted, 1, 'Clearing queued work must not start another worker.');
    assert.deepEqual(client.getSnapshot(), { active: 0, queued: 0 });

    const next = client.analyze('after-clear', '', '');
    const nextRejected = assert.rejects(next, { name: 'AbortError' });
    assert.equal(workersStarted, 2);
    client.clear();
    await nextRejected;
  } finally {
    client.clear();
  }
});

test('worker deadline includes queue time and settles requests without a response', async () => {
  const client = new TextAnalysisClient({
    maxConcurrency: 1,
    maxQueue: 1,
    timeoutMs: 60,
    createWorker: waitingWorker,
  });
  try {
    const active = assert.rejects(client.analyze('active-timeout', '', ''), /timed out/);
    const queued = assert.rejects(client.analyze('queued-timeout', '', ''), /timed out/);
    await Promise.all([active, queued]);
    assert.deepEqual(client.getSnapshot(), { active: 0, queued: 0 });
  } finally {
    client.clear();
  }
});

test('a failed worker releases capacity and runs the next queued comparison', async () => {
  const expected = prepareTextDiffAnalysis('alpha', 'alpha updated');
  const client = new TextAnalysisClient({
    maxConcurrency: 1,
    maxQueue: 1,
    createWorker: (input) => new Worker(
      input.baseText === 'failure'
        ? 'throw new Error("first worker failed");'
        : `require('node:worker_threads').parentPort.postMessage(${JSON.stringify({ ok: true, analysis: expected })});`,
      { eval: true, execArgv: [] },
    ),
  });
  try {
    const failed = assert.rejects(client.analyze('first', 'failure', ''), /first worker failed/);
    const queued = client.analyze('second', 'alpha', 'alpha updated');
    assert.deepEqual(client.getSnapshot(), { active: 1, queued: 1 });
    await failed;
    assert.deepEqual(await queued, expected);
    assert.deepEqual(client.getSnapshot(), { active: 0, queued: 0 });
  } finally {
    client.clear();
  }
});

test('worker errors and exits without a result reject instead of leaving IPC pending', async () => {
  for (const code of ['throw new Error("worker failure");', 'process.exit(0);']) {
    const client = new TextAnalysisClient({
      createWorker: () => new Worker(code, { eval: true, execArgv: [] }),
    });
    try {
      await assert.rejects(client.analyze('failure', '', ''), /worker failure|exited without a result/);
      assert.deepEqual(client.getSnapshot(), { active: 0, queued: 0 });
    } finally {
      client.clear();
    }
  }
});

test('worker launch failure settles and releases the concurrency slot', async () => {
  const client = new TextAnalysisClient({
    maxConcurrency: 1,
    createWorker: () => { throw new Error('Worker cannot start.'); },
  });
  try {
    await assert.rejects(client.analyze('launch-failure', '', ''), /Worker cannot start/);
    assert.deepEqual(client.getSnapshot(), { active: 0, queued: 0 });
  } finally {
    client.clear();
  }
});
