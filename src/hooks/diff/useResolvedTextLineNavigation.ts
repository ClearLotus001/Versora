import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import type { CollapseExpansionState } from '@/utils/collapse/collapseState';
import { isLineManuallyCollapsed, revealManualCollapsedLine, revealCollapsedLine } from '@/utils/collapse/collapseState';
import {
  findCollapsedRowTarget,
  type CollapsibleRowBlock,
} from '@/utils/collapse/collapsibleRows';

interface PendingScrollTarget {
  lineIdx: number;
  align: 'start' | 'center';
}

interface UseResolvedTextLineNavigationParams<RowT extends { lineIdx: number }> {
  itemsDependency: readonly unknown[];
  rowBlocks: readonly CollapsibleRowBlock<RowT>[];
  expandedBlocks: CollapseExpansionState;
  setExpandedBlocks: Dispatch<SetStateAction<CollapseExpansionState>>;
  contextLines: number;
  blockPrefix: string;
  scrollToIndex: (idx: number, align?: 'start' | 'center') => void;
  findExactItemIndex: (lineIdx: number) => number;
  findNearestItemIndex: (lineIdx: number) => number;
  rowHasLineIdx?: ((row: RowT, lineIdx: number) => boolean) | undefined;
  onAfterScrollToIndex?: (() => void) | undefined;
  onScrollerReady?: ((scrollToIndex: (idx: number, align?: 'start' | 'center') => void) => void) | undefined;
  activeSearchLineIdx: number;
  searchJumpNonce: number;
  initialSearchJumpNonce?: number | undefined;
}

interface UseResolvedTextLineNavigationResult {
  scrollToResolvedLine: (lineIdx: number, align?: 'start' | 'center') => boolean;
}

export function useResolvedTextLineNavigation<RowT extends { lineIdx: number }>({
  itemsDependency,
  rowBlocks,
  expandedBlocks,
  setExpandedBlocks,
  contextLines,
  blockPrefix,
  scrollToIndex,
  findExactItemIndex,
  findNearestItemIndex,
  rowHasLineIdx,
  onAfterScrollToIndex,
  onScrollerReady,
  activeSearchLineIdx,
  searchJumpNonce,
  initialSearchJumpNonce,
}: UseResolvedTextLineNavigationParams<RowT>): UseResolvedTextLineNavigationResult {
  const completedSearchJumpNonceRef = useRef<number>(initialSearchJumpNonce ?? -1);
  const [pendingScrollTarget, setPendingScrollTarget] = useState<PendingScrollTarget | null>(null);

  const revealLineIfCollapsed = useCallback((lineIdx: number) => {
    if (isLineManuallyCollapsed(expandedBlocks, lineIdx)) {
      setExpandedBlocks((prev) => revealManualCollapsedLine(prev, lineIdx));
      return true;
    }

    const target = findCollapsedRowTarget(rowBlocks, expandedBlocks, lineIdx, {
      contextLines,
      blockPrefix,
      ...(rowHasLineIdx ? { rowHasLineIdx } : {}),
    });
    if (!target) return false;
    setExpandedBlocks((prev) => revealCollapsedLine(
      prev,
      target.blockId,
      target.hiddenStart,
      target.hiddenEnd,
      target.targetIndex,
    ));
    return true;
  }, [blockPrefix, contextLines, expandedBlocks, rowBlocks, rowHasLineIdx, setExpandedBlocks]);

  const scrollToResolvedLine = useCallback((lineIdx: number, align: 'start' | 'center' = 'center') => {
    const exactIndex = findExactItemIndex(lineIdx);
    if (exactIndex >= 0) {
      scrollToIndex(exactIndex, align);
      onAfterScrollToIndex?.();
      setPendingScrollTarget((prev) => (
        prev && prev.lineIdx === lineIdx && prev.align === align ? null : prev
      ));
      return true;
    }
    if (revealLineIfCollapsed(lineIdx)) {
      setPendingScrollTarget({ lineIdx, align });
      return false;
    }
    const nearestIndex = findNearestItemIndex(lineIdx);
    if (nearestIndex >= 0) {
      scrollToIndex(nearestIndex, align);
      onAfterScrollToIndex?.();
      return true;
    }
    return false;
  }, [findExactItemIndex, findNearestItemIndex, onAfterScrollToIndex, revealLineIfCollapsed, scrollToIndex]);

  useEffect(() => {
    onScrollerReady?.((lineIdx, align) => {
      scrollToResolvedLine(lineIdx, align ?? 'center');
    });
  }, [onScrollerReady, scrollToResolvedLine]);

  useEffect(() => {
    if (searchJumpNonce === completedSearchJumpNonceRef.current) return;
    if (activeSearchLineIdx < 0) {
      completedSearchJumpNonceRef.current = searchJumpNonce;
      return;
    }
    if (scrollToResolvedLine(activeSearchLineIdx, 'center')) {
      completedSearchJumpNonceRef.current = searchJumpNonce;
    }
  }, [activeSearchLineIdx, scrollToResolvedLine, searchJumpNonce]);

  useEffect(() => {
    if (!pendingScrollTarget) return;
    if (scrollToResolvedLine(pendingScrollTarget.lineIdx, pendingScrollTarget.align)) {
      setPendingScrollTarget(null);
    }
  }, [itemsDependency, pendingScrollTarget, scrollToResolvedLine]);

  return {
    scrollToResolvedLine,
  };
}
