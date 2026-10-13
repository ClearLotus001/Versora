import { compactTextDiffLines } from './compactTextDiffLines.js';
import { compactTextSplitRowDescriptors } from '../../shared/textSplitRowTransport.js';
import type { CompactTextDiffLines, DiffData, DiffLine } from './types.js';

const MAX_SYNTAX_HIGHLIGHT_TOTAL_CHARS = 300_000;
const MAX_SYNTAX_HIGHLIGHT_LINES = 8_000;
const MAX_SYNTAX_HIGHLIGHT_LINE_LENGTH = 2_000;
const MIN_COMPACT_TEXT_DIFF_LINES = 2_048;

function getLineStats(text: string): { lineCount: number; longestLineLength: number } {
  if (!text) {
    return {
      lineCount: 0,
      longestLineLength: 0,
    };
  }

  let lineCount = 1;
  let currentLineLength = 0;
  let longestLineLength = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10) {
      lineCount += 1;
      longestLineLength = Math.max(longestLineLength, currentLineLength);
      currentLineLength = 0;
      continue;
    }
    currentLineLength += 1;
  }

  longestLineLength = Math.max(longestLineLength, currentLineLength);
  return { lineCount, longestLineLength };
}

function shouldStripRawTextTransport(data: DiffData): boolean {
  if (typeof data.baseContent !== 'string' || typeof data.mineContent !== 'string') {
    return false;
  }
  if (!data.analysisSnapshotsByMode?.strict?.textAnalysis && !data.analysisSnapshotsByMode?.content?.textAnalysis) {
    return false;
  }

  const totalChars = data.baseContent.length + data.mineContent.length;
  if (totalChars > MAX_SYNTAX_HIGHLIGHT_TOTAL_CHARS) {
    return true;
  }

  const baseStats = getLineStats(data.baseContent);
  const mineStats = getLineStats(data.mineContent);
  if ((baseStats.lineCount + mineStats.lineCount) > MAX_SYNTAX_HIGHLIGHT_LINES) {
    return true;
  }

  return Math.max(baseStats.longestLineLength, mineStats.longestLineLength) > MAX_SYNTAX_HIGHLIGHT_LINE_LENGTH;
}

export function projectTransportDiffData(data: DiffData): DiffData {
  const shouldStripRawText = shouldStripRawTextTransport(data);
  if (!shouldStripRawText) return data;

  const compactCache = new WeakMap<DiffLine[], CompactTextDiffLines | null>();
  const analysisSnapshotsByMode = data.analysisSnapshotsByMode
    ? Object.fromEntries(Object.entries(data.analysisSnapshotsByMode).map(([mode, snapshot]) => {
        if (!snapshot?.textAnalysis) return [mode, snapshot];
        const diffLines = snapshot.textAnalysis.diffLines;
        let compactDiffLines: CompactTextDiffLines | null = null;
        if (diffLines.length >= MIN_COMPACT_TEXT_DIFF_LINES) {
          const cached = compactCache.get(diffLines);
          compactDiffLines = cached === undefined
            ? compactTextDiffLines(diffLines)
            : cached;
          if (cached === undefined) compactCache.set(diffLines, compactDiffLines);
        }
        const compactSplitRowDescriptors = compactTextSplitRowDescriptors(
          snapshot.textAnalysis.splitRowDescriptors,
          diffLines.length,
        );
        return [mode, {
          ...snapshot,
          textAnalysis: {
            ...snapshot.textAnalysis,
            diffLines: compactDiffLines ? [] : diffLines,
            ...(compactDiffLines ? { compactDiffLines } : {}),
            splitRowDescriptors: [],
            ...(compactSplitRowDescriptors ? { compactSplitRowDescriptors } : {}),
          },
        }];
      })) as DiffData['analysisSnapshotsByMode']
    : data.analysisSnapshotsByMode;

  return {
    ...data,
    baseContent: null,
    mineContent: null,
    analysisSnapshotsByMode,
  };
}
