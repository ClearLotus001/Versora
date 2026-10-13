import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

import TokenText from '../src/components/shared/TokenText';
import { ThemeContext } from '../src/context/theme';

test('TokenText composes logical selection and diff highlight backgrounds', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ThemeContext.Provider,
      { value: 'light' },
      React.createElement(TokenText, {
        tokens: [{ type: 'plain', text: 'abcde' }],
        charSpans: [{ highlight: true, text: 'abcde' }],
        hlBg: 'var(--diff-modify-hl)',
        selectionRanges: [{ start: 1, end: 4 }],
        selectionHlBg: 'var(--text-selection-bg)',
      }),
    ),
  );

  assert.match(html, /var\(--text-selection-bg\)[\s\S]*var\(--diff-modify-hl\)/);
});

test('TokenText keeps diff highlight under search highlights', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ThemeContext.Provider,
      { value: 'light' },
      React.createElement(TokenText, {
        tokens: [{ type: 'plain', text: 'urgent' }],
        charSpans: [{ highlight: true, text: 'urgent' }],
        hlBg: 'var(--diff-modify-hl)',
        searchRanges: [{ start: 0, end: 6 }],
        searchHlBg: 'var(--search-hl)',
      }),
    ),
  );

  assert.match(html, /var\(--search-hl\)[\s\S]*var\(--diff-modify-hl\)/);
});

test('TokenText retains accessible syntax colors and adjusts weak character diff foregrounds', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ThemeContext.Provider,
      { value: 'light' },
      React.createElement(TokenText, {
        tokens: [
          { type: 'keyword', text: 'return', color: '#cf222e' },
          { type: 'plain', text: ' ' },
          { type: 'string', text: '"urgent"', color: '#0a3069' },
        ],
        charSpans: [
          { highlight: true, text: 'return' },
          { highlight: false, text: ' ' },
          { highlight: true, text: '"urgent"' },
        ],
        hlBg: 'var(--diff-modify-hl)',
      }),
    ),
  );

  assert.match(html, /data-diff-char-highlight="true"/);
  const keywordColor = html.match(/style="color:(#[\da-f]{6});-webkit-text-fill-color:\1[^>]*>return</i)?.[1];
  assert.ok(keywordColor);
  assert.notEqual(keywordColor, '#cf222e');
  assert.match(html, /color:#0a3069/);
  assert.match(html, /-webkit-text-fill-color:#0a3069/);
});
