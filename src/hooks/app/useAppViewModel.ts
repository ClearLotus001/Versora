import { useCallback, useEffect, useMemo, type MutableRefObject } from 'react';
import { activateWorkbookArtifact } from '@/utils/workbook/workbookArtifactProvider';
import type { TranslationFn } from '@/context/i18n';

import type {
  DiffTypeFilter,
  TextDiffStats,
  WorkbookDiffRegion,
} from '@/types';
import { computeHunks } from '@/engine/text/diff';
import { summarizeDiffChanges } from '@/engine/text/textChangeAlignment';
import {
  resolveDisplayFileName,
  resolveTwoFileVersionLabels,
  resolveVersionLabel,
} from '@/utils/diff/diffMeta';
import {
  prepareTextDiffAnalysisFromDiffLines,
  resolvePreparedTextAnalysisForDiffLines,
} from '@/utils/diff/preparedTextAnalysis';
import {
  filterTextDiffAnalysis,
  getTextDiffTypeAvailability,
} from '@/utils/diff/diffTypeFilter';
import {
  EMPTY_WORKBOOK_SECTION_ROW_INDEX,
} from '@/utils/workbook/workbookSheetIndex';
import {
  getWorkbookSheetMaxRowNumber,
  resolveWorkbookGotoTarget,
} from '@/utils/workbook/workbookGoto';
import {
  buildWorkbookVisibilityModel,
  getWorkbookDiffTypeAvailability,
} from '@/utils/workbook/workbookVisibilityModel';
import {
  formatWorkbookDiffRegionSummary,
} from '@/utils/workbook/workbookDiffRegion';
import { getWorkbookSharedExpandedBlocks } from '@/utils/workbook/workbookLayoutState';
import {
  buildWorkbookLineSheetContexts,
} from '@/utils/workbook/workbookSections';
import {
  getCompareContextLabels,
  getPreparedTextAnalysisForMode,
} from '@/hooks/app/helpers';
import type { CollapseExpansionState } from '@/utils/collapse/collapseState';
import { useAppStore } from '@/store/appStore';
import { createWorkbookSelectionState } from '@/utils/workbook/workbookSelectionState';
import { revealWorkbookSelection } from '@/utils/workbook/workbookManualVisibility';
import useAppSearchModel from '@/hooks/app/useAppSearchModel';

interface UseAppViewModelArgs {
  t: TranslationFn;
  workbookSharedExpandedBlocksRef: MutableRefObject<Map<string, CollapseExpansionState>>;
  scrollToIndexRef: MutableRefObject<((idx: number, align?: 'start' | 'center') => void) | null>;
  currentDiffData: import('@/types').DiffData | null;
  diffTypeFilter: DiffTypeFilter;
  showOnlyDifferences: boolean;
  onError: (message: string) => void;
}

const WORKBOOK_FILE_EXTENSION_RE = /\.(xlsx|xlsm|xltx|xltm|xlsb|xls)$/i;
const EMPTY_MODIFIED_WORKBOOK_SHEET_NAMES = new Set<string>();

function isWorkbookFileCandidate(name: string): boolean {
  return WORKBOOK_FILE_EXTENSION_RE.test(name.trim());
}

