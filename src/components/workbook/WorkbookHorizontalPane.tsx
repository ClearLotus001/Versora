import type { ReactNode, RefObject } from 'react';

interface WorkbookHorizontalPaneProps {
  paneRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  sheetRenderKey: string;
  contentWidth: number;
  contentHeight: number;
  stickyHeaderHeight: number;
  stickyRegion: ReactNode;
  bodyContent: ReactNode;
  overlayContent: ReactNode;
}

export default function WorkbookHorizontalPane({
  paneRef,
  onScroll,
  sheetRenderKey,
  contentWidth,
  contentHeight,
  stickyHeaderHeight,
  stickyRegion,
  bodyContent,
  overlayContent,
}: WorkbookHorizontalPaneProps) {
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      <div
        ref={paneRef}
        onScroll={onScroll}
        className="flex-1 overflow-auto relative min-w-0 min-h-0 bg-workbook-canvas-bg"
        style={{
          overflowAnchor: 'none',
          overflowX: 'scroll',
          scrollbarGutter: 'stable',
        }}>
        <div key={sheetRenderKey} style={{ position: 'relative', minWidth: contentWidth, height: contentHeight }}>
          <div
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 30,
              isolation: 'isolate',
              minWidth: contentWidth,
            }}>
            {stickyRegion}
          </div>
          <div
            style={{
              position: 'absolute',
              top: stickyHeaderHeight,
              left: 0,
              minWidth: '100%',
            }}>
            {bodyContent}
          </div>
          {overlayContent}
        </div>
      </div>
    </div>
  );
}
