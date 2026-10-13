import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHighlighterCore } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import githubDark from '@shikijs/themes/github-dark';
import githubLight from '@shikijs/themes/github-light';
import githubDarkHighContrast from '@shikijs/themes/github-dark-high-contrast';
import python from '@shikijs/langs/python';

import TokenText from '../src/components/shared/TokenText';
import DiffRow from '../src/components/diff/DiffRow';
import SplitCell from '../src/components/diff/SplitCell';
import { ThemeContext } from '../src/context/theme';
import { getThemeTokensSnapshot, type ThemeKey } from '../src/theme';
import { cssAlpha } from '../src/theme/cssUtils';
import { resolveShikiTheme } from '../src/utils/diff/syntaxHighlighting';
import { resolveTextBackgroundSamples, resolveTextForegroundColor } from '../src/utils/diff/textContrast';
import type { DiffLine, Token } from '../src/types';

type Rgb = readonly [number, number, number];
const selectionUnderlay = 'linear-gradient(180deg, var(--text-selection-edge) 0%, var(--text-selection-bg) 18%, var(--text-selection-bg) 82%, var(--text-selection-edge) 100%)';

function parseRgb(value: string): Rgb {
  if (value.startsWith('#')) return [1, 3, 5].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16)) as unknown as Rgb;
  return value.match(/[\d.]+/g)!.slice(0, 3).map(Number) as unknown as Rgb;
}

function blend(foreground: string, background: Rgb, alpha: number): Rgb {
  const color = parseRgb(foreground);
  return color.map((channel, index) => Math.round(channel * alpha + background[index]! * (1 - alpha))) as unknown as Rgb;
}

function contrast(foreground: string, background: Rgb): number {
  const luminance = (channels: Rgb) => channels.reduce((result, channel, index) => {
    const value = channel / 255;
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return result + linear * [0.2126, 0.7152, 0.0722][index]!;
  }, 0);
  const left = luminance(parseRgb(foreground));
  const right = luminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function rgbaAlpha(value: string): number {
  return Number(value.match(/[\d.]+/g)![3] ?? 1);
}

function render(themeKey: ThemeKey, element: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(ThemeContext.Provider, { value: themeKey }, element));
}

