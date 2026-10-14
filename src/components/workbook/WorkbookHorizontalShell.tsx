import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from 'react';
import { useI18n } from '@/context/i18n';
import { useWorkbookViewTransition } from '@/hooks/workbook/useWorkbookViewTransition';

interface WorkbookHorizontalShellProps {
  presentationKey: string;
  paneContainerRef: RefObject<HTMLDivElement | null>;
  paneGridTemplateColumns: string;
  splitRatio: number;
  isResizingSplitter: boolean;
  minSplitRatioPercent: number;
  maxSplitRatioPercent: number;
  onSplitterPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSplitterKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onResetSplitRatio: () => void;
  perfPanel?: ReactNode;
  frozenOverflowBar?: ReactNode;
  leftPane: ReactNode;
  rightPane: ReactNode;
  fastScrollLayer?: ReactNode;
  collapseJumpButton: ReactNode;
  miniMap: ReactNode;
  hoverTooltip?: ReactNode;
  sheetTabs: ReactNode;
}

export default function WorkbookHorizontalShell({
  presentationKey,
  paneContainerRef,
  paneGridTemplateColumns,
  splitRatio,
  isResizingSplitter,
  minSplitRatioPercent,
  maxSplitRatioPercent,
  onSplitterPointerDown,
  onSplitterKeyDown,
  onResetSplitRatio,
  perfPanel,
  frozenOverflowBar,
  leftPane,
  rightPane,
  fastScrollLayer,
  collapseJumpButton,
  miniMap,
  hoverTooltip,
  sheetTabs,
}: WorkbookHorizontalShellProps) {
  const { t } = useI18n();
  const tableSurfaceRef = useWorkbookViewTransition(presentationKey);

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0 min-h-0">
      {perfPanel}
      {frozenOverflowBar}
      <div
        ref={tableSurfaceRef}
        data-testid="workbook-table-surface"
        className="flex-1 flex overflow-hidden min-w-0 min-h-0">
        <div className="relative flex-1 flex flex-col min-w-0 min-h-0">
          <div
            ref={paneContainerRef}
            className="flex-1 min-w-0 min-h-0"
            style={{
              position: 'relative',
              display: 'grid',
              gridTemplateColumns: paneGridTemplateColumns,
              alignItems: 'stretch',
            }}>
            {leftPane}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('toolbarSplitPaneResizeWorkbook')}
              aria-valuemin={minSplitRatioPercent}
              aria-valuemax={maxSplitRatioPercent}
              aria-valuenow={Math.round(splitRatio * 100)}
              tabIndex={0}
              onPointerDown={onSplitterPointerDown}
              onKeyDown={onSplitterKeyDown}
              onDoubleClick={onResetSplitRatio}
              style={{
                position: 'relative',
                cursor: 'col-resize',
                touchAction: 'none',
                background: isResizingSplitter ? 'color-mix(in srgb, var(--acc) 12%, transparent)' : 'transparent',
                outline: 'none',
              }}>
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: 0,
                  bottom: 0,
                  width: 1,
                  transform: 'translateX(-50%)',
                  background: isResizingSplitter ? 'var(--acc)' : 'var(--border)',
                  boxShadow: `0 0 0 1px ${isResizingSplitter ? 'var(--acc)' : 'var(--border)'}`,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  width: 4,
                  height: 56,
                  transform: 'translate(-50%, -50%)',
                  borderRadius: 999,
                  background: isResizingSplitter ? 'color-mix(in srgb, var(--acc) 44%, transparent)' : 'color-mix(in srgb, var(--border) 66%, transparent)',
                }}
              />
            </div>
            {rightPane}
            {fastScrollLayer}
          </div>
          {collapseJumpButton}
        </div>
        {miniMap}
      </div>
      {hoverTooltip}
      {sheetTabs}
    </div>
  );
}
