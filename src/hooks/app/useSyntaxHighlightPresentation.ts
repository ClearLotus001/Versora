import { useEffect, useMemo, useState } from 'react';

import type { DiffData, SyntaxPresentation } from '@/types';
import type { ThemeKey } from '@/theme';
import { computeSyntaxTokensAsync } from '@/utils/diff/computeSyntaxTokensAsync';
import { detectSyntaxLanguage } from '@/utils/diff/detectSyntaxLanguage';
import { isWorkbookFileName, resolveDiffTexts } from '@/utils/diff/diffSource';
import { isSupportedShikiLanguage } from '@/utils/diff/shikiSupportedLanguages';
import {
  resolveShikiTheme,
  shouldUseAsyncSyntaxHighlighting,
} from '@/utils/diff/syntaxHighlighting';

interface UseSyntaxHighlightPresentationArgs {
  currentDiffData: DiffData | null;
  isWorkbookMode: boolean;
  themeKey: ThemeKey;
}

export default function useSyntaxHighlightPresentation({
  currentDiffData,
  isWorkbookMode,
  themeKey,
}: UseSyntaxHighlightPresentationArgs): SyntaxPresentation | null {
  const [presentation, setPresentation] = useState<SyntaxPresentation | null>(null);

  const syntaxInput = useMemo(() => {
    if (
      !currentDiffData
      || isWorkbookMode
      || [currentDiffData.fileName, currentDiffData.baseName, currentDiffData.mineName].some(isWorkbookFileName)
    ) return null;

    const { baseText, mineText } = resolveDiffTexts(currentDiffData);
    const languageId = detectSyntaxLanguage(
      currentDiffData.fileName || currentDiffData.baseName || currentDiffData.mineName,
      baseText,
      mineText,
    );
    const supportedLanguageId = isSupportedShikiLanguage(languageId) ? languageId : null;

    return {
      baseText,
      mineText,
      languageId: supportedLanguageId,
      themeName: resolveShikiTheme(themeKey),
    };
  }, [currentDiffData, isWorkbookMode, themeKey]);

  useEffect(() => {
    if (!syntaxInput) {
      setPresentation(null);
      return;
    }

    if (!shouldUseAsyncSyntaxHighlighting(
      syntaxInput.baseText,
      syntaxInput.mineText,
      syntaxInput.languageId,
    )) {
      setPresentation(null);
      return;
    }

    let cancelled = false;
    setPresentation(null);

    void computeSyntaxTokensAsync({
      baseText: syntaxInput.baseText,
      mineText: syntaxInput.mineText,
      languageId: syntaxInput.languageId!,
      themeName: syntaxInput.themeName,
    }).then((nextPresentation) => {
      if (!cancelled) setPresentation(nextPresentation);
    }).catch(() => {
      if (!cancelled) setPresentation(null);
    });

    return () => {
      cancelled = true;
    };
  }, [syntaxInput]);

  return presentation;
}
