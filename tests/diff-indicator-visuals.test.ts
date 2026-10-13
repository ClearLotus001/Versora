import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveDiffIndicatorCssPalette,
  resolveDiffIndicatorThemeVisual,
  resolveWorkbookSectionIndicatorTone,
} from '../src/utils/diff/diffIndicatorVisuals';
import { cssAlpha, cssVar } from '../src/theme/cssUtils';
import { getThemeTokensSnapshot } from '../src/theme';

const lightTheme = getThemeTokensSnapshot('light');

test('diff indicator palette maps semantic tones to shared DOM tokens', () => {
  const addPalette = resolveDiffIndicatorCssPalette('add');
  const deletePalette = resolveDiffIndicatorCssPalette('delete');
  const modifyPalette = resolveDiffIndicatorCssPalette('modify');
  const neutralPalette = resolveDiffIndicatorCssPalette('neutral');

  assert.deepEqual(addPalette, {
    accent: cssVar('addBrd'),
    text: cssVar('addTx'),
    border: cssAlpha('addBrd', '66'),
    background: cssVar('addBg'),
    softBackground: cssAlpha('addBrd', '14'),
    shadow: cssAlpha('addBrd', '55'),
  });
  assert.deepEqual(deletePalette, {
    accent: cssVar('delBrd'),
    text: cssVar('delTx'),
    border: cssAlpha('delBrd', '66'),
    background: cssVar('delBg'),
    softBackground: cssAlpha('delBrd', '14'),
    shadow: cssAlpha('delBrd', '55'),
  });
  assert.deepEqual(modifyPalette, {
    accent: cssVar('chgBrd'),
    text: cssVar('chgTx'),
    border: cssAlpha('chgBrd', '66'),
    background: cssVar('chgBg'),
    softBackground: cssAlpha('chgBrd', '14'),
    shadow: cssAlpha('chgBrd', '55'),
  });
  assert.deepEqual(neutralPalette, {
    accent: cssVar('acc2'),
    text: cssVar('acc2'),
    border: cssAlpha('acc2', '66'),
    background: cssAlpha('acc2', '16'),
    softBackground: cssAlpha('acc2', '14'),
    shadow: cssAlpha('acc2', '55'),
  });
});

test('workbook section indicator tone normalizes rename into modify semantics', () => {
  assert.equal(resolveWorkbookSectionIndicatorTone('equal'), 'neutral');
  assert.equal(resolveWorkbookSectionIndicatorTone('add'), 'add');
  assert.equal(resolveWorkbookSectionIndicatorTone('delete'), 'delete');
  assert.equal(resolveWorkbookSectionIndicatorTone('rename'), 'modify');
});

test('theme indicator visuals expose shared soft and strong semantic surfaces', () => {
  assert.deepEqual(resolveDiffIndicatorThemeVisual(lightTheme, 'modify', 'soft'), {
    background: `${lightTheme.chgBrd}12`,
    border: `${lightTheme.chgBrd}33`,
    textColor: lightTheme.chgTx,
  });
  assert.deepEqual(resolveDiffIndicatorThemeVisual(lightTheme, 'modify', 'strong'), {
    background: lightTheme.chgBg,
    border: lightTheme.chgBrd,
    textColor: lightTheme.chgTx,
  });
  assert.deepEqual(resolveDiffIndicatorThemeVisual(lightTheme, 'strict-only', 'strong'), {
    background: lightTheme.whitespaceBg,
    border: lightTheme.whitespaceBrd,
    textColor: lightTheme.whitespaceTx,
  });
});
