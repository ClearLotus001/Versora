import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Menu } from 'lucide-react';
import { getWorkbookFontScale } from '@/constants/typography';
import Tooltip from '@/components/shared/Tooltip';
import { useI18n } from '@/context/i18n';
import { cssVar } from '@/theme/cssUtils';
import {
  type DiffIndicatorTone,
  resolveDiffIndicatorCssPalette,
  resolveWorkbookSectionIndicatorTone,
} from '@/utils/diff/diffIndicatorVisuals';
import type { WorkbookSection } from '@/utils/workbook/workbookSections';
import {
  buildWorkbookSheetTabItems,
  type WorkbookCollapsedSheetTabItem,
} from '@/utils/workbook/workbookAutoCollapse';

interface WorkbookSheetTabsProps {
  sections: WorkbookSection[];
  activeIndex: number;
  onSelect: (index: number) => void;
  fontSize: number;
  modifiedSheetNames?: ReadonlySet<string>;
  collapseUnchanged?: boolean;
  onCollapsedGroupsChange?: ((groups: WorkbookCollapsedSheetTabItem[]) => void) | undefined;
}

const EMPTY_MODIFIED_SHEET_NAMES = new Set<string>();
const SCROLL_RAIL_CLASS = 'overflow-x-auto overflow-y-hidden [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden';

