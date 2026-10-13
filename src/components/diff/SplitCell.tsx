// src/components/SplitCell.tsx
import { memo, useMemo, type MouseEventHandler } from 'react';
import { FONT_CODE_STYLE, FONT_SIZE } from '@/constants/typography';
import { LN_W } from '@/constants/layout';
import type { DiffLine, Token, WorkbookSelectedCell } from '@/types';
import { tokenize } from '@/engine/text/tokenizer';
import { ROW_H } from '@/hooks/virtualization/useVirtual';
import { cssAlpha, cssVar } from '@/theme/cssUtils';
import type { HorizontalVirtualColumnEntry } from '@/hooks/virtualization/useHorizontalVirtualColumns';
import type { WorkbookMergeRange } from '@/utils/workbook/workbookMeta';
import { buildDiffSelectionSurfaces } from '@/utils/diff/selectionVisuals';
import {
  composeTextRowBackground,
  resolveTextDiffCssPalette,
  resolveTextEmptySideBackground,
  resolveTextEmptySideBackgroundPosition,
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

interface SplitCellProps {
  line: DiffLine | null;
  side: 'left' | 'right';
  copySide?: 'base' | 'mine' | 'both';
  lineIdx?: number | null;
  visualRowIndex?: number | null;
  syntaxTokens?: Token[] | undefined;
  widthMode?: 'fill' | 'content';
  lineNumberLayout?: 'single' | 'paired';
  isSearchMatch: boolean;
  isActiveSearch: boolean;
  searchRanges?: TokenSearchRange[] | undefined;
  showWhitespace: boolean;
  fontSize: number;
  allowTextSelection?: boolean;
  textSelectionRange?: TextSelectionRange | null | undefined;
  sheetName?: string;
  versionLabel?: string;
  headerRowNumber?: number;
  selectedCell?: WorkbookSelectedCell | null;
  onSelectCell?: ((cell: WorkbookSelectedCell | null) => void) | undefined;
  isReplacementPair?: boolean;
  maskEqualCells?: boolean;
  stickyLeftBase?: number;
  freezeColumnCount?: number;
  columnCount?: number;
  visibleColumns?: number[];
  renderColumns?: HorizontalVirtualColumnEntry[];
  leadingSpacerWidth?: number;
  trailingSpacerWidth?: number;
  mergedRanges?: WorkbookMergeRange[];
  changedColumns?: number[];
  workbookRoleLabel?: string;
  workbookRoleTone?: 'base' | 'mine';
  rowHeightOverride?: number;
  rowHighlightBg?: string | undefined;
  isRangeSelected?: boolean;
  isBaseLineSelected?: boolean;
  isMineLineSelected?: boolean;
  selectionAccentColor?: string | undefined;
  lineNumberTitle?: string | undefined;
  onBaseLineNumberClick?: MouseEventHandler<HTMLButtonElement> | undefined;
  onMineLineNumberClick?: MouseEventHandler<HTMLButtonElement> | undefined;
}

const SplitCell = memo(({
  line,
  side,
  copySide = side === 'left' ? 'base' : 'mine',
  lineIdx,
  visualRowIndex = lineIdx,
  syntaxTokens,
  widthMode = 'fill',
  lineNumberLayout = 'single',
  isSearchMatch: _isSearchMatch,
  isActiveSearch,
  searchRanges = [],
  showWhitespace,
  fontSize,
  allowTextSelection = false,
  textSelectionRange = null,
  isReplacementPair = false,
  rowHeightOverride,
  rowHighlightBg,
  isRangeSelected = false,
  isBaseLineSelected = false,
  isMineLineSelected = false,
  selectionAccentColor,
  lineNumberTitle,
  onBaseLineNumberClick,
  onMineLineNumberClick,
}: SplitCellProps) => {
  const resolvedRowHeight = rowHeightOverride ?? ROW_H;
  const lineNumberTone = side === 'left' ? 'base' : 'mine';
  const isContentWidth = widthMode === 'content';
  const usesPairedLineNumbers = lineNumberLayout === 'paired';
  const gutterWidth = usesPairedLineNumbers ? LN_W * 2 : LN_W;
  const content = line?.base ?? line?.mine ?? '';
  const tokens = useMemo(() => syntaxTokens ?? tokenize(content), [content, syntaxTokens]);
  const {
    activeCapsuleSurface,
    diffHighlightBackground,
    gutterBackground,
    gutterShadow,
    selectionAccent,
  } = buildDiffSelectionSurfaces({
    selectionAccentColor,
    isBaseLineSelected,
    isMineLineSelected,
    isRangeSelected,
    isActiveSearch,
  });

  const renderLineNumberGutter = (currentLine: DiffLine | null, accent = 'transparent') => (
    <div style={{
      width: gutterWidth,
      minWidth: gutterWidth,
      display: 'flex',
      flexShrink: 0,
      position: 'sticky',
      left: 0,
      zIndex: 4,
      background: currentLine == null && isRangeSelected
        ? `linear-gradient(90deg,
            color-mix(in srgb, ${selectionAccent} 14%, ${cssVar('lnBg')} 86%) 0%,
            color-mix(in srgb, ${selectionAccent} 8%, ${cssVar('bg0')} 92%) 100%)`
        : gutterBackground,
      boxShadow: currentLine == null && isRangeSelected
        ? `inset -1px 0 0 color-mix(in srgb, ${selectionAccent} 12%, transparent)`
        : gutterShadow,
    }}>
      {accent !== 'transparent' && (
        <div
          aria-hidden
          data-diff-row-accent="true"
          style={{
            position: 'absolute',
            right: -3,
            top: 2,
            bottom: 2,
            width: 3,
            borderRadius: 999,
            background: accent,
            pointerEvents: 'none',
            zIndex: 1,
          }}
        />
      )}
      {usesPairedLineNumbers ? (
        <>
          <Ln
            n={currentLine?.baseLineNo ?? null}
            active={isActiveSearch}
            tone="base"
            selected={isBaseLineSelected}
            selectedColor={selectionAccentColor}
            title={lineNumberTitle}
            blame={currentLine?.baseBlame}
            onClick={onBaseLineNumberClick}
          />
          <Ln
            n={currentLine?.mineLineNo ?? null}
            active={isActiveSearch}
            tone="mine"
            selected={isMineLineSelected}
            selectedColor={selectionAccentColor}
            title={lineNumberTitle}
            blame={currentLine?.mineBlame}
            onClick={onMineLineNumberClick}
          />
        </>
      ) : (
        <Ln
          n={side === 'left' ? (currentLine?.baseLineNo ?? null) : (currentLine?.mineLineNo ?? null)}
          active={isActiveSearch}
          tone={lineNumberTone}
          selected={side === 'left' ? isBaseLineSelected : isMineLineSelected}
          selectedColor={selectionAccentColor}
          title={lineNumberTitle}
          blame={side === 'left' ? currentLine?.baseBlame : currentLine?.mineBlame}
          onClick={side === 'left' ? onBaseLineNumberClick : onMineLineNumberClick}
        />
      )}
    </div>
  );

  // Empty padding cell (for alignment when one side has no matching line)
  if (!line) {
    const emptySideBackground = resolveTextEmptySideBackground({
      isRangeSelected,
      selectionAccent,
    });
    const emptySideRowBackground = composeTextRowBackground(activeCapsuleSurface, emptySideBackground);
    const emptySideBackgroundPosition = resolveTextEmptySideBackgroundPosition({
      visualRowIndex,
      rowHeight: resolvedRowHeight,
    });
    return (
      <div
        {...(lineIdx != null ? { 'data-line-idx': lineIdx } : {})}
        data-empty-side="true"
        data-copy-side={copySide}
        style={{
        flex: isContentWidth ? '1 1 auto' : 1,
        display: 'flex',
        height: resolvedRowHeight,
        width: isContentWidth ? '100%' : undefined,
        minWidth: isContentWidth ? 'max-content' : 0,
        isolation: 'isolate',
        position: 'relative',
        background: emptySideRowBackground,
        backgroundPosition: emptySideBackgroundPosition,
      }}>
        {renderLineNumberGutter(null)}
        <div style={{ flex: 1, minWidth: 0 }} />
      </div>
    );
  }

  const isAdd    = line.type === 'add';
  const isDel    = line.type === 'delete';
  const tone = resolveTextDiffVisualTone(line, isReplacementPair);
  const palette = resolveTextDiffCssPalette(tone);
  const brd      = palette.accent;
  const pfx      = isAdd ? '+' : isDel ? '-' : ' ';
  const pfxC     = palette.prefix;
  const hlBg     = palette.inlineHighlight;
  const charSpans = side === 'left' ? line.baseCharSpans : line.mineCharSpans;
  const hasSearchRanges = searchRanges.length > 0;
  const hasTextSelection = Boolean(textSelectionRange && textSelectionRange.end > textSelectionRange.start);
  const searchBg = rowHighlightBg;
  const contentBg = searchBg;
  const inlineBg = resolveTextInlineBackground({
    tone,
    hasSearchRanges,
    isRangeSelected,
    hasRowSurfaceOverride: Boolean(searchBg),
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
      {...(lineIdx != null ? { 'data-line-idx': lineIdx } : {})}
      style={{
        flex: isContentWidth ? '1 1 auto' : 1,
        display: 'flex',
        height: resolvedRowHeight,
        width: isContentWidth ? '100%' : undefined,
        minWidth: isContentWidth ? 'max-content' : 0,
        isolation: 'isolate',
        position: 'relative',
        background: rowBackground,
        borderRadius: isActiveSearch ? 4 : undefined,
      }}>
      {renderLineNumberGutter(line, brd)}
      <div data-diff-row-content="true" style={{
        flex: 1,
        display: 'flex',
        minWidth: isContentWidth ? 'max-content' : 0,
        background: contentBg,
        backgroundImage: contentHighlightBackground,
        position: 'relative',
        zIndex: 1,
      }}>
        <span style={{
          paddingLeft: 4, paddingRight: 3,
          color: pfxC, userSelect: 'none',
          fontSize: FONT_SIZE.md, flexShrink: 0,
          lineHeight: `${resolvedRowHeight}px`,
          ...FONT_CODE_STYLE,
          position: 'relative',
          zIndex: 1,
        }}>
          {pfx}
        </span>
        <span
          data-selectable-text-root="true"
          className={allowTextSelection ? 'logical-text-selection-surface cursor-text' : undefined}
          style={{
            display: 'block',
            flex: 1,
            paddingRight: 6,
            whiteSpace: 'pre',
            fontSize,
            lineHeight: `${resolvedRowHeight}px`,
            color: cssVar('t0'),
            ...FONT_CODE_STYLE,
            minWidth: isContentWidth ? 'max-content' : 0,
            position: 'relative',
            zIndex: 1,
          }}>
          <span
            data-selectable-text-content="true"
            style={{
              display: 'inline-block',
              position: 'relative',
              zIndex: 1,
              background: inlineBg,
              padding: inlineBg ? '0 2px' : 0,
              borderRadius: inlineBg ? 2 : 0,
            }}>
            <LogicalTextSelectionDecorations
              selectionRange={textSelectionRange}
            />
            <span style={{ position: 'relative', zIndex: 2 }}>
              <TokenText
                tokens={tokens}
                charSpans={charSpans}
                hlBg={effectiveHighlightBackground}
                backgroundLayers={[rowBackground, contentBg, inlineBg]}
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
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 4,
            border: `1px solid ${cssAlpha('searchHl', 'de')}`,
            boxSizing: 'border-box',
            boxShadow: `0 6px 18px -16px ${cssAlpha('searchHl', '44')}`,
            pointerEvents: 'none',
            zIndex: 5,
          }}
        />
      )}
    </div>
  );
});

export default SplitCell;
