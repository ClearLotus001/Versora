import type { ComponentProps } from 'react';
import WorkbookComparePanel from '@/components/workbook/WorkbookComparePanel';
import WorkbookHorizontalPanel from '@/components/workbook/WorkbookHorizontalPanel';

type WorkbookPanelProps =
  | { kind: 'compare'; panelProps: ComponentProps<typeof WorkbookComparePanel> }
  | { kind: 'horizontal'; panelProps: ComponentProps<typeof WorkbookHorizontalPanel> };

export default function WorkbookPanel(props: WorkbookPanelProps) {
  return props.kind === 'compare'
    ? <WorkbookComparePanel {...props.panelProps} />
    : <WorkbookHorizontalPanel {...props.panelProps} />;
}
