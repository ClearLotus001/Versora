import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import useSyntaxHighlightPresentation from '../src/hooks/app/useSyntaxHighlightPresentation';
import type { DiffData } from '../src/types';

function renderLoadingSource(names: { fileName: string; baseName: string; mineName: string }) {
  const data = {
    ...names,
    baseContent: null,
    mineContent: null,
  } as DiffData;
  function LoadingView() {
    const syntax = useSyntaxHighlightPresentation({
      currentDiffData: data,
      isWorkbookMode: false,
      themeKey: 'dark',
    });
    assert.equal(syntax, null);
    return createElement('span', null, 'Loading workbook');
  }
  return renderToStaticMarkup(createElement(LoadingView));
}

test('workbook source errors stay in the async loader instead of crashing syntax rendering', () => {
  for (const names of [
    { fileName: 'Book.xlsx', baseName: 'Before.xlsx', mineName: 'After.xlsx' },
    { fileName: '', baseName: 'Before.xlsm', mineName: 'After.xlsm' },
    { fileName: '', baseName: '', mineName: 'After.xltx' },
    { fileName: 'Before.ts', baseName: 'Before.ts', mineName: 'After.xlsx' },
  ]) {
    assert.equal(renderLoadingSource(names), '<span>Loading workbook</span>');
  }
});
