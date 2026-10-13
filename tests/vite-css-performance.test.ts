import assert from 'node:assert/strict';
import test from 'node:test';

import { restoreStandardBackdropFilter } from '../scripts/viteCss.mjs';

test('production CSS can stay minified without dropping Electron backdrop filters', () => {
  assert.equal(
    restoreStandardBackdropFilter('.glass{-webkit-backdrop-filter:blur(12px)}'),
    '.glass{-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}',
  );
  assert.equal(
    restoreStandardBackdropFilter('.glass{-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}'),
    '.glass{-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}',
  );
});
