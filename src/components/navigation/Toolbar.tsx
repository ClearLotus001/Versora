// src/components/Toolbar.tsx
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  AlignJustify,
  Columns2,
  Rows2,
  ChevronsLeft,
  ChevronsRight,
  Search,
  ArrowRightToLine,
  Globe,
  FileText,
  CircleHelp,
  Info,
  ChevronDown,
  RefreshCw,
  Download,
  PackageCheck,
  Minus,
  Square,
  Maximize2,
  X,
  Columns3,
  House,
  ListFilter,
} from 'lucide-react';
import { useI18n } from '@/context/i18n';
import type { AppUpdateState, ThemeKey, LayoutMode, WorkbookCompareMode } from '@/types';
import { THEME_KEYS } from '@/theme';
import Tooltip from '@/components/shared/Tooltip';
import ToolbarViewMenu from '@/components/navigation/ToolbarViewMenu';
import appIconUrl from '../../../assets/icon.png';

type IconName =
  | 'layoutUnified' | 'layoutSplit' | 'layoutVertical' | 'layoutTopBottom'
  | 'prev' | 'next' | 'search' | 'goto'
  | 'language' | 'file' | 'help'
  | 'home'
  | 'diffOnly'
  | 'update' | 'download' | 'install' | 'info' | 'chevronDown'
  | 'windowMinimize' | 'windowMaximize' | 'windowRestore' | 'windowClose';

const ICON_MAP: Record<IconName, React.ElementType> = {
  layoutUnified: AlignJustify,
  layoutSplit: Columns2,
  layoutVertical: Columns3,
  layoutTopBottom: Rows2,
  prev: ChevronsLeft,
  next: ChevronsRight,
  search: Search,
  goto: ArrowRightToLine,
  language: Globe,
  file: FileText,
  help: CircleHelp,
  home: House,
  diffOnly: ListFilter,
  update: RefreshCw,
  download: Download,
  install: PackageCheck,
  info: Info,
  chevronDown: ChevronDown,
  windowMinimize: Minus,
  windowMaximize: Square,
  windowRestore: Maximize2,
  windowClose: X,
};

function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  const LucideIcon = ICON_MAP[name];
  return LucideIcon ? <LucideIcon size={size} className="shrink-0" /> : null;
}

function ThemeSwatch({ theme, active = true }: { theme: ThemeKey; active?: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-theme={theme}
      data-active={active ? 'true' : 'false'}
      className="app-toolbar__theme-indicator shrink-0"
    />
  );
}

const LAYOUT_OPTIONS: { id: LayoutMode }[] = [
  { id: 'unified' },
  { id: 'split-h' },
  { id: 'split-v' },
];

type LayoutLabelKey =
  | 'toolbarLayoutUnified' | 'toolbarLayoutSplit' | 'toolbarLayoutVertical'
  | 'toolbarLayoutWorkbookUnified' | 'toolbarLayoutWorkbookColumns';

function getLayoutLabelKey(layout: LayoutMode, isWorkbookMode: boolean): LayoutLabelKey {
  if (layout === 'unified') return isWorkbookMode ? 'toolbarLayoutWorkbookUnified' : 'toolbarLayoutUnified';
  if (layout === 'split-v') return isWorkbookMode ? 'toolbarLayoutWorkbookColumns' : 'toolbarLayoutVertical';
  return 'toolbarLayoutSplit';
}

function getLayoutIconName(layout: LayoutMode, isWorkbookMode: boolean): IconName {
  if (layout === 'split-v') return isWorkbookMode ? 'layoutVertical' : 'layoutTopBottom';
  if (layout === 'split-h') return 'layoutSplit';
  return 'layoutUnified';
}

