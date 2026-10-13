import { parentPort, workerData } from 'node:worker_threads';
import type {
  WorkbookArtifactSearchRequest, WorkbookArtifactSearchMatch, WorkbookArtifactSide,
} from '../../shared/workbookArtifactProtocol.js';
import { WorkbookSearchSource, type WorkbookSearchLine, type WorkbookSearchManifest, type WorkbookSearchPair } from './workbookSearchSource.js';

const { request, manifest, root } = workerData as { request: WorkbookArtifactSearchRequest; manifest: WorkbookSearchManifest; root: string };
const limit = 100_000;
const matches: WorkbookArtifactSearchMatch[] = [];
let totalCount = 0;
if (!parentPort) throw new Error('Workbook search requires a worker thread.');
const expression = request.isRegex ? request.query : request.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function scanLine(pair: WorkbookSearchPair, side: WorkbookArtifactSide, line: WorkbookSearchLine, pattern: RegExp, source: WorkbookSearchSource): void {
  const { content, fields } = line;
  if (!content) return;
  let fieldEnds: Uint32Array | undefined;
  let changed: Uint32Array | undefined;
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    let column = 0;
    // Rare-match queries allocate no offset index for nonmatching rows. Once
    // the display cap is reached, all-row searches only need to count matches.
    if (request.visibleRowIndexes || matches.length < limit) {
      if (!fieldEnds) {
        fieldEnds = new Uint32Array(fields.length);
        let cursor = 0;
        for (let i = 0; i < fields.length; i += 1) { fieldEnds[i] = cursor + fields[i]!.length; cursor += fields[i]!.length + 1; }
      }
      let low = 0; let high = fields.length;
      const start = Math.min(match.index, content.length - 1);
      while (low < high) { const mid = (low + high) >>> 1; if (fieldEnds[mid]! <= start) low = mid + 1; else high = mid; }
      column = Math.min(fields.length - 1, low);
    }
    let visible = true;
    if (request.visibleRowIndexes) {
      changed ??= source.changedIntervals(pair);
      visible = false;
      for (let i = 0; i < changed.length; i += 2) { if (column >= changed[i]! && column < changed[i + 1]!) { visible = true; break; } }
    }
    if (visible) {
      totalCount += 1;
      if (matches.length < limit) {
        const rowNumber = side === 'mine' ? pair.mineRowNumber : pair.baseRowNumber;
        const prefixLength = `@@row\t${rowNumber}\t`.length;
        matches.push({
          rowIndex: pair.rowIndex, sheetId: pair.sheetId, side, rowNumber, column,
          start: prefixLength + match.index, end: prefixLength + match.index + match[0].length,
          // V8 substring views can otherwise retain the entire source row for
          // each tiny snippet. UTF-16 also preserves isolated surrogate units.
          snippet: Buffer.from(content.slice(Math.max(0, match.index - 80), Math.min(content.length, match.index + Math.max(1, match[0].length) + 160, match.index + 240)), 'utf16le').toString('utf16le'),
        });
      }
    }
    if (!match[0].length) pattern.lastIndex += 1;
  }
}

let source: WorkbookSearchSource | undefined;
try {
  let pattern: RegExp | undefined;
  if (request.query.trim()) { try { pattern = new RegExp(expression, request.isCaseSensitive ? 'g' : 'gi'); } catch { /* Invalid regex preserves the empty-result contract. */ } }
  if (pattern) {
    source = new WorkbookSearchSource(manifest, root, request);
    for (const pair of source.alignedRows()) {
      if (pair.searchBothSides && pair.baseRowNumber > 0) {
        const line = source.readLine(pair, 'base'); if (line) scanLine(pair, 'base', line, pattern, source);
      }
      const side = pair.mineRowNumber > 0 ? 'mine' : !pair.searchBothSides ? 'base' : null;
      if (side) { const line = source.readLine(pair, side); if (line) scanLine(pair, side, line, pattern, source); }
    }
  }
  parentPort.postMessage({ type: 'result', matches, totalCount, truncated: totalCount > matches.length });
} catch (error) {
  parentPort.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
} finally { source?.close(); parentPort.close(); }
