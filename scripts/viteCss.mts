export function restoreStandardBackdropFilter(css: string): string {
  return css.replace(/-webkit-backdrop-filter:([^;}]+)/g, (declaration, value: string, offset: number) => {
    const blockStart = css.lastIndexOf('{', offset);
    const blockEnd = css.indexOf('}', offset);
    const block = css.slice(Math.max(0, blockStart), blockEnd < 0 ? css.length : blockEnd);
    return /(?:^|[;{])backdrop-filter:/.test(block)
      ? declaration
      : `${declaration};backdrop-filter:${value}`;
  });
}
