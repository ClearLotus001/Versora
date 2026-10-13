const REPLACEMENT_SCORE_THRESHOLD = 0.5;
const SHORT_TEXT_REPLACEMENT_SCORE = 0.56;
const SHORT_TEXT_MAX_LENGTH = 3;
const SHORT_EDIT_DISTANCE_LIMIT = 24;
const STRUCTURED_LINE_PREFIX = '@@';
const CODE_NOISE_TOKENS = new Set([
  'const',
  'let',
  'var',
  'if',
  'elif',
  'else',
  'for',
  'while',
  'class',
  'def',
  'return',
  'raise',
  'with',
  'try',
  'except',
  'finally',
  'true',
  'false',
  'null',
  'undefined',
  'none',
  'pass',
]);

type TextLineKind =
  | 'blank'
  | 'markdown-structure'
  | 'placeholder'
  | 'code-like'
  | 'prose';

interface TextFeatures {
  raw: string;
  normalized: string;
  structured: boolean;
  kind: TextLineKind;
  proseTokens: Map<string, number>;
  proseTokenCount: number;
  codeTokens: Map<string, number>;
  codeTokenCount: number;
  bigrams: Map<string, number>;
  bigramCount: number;
}

export interface TextChangeAlignmentPair {
  deleteIndex: number | null;
  addIndex: number | null;
  isReplacement: boolean;
  score: number;
}

function isStructuredTextLine(text: string): boolean {
  return text.startsWith(STRUCTURED_LINE_PREFIX);
}

function classifyTextLine(text: string): TextLineKind {
  const trimmed = text.trim();
  if (!trimmed) return 'blank';
  if (
    trimmed.startsWith('```')
    || trimmed.startsWith('~~~')
    || trimmed.startsWith('#')
    || trimmed.startsWith('>')
    || trimmed.startsWith('|')
    || /^\d+\.\s/.test(trimmed)
    || /^[-*+]\s/.test(trimmed)
  ) {
    return 'markdown-structure';
  }
  if (trimmed === '...' || trimmed === 'pass') return 'placeholder';
  if (
    /^[\s]*@/.test(text)
    || /^[\s]*(if|elif|else|for|while|class|def|return|raise|with|try|except|finally|const|let|var|import|export|from)\b/.test(trimmed)
    || /^[\s]*#/.test(text)
    || /[A-Za-z_]+\([^)]+\)/.test(trimmed)
  ) {
    return 'code-like';
  }
  return 'prose';
}

