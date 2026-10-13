export interface SharedCharSpan { highlight: boolean; text: string }
interface DiffOp { type: 'equal' | 'insert' | 'delete'; text: string }
const CHAR_DIFF_LIMIT = 2000;
const MAX_EDIT_DISTANCE = 128;
const MAX_DIFF_WORK = 32_768;

interface CharDiffOptions {
  maxEditDistance?: number;
  maxWork?: number;
}

function normalizeBudget(value: number | undefined, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(maximum, Math.floor(value)))
    : maximum;
}

function replaceOps(a: string, b: string): DiffOp[] {
  return [
    ...(a ? [{ type: 'delete' as const, text: a }] : []),
    ...(b ? [{ type: 'insert' as const, text: b }] : []),
  ];
}

function myersOps(a: string, b: string, options: CharDiffOptions): DiffOp[] {
  const n = a.length, m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ type: 'insert', text: b }];
  if (m === 0) return [{ type: 'delete', text: a }];
  const max = Math.min(n + m, normalizeBudget(options.maxEditDistance, MAX_EDIT_DISTANCE));
  const maxWork = normalizeBudget(options.maxWork, MAX_DIFF_WORK);
  if (Math.abs(n - m) > max || maxWork === 0) return replaceOps(a, b);
  const offset = max + 1;
  // Bound both the frontier and retained trace by edit distance, rather than
  // copying a full input-sized JavaScript array at every search layer.
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let work = 0;
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      if (++work > maxWork) return replaceOps(a, b);
      const vKm1 = v[k - 1 + offset] ?? 0, vKp1 = v[k + 1 + offset] ?? 0;
      let x = k === -d || (k !== d && vKm1 < vKp1) ? vKp1 : vKm1 + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        if (++work > maxWork) return replaceOps(a, b);
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset, d);
    }
  }
  return replaceOps(a, b);
}

function backtrack(trace: Int32Array[], a: string, b: string, offset: number, d: number): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length, y = b.length;
  for (let dd = d; dd > 0; dd -= 1) {
    const v = trace[dd]!, k = x - y;
    const vKm1 = v[k - 1 + offset] ?? 0, vKp1 = v[k + 1 + offset] ?? 0;
    const prevK = k === -dd || (k !== dd && vKm1 < vKp1) ? k + 1 : k - 1;
    const prevX = v[prevK + offset] ?? 0, prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      if (a[x - 1] !== b[y - 1]) break;
      ops.push({ type: 'equal', text: a[x - 1]! }); x -= 1; y -= 1;
    }
    ops.push(prevK === k + 1 ? { type: 'insert', text: b[prevY]! } : { type: 'delete', text: a[prevX]! });
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) { ops.push({ type: 'equal', text: a[--x]! }); y -= 1; }
  return ops.reverse();
}

function boundedDiffOps(a: string, b: string, options: CharDiffOptions): DiffOp[] {
  let prefixLength = 0;
  const sharedLength = Math.min(a.length, b.length);
  while (prefixLength < sharedLength && a[prefixLength] === b[prefixLength]) prefixLength += 1;
  let suffixLength = 0;
  while (
    suffixLength < sharedLength - prefixLength
    && a[a.length - suffixLength - 1] === b[b.length - suffixLength - 1]
  ) suffixLength += 1;

  return [
    ...(prefixLength ? [{ type: 'equal' as const, text: a.slice(0, prefixLength) }] : []),
    ...myersOps(
      a.slice(prefixLength, a.length - suffixLength),
      b.slice(prefixLength, b.length - suffixLength),
      options,
    ),
    ...(suffixLength ? [{ type: 'equal' as const, text: a.slice(a.length - suffixLength) }] : []),
  ];
}

function mergeOps(ops: DiffOp[]): DiffOp[] {
  const merged: DiffOp[] = [];
  for (const op of ops) { const last = merged[merged.length - 1]; if (last?.type === op.type) last.text += op.text; else merged.push({ ...op }); }
  return merged;
}

export function shouldHighlightCharacterDiffText(text: string): boolean {
  const characters = Array.from(text);
  return characters.length > 1 || (characters.length === 1 && /^\s$/u.test(characters[0]!));
}

export function computeCharDiff(deletedLine: string, addedLine: string, options: CharDiffOptions = {}): { baseSpans: SharedCharSpan[]; mineSpans: SharedCharSpan[] } | null {
  if (deletedLine.length > CHAR_DIFF_LIMIT || addedLine.length > CHAR_DIFF_LIMIT) return null;
  const ops = mergeOps(boundedDiffOps(deletedLine, addedLine, options));
  const baseSpans: SharedCharSpan[] = [], mineSpans: SharedCharSpan[] = [];
  for (const op of ops) {
    if (op.type === 'equal') { baseSpans.push({ highlight: false, text: op.text }); mineSpans.push({ highlight: false, text: op.text }); }
    else if (op.type === 'delete') baseSpans.push({ highlight: true, text: op.text });
    else mineSpans.push({ highlight: true, text: op.text });
  }
  const merge = (spans: SharedCharSpan[]) => spans.reduce<SharedCharSpan[]>((acc, span) => { const last = acc[acc.length - 1]; if (last?.highlight === span.highlight) last.text += span.text; else acc.push({ ...span }); return acc; }, []);
  const resolveSideSpans = (spans: SharedCharSpan[], text: string) => (
    shouldHighlightCharacterDiffText(text)
      ? merge(spans)
      : text ? [{ highlight: false, text }] : []
  );
  const resolvedBaseSpans = resolveSideSpans(baseSpans, deletedLine);
  const resolvedMineSpans = resolveSideSpans(mineSpans, addedLine);
  if (![...resolvedBaseSpans, ...resolvedMineSpans].some((span) => span.highlight)) return null;
  return { baseSpans: resolvedBaseSpans, mineSpans: resolvedMineSpans };
}
