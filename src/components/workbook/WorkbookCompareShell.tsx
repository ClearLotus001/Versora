import type { ReactNode } from 'react';
import { useWorkbookViewTransition } from '@/hooks/workbook/useWorkbookViewTransition';

interface WorkbookCompareShellProps {
  presentationKey: string;
  perfPanel?: ReactNode;
  mergeNotice?: ReactNode;
  frozenOverflowBar?: ReactNode;
  mainContent: ReactNode;
  fastScrollLayer?: ReactNode;
  collapseJumpButton: ReactNode;
  miniMap: ReactNode;
  hoverTooltip?: ReactNode;
  sheetTabs: ReactNode;
}

export default function WorkbookCompareShell({
  presentationKey,
  perfPanel,
  mergeNotice,
  frozenOverflowBar,
  mainContent,
  fastScrollLayer,
  collapseJumpButton,
  miniMap,
  hoverTooltip,
  sheetTabs,
}: WorkbookCompareShellProps) {
  const tableSurfaceRef = useWorkbookViewTransition(presentationKey);

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0 min-h-0 bg-workbook-canvas-bg">
      {perfPanel}
      {mergeNotice}
      {frozenOverflowBar}
      <div
        ref={tableSurfaceRef}
        data-testid="workbook-table-surface"
        className="flex-1 flex overflow-hidden min-w-0 min-h-0">
        <div className="relative flex-1 flex flex-col min-w-0 min-h-0">
          {mainContent}
          {fastScrollLayer}
          {collapseJumpButton}
        </div>
        {miniMap}
      </div>
      {hoverTooltip}
      {sheetTabs}
    </div>
  );
}
