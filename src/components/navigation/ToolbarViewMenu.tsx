import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { useI18n } from '@/context/i18n';
import { cssAlpha, cssVar } from '@/theme/cssUtils';
import type { WorkbookCompareMode } from '@/types';
import Tooltip from '@/components/shared/Tooltip';

const DEFAULT_VIEW_STATE = {
  collapseCtx: true,
  showOnlyDifferences: true,
  showWhitespace: false,
  showHiddenColumns: false,
  botEnabled: true,
  workbookCompareMode: 'strict' as WorkbookCompareMode,
  fontSize: 12,
};
const MENU_WIDTH = 292;
const MENU_GAP = 8;
const VIEWPORT_PADDING = 12;
const MENU_ITEM_RADIUS = 12;
const FONT_CONTROL_RADIUS = 11;
const SECTION_TITLE_CLASS = 'h-5 px-1 flex items-center font-ui text-[11px] font-extrabold text-text-secondary tracking-wide';
const DIVIDER_CLASS = 'h-px bg-border-default opacity-70';

const createMenuButtonStyle = (active: boolean, interactiveStyle: CSSProperties): CSSProperties => ({
  ...interactiveStyle,
  borderRadius: MENU_ITEM_RADIUS,
  borderColor: active ? cssAlpha('acc', '66') : 'var(--liquid-glass-border, var(--border-color))',
  background: active
    ? `linear-gradient(180deg, ${cssAlpha('acc', '24')} 0%, color-mix(in srgb, var(--liquid-control-fill, var(--bg-surface-hover)) 76%, var(--accent) 12%) 100%)`
    : 'linear-gradient(180deg, color-mix(in srgb, var(--liquid-glass-highlight) 18%, transparent) 0%, var(--liquid-control-fill) 100%)',
  boxShadow: active
    ? `inset 0 1px 0 var(--liquid-glass-highlight), 0 10px 24px -20px ${cssAlpha('acc', '66')}`
    : 'inset 0 1px 0 var(--liquid-glass-highlight), 0 8px 20px -20px var(--liquid-glass-shadow)',
});

const createSwitchTrackStyle = (checked: boolean): CSSProperties => ({
  borderRadius: 999,
  border: `1px solid ${checked ? cssAlpha('acc', '88') : 'var(--liquid-glass-border, var(--border-color))'}`,
  background: checked
    ? `linear-gradient(180deg, ${cssVar('acc')} 0%, color-mix(in srgb, ${cssVar('acc')} 78%, var(--text-title) 10%) 100%)`
    : 'color-mix(in srgb, var(--text-secondary) 16%, var(--liquid-control-fill, var(--bg-surface-hover)) 84%)',
  boxShadow: checked
    ? `0 0 0 3px ${cssAlpha('acc', '18')}, inset 0 1px 0 color-mix(in srgb, var(--liquid-glass-highlight) 34%, transparent)`
    : 'inset 0 1px 0 var(--liquid-glass-highlight)',
});

const createSwitchKnobStyle = (checked: boolean): CSSProperties => ({
  borderRadius: 999,
  transform: checked ? 'translateX(16px)' : 'translateX(0)',
  background: checked ? 'var(--btn-active-text)' : 'var(--text-secondary)',
  boxShadow: '0 2px 6px color-mix(in srgb, var(--liquid-glass-shadow) 24%, transparent)',
});

interface ToolbarViewMenuProps {
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
  isWorkbookMode: boolean;
  showLabel: boolean;
  noDragStyle?: CSSProperties | undefined;
  anchorStyle?: CSSProperties | undefined;
}

