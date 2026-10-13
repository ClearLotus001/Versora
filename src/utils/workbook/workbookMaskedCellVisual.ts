import type { ThemeTokens } from '@/theme/tokens';
import { resolveThemeAppearance } from '@/theme';
import type { WorkbookMaskedRegionMotion } from '@/utils/workbook/workbookMaskedRegionMotion';

interface WorkbookMaskedCellRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface WorkbookMaskedCellColumnSegment {
  left: number;
  width: number;
}

interface WorkbookMaskedCellRowSegment {
  top: number;
  height: number;
}

interface ShouldMaskWorkbookCellOptions {
  maskedRegionId: string | null;
  revealedRegionId: string;
  isHeaderRow: boolean;
  isSearchMatch: boolean;
}

interface ResolveWorkbookMaskedCellOpacityOptions {
  maskedRegionId: string | null;
  motion: WorkbookMaskedRegionMotion | undefined;
  rowNumber: number;
  column: number;
  isHeaderRow: boolean;
  isSearchMatch: boolean;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothStep(value: number): number {
  const progress = clampUnit(value);
  return progress * progress * (3 - (2 * progress));
}

export function shouldMaskWorkbookCell({
  maskedRegionId,
  revealedRegionId,
  isHeaderRow,
  isSearchMatch,
}: ShouldMaskWorkbookCellOptions): boolean {
  return Boolean(maskedRegionId)
    && maskedRegionId !== revealedRegionId
    && !isHeaderRow
    && !isSearchMatch;
}

export function resolveWorkbookMaskedCellOpacity({
  maskedRegionId,
  motion,
  rowNumber,
  column,
  isHeaderRow,
  isSearchMatch,
}: ResolveWorkbookMaskedCellOpacityOptions): number {
  if (!maskedRegionId || isHeaderRow || isSearchMatch) return 0;
  if (!motion) return 1;

  const rowDistance = Math.abs(rowNumber - motion.rowNumber);
  const columnDistance = Math.abs(column - motion.column);
  const distance = Math.hypot(rowDistance * 0.85, columnDistance * 1.15);
  const waveDelay = Math.min(0.3, distance * 0.055);
  const localRevealProgress = clampUnit(
    (motion.revealProgress - waveDelay) / Math.max(0.001, 1 - waveDelay),
  );
  return 1 - smoothStep(localRevealProgress);
}

function drawWorkbookMaskedCellOverlay(
  ctx: CanvasRenderingContext2D,
  rect: WorkbookMaskedCellRect,
  theme: ThemeTokens,
  opacity: number,
): void {
  const left = rect.left + 1;
  const top = rect.top + 1;
  const width = Math.max(0, rect.width - 2);
  const height = Math.max(0, rect.height - 2);
  if (width <= 0 || height <= 0) return;

  const right = left + width;
  const bottom = top + height;
  const revealAmount = 1 - clampUnit(opacity);
  const gap = 8 + (revealAmount * 3.5);
  const drift = revealAmount * 7;
  const lineAlpha = resolveThemeAppearance(theme) === 'high-contrast' ? 'd0' : 'b0';

  ctx.save();
  ctx.globalAlpha *= clampUnit(opacity);
  ctx.beginPath();
  ctx.rect(left, top, width, height);
  ctx.clip();
  ctx.fillStyle = theme.workbookMissingBg;
  ctx.fillRect(left, top, width, height);
  ctx.strokeStyle = `${theme.workbookGridBorderStrong}${lineAlpha}`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const firstX = (Math.floor((left - height) / gap) * gap) - drift;
  for (let x = firstX; x < right; x += gap) {
    ctx.moveTo(x, bottom);
    ctx.lineTo(x + height + drift, top);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawWorkbookMaskedCellSegments(
  ctx: CanvasRenderingContext2D,
  columnSegments: readonly WorkbookMaskedCellColumnSegment[],
  rowSegments: readonly WorkbookMaskedCellRowSegment[],
  theme: ThemeTokens,
  opacity = 1,
): void {
  if (opacity <= 0.001) return;
  rowSegments.forEach((rowSegment) => {
    columnSegments.forEach((columnSegment) => {
      drawWorkbookMaskedCellOverlay(ctx, {
        left: columnSegment.left,
        top: rowSegment.top,
        width: columnSegment.width,
        height: rowSegment.height,
      }, theme, opacity);
    });
  });
}
