import { useEffect, useMemo, type MutableRefObject } from 'react';

import type { SvnRevisionInfo, WorkbookCompareMode } from '@/types';
import { clearTokenCache } from '@/engine/text/tokenizer';
import { saveStoredAppSettings } from '@/utils/app/settings';
import { getComputedThemeTokens, invalidateThemeTokensCache, THEME_CLASS_MAP } from '@/theme';
import { useAppStore } from '@/store/appStore';

interface UseAppChromeEffectsArgs {
  revisionOptionsRef: MutableRefObject<SvnRevisionInfo[]>;
  workbookCompareModeRef: MutableRefObject<WorkbookCompareMode>;
}

export default function useAppChromeEffects({
  revisionOptionsRef,
  workbookCompareModeRef,
}: UseAppChromeEffectsArgs) {
  // ── Read state/setters directly from Zustand store ────────────────────
  const themeKey = useAppStore((s) => s.themeKey);
  const isElectron = useAppStore((s) => s.isElectron);
  const usesNativeWindowControls = useAppStore((s) => s.usesNativeWindowControls);
  const revisionOptions = useAppStore((s) => s.revisionOptions);
  const workbookCompareMode = useAppStore((s) => s.workbookCompareMode);

  // ── Persisted settings (derived from store) ───────────────────────────
  const layout = useAppStore((s) => s.layout);
  const collapseCtx = useAppStore((s) => s.collapseCtx);
  const showOnlyDifferences = useAppStore((s) => s.showOnlyDifferences);
  const showWhitespace = useAppStore((s) => s.showWhitespace);
  const showHiddenColumns = useAppStore((s) => s.showHiddenColumns);
  const botEnabled = useAppStore((s) => s.botEnabled);
  const fontSize = useAppStore((s) => s.fontSize);

  const settings = useMemo(() => ({
    themeKey,
    layout,
    collapseCtx,
    showOnlyDifferences,
    showWhitespace,
    showHiddenColumns,
    botEnabled,
    workbookCompareMode,
    fontSize,
  }), [
    collapseCtx,
    fontSize,
    layout,
    showOnlyDifferences,
    showHiddenColumns,
    showWhitespace,
    botEnabled,
    themeKey,
    workbookCompareMode,
  ]);

  // 主题切换时同步 body className 并使 token 缓存失效
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    for (const themeClass of Object.values(THEME_CLASS_MAP)) {
      root.classList.remove(themeClass);
    }
    root.classList.add(THEME_CLASS_MAP[themeKey]);
    invalidateThemeTokensCache();
    const T = getComputedThemeTokens(themeKey);
    root.style.setProperty('--boot-bg', T.bg0);
    root.style.setProperty('--boot-fg', T.t0);
  }, [themeKey]);

  // 原生窗口控件的标题栏颜色跟随主题
  useEffect(() => {
    if (!isElectron || !usesNativeWindowControls || !window.versora?.setTitleBarOverlay) return;
    const T = getComputedThemeTokens(themeKey);
    window.versora.setTitleBarOverlay({
      color: T.bg1,
      symbolColor: T.t0,
      height: 44,
    });
  }, [themeKey, isElectron, usesNativeWindowControls]);

  useEffect(() => {
    revisionOptionsRef.current = revisionOptions;
  }, [revisionOptions, revisionOptionsRef]);

  useEffect(() => {
    clearTokenCache();
  }, [themeKey]);

  useEffect(() => {
    workbookCompareModeRef.current = workbookCompareMode;
  }, [workbookCompareMode, workbookCompareModeRef]);

  useEffect(() => {
    saveStoredAppSettings(settings);
  }, [settings]);

  useEffect(() => {
    window.versora?.saveStartupAppearance?.({ themeKey });
  }, [themeKey]);
}
