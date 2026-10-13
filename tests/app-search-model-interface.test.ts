import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('useAppSearchModel owns search orchestration outside the app view model', () => {
  const searchModel = fs.readFileSync('src/hooks/app/useAppSearchModel.ts', 'utf8');
  const appViewModel = fs.readFileSync('src/hooks/app/useAppViewModel.ts', 'utf8');

  for (const responsibility of [
    'compileSearchPattern',
    'computeSearchMatchesAsync',
    'createSearchResultItemResolver',
    'navigateSearch',
  ]) {
    assert.match(searchModel, new RegExp(`\\b${responsibility}\\b`));
  }

  assert.match(appViewModel, /useAppSearchModel\(\{/);
  assert.match(searchModel, /artifactProvider\.search\(/);
  assert.match(searchModel, /artifactProvider\.cancelSearch\(/);
  assert.doesNotMatch(appViewModel, /computeSearchMatchesAsync|searchSeqRef|allSearchMatches/);
});
