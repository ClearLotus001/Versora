// src/components/DiffRow.tsx
import { memo, useMemo, type MouseEventHandler } from 'react';
import { FONT_CODE_STYLE, FONT_SIZE } from '@/constants/typography';
import type { DiffLine, Token } from '@/types';
import { cssAlpha, cssVar } from '@/theme/cssUtils';
import { tokenize } from '@/engine/text/tokenizer';
import { ROW_H } from '@/hooks/virtualization/useVirtual';
import { LN_W } from '@/constants/layout';
import { buildDiffSelectionSurfaces } from '@/utils/diff/selectionVisuals';
import {
  composeTextRowBackground,
  resolveTextDiffCssPalette,
  resolveTextInlineBackground,
  resolveTextSelectedRowBackground,
  resolveTextDiffVisualTone,
} from '@/utils/diff/textDiffVisuals';
import Ln from '@/components/diff/Ln';
import LogicalTextSelectionDecorations from '@/components/shared/LogicalTextSelectionDecorations';
import TokenText from '@/components/shared/TokenText';
import type { TokenSearchRange } from '@/components/shared/TokenText';

interface TextSelectionRange {
  start: number;
  end: number;
}

interface DiffRowProps {
  line: DiffLine;
  copySide?: 'base' | 'mine' | 'both';
  syntaxTokens?: Token[] | undefined;
  isReplacementPair?: boolean;
  widthMode?: 'fill' | 'content';
  isSearchMatch: boolean;
  isActiveSearch: boolean;
  searchRanges?: TokenSearchRange[] | undefined;
  showWhitespace: boolean;
  fontSize: number;
  allowTextSelection?: boolean;
  textSelectionRange?: TextSelectionRange | null | undefined;
  isRangeSelected?: boolean;
  isBaseLineSelected?: boolean;
  isMineLineSelected?: boolean;
  selectionAccentColor?: string | undefined;
  lineNumberTitle?: string | undefined;
  onBaseLineNumberClick?: MouseEventHandler<HTMLButtonElement> | undefined;
  onMineLineNumberClick?: MouseEventHandler<HTMLButtonElement> | undefined;
}