function buildProseTokenCounts(text: string): Map<string, number> {
  const sanitized = text.replace(/`+/g, ' ');
  const matches = sanitized.match(/[\p{Script=Han}]|[A-Za-z0-9_]+/gu) ?? [];
  const counts = new Map<string, number>();
  matches.forEach((token) => {
    const normalized = token.toLowerCase();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  });
  return counts;
}

function buildCodeTokenCounts(text: string): Map<string, number> {
  const matches = text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) ?? [];
  const counts = new Map<string, number>();
  matches.forEach((token) => {
    const normalized = token.toLowerCase();
    if (CODE_NOISE_TOKENS.has(normalized)) return;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  });
  return counts;
}

function buildBigramCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function buildTextFeatures(text: string): TextFeatures {
  const normalized = text.toLowerCase();
  const proseTokens = buildProseTokenCounts(text);
  const codeTokens = buildCodeTokenCounts(text);
  return {
    raw: text,
    normalized,
    structured: isStructuredTextLine(text),
    kind: classifyTextLine(text),
    proseTokens,
    proseTokenCount: [...proseTokens.values()].reduce((sum, count) => sum + count, 0),
    codeTokens,
    codeTokenCount: [...codeTokens.values()].reduce((sum, count) => sum + count, 0),
    bigrams: buildBigramCounts(normalized),
    bigramCount: Math.max(0, normalized.length - 1),
  };
}

function computeBigramDice(left: TextFeatures, right: TextFeatures): number {
  if (left.bigramCount === 0 || right.bigramCount === 0) return 0;

  const [small, large] = left.bigrams.size <= right.bigrams.size
    ? [left.bigrams, right.bigrams]
    : [right.bigrams, left.bigrams];

  let overlap = 0;
  for (const [gram, count] of small) {
    overlap += Math.min(count, large.get(gram) ?? 0);
  }

  return (2 * overlap) / (left.bigramCount + right.bigramCount);
}

function computeCommonAffixRatio(left: string, right: string): number {
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 0;

  const sharedLimit = Math.min(left.length, right.length);
  let prefix = 0;
  while (prefix < sharedLimit && left[prefix] === right[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < sharedLimit - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return (prefix + suffix) / maxLength;
}

function computeTokenDice(left: TextFeatures, right: TextFeatures): number {
  if (left.proseTokenCount === 0 || right.proseTokenCount === 0) return 0;

  const [small, large] = left.proseTokens.size <= right.proseTokens.size
    ? [left.proseTokens, right.proseTokens]
    : [right.proseTokens, left.proseTokens];

  let overlap = 0;
  for (const [token, count] of small) {
    overlap += Math.min(count, large.get(token) ?? 0);
  }

  return (2 * overlap) / (left.proseTokenCount + right.proseTokenCount);
}

function computeCodeTokenDice(left: TextFeatures, right: TextFeatures): number {
  if (left.codeTokenCount === 0 || right.codeTokenCount === 0) return 0;

  const [small, large] = left.codeTokens.size <= right.codeTokens.size
    ? [left.codeTokens, right.codeTokens]
    : [right.codeTokens, left.codeTokens];

  let overlap = 0;
  for (const [token, count] of small) {
    overlap += Math.min(count, large.get(token) ?? 0);
  }

  return (2 * overlap) / (left.codeTokenCount + right.codeTokenCount);
}

function getTrailingSentencePunctuation(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed) return '';
  const lastChar = trimmed[trimmed.length - 1] ?? '';
  return '：。？！:;；'.includes(lastChar) ? lastChar : '';
}

function isLikelyProseRewrite(left: TextFeatures, right: TextFeatures): boolean {
  if (left.kind !== 'prose' || right.kind !== 'prose') return false;

  const leftPunctuation = getTrailingSentencePunctuation(left.raw);
  const rightPunctuation = getTrailingSentencePunctuation(right.raw);
  if (!leftPunctuation || leftPunctuation !== rightPunctuation) return false;

  const tokenDice = computeTokenDice(left, right);
  if (tokenDice < 0.16) return false;

  const leftLength = Math.max(left.raw.trim().length, 1);
  const rightLength = Math.max(right.raw.trim().length, 1);
  const lengthRatio = Math.max(leftLength, rightLength) / Math.min(leftLength, rightLength);
  return lengthRatio <= 4;
}

function computeShortEditSimilarity(left: string, right: string): number {
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0 || maxLength > SHORT_EDIT_DISTANCE_LIMIT) return 0;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array<number>(right.length + 1).fill(0);

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    for (let col = 1; col <= right.length; col += 1) {
      const substitutionCost = left[row - 1] === right[col - 1] ? 0 : 1;
      current[col] = Math.min(
        previous[col]! + 1,
        current[col - 1]! + 1,
        previous[col - 1]! + substitutionCost,
      );
    }

    for (let col = 0; col <= right.length; col += 1) {
      previous[col] = current[col]!;
    }
  }

  return 1 - (previous[right.length]! / maxLength);
}

function getReplacementScoreFromFeatures(left: TextFeatures, right: TextFeatures): number {
  if (!left.raw || !right.raw) return 0;
  if (left.raw === right.raw) return 0;
  if (left.structured || right.structured) return 1;
  if (left.kind === 'blank' || right.kind === 'blank') return 0;
  if (left.kind === 'placeholder' || right.kind === 'placeholder') return 0;
  if (left.kind === 'markdown-structure' || right.kind === 'markdown-structure') return 0;
  if (left.kind === 'code-like' && right.kind === 'code-like') {
    const codeTokenDice = computeCodeTokenDice(left, right);
    const structuralSimilarity = Math.max(
      computeCommonAffixRatio(left.normalized, right.normalized),
      computeShortEditSimilarity(left.normalized, right.normalized),
    );
    if (codeTokenDice <= 0) return structuralSimilarity;
    return Math.max(codeTokenDice, structuralSimilarity);
  }

  const maxLength = Math.max(left.raw.length, right.raw.length);
  if (left.kind === 'prose' && right.kind === 'prose' && maxLength > SHORT_TEXT_MAX_LENGTH) {
    if (isLikelyProseRewrite(left, right)) {
      return REPLACEMENT_SCORE_THRESHOLD;
    }
    return Math.max(
      computeTokenDice(left, right),
      computeBigramDice(left, right),
      computeCommonAffixRatio(left.normalized, right.normalized),
      computeShortEditSimilarity(left.normalized, right.normalized),
    );
  }
  if (maxLength <= SHORT_TEXT_MAX_LENGTH) {
    return SHORT_TEXT_REPLACEMENT_SCORE;
  }

  return Math.max(
    computeBigramDice(left, right),
    computeCommonAffixRatio(left.normalized, right.normalized),
    computeShortEditSimilarity(left.normalized, right.normalized),
  );
}

function buildPositionalPairs(deleteCount: number, addCount: number): TextChangeAlignmentPair[] {
  const pairs: TextChangeAlignmentPair[] = [];
  const maxLength = Math.max(deleteCount, addCount);

  for (let index = 0; index < maxLength; index += 1) {
    const deleteIndex = index < deleteCount ? index : null;
    const addIndex = index < addCount ? index : null;
    pairs.push({
      deleteIndex,
      addIndex,
      isReplacement: deleteIndex != null && addIndex != null,
      score: deleteIndex != null && addIndex != null ? 1 : 0,
    });
  }

  return pairs;
}
export function alignTextChangeBlock(
  deleteTexts: readonly string[],
  addTexts: readonly string[],
): TextChangeAlignmentPair[] {
  if (
    deleteTexts.length === 0
    || addTexts.length === 0
    || deleteTexts.some(isStructuredTextLine)
    || addTexts.some(isStructuredTextLine)
  ) {
    return buildPositionalPairs(deleteTexts.length, addTexts.length);
  }

  const deleteFeatures = deleteTexts.map(buildTextFeatures);
  const addFeatures = addTexts.map(buildTextFeatures);

  const scoreCache = new Map<string, number>();
  const getScore = (deleteIndex: number, addIndex: number): number => {
    const key = `${deleteIndex}:${addIndex}`;
    const cached = scoreCache.get(key);
    if (cached != null) return cached;

    const score = getReplacementScoreFromFeatures(
      deleteFeatures[deleteIndex]!,
      addFeatures[addIndex]!,
    );
    scoreCache.set(key, score);
    return score;
  };

  const pairs: TextChangeAlignmentPair[] = [];
  let deleteIndex = 0;
  let addIndex = 0;

  while (deleteIndex < deleteTexts.length || addIndex < addTexts.length) {
    if (deleteIndex >= deleteTexts.length) {
      pairs.push({ deleteIndex: null, addIndex, isReplacement: false, score: 0 });
      addIndex += 1;
      continue;
    }

    if (addIndex >= addTexts.length) {
      pairs.push({ deleteIndex, addIndex: null, isReplacement: false, score: 0 });
      deleteIndex += 1;
      continue;
    }

    const currentScore = getScore(deleteIndex, addIndex);
    const currentIsReplacement = currentScore >= REPLACEMENT_SCORE_THRESHOLD;
    const nextDeleteScore = deleteIndex + 1 < deleteTexts.length
      ? getScore(deleteIndex + 1, addIndex)
      : -1;
    const nextAddScore = addIndex + 1 < addTexts.length
      ? getScore(deleteIndex, addIndex + 1)
      : -1;

    const shouldSkipDelete = nextDeleteScore > currentScore && nextDeleteScore >= REPLACEMENT_SCORE_THRESHOLD;
    const shouldSkipAdd = nextAddScore > currentScore && nextAddScore >= REPLACEMENT_SCORE_THRESHOLD;

    if (shouldSkipDelete && (!shouldSkipAdd || nextDeleteScore >= nextAddScore)) {
      pairs.push({ deleteIndex, addIndex: null, isReplacement: false, score: 0 });
      deleteIndex += 1;
      continue;
    }

    if (shouldSkipAdd) {
      pairs.push({ deleteIndex: null, addIndex, isReplacement: false, score: 0 });
      addIndex += 1;
      continue;
    }

    if (currentIsReplacement) {
      pairs.push({
        deleteIndex,
        addIndex,
        isReplacement: true,
        score: currentScore,
      });
      deleteIndex += 1;
      addIndex += 1;
      continue;
    }

    const deleteRemaining = deleteTexts.length - deleteIndex;
    const addRemaining = addTexts.length - addIndex;
    if (deleteRemaining > addRemaining) {
      pairs.push({ deleteIndex, addIndex: null, isReplacement: false, score: 0 });
      deleteIndex += 1;
      continue;
    }

    if (addRemaining > deleteRemaining) {
      pairs.push({ deleteIndex: null, addIndex, isReplacement: false, score: 0 });
      addIndex += 1;
      continue;
    }

    pairs.push({ deleteIndex, addIndex, isReplacement: false, score: currentScore });
    deleteIndex += 1;
    addIndex += 1;
  }

  return pairs;
}