export default function useAppViewModel({
  t,
  workbookSharedExpandedBlocksRef,
  scrollToIndexRef,
  currentDiffData,
  diffTypeFilter,
  showOnlyDifferences,
  onError,
}: UseAppViewModelArgs) {
  // ── Read state directly from Zustand store ──────────────────────────
  const compareContext = useAppStore((s) => s.compareContext);
  const launchBaseName = useAppStore((s) => s.launchBaseName);
  const baseName = useAppStore((s) => s.baseName);
  const launchMineName = useAppStore((s) => s.launchMineName);
  const mineName = useAppStore((s) => s.mineName);
  const fileName = useAppStore((s) => s.fileName);
  const baseRevisionInfo = useAppStore((s) => s.baseRevisionInfo);
  const mineRevisionInfo = useAppStore((s) => s.mineRevisionInfo);
  const canSwitchRevisions = useAppStore((s) => s.canSwitchRevisions);
  const workbookSelection = useAppStore((s) => s.workbookSelection);
  const workbookFreezeBySheet = useAppStore((s) => s.workbookFreezeBySheet);
  const baseWorkbookMetadata = useAppStore((s) => s.baseWorkbookMetadata);
  const mineWorkbookMetadata = useAppStore((s) => s.mineWorkbookMetadata);
  const workbookArtifactDiff = useAppStore((s) => s.workbookArtifactDiff);
  const diffSourceNoticeCode = useAppStore((s) => s.diffSourceNoticeCode);
  const diffLines = useAppStore((s) => s.diffLines);
  const isElectron = useAppStore((s) => s.isElectron);
  const isDevMode = useAppStore((s) => s.isDevMode);
  const workbookCompareMode = useAppStore((s) => s.workbookCompareMode);
  const hunkIdx = useAppStore((s) => s.hunkIdx);
  const activeWorkbookSheetName = useAppStore((s) => s.activeWorkbookSheetName);
  const isWorkbookCandidate = useMemo(
    () => isWorkbookFileCandidate(fileName || baseName || mineName),
    [baseName, fileName, mineName],
  );
  const sourceTextAnalysis = useMemo(
    () => {
      const transported = getPreparedTextAnalysisForMode(currentDiffData, workbookCompareMode);
      if (
        transported
        && (
          transported.diffLines.length === 0
          || transported.splitRowDescriptors.length > 0
        )
      ) {
        return resolvePreparedTextAnalysisForDiffLines(transported, diffLines);
      }
      return !isWorkbookCandidate && diffLines.length > 0
        ? prepareTextDiffAnalysisFromDiffLines(diffLines)
        : null;
    },
    [currentDiffData, diffLines, isWorkbookCandidate, workbookCompareMode],
  );
  const preparedTextAnalysis = useMemo(
    () => {
      if (isWorkbookCandidate) return null;
      return sourceTextAnalysis
        ? filterTextDiffAnalysis(sourceTextAnalysis, diffTypeFilter)
        : null;
    },
    [diffTypeFilter, isWorkbookCandidate, sourceTextAnalysis],
  );
  const presentedDiffLines = useMemo(
    () => (
      isWorkbookCandidate
        ? diffLines
        : (preparedTextAnalysis?.diffLines ?? [])
    ),
    [diffLines, isWorkbookCandidate, preparedTextAnalysis],
  );
  // ── Read setters directly from store ──────────────────────────────────
  const setWorkbookSelection = useAppStore((s) => s.setWorkbookSelection);
  const setWorkbookHiddenStateBySheet = useAppStore((s) => s.setWorkbookHiddenStateBySheet);
  const setWorkbookContextMenu = useAppStore((s) => s.setWorkbookContextMenu);

  // ── Derived state (same logic as before) ─────────────────────────────
  const twoFileBasePath = compareContext === 'literal_two_file_compare'
    ? (currentDiffData?.basePath?.trim() ?? '')
    : '';
  const twoFileMinePath = compareContext === 'literal_two_file_compare'
    ? (currentDiffData?.minePath?.trim() ?? '')
    : '';
  const displayBaseName = (
    compareContext === 'literal_two_file_compare'
      ? (twoFileBasePath || launchBaseName || baseName || t('commonBase'))
      : (baseName || t('commonBase'))
  );
  const displayMineName = (
    compareContext === 'literal_two_file_compare'
      ? (twoFileMinePath || launchMineName || mineName || t('commonMine'))
      : (mineName || t('commonMine'))
  );

  const displayFileName = useMemo(
    () => resolveDisplayFileName(fileName, baseName, mineName),
    [fileName, baseName, mineName],
  );

  const selectedCell = workbookSelection.primary;

  const twoFileVersionLabels = useMemo(
    () => resolveTwoFileVersionLabels(displayBaseName, displayMineName),
    [displayBaseName, displayMineName],
  );
  const baseVersionLabel = useMemo(
    () => (
      compareContext === 'literal_two_file_compare'
        ? (canSwitchRevisions
            ? resolveVersionLabel(displayBaseName, baseRevisionInfo, twoFileVersionLabels.base)
            : twoFileVersionLabels.base)
        : resolveVersionLabel(displayBaseName, baseRevisionInfo, t('commonBase'))
    ),
    [baseRevisionInfo, canSwitchRevisions, compareContext, displayBaseName, t, twoFileVersionLabels.base],
  );
  const mineVersionLabel = useMemo(
    () => (
      compareContext === 'literal_two_file_compare'
        ? (canSwitchRevisions
            ? resolveVersionLabel(displayMineName, mineRevisionInfo, twoFileVersionLabels.mine)
            : twoFileVersionLabels.mine)
        : resolveVersionLabel(displayMineName, mineRevisionInfo, t('commonMine'))
    ),
    [mineRevisionInfo, canSwitchRevisions, compareContext, displayMineName, t, twoFileVersionLabels.mine],
  );

  const compareContextLabels = useMemo(
    () => getCompareContextLabels(compareContext, Boolean(currentDiffData?.isSideOrderSwapped)),
    [compareContext, currentDiffData?.isSideOrderSwapped],
  );
  const baseRoleTitle = t(compareContextLabels.baseTitleKey);
  const mineRoleTitle = t(compareContextLabels.mineTitleKey);
  const baseStatsTitle = t(compareContextLabels.baseStatsKey);
  const mineStatsTitle = t(compareContextLabels.mineStatsKey);

  const activeFreezeState = useMemo(
    () => (selectedCell ? (workbookFreezeBySheet[selectedCell.sheetName] ?? null) : null),
    [selectedCell, workbookFreezeBySheet],
  );
  const activeSelectionMergeRanges = useMemo(() => {
    if (!selectedCell) return [];
    const sheetName = selectedCell.sheetName;
    return selectedCell.side === 'base'
      ? (baseWorkbookMetadata?.sheets[sheetName]?.mergeRanges ?? [])
      : (mineWorkbookMetadata?.sheets[sheetName]?.mergeRanges ?? []);
  }, [baseWorkbookMetadata, mineWorkbookMetadata, selectedCell]);

  const artifactNoticeKey = useMemo(() => (
    workbookArtifactDiff?.hasArtifactOnlyDiff
      ? [
          fileName,
          baseRevisionInfo?.id ?? baseRevisionInfo?.revision ?? baseName,
          mineRevisionInfo?.id ?? mineRevisionInfo?.revision ?? mineName,
          workbookArtifactDiff.baseBytes,
          workbookArtifactDiff.mineBytes,
        ].join('::')
      : ''
  ), [
    baseName,
    baseRevisionInfo?.id,
    baseRevisionInfo?.revision,
    fileName,
    mineName,
    mineRevisionInfo?.id,
    mineRevisionInfo?.revision,
    workbookArtifactDiff,
  ]);
  const diffSourceNoticeKey = diffSourceNoticeCode ?? '';

  const hunks = useMemo(
    () => (isWorkbookCandidate ? [] : computeHunks(presentedDiffLines)),
    [isWorkbookCandidate, presentedDiffLines],
  );
  const textDiffStats = useMemo<TextDiffStats>(
    () => preparedTextAnalysis?.stats ?? summarizeDiffChanges(presentedDiffLines),
    [preparedTextAnalysis, presentedDiffLines],
  );
  const hunkPositions = useMemo(() => hunks.map((h) => h.startIdx), [hunks]);
  const totalHunks = hunks.length;

  const artifactProvider = useMemo(() => currentDiffData?.workbookArtifact
    ? activateWorkbookArtifact(currentDiffData.workbookArtifact) : null, [currentDiffData?.workbookArtifact]);
  useEffect(() => {
    const primary = workbookSelection.primary;
    if (!artifactProvider || !primary || primary.kind !== 'cell' || primary.dataStatus !== 'pending') return;
    let cancelled = false;
    void artifactProvider.resolveSelection(primary).then((resolved) => {
      if (cancelled) return;
      setWorkbookSelection((current) => current.primary === primary ? {
        ...current, primary: resolved,
        anchor: current.anchor === primary ? resolved : current.anchor,
        items: current.items.map((item) => item === primary ? resolved : item),
      } : current);
    }).catch(() => {
      if (cancelled) return;
      setWorkbookSelection((current) => current.primary === primary ? { ...current, primary: { ...primary, dataStatus: 'error' } } : current);
    });
    return () => { cancelled = true; };
  }, [artifactProvider, workbookSelection.primary, setWorkbookSelection]);
  const workbookSections = useMemo(
    () => artifactProvider?.getSections() ?? [],
    [artifactProvider],
  );
  const isWorkbookMode = workbookSections.length > 0;
  const activeWorkbookSection = useMemo(
    () => (
      activeWorkbookSheetName
        ? (workbookSections.find((section) => section.name === activeWorkbookSheetName) ?? null)
        : null
    ),
    [activeWorkbookSheetName, workbookSections],
  );
  const workbookSectionRowIndex = useMemo(
    () => {
      if (!artifactProvider) return EMPTY_WORKBOOK_SECTION_ROW_INDEX;
      return { artifactProvider, get: (name: string) => { const rows = artifactProvider.getRows(name); return rows ? { rows } : undefined; } };
    },
    [artifactProvider],
  );
  const diffTypeAvailability = useMemo(
    () => (
      isWorkbookMode
        ? getWorkbookDiffTypeAvailability({
            sections: workbookSections,
            sectionRowIndex: workbookSectionRowIndex,
            compareMode: workbookCompareMode,
          })
        : getTextDiffTypeAvailability(sourceTextAnalysis)
    ),
    [
      isWorkbookMode,
      sourceTextAnalysis,
      workbookCompareMode,
      workbookSectionRowIndex,
      workbookSections,
    ],
  );
  const workbookDiffRegions = useMemo<WorkbookDiffRegion[]>(
    () => artifactProvider?.getRegions(baseVersionLabel, mineVersionLabel, diffTypeFilter) ?? [],
    [artifactProvider, baseVersionLabel, mineVersionLabel, diffTypeFilter]);
  const modifiedWorkbookSheetNames = useMemo<ReadonlySet<string>>(() => {
    if (!artifactProvider) return EMPTY_MODIFIED_WORKBOOK_SHEET_NAMES;
    return new Set(artifactProvider.descriptor.sheets.filter((sheet) => !sheet.hasBaseSide || !sheet.hasMineSide || sheet.changedCellCount > 0 || sheet.addedRows > 0 || sheet.deletedRows > 0).map((sheet) => sheet.name));
  }, [artifactProvider]);
  const workbookVisibilityModel = useMemo(() => buildWorkbookVisibilityModel({
    showOnlyDifferences: showOnlyDifferences && isWorkbookMode,
    diffTypeFilter,
    sections: workbookSections,
    sectionRowIndex: workbookSectionRowIndex,
    modifiedSheetNames: modifiedWorkbookSheetNames,
    compareMode: workbookCompareMode,
  }), [
    isWorkbookMode,
    modifiedWorkbookSheetNames,
    showOnlyDifferences,
    diffTypeFilter,
    workbookCompareMode,
    workbookSectionRowIndex,
    workbookSections,
  ]);
  const hunkNavigationEnabled = !isWorkbookMode
    || workbookVisibilityModel.policy.mode === 'full';
  const {
    searchJumpNonce,
    isSearching,
    isSearchPatternInvalid,
    searchMatches,
    searchMatchCount,
    searchResultsTruncated,
    searchResultItemResolver,
    handleSearch,
    handleSearchPreviewNav,
    handleSearchNav,
    handleSearchJump,
  } = useAppSearchModel({
    t,
    diffLines: presentedDiffLines,
    isWorkbookMode,
    activeWorkbookSheetName,
    baseRoleTitle,
    mineRoleTitle,
    workbookVisibilityModel,
    artifactProvider,
    onError,
  });
  const activeWorkbookDiffRegion = isWorkbookMode && hunkNavigationEnabled
    ? (workbookDiffRegions[hunkIdx] ?? null)
    : null;
  const activeWorkbookSharedExpandedBlocks = getWorkbookSharedExpandedBlocks(
    workbookSharedExpandedBlocksRef.current,
    activeWorkbookSheetName,
    activeWorkbookDiffRegion?.id ?? null,
  );
  const activeWorkbookTargetCell = activeWorkbookDiffRegion?.anchorSelection ?? null;
  const activeWorkbookGuidedRange = useMemo(() => (
    activeWorkbookDiffRegion
      ? {
          startIdx: activeWorkbookDiffRegion.lineStartIdx,
          endIdx: activeWorkbookDiffRegion.lineEndIdx,
          addCount: 0,
          delCount: 0,
        }
      : null
  ), [activeWorkbookDiffRegion]);
  const navigationCount = isWorkbookMode ? workbookDiffRegions.length : totalHunks;
  const currentNavigationLabel = useMemo(() => {
    if (!isWorkbookMode) return '';
    return formatWorkbookDiffRegionSummary(activeWorkbookDiffRegion);
  }, [activeWorkbookDiffRegion, isWorkbookMode]);

  const totalLines = useMemo(() => {
    if (isWorkbookMode) {
      if (workbookVisibilityModel.policy.mode === 'differences-only' && activeWorkbookSheetName) {
        if (artifactProvider) {
          let maxRow = 0;
          for (const rowIndex of workbookVisibilityModel.visibleLineIndexesBySheet.get(activeWorkbookSheetName) ?? []) {
            maxRow = Math.max(maxRow, artifactProvider.descriptor.rows.baseRowNumbers[rowIndex] ?? 0,
              artifactProvider.descriptor.rows.mineRowNumbers[rowIndex] ?? 0);
          }
          return maxRow;
        }
        return getWorkbookSheetMaxRowNumber(
          diffLines,
          buildWorkbookLineSheetContexts(diffLines),
          activeWorkbookSheetName,
          workbookVisibilityModel.visibleLineIndexesBySheet.get(activeWorkbookSheetName),
        );
      }
      const activeSheetMaxRow = activeWorkbookSection?.rowCount ?? 0;
      if (activeSheetMaxRow > 0) return activeSheetMaxRow;

      const maxWorkbookRowCount = workbookSections.reduce(
        (max, section) => Math.max(max, section.rowCount),
        0,
      );
      if (maxWorkbookRowCount > 0) return maxWorkbookRowCount;
    }

    let max = 0;
    presentedDiffLines.forEach((line) => {
      const lineMax = Math.max(line.baseLineNo ?? 0, line.mineLineNo ?? 0);
      if (lineMax > max) max = lineMax;
    });
    return max;
  }, [activeWorkbookSection, activeWorkbookSheetName, artifactProvider, diffLines, isWorkbookMode, presentedDiffLines, workbookSections, workbookVisibilityModel]);
  const canLaunchUninstaller = isElectron && !isDevMode && typeof window.versora?.launchUninstaller === 'function';

  // Build a line-number → diff-index Map for O(1) goto lookup.
  const lineNoToIdx = useMemo(() => {
    const map = new Map<number, number>();
    for (let i = 0; i < presentedDiffLines.length; i++) {
      const line = presentedDiffLines[i]!;
      if (line.baseLineNo != null && !map.has(line.baseLineNo)) {
        map.set(line.baseLineNo, i);
      }
      if (line.mineLineNo != null && !map.has(line.mineLineNo)) {
        map.set(line.mineLineNo, i);
      }
    }
    return map;
  }, [presentedDiffLines]);

  const handleGoto = useCallback((lineNo: number) => {
    if (!scrollToIndexRef.current) return;

    if (isWorkbookMode && activeWorkbookSheetName) {
      const lineSheetContexts = buildWorkbookLineSheetContexts(diffLines);
      const resolvedGotoTarget = resolveWorkbookGotoTarget({
        lineNo,
        artifact: artifactProvider?.descriptor,
        diffLines,
        lineSheetContexts,
        sheetName: activeWorkbookSheetName,
        preferredSide: selectedCell?.sheetName === activeWorkbookSheetName
          ? selectedCell.side
          : null,
        preferredColumn: selectedCell?.kind !== 'column'
          ? (selectedCell?.colIndex ?? 0)
          : selectedCell.colIndex,
        preferredColumnLabel: selectedCell?.colLabel,
        baseVersionLabel,
        mineVersionLabel,
        allowedLineIndexes: workbookVisibilityModel.policy.mode === 'differences-only'
          ? workbookVisibilityModel.visibleLineIndexesBySheet.get(activeWorkbookSheetName)
          : undefined,
      });

      if (resolvedGotoTarget) {
        setWorkbookSelection(createWorkbookSelectionState(resolvedGotoTarget.selection));
        setWorkbookHiddenStateBySheet((prev) => revealWorkbookSelection(prev, resolvedGotoTarget.selection));
        setWorkbookContextMenu(null);
        scrollToIndexRef.current(resolvedGotoTarget.lineIdx, 'center');
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            scrollToIndexRef.current?.(resolvedGotoTarget.lineIdx, 'center');
          });
        });
        return;
      }
    }

    // O(1) exact match via pre-built index
    const exactIdx = lineNoToIdx.get(lineNo);
    if (exactIdx !== undefined) {
      scrollToIndexRef.current(exactIdx, 'center');
      return;
    }

    // Fallback: binary search for nearest line >= lineNo (lines are monotonic)
    let lo = 0;
    let hi = presentedDiffLines.length - 1;
    let nearestIdx = presentedDiffLines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const midLine = presentedDiffLines[mid]!;
      const midLineNo = Math.max(midLine.baseLineNo ?? 0, midLine.mineLineNo ?? 0);
      if (midLineNo >= lineNo) {
        nearestIdx = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    if (presentedDiffLines.length > 0) {
      scrollToIndexRef.current(nearestIdx, 'center');
    }
  }, [
    artifactProvider,
    activeWorkbookSheetName,
    baseVersionLabel,
    diffLines,
    isWorkbookMode,
    lineNoToIdx,
    mineVersionLabel,
    presentedDiffLines,
    scrollToIndexRef,
    selectedCell,
    workbookVisibilityModel,
    setWorkbookContextMenu,
    setWorkbookHiddenStateBySheet,
    setWorkbookSelection,
  ]);

  return {
    presentedDiffLines,
    displayBaseName,
    displayMineName,
    twoFileBasePath,
    twoFileMinePath,
    displayFileName,
    selectedCell,
    baseVersionLabel,
    mineVersionLabel,
    baseRoleTitle,
    mineRoleTitle,
    baseStatsTitle,
    mineStatsTitle,
    activeFreezeState,
    activeSelectionMergeRanges,
    artifactNoticeKey,
    diffSourceNoticeKey,
    hunks,
    preparedTextAnalysis,
    textDiffStats,
    hunkPositions,
    searchJumpNonce,
    isSearching,
    isSearchPatternInvalid,
    searchMatches,
    searchMatchCount,
    searchResultsTruncated,
    searchResultItemResolver,
    workbookSections,
    workbookSectionRowIndex,
    workbookVisibilityModel,
    isWorkbookMode,
    diffTypeAvailability,
    hunkNavigationEnabled,
    workbookDiffRegions,
    activeWorkbookDiffRegion,
    activeWorkbookSharedExpandedBlocks,
    activeWorkbookTargetCell,
    activeWorkbookGuidedRange,
    navigationCount,
    currentNavigationLabel,
    totalLines,
    canLaunchUninstaller,
    handleSearch,
    handleSearchPreviewNav,
    handleSearchNav,
    handleSearchJump,
    handleGoto,
  };
}