function renderedColor(html: string): string {
  return html.match(/style="color:(#[\da-f]{6})/i)?.[1] ?? '';
}

const highlighterPromise = createHighlighterCore({
  engine: createJavaScriptRegexEngine(),
  themes: [githubDark, githubLight, githubDarkHighContrast],
  langs: [python],
});

test('actual Shiki text stays readable on semantic rows, character highlights, search and logical selections', async () => {
  const highlighter = await highlighterPromise;
  for (const themeKey of ['dark', 'light', 'hc'] as const) {
    const theme = getThemeTokensSnapshot(themeKey);
    const themedTokens = highlighter.codeToTokensBase('# update customer names\nreturn 42\nname = "urgent"', {
      lang: 'python', theme: resolveShikiTheme(themeKey),
    }).flat().filter(token => token.content.trim());
    let changedColors = 0;
    let retainedColors = 0;
    for (const tone of ['add', 'delete', 'modify'] as const) {
      const prefix = tone === 'delete' ? 'del' : tone === 'modify' ? 'chg' : 'add';
      const bg = theme[`${prefix}Bg`];
      const highlight = theme[`${prefix}Hl`];
      const base = parseRgb(bg === 'transparent' ? theme.bg0 : bg);
      const selected = [theme.textSelectionBg, theme.textSelectionEdge].map(value => blend(value, base, rgbaAlpha(value)));
      const cases = [
        { name: 'row', highlight: false, select: false, search: false, active: false, backgrounds: [base] },
        { name: 'character', highlight: true, select: false, search: false, active: false, backgrounds: [parseRgb(highlight)] },
        { name: 'selection under text', highlight: false, select: true, search: false, active: false, backgrounds: selected },
        { name: 'selection under opaque character', highlight: true, select: true, search: false, active: false, backgrounds: [parseRgb(highlight)] },
        { name: 'search over character', highlight: true, select: false, search: true, active: false, backgrounds: [blend(theme.searchHl, parseRgb(highlight), 0.20)] },
        { name: 'search over selected text', highlight: false, select: true, search: true, active: false, backgrounds: selected.map(background => blend(theme.searchHl, background, 0.20)) },
        { name: 'active search over row', highlight: false, select: false, search: true, active: true, backgrounds: [blend(theme.searchHl, base, 0.57)] },
        { name: 'active search over selected character', highlight: true, select: true, search: true, active: true, backgrounds: [blend(theme.searchHl, parseRgb(highlight), 0.57)] },
      ];
      for (const token of themedTokens) {
        for (const scenario of cases) {
          const html = render(themeKey, React.createElement(TokenText, {
            tokens: [{ type: 'plain', text: token.content, color: token.color ?? null }],
            backgroundLayers: [`var(--diff-${tone === 'delete' ? 'remove' : tone}-bg)`],
            charSpans: scenario.highlight ? [{ highlight: true, text: token.content }] : null,
            hlBg: `var(--diff-${tone === 'delete' ? 'remove' : tone}-hl)`,
            selectionRanges: scenario.select ? [{ start: 0, end: token.content.length }] : [],
            selectionUnderlay,
            selectionHlBg: 'color-mix(in srgb, var(--text-selection-bg) 0%, transparent)',
            searchRanges: scenario.search ? [{ start: 0, end: token.content.length, active: scenario.active }] : [],
            searchHlBg: cssAlpha('searchHl', '32'),
            activeSearchHlBg: cssAlpha('searchHl', '92'),
          }));
          const color = renderedColor(html);
          assert.ok(color, html);
          for (const background of scenario.backgrounds) {
            assert.ok(contrast(color, background) >= 4.5, `${themeKey} ${tone} ${scenario.name} ${token.content}: ${color} on ${background}`);
          }
          if (color.toLowerCase() === token.color?.toLowerCase()) retainedColors += 1;
          else changedColors += 1;
        }
      }
    }
    assert.ok(retainedColors > 0, `${themeKey} should retain sufficient syntax colors`);
    assert.ok(changedColors > 0, `${themeKey} should repair weak foregrounds`);
  }
});

test('unhighlighted modified comments receive the actual row surface in unified and split callers', async () => {
  const highlighter = await highlighterPromise;
  for (const themeKey of ['dark', 'light'] as const) {
    const theme = getThemeTokensSnapshot(themeKey);
    const token = highlighter.codeToTokensBase('# update customer names', { lang: 'python', theme: resolveShikiTheme(themeKey) })[0]![0]!;
    const syntaxTokens: Token[] = [{ type: 'plain', text: token.content, color: token.color ?? null }];
    const line: DiffLine = { type: 'add', base: null, mine: token.content, baseLineNo: null, mineLineNo: 1, baseCharSpans: null, mineCharSpans: null };
    const commonProps = { line, syntaxTokens, isReplacementPair: true, isSearchMatch: false, isActiveSearch: false, showWhitespace: false, fontSize: 13 };
    const elements = [
      React.createElement(DiffRow, commonProps),
      React.createElement(SplitCell, { ...commonProps, side: 'right' }),
    ];
    for (const element of elements) {
      const contentHtml = render(themeKey, element).split('data-selectable-text-content="true"')[1] ?? '';
      const colors = [...contentHtml.matchAll(/<span style="color:(#[\da-f]{6})/gi)].map(match => match[1]!);
      assert.equal(colors.length, 1, contentHtml);
      assert.ok(contrast(colors[0]!, parseRgb(theme.chgBg)) >= 4.5, `${themeKey} comment on modified row`);
      assert.notEqual(colors[0]!.toLowerCase(), token.color?.toLowerCase());
    }
  }
});

test('equal-row Shiki comments are checked against both ends of the editor surface', async () => {
  const highlighter = await highlighterPromise;
  for (const themeKey of ['dark', 'light', 'hc'] as const) {
    const theme = getThemeTokensSnapshot(themeKey);
    const token = highlighter.codeToTokensBase('# update customer names', { lang: 'python', theme: resolveShikiTheme(themeKey) })[0]![0]!;
    const html = render(themeKey, React.createElement(TokenText, {
      tokens: [{ type: 'plain', text: token.content, color: token.color ?? null }],
    }));
    const color = renderedColor(html);
    for (const background of [theme.bg0, theme.bg1]) {
      assert.ok(contrast(color, parseRgb(background)) >= 4.5, `${themeKey} ${color} on ${background}`);
    }
  }
});

test('row gradients and rounded CSS alpha are included in foreground contrast', () => {
  const theme = getThemeTokensSnapshot('light');
  const surfaces = resolveTextBackgroundSamples(theme, [
    'linear-gradient(90deg, color-mix(in srgb, var(--acc2) 20%, transparent) 0%, color-mix(in srgb, var(--acc2) 7%, transparent) 100%), var(--diff-modify-bg)',
    cssAlpha('searchHl', '32'),
  ]);
  const expected = [0.20, 0.07].map(alpha => blend(theme.searchHl, blend(theme.acc2, parseRgb(theme.chgBg), alpha), 0.20));
  assert.deepEqual(surfaces, expected);
  const foreground = resolveTextForegroundColor('#6A737D', theme, surfaces);
  expected.forEach(background => assert.ok(contrast(foreground, background) >= 4.5));
});

test('sufficient syntax colors stay byte-for-byte unchanged; repaired colors keep their hue', () => {
  const theme = getThemeTokensSnapshot('light');
  const background = [parseRgb(theme.chgHl)];
  assert.equal(resolveTextForegroundColor('#0a3069', theme, background), '#0a3069');
  const source = '#d73a49';
  const repaired = resolveTextForegroundColor(source, theme, background);
  assert.ok(contrast(repaired, background[0]!) >= 4.5);
  // A darker red retains its hue and saturation despite 8-bit rounding.
  const hueAndSaturation = (value: string) => {
    const [r, g, b] = parseRgb(value);
    return [(60 * (g - b) / (r - g) + 360) % 360, (r - g) / (255 - Math.abs(r + g - 255))];
  };
  const before = hueAndSaturation(source);
  const after = hueAndSaturation(repaired);
  assert.ok(Math.abs(before[0]! - after[0]!) < 2);
  assert.ok(Math.abs(before[1]! - after[1]!) < 0.02);
});
