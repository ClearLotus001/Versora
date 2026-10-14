import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Layers3, Minus, Pencil, Plus } from 'lucide-react';

import type { DiffTypeFilter } from '@/types';
import type { ConcreteDiffType, DiffTypeAvailability } from '@/utils/diff/diffTypeFilter';
import { useI18n } from '@/context/i18n';
import Tooltip from '@/components/shared/Tooltip';

interface DiffTypeFilterControlProps {
  value: DiffTypeFilter;
  availability: DiffTypeAvailability;
  onChange: (value: DiffTypeFilter) => void;
  availableWidth: number;
  density: 'tight' | 'regular';
  noDragStyle?: CSSProperties | undefined;
}

const FILTER_OPTIONS: Array<{
  value: DiffTypeFilter;
  labelKey: 'diffFilterAll' | 'diffFilterAdded' | 'diffFilterModified' | 'diffFilterDeleted';
  titleKey: 'diffFilterAllTitle' | 'diffFilterAddedTitle' | 'diffFilterModifiedTitle' | 'diffFilterDeletedTitle';
  unavailableTitleKey?: 'diffFilterAddedUnavailableTitle' | 'diffFilterModifiedUnavailableTitle' | 'diffFilterDeletedUnavailableTitle';
  icon: typeof Layers3;
  color: string;
  background: string;
}> = [
  { value: 'all', labelKey: 'diffFilterAll', titleKey: 'diffFilterAllTitle', icon: Layers3, color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, var(--bg-surface-solid) 88%)' },
  { value: 'add', labelKey: 'diffFilterAdded', titleKey: 'diffFilterAddedTitle', unavailableTitleKey: 'diffFilterAddedUnavailableTitle', icon: Plus, color: 'var(--diff-add-text)', background: 'color-mix(in srgb, var(--diff-add-bg) 74%, var(--bg-surface-solid) 26%)' },
  { value: 'modify', labelKey: 'diffFilterModified', titleKey: 'diffFilterModifiedTitle', unavailableTitleKey: 'diffFilterModifiedUnavailableTitle', icon: Pencil, color: 'var(--diff-modify-text)', background: 'color-mix(in srgb, var(--diff-modify-bg) 76%, var(--bg-surface-solid) 24%)' },
  { value: 'delete', labelKey: 'diffFilterDeleted', titleKey: 'diffFilterDeletedTitle', unavailableTitleKey: 'diffFilterDeletedUnavailableTitle', icon: Minus, color: 'var(--diff-remove-text)', background: 'color-mix(in srgb, var(--diff-remove-bg) 74%, var(--bg-surface-solid) 26%)' },
];

const BUTTON_CLASS = 'app-toolbar__button h-8 rounded-lg border inline-flex items-center justify-center gap-1.5 font-ui text-[13px] font-semibold whitespace-nowrap leading-none';
const MENU_WIDTH = 192;
const VIEWPORT_PADDING = 8;

function optionStyle(option: typeof FILTER_OPTIONS[number], active: boolean, disabled: boolean): CSSProperties {
  return {
    color: disabled ? 'var(--text-secondary)' : active ? option.color : 'var(--text-title)',
    background: active && !disabled ? option.background : 'transparent',
    borderColor: active && !disabled ? `color-mix(in srgb, ${option.color} 38%, var(--border-color) 62%)` : 'transparent',
    boxShadow: active && !disabled ? `inset 0 -2px 0 color-mix(in srgb, ${option.color} 72%, transparent)` : 'none',
  };
}

