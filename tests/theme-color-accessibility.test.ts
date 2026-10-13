import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getThemeTokensSnapshot, type ThemeKey } from '../src/theme';

function relativeLuminance(color: string): number {
  const channels = color.slice(1).match(/../g)?.map((part) => Number.parseInt(part, 16) / 255) ?? [];
  const linear = channels.map((value) => (
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * (linear[0] ?? 0))
    + (0.7152 * (linear[1] ?? 0))
    + (0.0722 * (linear[2] ?? 0));
}

function contrastRatio(foreground: string, background: string): number {
  const left = relativeLuminance(foreground);
  const right = relativeLuminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function blendHex(foreground: string, background: string, foregroundWeight: number): string {
  const parse = (value: string) => value.slice(1).match(/../g)?.map(part => Number.parseInt(part, 16)) ?? [];
  const foregroundChannels = parse(foreground);
  const backgroundChannels = parse(background);
  const channels = [0, 1, 2].map(index => Math.round(
    (foregroundChannels[index] ?? 0) * foregroundWeight
    + (backgroundChannels[index] ?? 0) * (1 - foregroundWeight),
  ));
  return `#${channels.map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

function readThemeCssVariables(css: string, themeKey: ThemeKey): Map<string, string> {
  const block = css.match(new RegExp(`\\.theme-${themeKey}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
  return new Map(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
      .map(match => [match[1]!, match[2]!.trim()]),
  );
}

function collectComponentFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectComponentFiles(target);
    return entry.isFile() && target.endsWith('.tsx') ? [target] : [];
  });
}

test('theme text roles retain accessible contrast on their intended surfaces', () => {
  for (const themeKey of ['dark', 'light'] as const) {
    const theme = getThemeTokensSnapshot(themeKey);
    const pairs = [
      ['primary text', theme.t1, theme.bg0],
      ['secondary text', theme.t2, theme.bg0],
      ['syntax comments', theme.cmt, theme.bg0],
      ['line numbers', theme.lnTx, theme.lnBg],
      ['added text', theme.addTx, theme.addBg],
      ['added inline text', theme.addTx, theme.addHl],
      ['deleted text', theme.delTx, theme.delBg],
      ['deleted inline text', theme.delTx, theme.delHl],
      ['modified text', theme.chgTx, theme.chgBg],
      ['modified inline text', theme.chgTx, theme.chgHl],
    ] as const;

    pairs.forEach(([label, foreground, background]) => {
      assert.ok(
        contrastRatio(foreground, background) >= 4.5,
        `${themeKey} ${label}: ${foreground} on ${background}`,
      );
    });
  }
});

test('workbook surfaces and whitespace differences retain accessible contrast in every theme', () => {
  for (const themeKey of ['dark', 'light', 'hc'] as const) {
    const theme = getThemeTokensSnapshot(themeKey);
    const textPairs = [
      ['cell text', theme.t0, theme.workbookCellBg],
      ['empty cell text', theme.t0, theme.workbookEmptyBg],
      ['missing cell text', theme.t0, theme.workbookMissingBg],
      ['header text', theme.t0, theme.workbookHeaderBg],
      ['whitespace text', theme.whitespaceTx, theme.whitespaceBg],
      ['whitespace inline text', theme.whitespaceTx, theme.whitespaceHl],
    ] as const;
    for (const [label, foreground, background] of textPairs) {
      const ratio = contrastRatio(foreground, background);
      assert.ok(ratio >= 4.5, `${themeKey} ${label}: ${ratio.toFixed(2)}:1`);
    }

    for (const background of [theme.whitespaceBg, theme.whitespaceHl, theme.workbookCellBg]) {
      const ratio = contrastRatio(theme.whitespaceBrd, background);
      assert.ok(ratio >= 3, `${themeKey} whitespace edge on ${background}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test('source badges use theme-owned colors with accessible contrast', () => {
  const css = fs.readFileSync('src/styles/app.css', 'utf8');

  for (const themeKey of ['dark', 'light', 'hc'] as const) {
    const variables = readThemeCssVariables(css, themeKey);
    const theme = getThemeTokensSnapshot(themeKey);

    for (const variableName of ['--source-git', '--source-svn'] as const) {
      const foreground = variables.get(variableName) ?? '';
      assert.match(foreground, /^#[0-9a-f]{6}$/i, `${themeKey} ${variableName}`);
      const badgeBackground = blendHex(foreground, theme.bg1, 0.11);
      assert.ok(
        contrastRatio(foreground, badgeBackground) >= 4.5,
        `${themeKey} ${variableName}: ${foreground} on ${badgeBackground}`,
      );
    }
  }
});

test('ordinary React UI components do not introduce fixed color literals', () => {
  const artisticComponentPaths = [
    `${path.sep}app${path.sep}HomeStartPanel.tsx`,
    `${path.sep}app${path.sep}global-bot${path.sep}`,
  ];
  const staticColorLiteral = /#[0-9a-f]{3,8}\b|rgba?\(\s*[\d.]/gi;
  const violations = collectComponentFiles('src/components').flatMap((file) => {
    if (artisticComponentPaths.some(allowedPath => file.includes(allowedPath))) return [];
    const source = fs.readFileSync(file, 'utf8');
    return [...source.matchAll(staticColorLiteral)].map(match => `${file}: ${match[0]}`);
  });

  assert.deepEqual(violations, []);
});
