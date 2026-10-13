import { memo, useRef } from 'react';
import { useI18n } from '@/context/i18n';
import useElementWidth from '@/hooks/ui/useElementWidth';
import { cssAlpha, cssVar } from '@/theme/cssUtils';
import type { DiffPerformanceMetrics } from '@/types';
import { copyText } from '@/utils/app/clipboard';
import {
  clearWorkbookDebugLogs,
  getWorkbookDebugLogSnapshot,
} from '@/utils/workbook/workbookDebug';

interface PerfBarProps {
  metrics: DiffPerformanceMetrics | null;
}

const SCROLL_RAIL_CLASS = 'overflow-x-auto overflow-y-hidden [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden';

const PerfBar = memo(({ metrics }: PerfBarProps) => {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const containerWidth = useElementWidth(rootRef, 1440);

  if (!metrics) return null;

  const layoutMode = containerWidth < 1120 ? 'stacked' : 'inline';
  const pinActionsRight = layoutMode === 'inline' && containerWidth >= 1480;
  const copyLabel = t('perfCopyLog');
  const clearLabel = t('perfClearLog');

  const chip = (label: string, value: string, accent = cssVar('acc2')) => (
    <div className="inline-flex items-center gap-1.5 py-1 px-2 rounded-full bg-bg-surface-hover border border-border-default text-text-primary min-w-0 shrink-0 whitespace-nowrap">
      <span className="size-1.5 rounded-full shrink-0" style={{ background: accent }} />
      <span className="font-ui text-[11px] text-text-secondary font-bold uppercase tracking-wider">{label}</span>
      <span className="font-code text-[13px] text-text-title font-bold">{value}</span>
    </div>
  );

  const formatMs = (value?: number) => (typeof value === 'number' ? `${value.toFixed(value >= 100 ? 0 : 1)}ms` : '—');
  const formatBytes = (value?: number) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`;
    return `${value}B`;
  };
  const sourceLabel = {
    cli: t('perfSource_cli'),
    'revision-switch': t('perfSource_revision-switch'),
    'local-dev': t('perfSource_local-dev'),
  }[metrics.source] ?? metrics.source;

  const actionButtons = (
    <>
      <button
        type="button"
        onClick={() => { void copyText(getWorkbookDebugLogSnapshot()); }}
        className="rounded-full py-1 px-2.5 font-ui text-[11px] font-bold cursor-pointer shrink-0 whitespace-nowrap transition-all duration-150 hover:-translate-y-px"
        style={{
          border: `1px solid ${cssAlpha('acc2', '66')}`,
          background: cssAlpha('acc2', '10'),
          color: cssVar('acc2'),
        }}>
        {copyLabel}
      </button>
      <button
        type="button"
        onClick={() => clearWorkbookDebugLogs()}
        className="rounded-full py-1 px-2.5 bg-bg-surface-hover border border-border-default text-text-primary font-ui text-[11px] font-bold cursor-pointer shrink-0 whitespace-nowrap transition-all duration-150 hover:-translate-y-px">
        {clearLabel}
      </button>
    </>
  );

  const rail = (
    <div className={`flex-1 min-w-0 ${SCROLL_RAIL_CLASS}`}>
      <div className="inline-flex items-center gap-2 min-w-max pr-1">
        {chip(t('perfMainLoad'), formatMs(metrics.mainLoadMs), cssVar('acc'))}
        {chip(t('perfBaseRead'), formatMs(metrics.baseReadMs), cssVar('versionBase'))}
        {chip(t('perfMineRead'), formatMs(metrics.mineReadMs), cssVar('versionMine'))}
        {chip(t('perfTextResolve'), formatMs(metrics.textResolveMs), cssVar('acc2'))}
        {chip(t('perfMetadata'), formatMs(metrics.metadataMs), cssVar('acc'))}
        {chip(t('perfDiff'), formatMs(metrics.diffMs), cssVar('acc2'))}
        {chip(t('perfRendererApply'), formatMs(metrics.rendererApplyMs), cssVar('acc'))}
        {chip(t('perfRequestCommit'), formatMs(metrics.requestToCommitMs), cssVar('acc'))}
        {chip(t('perfBaseBytes'), formatBytes(metrics.baseBytes), cssVar('versionBase'))}
        {chip(t('perfMineBytes'), formatBytes(metrics.mineBytes), cssVar('versionMine'))}
        {chip(t('perfDiffLines'), typeof metrics.diffLineCount === 'number' ? String(metrics.diffLineCount) : '—', cssVar('acc2'))}
        {!pinActionsRight && actionButtons}
      </div>
    </div>
  );

  return (
    <div
      ref={rootRef}
      className="w-full min-w-0 border-b border-border-default shrink-0 bg-bg-surface-solid overflow-hidden">
      {layoutMode === 'stacked' ? (
        <div className="grid gap-2 py-2 px-3">
          <div className="flex items-start justify-between gap-3 min-w-0">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="font-ui text-[13px] text-text-title font-bold">{t('perfTitle')}</span>
              <span className="font-ui text-[11px] text-text-secondary whitespace-nowrap overflow-hidden text-ellipsis">
                {sourceLabel}
              </span>
            </div>
            <div className="inline-flex items-center gap-2 shrink-0">
              {actionButtons}
            </div>
          </div>
          {rail}
        </div>
      ) : (
        <div className="flex items-center gap-3 py-2 px-3 min-w-0">
          <div className="flex flex-col gap-0.5 shrink-0 min-w-[132px]">
            <span className="font-ui text-[13px] text-text-title font-bold">{t('perfTitle')}</span>
            <span className="font-ui text-[11px] text-text-secondary whitespace-nowrap overflow-hidden text-ellipsis max-w-[180px]">
              {sourceLabel}
            </span>
          </div>
          {rail}
          {pinActionsRight && (
            <div className="inline-flex items-center gap-2 shrink-0">
              {actionButtons}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default PerfBar;