const ToolbarViewMenu = memo(({
  collapseCtx, setCollapseCtx,
  showOnlyDifferences, setShowOnlyDifferences,
  showWhitespace, setShowWhitespace,
  showHiddenColumns, setShowHiddenColumns,
  botEnabled, setBotEnabled,
  workbookCompareMode, setWorkbookCompareMode,
  fontSize, setFontSize,
  isWorkbookMode, showLabel,
  noDragStyle, anchorStyle,
}: ToolbarViewMenuProps) => {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const interactiveStyle = noDragStyle ?? {};
  const menuTooltipAnchorStyle = useMemo<CSSProperties>(
    () => ({ ...anchorStyle, width: '100%' }),
    [anchorStyle],
  );

  const updateAnchorRect = () => {
    const nextRect = rootRef.current?.getBoundingClientRect();
    if (nextRect) setAnchorRect(nextRect);
  };

  useEffect(() => {
    if (!open) return;
    updateAnchorRect();
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (rootRef.current?.contains(target ?? null)) return;
      if (menuRef.current?.contains(target ?? null)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const handleLayout = () => updateAnchorRect();
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleLayout);
    window.addEventListener('scroll', handleLayout, true);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleLayout);
      window.removeEventListener('scroll', handleLayout, true);
    };
  }, [open]);

  const viewStateCount = useMemo(() => {
    let count = 0;
    if (collapseCtx !== DEFAULT_VIEW_STATE.collapseCtx) count += 1;
    if (isWorkbookMode && showOnlyDifferences !== DEFAULT_VIEW_STATE.showOnlyDifferences) count += 1;
    if (showWhitespace !== DEFAULT_VIEW_STATE.showWhitespace) count += 1;
    if (isWorkbookMode && showHiddenColumns !== DEFAULT_VIEW_STATE.showHiddenColumns) count += 1;
    if (botEnabled !== DEFAULT_VIEW_STATE.botEnabled) count += 1;
    if (isWorkbookMode && workbookCompareMode !== DEFAULT_VIEW_STATE.workbookCompareMode) count += 1;
    if (fontSize !== DEFAULT_VIEW_STATE.fontSize) count += 1;
    return count;
  }, [botEnabled, collapseCtx, fontSize, isWorkbookMode, showHiddenColumns, showOnlyDifferences, showWhitespace, workbookCompareMode]);

  const ToggleRow = ({
    checked, label, onClick, tooltip, testId,
  }: {
    checked: boolean; label: string; onClick: () => void; tooltip: string; testId?: string;
  }) => (
    <Tooltip content={tooltip} placement="left" anchorStyle={menuTooltipAnchorStyle} sideBoundaryRef={menuRef}>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={checked}
        data-testid={testId}
        onClick={onClick}
        className={`
          toolbar-view-menu__item
          w-full h-10 px-3 border font-ui text-[13px] font-semibold leading-[1.4]
          grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 cursor-pointer text-left
          transition-all duration-150 hover:-translate-y-px active:translate-y-0
          ${checked ? 'text-accent' : 'text-text-title'}
        `}
        style={createMenuButtonStyle(checked, interactiveStyle)}>
        <span className="min-w-0 whitespace-nowrap leading-[1.4] overflow-visible">{label}</span>
        <span
          aria-hidden="true"
          className="toolbar-view-menu__switch relative w-[34px] h-[18px] shrink-0 transition-all duration-150"
          style={createSwitchTrackStyle(checked)}>
          <span
            className="toolbar-view-menu__switch-knob absolute left-[2px] top-[2px] size-[14px] transition-transform duration-150 ease-out"
            style={createSwitchKnobStyle(checked)}
          />
        </span>
      </button>
    </Tooltip>
  );

  const CompareModeButton = ({
    active, label, onClick, tooltip, testId,
  }: {
    active: boolean; label: string; onClick: () => void; tooltip: string; testId?: string;
  }) => (
    <Tooltip content={tooltip} placement="left" anchorStyle={menuTooltipAnchorStyle} sideBoundaryRef={menuRef}>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={active}
        data-testid={testId}
        onClick={onClick}
        className={`
          toolbar-view-menu__item
          w-full h-10 px-3 border font-ui text-[13px] font-bold
          inline-flex items-center justify-center gap-2 cursor-pointer text-center
          transition-all duration-150 hover:-translate-y-px active:translate-y-0
          ${active ? 'text-accent' : 'text-text-title'}
        `}
        style={createMenuButtonStyle(active, interactiveStyle)}>
        <span
          aria-hidden="true"
          className="size-[6px] shrink-0 transition-opacity duration-150"
          style={{ borderRadius: 999, background: active ? cssVar('acc') : 'var(--text-secondary)', opacity: active ? 1 : 0.35 }}
        />
        <span className="min-w-0 truncate">{label}</span>
      </button>
    </Tooltip>
  );

  const menuLayout = useMemo(() => {
    if (!anchorRect || typeof window === 'undefined') return null;
    const left = Math.min(
      Math.max(anchorRect.right - MENU_WIDTH, VIEWPORT_PADDING),
      Math.max(VIEWPORT_PADDING, window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING),
    );
    return { left, top: anchorRect.bottom + MENU_GAP };
  }, [anchorRect]);

  const menu = open && menuLayout && typeof document !== 'undefined'
    ? createPortal(
      <div
        ref={menuRef}
        role="menu"
        className="toolbar-view-menu motion-floating-panel fixed p-2.5 rounded-[18px] border border-border-default bg-bg-surface-solid grid gap-2 z-[220] glass"
        style={{
          top: menuLayout.top,
          left: menuLayout.left,
          width: MENU_WIDTH,
          boxShadow: 'inset 0 1px 0 var(--liquid-glass-highlight), 0 22px 54px -34px var(--liquid-glass-shadow)',
          ...interactiveStyle,
        }}>
        <div className="grid gap-1.5">
          <div className={SECTION_TITLE_CLASS}>{t('toolbarSectionDisplay')}</div>
          <ToggleRow checked={collapseCtx} onClick={() => setCollapseCtx((v) => !v)} label={collapseCtx ? t('toolbarExpandAllLabel') : t('toolbarCollapseLabel')} tooltip={t('toolbarCollapseTitle')} />
          {isWorkbookMode && (
            <ToggleRow
              checked={showOnlyDifferences}
              onClick={() => setShowOnlyDifferences((value) => !value)}
              label={t('toolbarDiffOnlyLabel')}
              tooltip={t('toolbarDiffOnlyTitle')}
            />
          )}
          <ToggleRow checked={showWhitespace} onClick={() => setShowWhitespace((v) => !v)} label={t('toolbarWhitespaceLabel')} tooltip={t('toolbarWhitespaceTitle')} />
          <ToggleRow checked={botEnabled} onClick={() => setBotEnabled((value) => !value)} label={t('toolbarBotLabel')} tooltip={t('toolbarBotTitle')} testId="toolbar-bot-toggle" />
          {isWorkbookMode && (
            <ToggleRow checked={showHiddenColumns} onClick={() => setShowHiddenColumns((v) => !v)} label={t('toolbarHiddenColumnsLabel')} tooltip={t('toolbarHiddenColumnsTitle')} />
          )}
        </div>

        {isWorkbookMode && (
          <>
            <div className={DIVIDER_CLASS} />
            <div className="grid gap-1.5">
              <div className={SECTION_TITLE_CLASS}>{t('toolbarSectionCompare')}</div>
              <div className="grid grid-cols-2 gap-2">
                <CompareModeButton
                  active={workbookCompareMode === 'content'}
                  label={t('toolbarCompareModeContent')}
                  onClick={() => setWorkbookCompareMode('content')}
                  tooltip={t('toolbarCompareModeContentTitle')}
                  testId="toolbar-compare-content"
                />
                <CompareModeButton
                  active={workbookCompareMode === 'strict'}
                  label={t('toolbarCompareModeStrict')}
                  onClick={() => setWorkbookCompareMode('strict')}
                  tooltip={t('toolbarCompareModeStrictTitle')}
                  testId="toolbar-compare-strict"
                />
              </div>
            </div>
          </>
        )}

        <div className={DIVIDER_CLASS} />

        <div className="grid gap-2">
          <div className={SECTION_TITLE_CLASS}>{t('toolbarSectionFont')}</div>
          <div className="flex items-center justify-between gap-3 px-0.5">
            <div
              className="toolbar-view-menu__font-control inline-grid grid-cols-[32px_36px_32px] items-center h-9 overflow-hidden border border-border-default"
              style={{
                ...interactiveStyle,
                borderRadius: FONT_CONTROL_RADIUS,
                background: 'var(--liquid-control-fill, var(--bg-surface-hover))',
                borderColor: 'var(--liquid-glass-border, var(--border-color))',
              }}>
              <button
                type="button"
                onClick={() => setFontSize((s) => Math.max(10, s - 1))}
                className="toolbar-view-menu__font-button h-full border-none bg-transparent text-text-title font-ui text-[13px] font-bold cursor-pointer hover:bg-bg-elevated active:scale-95 transition-all duration-150"
                style={{ ...interactiveStyle, boxShadow: 'none' }}>
                A-
              </button>
              <span className="text-center text-text-primary font-code text-[13px] font-semibold tabular-nums">{fontSize}</span>
              <button
                type="button"
                onClick={() => setFontSize((s) => Math.min(20, s + 1))}
                className="toolbar-view-menu__font-button h-full border-none bg-transparent text-text-title font-ui text-[13px] font-bold cursor-pointer hover:bg-bg-elevated active:scale-95 transition-all duration-150"
                style={{ ...interactiveStyle, boxShadow: 'none' }}>
                A+
              </button>
            </div>
            <span className="text-[12px] text-text-secondary font-code whitespace-nowrap tabular-nums">10px - 20px</span>
          </div>
        </div>
      </div>,
      document.body,
    )
    : null;

  return (
    <div ref={rootRef} className="relative shrink-0" style={noDragStyle}>
      <Tooltip content={t('toolbarViewTitle')} anchorStyle={anchorStyle}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="toolbar-view-menu"
          onClick={() => setOpen((v) => !v)}
          className={`
            h-8 rounded-[10px] border border-border-default
            bg-bg-surface-hover font-ui text-[13px] font-semibold
            inline-flex items-center gap-2 cursor-pointer whitespace-nowrap
            transition-all duration-150
            hover:-translate-y-px hover:border-border-strong hover:shadow-sm
            ${open ? 'text-accent' : 'text-text-title'}
          `}
          style={{
            padding: showLabel ? '0 10px 0 12px' : '0 10px',
            ...interactiveStyle,
          }}>
          {showLabel && <span>{t('toolbarViewLabel')}</span>}
          {viewStateCount > 0 && (
            <span
              className="min-w-[18px] h-[18px] px-1.5 rounded-full text-[10px] font-extrabold inline-flex items-center justify-center"
              style={{ background: cssAlpha('acc', '16'), color: cssVar('acc') }}>
              {viewStateCount}
            </span>
          )}
          <ChevronDown size={10} />
        </button>
      </Tooltip>
      {menu}
    </div>
  );
});

export default ToolbarViewMenu;