const DiffRow = memo(({
  line,
  copySide = 'both',
  syntaxTokens,
  isReplacementPair = false,
  widthMode = 'fill',
  isSearchMatch: _isSearchMatch,
  isActiveSearch,
  searchRanges = [],
  showWhitespace,
  fontSize,
  allowTextSelection = false,
  textSelectionRange = null,
  isRangeSelected = false,
  isBaseLineSelected = false,
  isMineLineSelected = false,
  selectionAccentColor,
  lineNumberTitle,
  onBaseLineNumberClick,
  onMineLineNumberClick,
}: DiffRowProps) => {
  const content = line.base ?? line.mine ?? '';
  const tokens = useMemo(() => syntaxTokens ?? tokenize(content), [content, syntaxTokens]);
  const isContentWidth = widthMode === 'content';
  const gutterWidth = LN_W * 2;

  const isAdd = line.type === 'add';
  const isDel = line.type === 'delete';
  const tone = resolveTextDiffVisualTone(line, isReplacementPair);
  const palette = resolveTextDiffCssPalette(tone);
  const brdL = palette.accent;
  const pfxTx = palette.prefix;
  const pfx = isAdd ? '+' : isDel ? '-' : ' ';
  const hlBg = palette.inlineHighlight;
  const charSpans = isDel ? line.baseCharSpans : isAdd ? line.mineCharSpans : null;
  const hasSearchRanges = searchRanges.length > 0;
  const hasTextSelection = Boolean(textSelectionRange && textSelectionRange.end > textSelectionRange.start);
  const {
    activeCapsuleSurface,
    diffHighlightBackground,
    gutterBackground,
    gutterShadow,
  } = buildDiffSelectionSurfaces({
    selectionAccentColor,
    isBaseLineSelected,
    isMineLineSelected,
    isRangeSelected,
    isActiveSearch,
  });
  const inlineBg = resolveTextInlineBackground({
    tone,
    hasSearchRanges,
    isRangeSelected,
    hasTextSelection,
  });
  const selectedRowBackground = resolveTextSelectedRowBackground({
    tone,
    isRangeSelected,
  });
  const rowBackground = composeTextRowBackground(activeCapsuleSurface, selectedRowBackground);
  const effectiveHighlightBackground = diffHighlightBackground ?? hlBg;
  const contentHighlightBackground = undefined;

  return (
    <div
      data-copy-side={copySide}
      className="flex items-stretch relative isolate"
      style={{
        height: ROW_H,
        width: isContentWidth ? '100%' : undefined,
        minWidth: isContentWidth ? 'max-content' : undefined,
        background: rowBackground,
        borderRadius: isActiveSearch ? 4 : undefined,
      }}>
      <div
        className="flex shrink-0 sticky left-0 z-[4]"
        style={{
          width: gutterWidth,
          minWidth: gutterWidth,
          background: gutterBackground,
          boxShadow: gutterShadow,
        }}>
        {brdL !== 'transparent' && (
          <div
            aria-hidden
            data-diff-row-accent="true"
            className="pointer-events-none absolute"
            style={{
              right: -3,
              top: 2,
              bottom: 2,
              width: 3,
              borderRadius: 999,
              background: brdL,
              zIndex: 1,
            }}
          />
        )}
        <Ln
          n={line.baseLineNo}
          active={isActiveSearch}
          tone="base"
          selected={isBaseLineSelected}
          selectedColor={selectionAccentColor}
          title={lineNumberTitle}
          blame={line.baseBlame}
          onClick={onBaseLineNumberClick}
        />
        <Ln
          n={line.mineLineNo}
          active={isActiveSearch}
          tone="mine"
          selected={isMineLineSelected}
          selectedColor={selectionAccentColor}
          title={lineNumberTitle}
          blame={line.mineBlame}
          onClick={onMineLineNumberClick}
        />
      </div>
      <div
        data-diff-row-content="true"
        className="flex relative z-[1]"
          style={{
            flex: 1,
            minWidth: isContentWidth ? 'max-content' : 0,
            background: contentHighlightBackground,
          }}>
        <span
          className="select-none shrink-0 relative z-[1]"
          style={{
            paddingLeft: 4, paddingRight: 3,
            color: pfxTx,
            fontSize: FONT_SIZE.md,
            lineHeight: `${ROW_H}px`,
            ...FONT_CODE_STYLE,
          }}>
          {pfx}
        </span>
        <span
          data-selectable-text-root="true"
          className={allowTextSelection ? 'relative z-[1] logical-text-selection-surface cursor-text' : 'relative z-[1]'}
          style={{
            display: 'block',
            flex: 1,
            paddingRight: 8,
            whiteSpace: 'pre',
            fontSize,
            lineHeight: `${ROW_H}px`,
            color: cssVar('t0'),
            ...FONT_CODE_STYLE,
            minWidth: isContentWidth ? 'max-content' : 0,
          }}>
          <span
            data-selectable-text-content="true"
            className="relative z-[1] inline-block"
            style={{
              background: inlineBg,
              padding: inlineBg ? '0 2px' : 0,
              borderRadius: inlineBg ? 2 : 0,
            }}>
            <LogicalTextSelectionDecorations
              selectionRange={textSelectionRange}
            />
            <span className="relative z-[2]">
              <TokenText
                tokens={tokens}
                charSpans={charSpans}
                hlBg={effectiveHighlightBackground}
                backgroundLayers={[rowBackground, inlineBg]}
                selectionUnderlay="linear-gradient(180deg, var(--text-selection-edge) 0%, var(--text-selection-bg) 18%, var(--text-selection-bg) 82%, var(--text-selection-edge) 100%)"
                searchRanges={searchRanges}
                selectionRanges={textSelectionRange ? [textSelectionRange] : []}
                selectionHlBg="color-mix(in srgb, var(--text-selection-bg) 0%, transparent)"
                searchHlBg={cssAlpha('searchHl', '32')}
                activeSearchHlBg={cssAlpha('searchHl', '92')}
                showWhitespace={showWhitespace}
              />
            </span>
          </span>
        </span>
      </div>
      {isActiveSearch && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[4px]"
          style={{
            zIndex: 5,
            border: `1px solid ${cssAlpha('searchHl', 'de')}`,
            boxSizing: 'border-box',
            boxShadow: `0 6px 18px -16px ${cssAlpha('searchHl', '44')}`,
          }}
        />
      )}
    </div>
  );
});

export default DiffRow;