const WorkbookSheetTabs = memo(({
  sections,
  activeIndex,
  onSelect,
  fontSize,
  modifiedSheetNames = EMPTY_MODIFIED_SHEET_NAMES,
  collapseUnchanged = false,
  onCollapsedGroupsChange,
}: WorkbookSheetTabsProps) => {
  const { t } = useI18n();
  const sizes = useMemo(() => getWorkbookFontScale(fontSize), [fontSize]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuSurfaceRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 8, bottom: 0, maxHeight: 320 });
  const [expandedCollapseKeys, setExpandedCollapseKeys] = useState<Set<string>>(() => new Set());
  const sheetTabItems = useMemo(
    () => buildWorkbookSheetTabItems(sections, {
      collapseUnchanged,
      activeIndex,
      modifiedSheetNames,
      expandedCollapseKeys,
    }),
    [activeIndex, collapseUnchanged, expandedCollapseKeys, modifiedSheetNames, sections],
  );
  const collapsedGroups = useMemo(
    () => sheetTabItems.filter((item): item is WorkbookCollapsedSheetTabItem => item.kind === 'collapse'),
    [sheetTabItems],
  );

  useEffect(() => {
    if (collapseUnchanged) return;
    setExpandedCollapseKeys(new Set());
  }, [collapseUnchanged]);

  useEffect(() => {
    onCollapsedGroupsChange?.(collapsedGroups);
  }, [collapsedGroups, onCollapsedGroupsChange]);

  const isModifiedSection = (section: WorkbookSection) => (
    section.changeType === 'equal' && modifiedSheetNames.has(section.name)
  );

  const resolveSectionTone = (section: WorkbookSection): DiffIndicatorTone => (
    isModifiedSection(section)
      ? 'modify'
      : resolveWorkbookSectionIndicatorTone(section.changeType)
  );

  const getSectionBadge = (section: WorkbookSection) => {
    if (isModifiedSection(section)) return '~';
    switch (section.changeType) {
      case 'add': return '+';
      case 'delete': return '−';
      case 'rename': return section.renameRole === 'target' ? '→' : '↦';
      default: return '';
    }
  };

  const getSectionLabel = (section: WorkbookSection) => {
    switch (section.changeType) {
      case 'add': return t('workbookSheetTabAddedLabel', { name: section.name });
      case 'delete': return t('workbookSheetTabDeletedLabel', { name: section.name });
      case 'rename': return section.renameRole === 'target'
        ? t('workbookSheetTabRenameTargetLabel', { name: section.name })
        : t('workbookSheetTabRenameSourceLabel', { name: section.name });
      default: return section.displayName;
    }
  };

  const getSectionTooltipStatus = (
    section: WorkbookSection,
  ): { label: string; tone: DiffIndicatorTone } | null => {
    if (section.changeType === 'add') {
      return { label: t('workbookSheetTabTooltipTagAdded'), tone: 'add' };
    }
    if (section.changeType === 'delete') {
      return { label: t('workbookSheetTabTooltipTagDeleted'), tone: 'delete' };
    }
    if (section.changeType === 'rename') {
      return { label: t('workbookSheetTabTooltipTagRenamed'), tone: 'modify' };
    }
    if (isModifiedSection(section)) {
      return { label: t('workbookSheetTabTooltipTagModified'), tone: 'modify' };
    }
    return null;
  };

  const renderSectionTooltip = (section: WorkbookSection) => {
    const status = getSectionTooltipStatus(section) ?? {
      label: t('workbookSheetTabTooltipTagSheet'),
      tone: 'neutral' as const,
    };
    const palette = resolveDiffIndicatorCssPalette(status.tone);
    return (
      <div
        data-testid="workbook-sheet-tab-tooltip-content"
        className="min-w-[148px] max-w-full text-left">
        <span className="block min-w-0">
          <span className="block break-words font-ui text-[12px] font-bold leading-[1.3] text-text-title">
            {section.displayName}
          </span>
          <span
            className="mt-1 flex items-center gap-1.5 font-ui text-[10.5px] font-semibold leading-none"
            style={{ color: status.tone === 'neutral' ? cssVar('t1') : palette.text }}>
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full"
              style={{
                background: palette.accent,
                boxShadow: `0 0 0 3px ${palette.softBackground}`,
              }}
            />
            {status.label}
          </span>
        </span>
      </div>
    );
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0 || el.scrollWidth <= el.clientWidth) return;
      event.preventDefault();
      el.scrollLeft += delta;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node | null) || menuSurfaceRef.current?.contains(event.target as Node | null)) return;
      setMenuOpen(false);
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [menuOpen]);
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const update = () => {
      const anchor = menuRef.current?.getBoundingClientRect();
      if (anchor) setMenuPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - 228)),
        bottom: window.innerHeight - anchor.top + 7, maxHeight: Math.min(320, Math.max(30, anchor.top - 15)) });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [menuOpen]);

  if (sections.length === 0) return null;

  return (
    <div
      data-testid="workbook-sheet-tabs"
      className="flex flex-nowrap items-end gap-1.5 py-1 px-2 shrink-0 relative z-[40] isolate border-t border-border-default overflow-visible"
      style={{
        background: `linear-gradient(180deg, ${cssVar('bg1')} 0%, ${cssVar('bg0')} 100%)`,
        boxShadow: `0 -1px 0 ${cssVar('border')}, 0 -10px 22px -24px ${cssVar('border2')}`,
      }}>
      <div ref={menuRef} className="relative z-[2] shrink-0">
        <button
          type="button"
          data-testid="workbook-sheet-menu-trigger"
          aria-expanded={menuOpen}
          aria-label={t('workbookSheetMenuLabel', { count: sections.length })}
          onClick={() => setMenuOpen((open) => !open)}
          className="h-8 min-w-8 px-2 rounded-[7px] border border-border-default bg-bg-surface-hover text-text-primary cursor-pointer inline-flex items-center justify-center gap-1.5 hover:text-accent hover:border-accent active:scale-95 transition-all duration-150"
          style={{ boxShadow: `0 10px 18px -18px ${cssVar('border2')}` }}>
          <Menu size={13} />
          <span className="font-code text-[10px] font-bold tabular-nums">{sections.length}</span>
        </button>
        {menuOpen && createPortal(
          <div
            ref={menuSurfaceRef}
            data-testid="workbook-sheet-menu"
            className="motion-floating-panel app-themed-scrollbar fixed min-w-[220px] overflow-y-auto p-1.5 rounded-[12px] border border-border-default bg-bg-surface-solid grid gap-1 z-[160]"
            style={{ ...menuPosition, boxShadow: `0 16px 40px -24px ${cssVar('border2')}` }}>
            {sections.map((section, index) => {
              const active = index === activeIndex;
              const modified = isModifiedSection(section);
              const indicatorTone = resolveSectionTone(section);
              const palette = resolveDiffIndicatorCssPalette(indicatorTone);
              const badge = getSectionBadge(section);
              const label = getSectionLabel(section);
              const tooltipContent = renderSectionTooltip(section);
              return (
                <Tooltip
                  key={`menu-${section.name}-${section.startLineIdx}`}
                  content={tooltipContent}
                  maxWidth={240}
                  disabled={!tooltipContent}
                  anchorStyle={{ display: 'block', width: '100%', flexShrink: 1 }}>
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      onSelect(index);
                      setMenuOpen(false);
                    }}
                    className="w-full h-[30px] px-2.5 rounded-[6px] cursor-pointer font-ui text-left whitespace-nowrap overflow-hidden text-ellipsis flex items-center gap-1.5 transition-all duration-150 hover:brightness-110"
                    style={{
                      fontSize: Math.max(12, sizes.ui),
                      border: `1px solid ${active ? palette.border : modified ? palette.softBackground : 'transparent'}`,
                      background: active
                        ? palette.background
                        : modified
                          ? `linear-gradient(90deg, ${palette.softBackground} 0%, transparent 92%)`
                          : 'transparent',
                      color: active ? palette.text : cssVar('t0'),
                      fontWeight: active ? 700 : 600,
                      boxShadow: modified ? `inset 2px 0 0 ${palette.accent}` : 'none',
                    }}>
                    {badge && (
                      <span
                        aria-hidden="true"
                        className="min-w-3.5 font-extrabold"
                        style={{ color: palette.accent }}>
                        {badge}
                      </span>
                    )}
                    {!badge && modified && (
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full shrink-0"
                        style={{
                          background: palette.accent,
                          boxShadow: `0 0 0 4px ${palette.softBackground}`,
                        }}
                      />
                    )}
                    <span className="overflow-hidden text-ellipsis">{label}</span>
                    {tooltipContent && <span className="sr-only">{getSectionTooltipStatus(section)?.label ?? ''}</span>}
                  </button>
                </Tooltip>
              );
            })}
          </div>, document.body,
        )}
      </div>

      <div
        ref={scrollRef}
        className={`flex-1 min-w-0 ${SCROLL_RAIL_CLASS}`}>
        <div className="inline-flex items-end gap-1 min-w-max pr-1">
          {sheetTabItems.map((item) => {
            if (item.kind === 'collapse') {
              const label = t('workbookCollapsedSheetsLabel', { count: item.count });
              return (
                <Tooltip key={item.key} content={label} maxWidth={220}>
                  <button
                    type="button"
                    data-testid="workbook-sheet-collapse"
                    data-collapse-visual="compressed-range"
                    data-collapse-density="compact"
                    data-collapse-arrows="wrap-count"
                    aria-label={t('workbookCollapsedSheetsExpandTitle', { count: item.count })}
                    onClick={() => setExpandedCollapseKeys((previous) => {
                      const next = new Set(previous);
                      next.add(item.key);
                      return next;
                    })}
                    className="group h-6 mb-[3px] min-w-8 px-1.5 rounded-full border border-dashed cursor-pointer font-ui whitespace-nowrap shrink-0 inline-flex items-center justify-center gap-0.5 transition-all duration-150 hover:-translate-y-px hover:brightness-110 active:translate-y-0 active:scale-[0.97]"
                    style={{
                      borderColor: cssVar('border2'),
                      background: `linear-gradient(180deg, color-mix(in srgb, ${cssVar('border2')} 9%, ${cssVar('bg1')}) 0%, color-mix(in srgb, ${cssVar('border2')} 16%, ${cssVar('bg2')}) 100%)`,
                      color: cssVar('t1'),
                      fontSize: Math.max(10, sizes.ui - 1),
                      fontWeight: 700,
                      boxShadow: `inset 0 1px 0 color-mix(in srgb, ${cssVar('bg0')} 72%, transparent)`,
                    }}>
                    <ChevronRight
                      aria-hidden="true"
                      size={8}
                      strokeWidth={2.4}
                      className="shrink-0 opacity-60 transition-all duration-150 group-hover:opacity-90 group-hover:rotate-180"
                    />
                    <span
                      className="min-w-[10px] text-center tabular-nums leading-none"
                      style={{ color: cssVar('t0') }}>
                      {item.count}
                    </span>
                    <ChevronLeft
                      aria-hidden="true"
                      size={8}
                      strokeWidth={2.4}
                      className="shrink-0 opacity-60 transition-all duration-150 group-hover:opacity-90 group-hover:rotate-180"
                    />
                  </button>
                </Tooltip>
              );
            }

            const { section, index } = item;
            const active = index === activeIndex;
            const modified = isModifiedSection(section);
            const indicatorTone = resolveSectionTone(section);
            const palette = resolveDiffIndicatorCssPalette(indicatorTone);
            const badge = getSectionBadge(section);
            const label = getSectionLabel(section);
            const activeTextColor = indicatorTone === 'neutral' ? cssVar('t0') : palette.text;
            const tooltipContent = renderSectionTooltip(section);
            return (
              <Tooltip
                key={`${section.name}-${section.startLineIdx}`}
                content={tooltipContent}
                maxWidth={240}
                disabled={!tooltipContent}>
                <button
                  type="button"
                  data-testid="workbook-sheet-tab"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onSelect(index)}
                  className="h-[30px] px-2.5 rounded-t-[7px] border-b-0 cursor-pointer font-ui whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 max-w-[220px] transition-all duration-150"
                  style={{
                    borderLeft: `1px solid ${active || modified ? palette.border : cssVar('border')}`,
                    borderRight: `1px solid ${active || modified ? palette.border : cssVar('border')}`,
                    borderTop: `${active ? 2 : 1}px solid ${active ? palette.accent : modified ? palette.border : 'transparent'}`,
                    background: active
                      ? `linear-gradient(180deg, ${palette.softBackground} 0%, ${cssVar('bg1')} 65%)`
                      : modified
                        ? `linear-gradient(180deg, ${palette.softBackground} 0%, ${cssVar('bg2')} 82%)`
                        : cssVar('bg2'),
                    color: active ? activeTextColor : modified ? cssVar('t0') : cssVar('t1'),
                    fontSize: Math.max(12, sizes.ui),
                    fontWeight: active ? 700 : 600,
                    boxShadow: active
                      ? `0 -6px 14px -10px ${palette.shadow}`
                      : modified
                        ? `0 -6px 14px -12px ${palette.shadow}`
                        : 'none',
                    transform: active ? 'translateY(0.5px)' : 'none',
                  }}>
                  {badge && (
                    <span
                      aria-hidden="true"
                      className="min-w-3.5 font-extrabold"
                      style={{ color: palette.accent }}>
                      {badge}
                    </span>
                  )}
                  {!badge && modified && (
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full shrink-0"
                      style={{
                        background: palette.accent,
                        boxShadow: `0 0 0 4px ${palette.softBackground}`,
                      }}
                    />
                  )}
                  <span className="overflow-hidden text-ellipsis">{label}</span>
                  <span className="sr-only">{getSectionTooltipStatus(section)?.label ?? t('workbookSheetTabTooltipTagSheet')}</span>
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </div>
  );
});

export default WorkbookSheetTabs;
