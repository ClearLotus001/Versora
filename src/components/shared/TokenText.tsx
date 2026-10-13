// src/components/TokenText.tsx
import { memo, useMemo, type CSSProperties } from 'react';
import type { Token } from '@/types';
import { getThemeTokensSnapshot, makeTokenColors } from '@/theme';
import { useTheme } from '@/context/theme';
import { resolveTextBackgroundSamples, resolveTextForegroundColor } from '@/utils/diff/textContrast';

export interface TokenSearchRange {
  start: number;
  end: number;
  active?: boolean;
}

interface TokenTextProps {
  tokens: Token[];
  charSpans?: { highlight: boolean; text: string }[] | null;
  hlBg?: string | undefined;
  searchRanges?: TokenSearchRange[] | undefined;
  searchHlBg?: string | undefined;
  activeSearchHlBg?: string | undefined;
  selectionRanges?: TokenSearchRange[] | undefined;
  selectionHlBg?: string | undefined;
  selectionTextColor?: string | undefined;
  /** Existing row/content surfaces, ordered from back to front. */
  backgroundLayers?: readonly (string | undefined)[] | undefined;
  /** Logical selection is painted beneath character and search highlights. */
  selectionUnderlay?: string | undefined;
  showWhitespace?: boolean | undefined;
}

interface AnnotatedSegment {
  text: string;
  color: string;
  fontStyle: number | null;
  diffHighlighted: boolean;
  searchHighlighted: boolean;
  activeSearch: boolean;
  selectionHighlighted: boolean;
}

