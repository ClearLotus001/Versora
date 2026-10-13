// ─────────────────────────────────────────────────────────────────────────────
// src/theme/tokens.ts — CSS Variables 名称映射与运行时 Token 接口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 运行时可读取的主题色值结构。
 *
 * 用于 Canvas 渲染层（workbook 组件）等无法使用 CSS 类名的场景，
 * 通过 `getComputedThemeTokens()` 从 DOM 读取 CSS Variables 实际值。
 */
export interface ThemeTokens {
  /* 背景 */
  bg0: string;
  bg1: string;
  bg2: string;
  bg3: string;
  bg4: string;
  /* 边框 */
  border: string;
  border2: string;
  /* 文字 */
  t0: string;
  t1: string;
  t2: string;
  /* Diff 新增 */
  addBg: string;
  addHl: string;
  addTx: string;
  addBrd: string;
  /* Diff 删除 */
  delBg: string;
  delHl: string;
  delTx: string;
  delBrd: string;
  /* Diff 修改 */
  chgBg: string;
  chgHl: string;
  chgTx: string;
  chgBrd: string;
  /* 仅空白差异，独立于搜索状态 */
  whitespaceBg: string;
  whitespaceHl: string;
  whitespaceTx: string;
  whitespaceBrd: string;
  /* 强调色 */
  acc: string;
  acc2: string;
  /* 对比版本 */
  versionBase: string;
  versionMine: string;
  /* 语法高亮 */
  kw: string;
  str: string;
  num: string;
  cmt: string;
  punc: string;
  /* 行号 */
  lnBg: string;
  lnTx: string;
  /* 工作表字段标题 */
  workbookHeaderBg: string;
  workbookHeaderBorder: string;
  /* 工作表不透明底板 */
  workbookCanvasBg: string;
  workbookCellBg: string;
  workbookEmptyBg: string;
  workbookMissingBg: string;
  /* 工作表网格层级 */
  workbookGridBorder: string;
  workbookGridBorderStrong: string;
  /* 滚动条 */
  scrollThumb: string;
  scrollThumbHover: string;
  scrollTrack: string;
  /* MiniMap */
  miniAdd: string;
  miniDel: string;
  miniVp: string;
  /* 搜索 */
  searchHl: string;
  searchActiveBg: string;
  /* 保留透明度，供文字对比度合成计算 */
  textSelectionBg: string;
  textSelectionEdge: string;
  /* 毛玻璃 */
  glassBlur: string;
}

/**
 * 将 ThemeTokens 字段名映射到对应的 CSS 变量名。
 *
 * 键为 ThemeTokens 的字段名，值为 CSS 变量名（不带 `var()` 包裹）。
 */
export const THEME_VAR_MAP: Record<keyof ThemeTokens, string> = {
  bg0: '--bg-base',
  bg1: '--bg-surface-solid',
  bg2: '--bg-surface-hover',
  bg3: '--bg-elevated',
  bg4: '--border-color',
  border: '--border-color',
  border2: '--border-strong',
  t0: '--text-title',
  t1: '--text-primary',
  t2: '--text-secondary',
  addBg: '--diff-add-bg',
  addHl: '--diff-add-hl',
  addTx: '--diff-add-text',
  addBrd: '--diff-add-border',
  delBg: '--diff-remove-bg',
  delHl: '--diff-remove-hl',
  delTx: '--diff-remove-text',
  delBrd: '--diff-remove-border',
  chgBg: '--diff-modify-bg',
  chgHl: '--diff-modify-hl',
  chgTx: '--diff-modify-text',
  chgBrd: '--diff-modify-border',
  whitespaceBg: '--diff-whitespace-bg',
  whitespaceHl: '--diff-whitespace-hl',
  whitespaceTx: '--diff-whitespace-text',
  whitespaceBrd: '--diff-whitespace-border',
  acc: '--accent',
  acc2: '--acc2',
  versionBase: '--version-base',
  versionMine: '--version-mine',
  kw: '--syntax-keyword',
  str: '--syntax-string',
  num: '--syntax-number',
  cmt: '--syntax-comment',
  punc: '--syntax-punctuation',
  lnBg: '--ln-bg',
  lnTx: '--ln-text',
  workbookHeaderBg: '--workbook-header-bg',
  workbookHeaderBorder: '--workbook-header-border',
  workbookCanvasBg: '--workbook-canvas-bg',
  workbookCellBg: '--workbook-cell-bg',
  workbookEmptyBg: '--workbook-empty-bg',
  workbookMissingBg: '--workbook-missing-bg',
  workbookGridBorder: '--workbook-grid-border',
  workbookGridBorderStrong: '--workbook-grid-border-strong',
  scrollThumb: '--scroll-thumb',
  scrollThumbHover: '--scroll-thumb-hover',
  scrollTrack: '--scroll-track',
  miniAdd: '--mini-add',
  miniDel: '--mini-del',
  miniVp: '--mini-vp',
  searchHl: '--search-hl',
  searchActiveBg: '--search-active-bg',
  textSelectionBg: '--text-selection-bg',
  textSelectionEdge: '--text-selection-edge',
  glassBlur: '--glass-blur',
};
