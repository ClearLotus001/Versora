import test from 'node:test';
import assert from 'node:assert/strict';

import { EMPTY_CLI_ARGS } from '../electron/cliArgs';
import {
  filePayloadCache,
  getSessionCacheGeneration,
  revisionPayloadCache,
  setActiveCliArgs,
} from '../electron/main/state';
import {
  localSvnUrlCache,
  localVersioningStatusCache,
} from '../electron/main/svnProbeCache';

test('setActiveCliArgs clears local SVN probe caches', () => {
  localSvnUrlCache.clear();
  localVersioningStatusCache.clear();

  localSvnUrlCache.set('C:\\wc\\sample.xlsx', Promise.resolve('http://repo/sample.xlsx'));
  localVersioningStatusCache.set('C:\\wc\\sample.xlsx', Promise.resolve('versioned'));

  setActiveCliArgs({
    ...EMPTY_CLI_ARGS,
    minePath: 'C:\\wc\\sample.xlsx',
  });

  assert.equal(localSvnUrlCache.size, 0);
  assert.equal(localVersioningStatusCache.size, 0);
});

test('setActiveCliArgs advances the session and releases every large main-process cache', () => {
  filePayloadCache.set('file', {} as never);
  revisionPayloadCache.set('revision', {} as never);

  const previousGeneration = getSessionCacheGeneration();

  setActiveCliArgs({
    ...EMPTY_CLI_ARGS,
    minePath: 'C:\\wc\\next.xlsx',
  });

  assert.equal(getSessionCacheGeneration(), previousGeneration + 1);
  for (const cache of [
    filePayloadCache,
    revisionPayloadCache,
  ]) {
    assert.equal(cache.size, 0);
  }
});