function toBackgroundImageLayer(layer: string) {
  return /(?:gradient|url)\(/i.test(layer)
    ? layer
    : `linear-gradient(180deg, ${layer} 0%, ${layer} 100%)`;
}

function composeBackgroundLayers(...layers: Array<string | undefined>) {
  const resolvedLayers = layers.filter((layer): layer is string => Boolean(layer));
  return resolvedLayers.length > 0
    ? resolvedLayers.map(toBackgroundImageLayer).join(', ')
    : undefined;
}

function buildDiffTextHighlightBackground(highlight: string | undefined) {
  if (!highlight) return undefined;

  const softFill = `linear-gradient(180deg,
    ${highlight} 0%,
    ${highlight} 100%)`;
  const emphasisEdge = `linear-gradient(180deg,
    transparent 0 calc(100% - 2px),
    ${highlight} calc(100% - 2px) 100%)`;

  return `${emphasisEdge}, ${softFill}`;
}

function resolveFontStyle(fontStyle: number | null | undefined) {
  if (fontStyle == null || fontStyle <= 0) return undefined;

  return {
    fontStyle: (fontStyle & 1) !== 0 ? 'italic' : undefined,
    fontWeight: (fontStyle & 2) !== 0 ? 700 : undefined,
    textDecorationLine: [
      (fontStyle & 4) !== 0 ? 'underline' : '',
      (fontStyle & 8) !== 0 ? 'line-through' : '',
    ].filter(Boolean).join(' ') || undefined,
  };
}

const TokenText = memo(({
  tokens,
  charSpans,
  hlBg,
  searchRanges = [],
  searchHlBg,
  activeSearchHlBg,
  selectionRanges = [],
  selectionHlBg,
  selectionTextColor,
  backgroundLayers = [],
  selectionUnderlay,
  showWhitespace = false,
}: TokenTextProps) => {
  const themeKey = useTheme();
  const colors = useMemo(() => makeTokenColors(themeKey), [themeKey]);
  const theme = useMemo(() => getThemeTokensSnapshot(themeKey), [themeKey]);
  const baseBackgroundSamples = useMemo(() => resolveTextBackgroundSamples(theme, backgroundLayers), [theme, backgroundLayers]);
  const annotatedSegments = useMemo<AnnotatedSegment[] | null>(() => {
    if (
      searchRanges.length === 0
      && selectionRanges.length === 0
      && (!charSpans || charSpans.length === 0)
      && !showWhitespace
    ) return null;

    const content = (charSpans?.map((span) => span.text).join('') ?? tokens.map((token) => token.text).join(''));
    if (!content) return null;

    const length = content.length;
    const colorByIndex = new Array<string>(length).fill(colors.plain);
    const fontStyleByIndex = new Array<number | null>(length).fill(null);
    const diffHighlightByIndex = new Array<boolean>(length).fill(false);
    const searchHighlightByIndex = new Array<boolean>(length).fill(false);
    const activeSearchByIndex = new Array<boolean>(length).fill(false);
    const selectionHighlightByIndex = new Array<boolean>(length).fill(false);

    let offset = 0;
    tokens.forEach((token) => {
      const color = token.color ?? colors[token.type] ?? colors.plain;
      const fontStyle = token.fontStyle ?? null;
      for (let index = 0; index < token.text.length && (offset + index) < length; index += 1) {
        colorByIndex[offset + index] = color;
        fontStyleByIndex[offset + index] = fontStyle;
      }
      offset += token.text.length;
    });

    if (charSpans && charSpans.length > 0) {
      offset = 0;
      charSpans.forEach((span) => {
        for (let index = 0; index < span.text.length && (offset + index) < length; index += 1) {
          diffHighlightByIndex[offset + index] = span.highlight;
        }
        offset += span.text.length;
      });
    }

    searchRanges.forEach((range) => {
      const start = Math.max(0, Math.min(length, range.start));
      const end = Math.max(start, Math.min(length, range.end));
      for (let index = start; index < end; index += 1) {
        searchHighlightByIndex[index] = true;
        if (range.active) activeSearchByIndex[index] = true;
      }
    });

    selectionRanges.forEach((range) => {
      const start = Math.max(0, Math.min(length, range.start));
      const end = Math.max(start, Math.min(length, range.end));
      for (let index = start; index < end; index += 1) {
        selectionHighlightByIndex[index] = true;
      }
    });

    const segments: AnnotatedSegment[] = [];
    let cursor = 0;
    while (cursor < length) {
      const nextColor = colorByIndex[cursor] ?? colors.plain;
      const nextFontStyle = fontStyleByIndex[cursor] ?? null;
      const nextDiff = diffHighlightByIndex[cursor] ?? false;
      const nextSearch = searchHighlightByIndex[cursor] ?? false;
      const nextActive = activeSearchByIndex[cursor] ?? false;
      const nextSelection = selectionHighlightByIndex[cursor] ?? false;
      let end = cursor + 1;

      while (end < length) {
        if (
          (colorByIndex[end] ?? colors.plain) !== nextColor
          || (fontStyleByIndex[end] ?? null) !== nextFontStyle
          || (diffHighlightByIndex[end] ?? false) !== nextDiff
          || (searchHighlightByIndex[end] ?? false) !== nextSearch
          || (activeSearchByIndex[end] ?? false) !== nextActive
          || (selectionHighlightByIndex[end] ?? false) !== nextSelection
        ) {
          break;
        }
        end += 1;
      }

      segments.push({
        text: content.slice(cursor, end),
        color: nextColor,
        fontStyle: nextFontStyle,
        diffHighlighted: nextDiff,
        searchHighlighted: nextSearch,
        activeSearch: nextActive,
        selectionHighlighted: nextSelection,
      });
      cursor = end;
    }

    return segments;
  }, [charSpans, colors, searchRanges, selectionRanges, showWhitespace, tokens]);

  if (annotatedSegments) {
    return (
      <>
        {annotatedSegments.map((segment, index) => {
          const isSelectionOnly = segment.selectionHighlighted && !segment.searchHighlighted && !segment.activeSearch;
          const diffBackground = segment.diffHighlighted ? buildDiffTextHighlightBackground(hlBg) : undefined;
          const selectionBackground = segment.selectionHighlighted ? selectionHlBg : undefined;
          const searchBackground = segment.activeSearch
            ? activeSearchHlBg
            : segment.searchHighlighted
              ? searchHlBg
              : undefined;
          const background = composeBackgroundLayers(searchBackground, selectionBackground, diffBackground);
          const syntaxColor = segment.diffHighlighted || isSelectionOnly
            ? segment.color
            : segment.selectionHighlighted && selectionTextColor
              ? selectionTextColor
              : segment.color;
          const foregroundColor = resolveTextForegroundColor(syntaxColor, theme, resolveTextBackgroundSamples(theme, [
            ...backgroundLayers,
            segment.selectionHighlighted ? selectionUnderlay : undefined,
            segment.diffHighlighted ? hlBg : undefined,
            selectionBackground,
            searchBackground,
          ]));
          const style: CSSProperties = {
            color: foregroundColor,
            WebkitTextFillColor: foregroundColor,
            borderRadius: background && !isSelectionOnly ? 2 : undefined,
            background,
            backgroundClip: background ? 'padding-box' : undefined,
            WebkitBoxDecorationBreak: background ? 'clone' : undefined,
            boxDecorationBreak: background ? 'clone' : undefined,
            padding: background && !isSelectionOnly ? '0 1px' : undefined,
            ...resolveFontStyle(segment.fontStyle),
          };
          const revealWhitespace = showWhitespace || segment.selectionHighlighted;
          const renderedText = revealWhitespace
            ? segment.text.replace(/ /g, '·')
            : segment.text;
          const containsVisibleWhitespace = revealWhitespace && segment.text.includes(' ');
          return background ? (
            <mark
              key={index}
              data-diff-char-highlight={segment.diffHighlighted ? 'true' : undefined}
              data-selection-whitespace={segment.selectionHighlighted && containsVisibleWhitespace ? 'true' : undefined}
              data-visible-whitespace={containsVisibleWhitespace ? 'true' : undefined}
              style={style}>
              {renderedText}
            </mark>
          ) : (
            <span
              key={index}
              data-visible-whitespace={containsVisibleWhitespace ? 'true' : undefined}
              style={{ color: foregroundColor, ...resolveFontStyle(segment.fontStyle) }}>
              {renderedText}
            </span>
          );
        })}
      </>
    );
  }

  return (
    <>
      {tokens.map((tok, i) => (
        <span
          key={i}
          style={{
            color: resolveTextForegroundColor(
              tok.color ?? colors[tok.type] ?? colors.plain,
              theme,
              baseBackgroundSamples,
            ),
            ...resolveFontStyle(tok.fontStyle),
          }}>
          {tok.text}
        </span>
      ))}
    </>
  );
});

export default TokenText;