const DiffTypeFilterControl = memo(({ value, availability, onChange, availableWidth, density, noDragStyle }: DiffTypeFilterControlProps) => {
  const { t } = useI18n();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Partial<Record<DiffTypeFilter, HTMLButtonElement | null>>>({});
  const focusOnOpenRef = useRef<DiffTypeFilter>('all');
  const focusWithinRef = useRef(false);
  const returnFocusRef = useRef(false);
  const [segmentedWidth, setSegmentedWidth] = useState(Infinity);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const dropdown = availableWidth < segmentedWidth;
  const previousDropdownRef = useRef(dropdown);
  const previousOpenRef = useRef(open);
  const segmentClass = `${BUTTON_CLASS} ${density === 'tight' ? 'px-1.5 min-w-7' : 'px-2.5'}`;
  const groupClass = `app-toolbar__group rounded-xl bg-bg-surface-hover border border-border-default inline-flex items-center shrink-0 gap-0.5 ${density === 'tight' ? 'p-0' : 'p-0.5'}`;
  const currentOption = FILTER_OPTIONS.find((option) => option.value === value) ?? FILTER_OPTIONS[0]!;
  const enabledOptions = FILTER_OPTIONS.filter((option) => option.value === 'all' || availability[option.value as ConcreteDiffType]);
  const tabStop = enabledOptions.some((option) => option.value === value) ? value : 'all';

  useLayoutEffect(() => {
    const probe = probeRef.current;
    if (!probe) return;
    const measure = () => setSegmentedWidth(Math.ceil(probe.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(probe);
    return () => observer.disconnect();
  }, [t, density]);

  useLayoutEffect(() => {
    const modeChanged = previousDropdownRef.current !== dropdown;
    const wasOpen = previousOpenRef.current;
    previousDropdownRef.current = dropdown;
    previousOpenRef.current = open;
    if (!dropdown && open) setOpen(false);
    if ((modeChanged && focusWithinRef.current) || (returnFocusRef.current && (!open || !dropdown))) {
      returnFocusRef.current = false;
      if (dropdown) triggerRef.current?.focus();
      else optionRefs.current[tabStop]?.focus();
    } else if (open && dropdown && !wasOpen) {
      optionRefs.current[focusOnOpenRef.current]?.focus();
    }
  }, [dropdown, open, tabStop]);

  useEffect(() => {
    if (!open || !dropdown) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const height = menuRef.current?.offsetHeight ?? 158;
      setMenuPosition({
        left: Math.max(VIEWPORT_PADDING, Math.min(rect.left, window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING)),
        top: Math.max(VIEWPORT_PADDING, Math.min(rect.bottom + 6, window.innerHeight - height - VIEWPORT_PADDING)),
      });
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (rootRef.current?.contains(target) || menuRef.current?.contains(target))) return;
      focusWithinRef.current = false;
      setOpen(false);
    };
    updatePosition();
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const observer = new ResizeObserver(updatePosition);
    if (rootRef.current) observer.observe(rootRef.current);
    return () => {
      observer.disconnect();
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, dropdown]);

  const openMenu = (target: DiffTypeFilter = tabStop) => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setMenuPosition({ left: Math.max(VIEWPORT_PADDING, Math.min(rect.left, window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING)), top: rect.bottom + 6 });
    focusOnOpenRef.current = target;
    setOpen(true);
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const target = event.relatedTarget as Node | null;
    if (target && !rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
      focusWithinRef.current = false;
      setOpen(false);
    }
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, optionValue: DiffTypeFilter) => {
    if (event.key === 'Tab' && dropdown) {
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    const currentIndex = enabledOptions.findIndex((option) => option.value === optionValue);
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowDown': case 'ArrowRight': nextIndex = (currentIndex + 1) % enabledOptions.length; break;
      case 'ArrowUp': case 'ArrowLeft': nextIndex = (currentIndex + enabledOptions.length - 1) % enabledOptions.length; break;
      case 'Home': nextIndex = 0; break;
      case 'End': nextIndex = enabledOptions.length - 1; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    const nextValue = enabledOptions[nextIndex]!.value;
    optionRefs.current[nextValue]?.focus();
    if (!dropdown) onChange(nextValue);
  };

  const renderOption = (option: typeof FILTER_OPTIONS[number]) => {
    const active = value === option.value;
    const disabled = option.value !== 'all' && !availability[option.value as ConcreteDiffType];
    const Icon = option.icon;
    const tooltipKey = disabled && option.unavailableTitleKey ? option.unavailableTitleKey : option.titleKey;
    return (
      <Tooltip key={option.value} content={t(tooltipKey)} placement={dropdown ? 'left' : 'top'} sideBoundaryRef={dropdown ? menuRef : undefined} anchorStyle={{ ...noDragStyle, ...(dropdown ? { width: '100%' } : {}) }}>
        <button
          ref={(element) => { optionRefs.current[option.value] = element; }}
          type="button"
          role={dropdown ? 'menuitemradio' : 'radio'}
          aria-checked={active}
          aria-disabled={disabled}
          disabled={disabled}
          tabIndex={dropdown ? -1 : option.value === tabStop ? 0 : -1}
          data-testid={`diff-filter-${option.value}`}
          onKeyDown={(event) => handleOptionKeyDown(event, option.value)}
          onClick={() => {
            if (dropdown) returnFocusRef.current = true;
            onChange(option.value);
            if (dropdown) setOpen(false);
          }}
          className={`${dropdown ? `${BUTTON_CLASS} w-full justify-start px-3` : segmentClass} ${active ? 'text-accent' : ''} cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
          style={{ ...optionStyle(option, active, disabled), ...noDragStyle }}>
          <Icon size={14} />
          <span>{t(option.labelKey)}</span>
        </button>
      </Tooltip>
    );
  };

  return (
    <div
      ref={rootRef}
      data-testid="diff-type-filter"
      onFocusCapture={() => { focusWithinRef.current = true; }}
      onBlurCapture={handleBlur}
      onKeyDownCapture={(event) => {
        if (!open || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        returnFocusRef.current = true;
        setOpen(false);
      }}
      className="relative shrink-0"
      style={noDragStyle}>
      <div ref={probeRef} aria-hidden="true" className={`${groupClass} absolute invisible pointer-events-none w-max`}>
        {FILTER_OPTIONS.map((option) => {
          const Icon = option.icon;
          return <span key={option.value} className={segmentClass}><Icon size={14} /><span>{t(option.labelKey)}</span></span>;
        })}
      </div>
      {dropdown ? (
        <Tooltip content={t('diffFilterLabel')} disabled={open} anchorStyle={noDragStyle}>
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            aria-label={`${t('diffFilterLabel')}: ${t(currentOption.labelKey)}`}
            data-testid="diff-type-filter-trigger"
            onClick={() => open ? setOpen(false) : openMenu()}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
              event.preventDefault();
              event.stopPropagation();
              openMenu(event.key === 'ArrowUp' ? enabledOptions[enabledOptions.length - 1]!.value : tabStop);
            }}
            className="text-accent h-8 rounded-[10px] border inline-flex items-center justify-center gap-2 font-ui text-[13px] font-semibold whitespace-nowrap leading-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            style={{ ...optionStyle(currentOption, true, false), padding: density === 'tight' ? '0 8px' : '0 10px 0 12px', ...noDragStyle }}>
            <span>{t('diffFilterType')}: {t(currentOption.labelKey)}</span>
            <ChevronDown size={10} />
          </button>
        </Tooltip>
      ) : (
        <div role="radiogroup" aria-label={t('diffFilterLabel')} className={groupClass}>
          {FILTER_OPTIONS.map(renderOption)}
        </div>
      )}
      {open && dropdown && createPortal(
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          aria-label={t('diffFilterLabel')}
          data-testid="diff-type-filter-menu"
          onFocusCapture={() => { focusWithinRef.current = true; }}
          onBlurCapture={handleBlur}
          className="fixed z-[220] p-1.5 border border-border-default bg-bg-surface-solid flex flex-col gap-1"
          style={{ ...menuPosition, width: MENU_WIDTH, borderRadius: 12, boxShadow: '0 14px 30px var(--liquid-glass-shadow)', ...noDragStyle }}>
          {FILTER_OPTIONS.map(renderOption)}
        </div>,
        document.body,
      )}
    </div>
  );
});

export default DiffTypeFilterControl;
