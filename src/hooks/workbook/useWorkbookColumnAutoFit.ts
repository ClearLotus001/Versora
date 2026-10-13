import { useCallback, useEffect, useRef } from 'react';
import type { WorkbookCompareMode, WorkbookSection } from '@/types';
import type { WorkbookArtifactProvider } from '@/utils/workbook/workbookArtifactProvider';
import { measureWorkbookAutoFitColumnWidthsAsync, type WorkbookColumnWidthBySheet } from '@/utils/workbook/workbookColumnWidths';

interface WorkbookColumnAutoFitArgs {
  provider: WorkbookArtifactProvider | undefined;
  sheet: WorkbookSection | undefined;
  compareMode: WorkbookCompareMode;
  fontSize: number;
  active: boolean;
  columnWidthBySheet: WorkbookColumnWidthBySheet;
  onColumnWidthChange: (sheetName: string, column: number, width: number) => void;
  onOperationError: ((message: string) => void) | undefined;
}

/** One cancellable double-click operation for all workbook panel layouts. */
export default function useWorkbookColumnAutoFit({
  provider, sheet, compareMode, fontSize, active, columnWidthBySheet, onColumnWidthChange, onOperationError,
}: WorkbookColumnAutoFitArgs) {
  const columnWidths = sheet ? columnWidthBySheet[sheet.name] : undefined;
  const current = useRef({ provider, sheet, compareMode, fontSize, active, columnWidths });
  current.current = { provider, sheet, compareMode, fontSize, active, columnWidths };
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); }, [provider, sheet, compareMode, fontSize, active, columnWidths]);

  const handleResizeColumn = useCallback((column: number, width: number) => {
    controller.current?.abort();
    provider?.cancelColumnMeasurement();
    if (sheet) onColumnWidthChange(sheet.name, column, width);
  }, [sheet, provider, onColumnWidthChange]);

  const handleAutoFitColumn = useCallback(async (column: number) => {
    if (!sheet || !active) return;
    controller.current?.abort();
    const operation = new AbortController();
    controller.current = operation;
    const context = current.current;
    const isCurrent = () => {
      const latest = current.current;
      return latest.active && latest.provider === context.provider && latest.sheet === context.sheet
        && latest.compareMode === context.compareMode && latest.fontSize === context.fontSize
        && latest.columnWidths === context.columnWidths && !operation.signal.aborted;
    };
    try {
      const [width] = await measureWorkbookAutoFitColumnWidthsAsync(provider, sheet.name, [column], fontSize, { signal: operation.signal, isCurrent });
      if (isCurrent()) onColumnWidthChange(sheet.name, column, width!);
    } catch (error) {
      if (isCurrent() && !(error instanceof Error && error.name === 'AbortError')) onOperationError?.(error instanceof Error ? error.message : String(error));
    } finally {
      if (controller.current === operation) controller.current = null;
    }
  }, [sheet, active, provider, fontSize, onColumnWidthChange, onOperationError]);

  return { handleResizeColumn, handleAutoFitColumn };
}
