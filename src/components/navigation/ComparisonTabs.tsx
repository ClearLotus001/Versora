import { memo, useEffect, useRef, type KeyboardEvent } from 'react';
import { FileDiff, Plus, X } from 'lucide-react';

import { useI18n } from '@/context/i18n';
import Tooltip from '@/components/shared/Tooltip';

interface ComparisonTabsProps {
  tabs: Array<{ id: string; title: string; description?: string }>;
  activeId: string | null;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

const ComparisonTabs = memo(({
  tabs,
  activeId,
  disabled = false,
  onSelect,
  onClose,
  onNew,
}: ComparisonTabsProps) => {
  const { t } = useI18n();
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const selectedId = tabs.some((tab) => tab.id === activeId) ? activeId : null;
  const focusableId = selectedId ?? tabs[0]?.id;

  useEffect(() => {
    if (selectedId) {
      tabButtons.current.get(selectedId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [selectedId]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (disabled) return;
    const currentIndex = tabs.findIndex((tab) => tab.id === id);
    if (currentIndex < 0) return;
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowLeft': nextIndex = (currentIndex - 1 + tabs.length) % tabs.length; break;
      case 'ArrowRight': nextIndex = (currentIndex + 1) % tabs.length; break;
      case 'Home': nextIndex = 0; break;
      case 'End': nextIndex = tabs.length - 1; break;
      case 'Delete': {
        event.preventDefault();
        const neighbor = tabs[currentIndex + 1] ?? tabs[currentIndex - 1];
        if (neighbor) tabButtons.current.get(neighbor.id)?.focus();
        onClose(id);
        return;
      }
      default: return;
    }
    event.preventDefault();
    const nextId = tabs[nextIndex]?.id;
    if (!nextId) return;
    onSelect(nextId);
    tabButtons.current.get(nextId)?.focus();
  };

  return (
    <div className="comparison-tabs relative z-[45] shrink-0 flex min-w-0 items-center gap-1 border-b border-border-default bg-bg-surface px-2 py-1.5">
      <div
        role="tablist"
        aria-label={t('comparisonTabsLabel')}
        aria-orientation="horizontal"
        aria-busy={disabled}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = selectedId === tab.id;
          return (
            <div
              key={tab.id}
              role="presentation"
              className="group flex shrink-0 items-center rounded-lg border transition-colors"
              style={{
                background: active
                  ? 'color-mix(in srgb, var(--accent) 12%, var(--bg-surface-solid) 88%)'
                  : 'transparent',
                borderColor: active
                  ? 'color-mix(in srgb, var(--accent) 40%, var(--border-color) 60%)'
                  : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-primary)',
              }}
            >
              <Tooltip content={tab.description ?? tab.title} placement="bottom" disabled={disabled}>
                <button
                  ref={(element) => {
                    if (element) tabButtons.current.set(tab.id, element);
                    else tabButtons.current.delete(tab.id);
                  }}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  disabled={disabled}
                  tabIndex={tab.id === focusableId && !disabled ? 0 : -1}
                  data-testid="comparison-tab"
                  data-session-id={tab.id}
                  onClick={() => onSelect(tab.id)}
                  onKeyDown={(event) => handleKeyDown(event, tab.id)}
                  className="inline-flex h-8 max-w-[260px] min-w-0 items-center gap-1.5 rounded-lg px-2.5 font-ui text-[12px] font-semibold cursor-pointer hover:bg-bg-surface-hover disabled:cursor-wait disabled:opacity-50 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                >
                  <FileDiff size={13} className="shrink-0" aria-hidden="true" />
                  <span className="truncate">{tab.title}</span>
                </button>
              </Tooltip>
              <Tooltip content={t('comparisonTabClose')} placement="bottom" disabled={disabled}>
                <button
                  type="button"
                  aria-label={`${t('comparisonTabClose')}: ${tab.title}`}
                  disabled={disabled}
                  tabIndex={active && !disabled ? 0 : -1}
                  data-testid="comparison-tab-close"
                  data-session-id={tab.id}
                  onClick={() => onClose(tab.id)}
                  className="mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-text-secondary cursor-pointer hover:bg-bg-surface-hover hover:text-text-primary disabled:cursor-wait disabled:opacity-50 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </Tooltip>
            </div>
          );
        })}
      </div>
      <Tooltip content={t('comparisonTabNew')} placement="bottom" disabled={disabled}>
        <button
          type="button"
          aria-label={t('comparisonTabNew')}
          data-testid="comparison-tab-new"
          disabled={disabled}
          onClick={onNew}
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border-default px-2.5 font-ui text-[12px] font-semibold text-text-primary cursor-pointer hover:bg-bg-surface-hover disabled:cursor-wait disabled:opacity-50 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <Plus size={14} aria-hidden="true" />
          <span>{t('comparisonTabNew')}</span>
        </button>
      </Tooltip>
    </div>
  );
});

export default ComparisonTabs;