interface ToolbarProps {
  fileName: string;
  isHome?: boolean;
  themeKey: ThemeKey;
  setThemeKey: (k: ThemeKey) => void;
  layout: LayoutMode;
  setLayout: (l: LayoutMode) => void;
  hunkIdx: number;
  totalHunks: number;
  hunkTargetLabel?: string;
  showHunkNavigation?: boolean;
  onPrev: () => void;
  onNext: () => void;
  showSearch: boolean;
  setShowSearch: React.Dispatch<React.SetStateAction<boolean>>;
  collapseCtx: boolean;
  setCollapseCtx: React.Dispatch<React.SetStateAction<boolean>>;
  showOnlyDifferences: boolean;
  setShowOnlyDifferences: React.Dispatch<React.SetStateAction<boolean>>;
  showWhitespace: boolean;
  setShowWhitespace: React.Dispatch<React.SetStateAction<boolean>>;
  showHiddenColumns: boolean;
  setShowHiddenColumns: React.Dispatch<React.SetStateAction<boolean>>;
  botEnabled: boolean;
  setBotEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  workbookCompareMode: WorkbookCompareMode;
  setWorkbookCompareMode: (mode: WorkbookCompareMode) => void;
  fontSize: number;
  setFontSize: React.Dispatch<React.SetStateAction<number>>;
  onPickFile: () => void;
  onHome: () => void;
  onGoto: () => void;
  onHelp: () => void;
  onAbout: () => void;
  isElectron: boolean;
  usesNativeWindowControls: boolean;
  isWindowMaximized: boolean;
  isWorkbookMode: boolean;
  workbookContentFiltered: boolean;
  updateState: AppUpdateState | null;
  onCheckForUpdates: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
}

