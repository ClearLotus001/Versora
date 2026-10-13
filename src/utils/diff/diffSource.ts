const WORKBOOK_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xltx', '.xltm', '.xlsb', '.xls']);

export function isWorkbookFileName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return WORKBOOK_EXTENSIONS.has(normalized.slice(normalized.lastIndexOf('.')));
}

export interface DiffTextSourceInput {
  baseName: string;
  mineName: string;
  fileName: string;
  baseContent: string | null;
  mineContent: string | null;
}

/** Only text sources enter this decoder. Workbooks must use the Rust artifact pipeline. */
export function resolveDiffTexts(data: DiffTextSourceInput): { baseText: string; mineText: string } {
  if ([data.fileName, data.baseName, data.mineName].some(isWorkbookFileName)) {
    throw new Error('Workbook comparison requires a prepared artifact.');
  }
  return { baseText: data.baseContent ?? '', mineText: data.mineContent ?? '' };
}
