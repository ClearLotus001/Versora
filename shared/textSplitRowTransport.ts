interface SplitRowDescriptor {
  leftLineIdx: number | null;
  rightLineIdx: number | null;
  isReplacementPair?: boolean;
  lineIdx: number;
  lineIdxs: number[];
}

export interface CompactTextSplitRowDescriptors {
  version: 1;
  leftLineIndexes: Int32Array;
  rightLineIndexes: Int32Array;
  replacementFlags: Uint8Array;
}

function encodeIndex(index: number | null, lineCount: number): number | null {
  if (index === null) return -1;
  return Number.isInteger(index) && index >= 0 && index < lineCount && index <= 0x7fff_ffff
    ? index
    : null;
}

/** Preserve prepared row order without cloning a descriptor object graph. */
export function compactTextSplitRowDescriptors(
  descriptors: readonly SplitRowDescriptor[],
  lineCount: number,
): CompactTextSplitRowDescriptors | null {
  if (descriptors.length === 0) return null;
  const leftLineIndexes = new Int32Array(descriptors.length);
  const rightLineIndexes = new Int32Array(descriptors.length);
  const replacementFlags = new Uint8Array(descriptors.length);

  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index]!;
    const left = encodeIndex(descriptor.leftLineIdx, lineCount);
    const right = encodeIndex(descriptor.rightLineIdx, lineCount);
    if (left === null || right === null || (left === -1 && right === -1)) return null;
    const first = left === -1 ? right : left;
    const hasSecond = left !== -1 && right !== -1 && left !== right;
    if (
      descriptor.lineIdx !== first
      || descriptor.lineIdxs.length !== (hasSecond ? 2 : 1)
      || descriptor.lineIdxs[0] !== first
      || (hasSecond && descriptor.lineIdxs[1] !== right)
    ) return null;
    leftLineIndexes[index] = left;
    rightLineIndexes[index] = right;
    replacementFlags[index] = descriptor.isReplacementPair === undefined
      ? 0
      : descriptor.isReplacementPair ? 1 : 2;
  }
  return { version: 1, leftLineIndexes, rightLineIndexes, replacementFlags };
}

export function materializeCompactTextSplitRowDescriptors(
  compact: CompactTextSplitRowDescriptors,
  lineCount: number,
): SplitRowDescriptor[] {
  const rowCount = compact.leftLineIndexes.length;
  if (
    compact.version !== 1
    || compact.rightLineIndexes.length !== rowCount
    || compact.replacementFlags.length !== rowCount
  ) throw new Error('Invalid compact text split row column lengths.');

  const descriptors = new Array<SplitRowDescriptor>(rowCount);
  for (let index = 0; index < rowCount; index += 1) {
    const left = compact.leftLineIndexes[index]!;
    const right = compact.rightLineIndexes[index]!;
    const flag = compact.replacementFlags[index]!;
    if (
      !Number.isInteger(left) || left < -1 || left >= lineCount
      || !Number.isInteger(right) || right < -1 || right >= lineCount
      || (left === -1 && right === -1)
      || (flag !== 0 && flag !== 1 && flag !== 2)
    ) throw new Error('Invalid compact text split row value.');

    const first = left === -1 ? right : left;
    descriptors[index] = {
      leftLineIdx: left === -1 ? null : left,
      rightLineIdx: right === -1 ? null : right,
      lineIdx: first,
      lineIdxs: left !== -1 && right !== -1 && left !== right ? [left, right] : [first],
      ...(flag === 0 ? {} : { isReplacementPair: flag === 1 }),
    };
  }
  return descriptors;
}