const Toolbar = memo((props: ToolbarProps) => {
  const {
    isHome = false,
    fileName,
    themeKey, setThemeKey, layout, setLayout,
    hunkIdx, totalHunks, hunkTargetLabel = '', showHunkNavigation = true, onPrev, onNext,
    showSearch, setShowSearch, collapseCtx, setCollapseCtx,
    showOnlyDifferences, setShowOnlyDifferences,
    showWhitespace, setShowWhitespace, showHiddenColumns, setShowHiddenColumns,
    botEnabled, setBotEnabled,
    workbookCompareMode, setWorkbookCompareMode,
    fontSize, setFontSize,
    onPickFile, onHome,
    onGoto, onHelp, onAbout, isElectron, usesNativeWindowControls, isWindowMaximized, isWorkbookMode, workbookContentFiltered,
    updateState, onCheckForUpdates, onDownloadUpdate, onInstallUpdate,
  } = props;

  const { getThemeLabel, getLocaleLabel, getNextLocale, setLocale, t } = useI18n();
  const showGotoAction = !(isWorkbookMode && workbookContentFiltered);
  const nextLocale = getNextLocale();
  const noDragStyle = (isElectron ? { WebkitAppRegion: 'no-drag' as const } : undefined) as CSSProperties | undefined;
  const noDragAnchorStyle = noDragStyle;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);
  const [toolbarWidth, setToolbarWidth] = useState(1600);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setToolbarWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!themeMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (themeMenuRef.current?.contains(target ?? null)) return;
      setThemeMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setThemeMenuOpen(false);
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [themeMenuOpen]);

  const responsiveMode = useMemo(() => {
    if (toolbarWidth < 1024) return 'tight';
    if (toolbarWidth < 1180) return 'compact';
    if (toolbarWidth < 1440) return 'condensed';
    return 'regular';
  }, [toolbarWidth]);
  const showLayoutText = responsiveMode === 'regular';
  const showActionText = responsiveMode === 'regular';
  const showFileActionText = responsiveMode !== 'tight';
  const showHunkTarget = (responsiveMode === 'regular' || responsiveMode === 'condensed') && !isWorkbookMode;
  const showThemeLabel = responsiveMode === 'regular' || responsiveMode === 'condensed';
  const showLanguageText = responsiveMode === 'regular' || responsiveMode === 'condensed';
  const showUpdateLabel = responsiveMode !== 'tight';
  const showDiffControls = !isHome;
  const nativeWindowControlsInset = usesNativeWindowControls ? 138 : 0;
  const windowMaximizeTooltip = isWindowMaximized ? t('toolbarWindowRestoreTitle') : t('toolbarWindowMaximizeTitle');
  const fileActionLabel = fileName ? t('toolbarSwitchFileLabel') : t('toolbarPickFileLabel');
  const fileActionTooltip = fileName ? t('toolbarSwitchFileTitle') : t('toolbarPickFileTitle');

  const updateAction = useMemo(() => {
    if (!isElectron || !updateState) return null;
    switch (updateState.status) {
      case 'checking': return { label: t('toolbarUpdateChecking'), icon: 'update' as const, onClick: onCheckForUpdates, disabled: true, active: false };
      case 'available': return { label: t('toolbarUpdateDownload'), icon: 'download' as const, onClick: onDownloadUpdate, disabled: false, active: true };
      case 'downloading': return { label: `${t('toolbarUpdateDownloading')} ${Math.round(updateState.downloadPercent)}%`, icon: 'download' as const, onClick: onDownloadUpdate, disabled: true, active: true };
      case 'downloaded': return { label: t('toolbarUpdateInstall'), icon: 'install' as const, onClick: onInstallUpdate, disabled: false, active: true };
      case 'upToDate': return { label: t('toolbarUpdateUpToDate'), icon: 'update' as const, onClick: onCheckForUpdates, disabled: true, active: false };
      case 'error': return { label: t('toolbarUpdateRetry'), icon: 'update' as const, onClick: onCheckForUpdates, disabled: false, active: true };
      case 'disabled': return { label: t('toolbarUpdateDisabled'), icon: 'update' as const, onClick: onCheckForUpdates, disabled: true, active: false };
      case 'unsupported': return { label: t('toolbarUpdateUnsupported'), icon: 'update' as const, onClick: onCheckForUpdates, disabled: true, active: false };
      case 'idle':
      default: return { label: t('toolbarUpdateCheck'), icon: 'update' as const, onClick: onCheckForUpdates, disabled: false, active: false };
    }
  }, [isElectron, onCheckForUpdates, onDownloadUpdate, onInstallUpdate, t, updateState]);

  const Btn = ({
    active = false, pressed, onClick, children, tooltip = '', compact = false, disabled = false, testId, standalone = false,
  }: {
    active?: boolean; pressed?: boolean; onClick: () => void; children: React.ReactNode;
    tooltip?: string; compact?: boolean; disabled?: boolean;
    testId?: string; standalone?: boolean;
  }) => {
    const button = (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-pressed={pressed}
        data-testid={testId}
        aria-label={tooltip || undefined}
        className={`
          app-toolbar__button
          ${standalone ? 'app-toolbar__control-surface' : ''}
          inline-flex items-center justify-center gap-1.5
          h-8 text-[13px] font-ui
          ${standalone ? 'rounded-[10px] font-bold' : 'rounded-lg font-semibold'}
          whitespace-nowrap leading-none
          transition-all duration-150
          ${compact
            ? (standalone ? 'px-2 min-w-8' : (responsiveMode === 'tight' ? 'px-1.5 min-w-7' : 'px-2 min-w-7'))
            : (responsiveMode === 'tight' ? 'px-2' : 'px-2.5')
          }
          ${active
            ? 'bg-[var(--accent)]/[0.13] border border-[var(--accent)]/40 text-accent'
            : (standalone ? 'bg-bg-surface-hover border border-border-default text-text-title' : 'bg-transparent border border-transparent text-text-title')
          }
          ${disabled
            ? 'opacity-45 cursor-not-allowed'
            : 'cursor-pointer hover:bg-bg-elevated hover:border-border-strong hover:shadow-sm'
          }
          ${standalone && !disabled ? 'hover:-translate-y-px' : ''}
        `}
        style={{
          ...(active ? { boxShadow: 'inset 0 -2px 0 var(--acc2)' } : {}),
          ...noDragStyle,
        }}>
        {children}
      </button>
    );
    return tooltip ? <Tooltip content={tooltip} anchorStyle={noDragAnchorStyle}>{button}</Tooltip> : button;
  };

  const Group = ({ children, ariaLabel, plain = false }: { children: React.ReactNode; ariaLabel?: string; plain?: boolean }) => (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`
        flex items-center shrink-0
        ${plain
          ? 'gap-1.5'
          : `app-toolbar__group rounded-xl bg-bg-surface-hover border border-border-default ${responsiveMode === 'tight' ? 'gap-0.5 p-px' : 'gap-0.5 p-0.5'}`}
      `}
      style={noDragStyle}>
      {children}
    </div>
  );

  const ThemeMenu = () => (
    <div ref={themeMenuRef} className="relative" style={noDragStyle}>
      <Tooltip content={getThemeLabel(themeKey)} anchorStyle={noDragAnchorStyle}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={themeMenuOpen}
          onClick={() => setThemeMenuOpen((open) => !open)}
          className="
            app-toolbar__theme-button app-toolbar__control-surface
            h-8 rounded-[10px] border border-border-default
            bg-bg-surface-hover text-text-title
            font-ui text-[13px] font-bold
            inline-flex items-center gap-2 cursor-pointer whitespace-nowrap
            transition-all duration-150
            hover:-translate-y-px hover:border-border-strong hover:shadow-sm
          "
          style={{
            padding: showThemeLabel ? '0 10px 0 12px' : '0 10px',
            ...noDragStyle,
          }}>
          <ThemeSwatch theme={themeKey} />
          {showThemeLabel && <span>{getThemeLabel(themeKey)}</span>}
          <Icon name="chevronDown" size={12} />
        </button>
      </Tooltip>
      {themeMenuOpen && (
        <div
          role="menu"
          className="
            absolute top-[calc(100%+8px)] right-0 min-w-[176px] p-1.5
            rounded-[14px] border border-border-default
            bg-bg-surface-solid shadow-xl
            flex flex-col gap-1 z-[80]
          "
          style={noDragStyle}>
          {THEME_KEYS.map((k) => {
            const active = themeKey === k;
            return (
              <button
                key={k}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => { setThemeKey(k); setThemeMenuOpen(false); }}
                className={`
                  h-[34px] px-3 rounded-[10px] border
                  font-ui text-[13px]
                  flex items-center justify-between gap-2.5
                  cursor-pointer text-left
                  transition-all duration-150
                  ${active
                    ? 'border-[var(--accent)]/25 bg-[var(--accent)]/[0.08] text-accent font-bold'
                    : 'border-transparent bg-transparent text-text-title font-semibold hover:bg-bg-surface-hover'
                  }
                `}
                style={noDragStyle}>
                <span>{getThemeLabel(k)}</span>
                <ThemeSwatch theme={k} active={active} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={`
        app-toolbar
        ${isHome ? 'app-toolbar--home' : ''}
        flex items-center flex-nowrap gap-2
        min-h-[44px] shrink-0 min-w-0 overflow-visible
        relative z-50 border-b border-border-default
        bg-bg-surface glass
      `}
      style={{
        padding: `6px ${8 + nativeWindowControlsInset}px 6px 8px`,
        ...(isElectron ? { WebkitAppRegion: 'drag' as const } : {}),
      }}>
      {/* ── Left Section ── */}
      <div className="flex items-center content-center flex-nowrap gap-1.5 min-w-0 flex-1 overflow-hidden">
        {isHome && (
          <div className="app-toolbar__brand" data-testid="toolbar-home-brand">
            <img src={appIconUrl} alt="" draggable={false} />
            <span>Versora</span>
          </div>
        )}

        {showDiffControls && (
          <Group ariaLabel={t('toolbarHomeTitle')}>
            <Btn onClick={onHome} tooltip={t('toolbarHomeTitle')} testId="toolbar-home">
              <Icon name="home" />
              {showFileActionText && <span>{t('toolbarHomeLabel')}</span>}
            </Btn>
          </Group>
        )}

        {showDiffControls && isElectron && Boolean(fileName) && (
          <Group ariaLabel={fileActionTooltip}>
            <Btn onClick={onPickFile} tooltip={fileActionTooltip} testId="toolbar-pick-file">
              <Icon name="file" />
              {showFileActionText && <span>{fileActionLabel}</span>}
            </Btn>
          </Group>
        )}

        {/* Layout group */}
        {showDiffControls && (
          <Group ariaLabel={t(getLayoutLabelKey(layout, isWorkbookMode))}>
            {LAYOUT_OPTIONS.map((option) => {
              const labelKey = getLayoutLabelKey(option.id, isWorkbookMode);
              const iconName = getLayoutIconName(option.id, isWorkbookMode);
              return (
                <Btn
                  key={option.id}
                  active={layout === option.id}
                  pressed={layout === option.id}
                  onClick={() => setLayout(option.id)}
                  tooltip={t(labelKey)}
                  testId={`toolbar-layout-${option.id}`}>
                  <Icon name={iconName} />
                  {showLayoutText && <span>{t(labelKey)}</span>}
                </Btn>
              );
            })}
          </Group>
        )}

        {/* Hunk navigation */}
        {showDiffControls && showHunkNavigation && (
          <Group ariaLabel={t('toolbarNextHunkTitle')}>
          <Btn onClick={onPrev} tooltip={t('toolbarPrevHunkTitle')} compact>
            <Icon name="prev" />
          </Btn>
          <span
            className="text-[13px] text-text-primary font-code min-w-[42px] text-center leading-none"
            style={noDragStyle}>
            {totalHunks > 0 ? `${hunkIdx + 1}/${totalHunks}` : '–/–'}
          </span>
          {showHunkTarget && hunkTargetLabel && (
            <Tooltip content={hunkTargetLabel} anchorStyle={noDragAnchorStyle}>
              <span
                className="
                  max-w-[132px] h-6 px-2 rounded-full
                  border border-border-default
                  text-[var(--acc2)] text-[11px] font-bold font-code
                  inline-flex items-center min-w-0
                  overflow-hidden text-ellipsis whitespace-nowrap
                "
                style={{
                  background: 'color-mix(in srgb, var(--acc2) 6%, transparent)',
                  ...noDragStyle,
                }}>
                {hunkTargetLabel}
              </span>
            </Tooltip>
          )}
          <Btn onClick={onNext} tooltip={t('toolbarNextHunkTitle')} compact>
            <Icon name="next" />
          </Btn>
          </Group>
        )}

        {/* Search & Goto */}
        {showDiffControls && (
          <Group ariaLabel={t('toolbarSearchTitle')}>
          <Btn active={showSearch} pressed={showSearch} onClick={() => setShowSearch(v => !v)} tooltip={t('toolbarSearchTitle')}>
            <Icon name="search" />
            {showActionText && <span>{t('toolbarSearchLabel')}</span>}
          </Btn>
          {showGotoAction && (
            <Btn onClick={onGoto} tooltip={t('toolbarGotoTitle')}>
              <Icon name="goto" />
              {showActionText && <span>{t('toolbarGotoLabel')}</span>}
            </Btn>
          )}
          </Group>
        )}

        {showDiffControls && isWorkbookMode && (
          <Group ariaLabel={t('toolbarDiffOnlyTitle')}>
            <Btn
              active={showOnlyDifferences}
              pressed={showOnlyDifferences}
              onClick={() => setShowOnlyDifferences((value) => !value)}
              tooltip={t('toolbarDiffOnlyQuickTitle')}
              testId="toolbar-diff-only">
              <Icon name="diffOnly" />
              {showActionText && <span>{t('toolbarDiffOnlyQuickLabel')}</span>}
            </Btn>
          </Group>
        )}

        {showDiffControls && (
          <ToolbarViewMenu
            collapseCtx={collapseCtx}
            setCollapseCtx={setCollapseCtx}
            showOnlyDifferences={showOnlyDifferences}
            setShowOnlyDifferences={setShowOnlyDifferences}
            showWhitespace={showWhitespace}
            setShowWhitespace={setShowWhitespace}
            showHiddenColumns={showHiddenColumns}
            setShowHiddenColumns={setShowHiddenColumns}
            botEnabled={botEnabled}
            setBotEnabled={setBotEnabled}
            workbookCompareMode={workbookCompareMode}
            setWorkbookCompareMode={setWorkbookCompareMode}
            fontSize={fontSize}
            setFontSize={setFontSize}
            isWorkbookMode={isWorkbookMode}
            showLabel
            noDragStyle={noDragStyle}
            anchorStyle={noDragAnchorStyle}
          />
        )}
      </div>

      {/* ── Right Section ── */}
      <div className="flex items-center justify-end content-center flex-nowrap gap-1.5 flex-none ml-2" style={noDragStyle}>
        {updateAction && (
          <Btn standalone active={updateAction.active} onClick={updateAction.onClick} tooltip={updateState?.errorMessage || updateAction.label} disabled={updateAction.disabled}>
            <Icon name={updateAction.icon} />
            {showUpdateLabel && <span>{updateAction.label}</span>}
          </Btn>
        )}

        <Group plain ariaLabel={t('toolbarLanguageTitle')}>
          <Btn standalone onClick={() => setLocale(nextLocale)} tooltip={t('toolbarLanguageTitle')}>
            <Icon name="language" />
            {showLanguageText && (
              <span>{getLocaleLabel(nextLocale)}</span>
            )}
          </Btn>
          <Btn standalone onClick={onAbout} tooltip={t('toolbarAboutTitle')} compact>
            <Icon name="info" />
          </Btn>
          <Btn standalone onClick={onHelp} tooltip={t('toolbarShortcutsTitle')} compact>
            <Icon name="help" />
          </Btn>
        </Group>

        <ThemeMenu />

        {isElectron && !usesNativeWindowControls && (
          <Group plain>
            <Btn standalone onClick={() => window.versora!.windowMinimize()} tooltip={t('toolbarWindowMinimizeTitle')} compact>
              <Icon name="windowMinimize" />
            </Btn>
            <Btn standalone onClick={() => window.versora!.windowMaximize()} tooltip={windowMaximizeTooltip} compact>
              <Icon name={isWindowMaximized ? 'windowRestore' : 'windowMaximize'} />
            </Btn>
            <Btn standalone onClick={() => window.versora!.windowClose()} tooltip={t('toolbarWindowCloseTitle')} compact>
              <Icon name="windowClose" />
            </Btn>
          </Group>
        )}
      </div>
    </div>
  );
});

export default Toolbar;
