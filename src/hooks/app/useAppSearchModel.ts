import type { WorkbookArtifactProvider } from '@/utils/workbook/workbookArtifactProvider';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TranslationFn } from '@/context/i18n';
import type { DiffLine, SearchMatch } from '@/types';
import { compileSearchPattern, getSearchableLineContent, navigateSearch } from '@/engine/text/search';
import { useAppStore } from '@/store/appStore';
import { computeSearchMatchesAsync, disposeTextSearchWorker } from '@/utils/diff/computeSearchMatchesAsync';
import { createSearchResultItemResolver } from '@/utils/diff/searchResultItems';
import type { WorkbookVisibilityModel } from '@/utils/workbook/workbookVisibilityModel';
const EMPTY_SEARCH_MATCHES: SearchMatch[] = [];
const SEARCH_REQUEST_DEBOUNCE_MS = 90;

export default function useAppSearchModel({
  t,
  diffLines,
  isWorkbookMode,
  activeWorkbookSheetName,
  baseRoleTitle,
  mineRoleTitle,
  workbookVisibilityModel,
  artifactProvider,
  onError,
}: {
  t: TranslationFn;
  diffLines: DiffLine[];
  isWorkbookMode: boolean;
  activeWorkbookSheetName: string | null;
  baseRoleTitle: string;
  mineRoleTitle: string;
  workbookVisibilityModel: WorkbookVisibilityModel;
  artifactProvider?: WorkbookArtifactProvider | null;
  onError: (message: string) => void;
}) {
  const searchQ = useAppStore((state) => state.searchQ);
  const searchRx = useAppStore((state) => state.searchRx);
  const searchCs = useAppStore((state) => state.searchCs);
  const searchWorkbookScope = useAppStore((state) => state.searchWorkbookScope);
  const searchJumpNonce = useAppStore((state) => state.searchJumpNonce);
  const setSearchQ = useAppStore((state) => state.setSearchQ);
  const setSearchRx = useAppStore((state) => state.setSearchRx);
  const setSearchCs = useAppStore((state) => state.setSearchCs);
  const setSearchWorkbookScope = useAppStore((state) => state.setSearchWorkbookScope);
  const setActiveSearchIdx = useAppStore((state) => state.setActiveSearchIdx);
  const setSearchJumpNonce = useAppStore((state) => state.setSearchJumpNonce);
  const sequenceRef = useRef(0);
  const [allMatches, setAllMatches] = useState<SearchMatch[]>(EMPTY_SEARCH_MATCHES);
  const [matchCount, setMatchCount] = useState(0);
  const [resultsTruncated, setResultsTruncated] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [resolvedInput, setResolvedInput] = useState<{
    projection: object;
    query: string;
    regex: boolean;
    caseSensitive: boolean;
  } | null>(null);

  const compilation = useMemo(
    () => compileSearchPattern(searchQ, { isRegex: searchRx, isCaseSensitive: searchCs }),
    [searchCs, searchQ, searchRx],
  );
  const hasQuery = searchQ.trim().length > 0;
  const projection = useMemo(() => ({
    lines: hasQuery && !artifactProvider ? diffLines.map(getSearchableLineContent) : [],
    lineStartOffsets: null,
    // These inputs also define the identity of an artifact search result.
    artifactProvider, activeWorkbookSheetName, searchWorkbookScope, workbookVisibilityModel,
  }), [artifactProvider, activeWorkbookSheetName, diffLines, hasQuery, searchWorkbookScope, workbookVisibilityModel]);

  useEffect(() => {
    const sequence = ++sequenceRef.current;
    if (!compilation.pattern || !hasQuery) {
      disposeTextSearchWorker();
      setAllMatches(EMPTY_SEARCH_MATCHES);
      setMatchCount(0);
      setResultsTruncated(false);
      setIsSearching(false);
      return;
    }
    setIsSearching(false);
    const requestId = `workbook-search:${sequence}:${Date.now()}`;
    const timeoutId = window.setTimeout(() => {
      if (sequence !== sequenceRef.current) return;
      setIsSearching(true);
      const searchTask = artifactProvider ? artifactProvider.search({
        artifactId: artifactProvider.descriptor.artifactId, compareMode: artifactProvider.descriptor.compareMode,
        requestId, query: searchQ, isRegex: searchRx, isCaseSensitive: searchCs,
        ...(searchWorkbookScope === 'sheet' && activeWorkbookSheetName
          ? { sheetId: artifactProvider.descriptor.sheets.find((sheet) => sheet.name === activeWorkbookSheetName)!.id } : {}),
        ...(workbookVisibilityModel.policy.mode === 'differences-only'
          ? { visibleRowIndexes: Uint32Array.from([...workbookVisibilityModel.visibleLineIndexesBySheet.values()].flatMap((rows) => [...rows])) } : {}),
      }).then((result) => ({ matches: result.matches.map((match): SearchMatch => ({
        lineIdx: match.rowIndex, start: match.start, end: match.end, snippet: match.snippet,
        workbookTarget: { sheetName: artifactProvider.descriptor.sheets.find((sheet) => sheet.id === match.sheetId)!.name,
          side: match.side, rowNumber: match.rowNumber, colIndex: match.column },
      })), truncated: result.truncated, totalCount: result.totalCount })) : computeSearchMatchesAsync(projection.lines, {
        query: searchQ,
        isRegex: searchRx,
        isCaseSensitive: searchCs,
      }, projection.lineStartOffsets);
      void searchTask.then((result) => {
        if (sequence !== sequenceRef.current) return;
        setIsSearching(false);
        const matches = result.matches;
        setMatchCount(artifactProvider && 'totalCount' in result ? result.totalCount as number : matches.length);
        setResultsTruncated(result.truncated);
        setAllMatches(matches);
        setResolvedInput({ projection, query: searchQ, regex: searchRx, caseSensitive: searchCs });
      }).catch((error: unknown) => {
        if (sequence !== sequenceRef.current) return;
        setIsSearching(false);
        if (error instanceof Error && error.name === 'AbortError') return;
        onError(error instanceof Error ? error.message : String(error));
        setAllMatches(EMPTY_SEARCH_MATCHES);
        setMatchCount(0);
        setResultsTruncated(false);
        setResolvedInput({ projection, query: searchQ, regex: searchRx, caseSensitive: searchCs });
      });
    }, SEARCH_REQUEST_DEBOUNCE_MS);
    return () => {
      if (sequenceRef.current === sequence) sequenceRef.current += 1;
      window.clearTimeout(timeoutId);
      if (artifactProvider) void artifactProvider.cancelSearch(requestId).catch(() => {});
    };
  }, [artifactProvider, activeWorkbookSheetName, searchWorkbookScope, compilation.pattern, diffLines, hasQuery, onError, projection, searchCs, searchQ, searchRx, workbookVisibilityModel]);

  const resultsCurrent = resolvedInput?.projection === projection
    && resolvedInput.query === searchQ
    && resolvedInput.regex === searchRx
    && resolvedInput.caseSensitive === searchCs;
  const searchMatches = useMemo(() => (
    !resultsCurrent ? EMPTY_SEARCH_MATCHES
    : !isWorkbookMode || searchWorkbookScope !== 'sheet' || !activeWorkbookSheetName
      ? allMatches
      : allMatches.filter((match) => match.workbookTarget?.sheetName === activeWorkbookSheetName)
  ), [activeWorkbookSheetName, allMatches, isWorkbookMode, resultsCurrent, searchWorkbookScope]);
  const searchResultItemResolver = useMemo(() => createSearchResultItemResolver({
    diffLines,
    searchMatches,
    baseRoleTitle,
    mineRoleTitle,
    noResultsLabel: t('searchNoResults'),
  }), [baseRoleTitle, diffLines, mineRoleTitle, searchMatches, t]);

  useEffect(() => {
    if (hasQuery && compilation.pattern && !resultsCurrent) return;
    setActiveSearchIdx((previous) => searchMatches.length === 0 ? -1 : Math.min(Math.max(previous, 0), searchMatches.length - 1));
  }, [compilation.pattern, hasQuery, resultsCurrent, searchMatches.length, setActiveSearchIdx]);

  const handleSearch = useCallback((query: string, regex: boolean, caseSensitive: boolean, scope: 'all' | 'sheet') => {
    setSearchQ(query); setSearchRx(regex); setSearchCs(caseSensitive); setSearchWorkbookScope(scope);
    setActiveSearchIdx(query ? 0 : -1); setSearchJumpNonce((value) => value + 1);
  }, [setActiveSearchIdx, setSearchCs, setSearchJumpNonce, setSearchQ, setSearchRx, setSearchWorkbookScope]);
  const handleSearchNav = useCallback((direction: 1 | -1) => {
    setActiveSearchIdx((index) => navigateSearch(index, searchMatches.length, direction));
    setSearchJumpNonce((value) => value + 1);
  }, [searchMatches.length, setActiveSearchIdx, setSearchJumpNonce]);
  const handleSearchPreviewNav = useCallback((direction: 1 | -1) => {
    setActiveSearchIdx((index) => navigateSearch(index, searchMatches.length, direction));
  }, [searchMatches.length, setActiveSearchIdx]);
  const handleSearchJump = useCallback((index: number) => {
    setActiveSearchIdx(index >= 0 && index < searchMatches.length ? index : -1);
    setSearchJumpNonce((value) => value + 1);
  }, [searchMatches.length, setActiveSearchIdx, setSearchJumpNonce]);

  return {
    searchJumpNonce,
    isSearching,
    isSearchPatternInvalid: compilation.status === 'invalid',
    searchMatches,
    searchMatchCount: resultsCurrent ? matchCount : 0,
    searchResultsTruncated: resultsCurrent && resultsTruncated,
    searchResultItemResolver,
    handleSearch,
    handleSearchNav,
    handleSearchPreviewNav,
    handleSearchJump,
  };
}
