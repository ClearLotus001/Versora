import type { HorizontalVirtualColumnEntry } from '@/hooks/virtualization/useHorizontalVirtualColumns';
import type { WorkbookDiffRegion } from '@/types';
import {
  type WorkbookColumnSpanBounds,
  type WorkbookCanvasSpanGeometry,
  getWorkbookCanvasSpanGeometry,
  getWorkbookColumnSpanBounds,
} from '@/utils/workbook/workbookMergeLayout';
import {
  mergeWorkbookSemanticTone,
  resolveWorkbookRegionTone,
  type WorkbookRowSemanticTone,
} from '@/utils/workbook/workbookRowVisuals';

export interface WorkbookRegionOverlayBox {
  key: string;
  top: number;
  left: number;
  width: number;
  height: number;
  tone?: WorkbookRowSemanticTone;
  openTop?: boolean;
  openBottom?: boolean;
}

export type WorkbookRegionOverlayBoundsMode = 'single' | 'paired-shared' | 'paired-base' | 'paired-mine';

export interface WorkbookRegionHorizontalBounds {
  leftOffset: number;
  rightOffset: number;
  width: number;
}

export interface WorkbookRegionOverlayVisibleRowBounds {
  firstVisibleRowIndex: number;
  lastVisibleRowIndex: number;
  top: number;
  bottom: number;
}

interface WorkbookRegionOverlayGeometryOptions {
  region: WorkbookDiffRegion;
  visibleRowFrames: Map<number, { top: number; height: number }>;
  boundsModes: WorkbookRegionOverlayBoundsMode[];
  columnLayoutByColumn: ReadonlyMap<number, HorizontalVirtualColumnEntry>;
  contentLeft: number;
  scrollLeft: number;
  frozenWidth: number;
  freezeColumnCount: number;
  key: string;
}

interface WorkbookRegionOverlayVerticalBounds {
  top: number;
  bottom: number;
  openTop: boolean;
  openBottom: boolean;
}

interface BuildWorkbookPatchOverlayBoxesParams {
  region: WorkbookDiffRegion;
  visibleRows: Array<[number, { top: number; height: number }]>;
  columnLayoutByColumn: ReadonlyMap<number, HorizontalVirtualColumnEntry>;
  contentLeft: number;
  scrollLeft: number;
  frozenWidth: number;
  freezeColumnCount: number;
  resolvePatchBoundsModes: (patch: WorkbookDiffRegion['patches'][number]) => WorkbookRegionOverlayBoundsMode[];
  filterPatch?: ((patch: WorkbookDiffRegion['patches'][number]) => boolean) | undefined;
  keyPrefix: string;
}

interface BuildWorkbookRegionOutlineOverlayBoxesParams {
  region: WorkbookDiffRegion;
  visibleRows: Array<[number, { top: number; height: number }]>;
  columnLayoutByColumn: ReadonlyMap<number, HorizontalVirtualColumnEntry>;
  contentLeft: number;
  scrollLeft: number;
  frozenWidth: number;
  freezeColumnCount: number;
  resolvePatchBoundsModes: (patch: WorkbookDiffRegion['patches'][number]) => WorkbookRegionOverlayBoundsMode[];
  fallbackBoundsModes?: WorkbookRegionOverlayBoundsMode[] | undefined;
  filterPatch?: ((patch: WorkbookDiffRegion['patches'][number]) => boolean) | undefined;
  keyPrefix: string;
}

export function findVisibleWorkbookRowBounds(
  visibleRows: Array<[number, { top: number; height: number }]>,
  startRowIndex: number,
  endRowIndex: number,
): WorkbookRegionOverlayVisibleRowBounds | null {
  if (visibleRows.length === 0) return null;

  let low = 0;
  let high = visibleRows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((visibleRows[middle]?.[0] ?? Number.POSITIVE_INFINITY) < startRowIndex) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const firstIndex = low;
  const firstRow = visibleRows[firstIndex];
  if (!firstRow || firstRow[0] > endRowIndex) return null;

  low = firstIndex;
  high = visibleRows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((visibleRows[middle]?.[0] ?? Number.NEGATIVE_INFINITY) <= endRowIndex) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const lastIndex = Math.max(firstIndex, low - 1);
  const lastRow = visibleRows[lastIndex];
  if (!lastRow) return null;

  return {
    firstVisibleRowIndex: firstRow[0],
    lastVisibleRowIndex: lastRow[0],
    top: firstRow[1].top,
    bottom: lastRow[1].top + lastRow[1].height,
  };
}

function getWorkbookRegionOverlayVerticalBounds(
  region: WorkbookDiffRegion,
  visibleRowFrames: Map<number, { top: number; height: number }>,
): WorkbookRegionOverlayVerticalBounds | null {
  const visibleRows = Array.from(visibleRowFrames.entries())
    .filter(([rowIndex]) => rowIndex >= region.startRowIndex && rowIndex <= region.endRowIndex)
    .sort((left, right) => left[0] - right[0]);
  if (visibleRows.length === 0) return null;

  const firstVisibleRowIndex = visibleRows[0]?.[0] ?? region.startRowIndex;
  const lastVisibleRowIndex = visibleRows[visibleRows.length - 1]?.[0] ?? region.endRowIndex;

  return {
    top: Math.min(...visibleRows.map(([, frame]) => frame.top)),
    bottom: Math.max(...visibleRows.map(([, frame]) => frame.top + frame.height)),
    openTop: firstVisibleRowIndex > region.startRowIndex,
    openBottom: lastVisibleRowIndex < region.endRowIndex,
  };
}

function mergeWorkbookRegionHorizontalBounds(
  bounds: WorkbookColumnSpanBounds[],
): WorkbookRegionHorizontalBounds | null {
  if (bounds.length === 0) return null;

  const leftOffset = Math.min(...bounds.map((entry) => entry.leftOffset));
  const rightOffset = Math.max(...bounds.map((entry) => entry.rightOffset));
  return {
    leftOffset,
    rightOffset,
    width: Math.max(0, rightOffset - leftOffset),
  };
}

function getWorkbookCanvasSpanGeometryFromOffsets(params: {
  leftOffset: number;
  rightOffset: number;
  contentLeft: number;
  scrollLeft: number;
  frozenWidth: number;
}): WorkbookCanvasSpanGeometry | null {
  const {
    leftOffset,
    rightOffset,
    contentLeft,
    scrollLeft,
    frozenWidth,
  } = params;

  if (rightOffset <= leftOffset) return null;

  const boundaryX = contentLeft + frozenWidth;
  const segments: WorkbookCanvasSpanGeometry['segments'] = [];
  const frozenLayerSegments: WorkbookCanvasSpanGeometry['layerSegments']['frozen'] = [];
  const scrollLayerSegments: WorkbookCanvasSpanGeometry['layerSegments']['scroll'] = [];

  if (leftOffset < frozenWidth) {
    const frozenLeftOffset = leftOffset;
    const frozenRightOffset = Math.min(rightOffset, frozenWidth);
    if (frozenRightOffset > frozenLeftOffset) {
      const frozenSegment = {
        left: contentLeft + frozenLeftOffset,
        width: frozenRightOffset - frozenLeftOffset,
      };
      segments.push(frozenSegment);
      frozenLayerSegments.push(frozenSegment);
    }
  }

  if (rightOffset > frozenWidth) {
    const scrollLeftOffset = Math.max(leftOffset, frozenWidth);
    const rawLeft = contentLeft + scrollLeftOffset - scrollLeft;
    const rawRight = contentLeft + rightOffset - scrollLeft;
    if (rawRight > rawLeft) {
      scrollLayerSegments.push({
        left: rawLeft,
        width: rawRight - rawLeft,
      });
    }
    const clippedLeft = Math.max(boundaryX, rawLeft);
    if (rawRight > clippedLeft) {
      segments.push({
        left: clippedLeft,
        width: rawRight - clippedLeft,
      });
    }
  }

  const visibleSegments = segments.filter((segment) => segment.width > 0);
  if (visibleSegments.length === 0) return null;

  const left = Math.min(...visibleSegments.map((segment) => segment.left));
  const right = Math.max(...visibleSegments.map((segment) => segment.left + segment.width));

  return {
    left,
    right,
    width: Math.max(0, right - left),
    segments: visibleSegments,
    layerSegments: {
      frozen: frozenLayerSegments.filter((segment) => segment.width > 0),
      scroll: scrollLayerSegments.filter((segment) => segment.width > 0),
    },
  };
}

export function resolveWorkbookRegionHorizontalBounds(params: {
  region: WorkbookDiffRegion;
  columnLayoutByColumn: ReadonlyMap<number, HorizontalVirtualColumnEntry>;
  freezeColumnCount: number;
  resolvePatchBoundsModes: (patch: WorkbookDiffRegion['patches'][number]) => WorkbookRegionOverlayBoundsMode[];
  fallbackBoundsModes?: WorkbookRegionOverlayBoundsMode[];
  filterPatch?: ((patch: WorkbookDiffRegion['patches'][number]) => boolean) | undefined;
}): WorkbookRegionHorizontalBounds | null {
  const {
    region,
    columnLayoutByColumn,
    freezeColumnCount,
    resolvePatchBoundsModes,
    fallbackBoundsModes = [],
    filterPatch,
  } = params;

  const patchBounds = region.patches.flatMap((patch) => {
    if (filterPatch && !filterPatch(patch)) return [];

    return resolvePatchBoundsModes(patch)
      .map((boundsMode) => getWorkbookColumnSpanBounds(
        patch.startCol,
        patch.endCol,
        columnLayoutByColumn,
        boundsMode,
        freezeColumnCount,
      ))
      .filter((bounds): bounds is WorkbookColumnSpanBounds => bounds != null);
  });

  if (patchBounds.length > 0) {
    return mergeWorkbookRegionHorizontalBounds(patchBounds);
  }

  const fallbackBounds = fallbackBoundsModes
    .map((boundsMode) => getWorkbookColumnSpanBounds(
      region.startCol,
      region.endCol,
      columnLayoutByColumn,
      boundsMode,
      freezeColumnCount,
    ))
    .filter((bounds): bounds is WorkbookColumnSpanBounds => bounds != null);

  return mergeWorkbookRegionHorizontalBounds(fallbackBounds);
}

export function buildWorkbookPatchOverlayBoxes({
  region,
  visibleRows,
  columnLayoutByColumn,
  contentLeft,
  scrollLeft,
  frozenWidth,
  freezeColumnCount,
  resolvePatchBoundsModes,
  filterPatch,
  keyPrefix,
}: BuildWorkbookPatchOverlayBoxesParams): WorkbookRegionOverlayBox[] {
  if (region.artifactRegion) region = { ...region, patches: region.artifactRegion.provider.getClippedRegionPatches(
    region.artifactRegion.index, visibleRows.map(([row]) => row), [...columnLayoutByColumn.keys()],
  ) };
  return region.patches.flatMap((patch, patchIndex) => {
    if (filterPatch && !filterPatch(patch)) return [];

    const boundsModes = resolvePatchBoundsModes(patch);
    if (boundsModes.length === 0) return [];

    const visibleBounds = findVisibleWorkbookRowBounds(
      visibleRows,
      patch.startRowIndex,
      patch.endRowIndex,
    );
    if (!visibleBounds) return [];

    return boundsModes.flatMap((boundsMode, boundsIndex) => {
      const bounds = getWorkbookColumnSpanBounds(
        patch.startCol,
        patch.endCol,
        columnLayoutByColumn,
        boundsMode,
        freezeColumnCount,
      );
      const geometry = bounds
        ? getWorkbookCanvasSpanGeometry(bounds, contentLeft, scrollLeft, frozenWidth)
        : null;
      if (!geometry) return [];

      return buildWorkbookRegionOverlayBoxesFromGeometry({
        geometry,
        keyPrefix: `${keyPrefix}:${patchIndex}:${boundsMode}:${boundsIndex}`,
        top: visibleBounds.top,
        bottom: visibleBounds.bottom,
        tone: resolveWorkbookRegionTone(patch.hasBaseSide, patch.hasMineSide),
        openTop: visibleBounds.firstVisibleRowIndex > patch.startRowIndex,
        openBottom: visibleBounds.lastVisibleRowIndex < patch.endRowIndex,
      });
    });
  });
}

export function buildWorkbookRegionOutlineOverlayBoxes({
  region,
  visibleRows,
  columnLayoutByColumn,
  contentLeft,
  scrollLeft,
  frozenWidth,
  freezeColumnCount,
  resolvePatchBoundsModes,
  fallbackBoundsModes = [],
  filterPatch,
  keyPrefix,
}: BuildWorkbookRegionOutlineOverlayBoxesParams): WorkbookRegionOverlayBox[] {
  const visibleBounds = findVisibleWorkbookRowBounds(
    visibleRows,
    region.startRowIndex,
    region.endRowIndex,
  );
  if (!visibleBounds) return [];

  const relevantPatches = filterPatch
    ? region.patches.filter((patch) => filterPatch(patch))
    : region.patches.slice();
  if (filterPatch && relevantPatches.length === 0) return [];

  const horizontalBounds = resolveWorkbookRegionHorizontalBounds({
    region,
    columnLayoutByColumn,
    freezeColumnCount,
    resolvePatchBoundsModes,
    fallbackBoundsModes,
    ...(filterPatch ? { filterPatch } : {}),
  });
  if (!horizontalBounds) return [];

  const geometry = getWorkbookCanvasSpanGeometryFromOffsets({
    leftOffset: horizontalBounds.leftOffset,
    rightOffset: horizontalBounds.rightOffset,
    contentLeft,
    scrollLeft,
    frozenWidth,
  });
  if (!geometry) return [];

  const tone = relevantPatches.reduce<WorkbookRowSemanticTone | undefined>(
    (mergedTone, patch) => mergeWorkbookSemanticTone(
      mergedTone,
      resolveWorkbookRegionTone(patch.hasBaseSide, patch.hasMineSide),
    ),
    undefined,
  ) ?? resolveWorkbookRegionTone(region.hasBaseSide, region.hasMineSide);

  return buildWorkbookRegionOverlayBoxesFromGeometry({
    geometry,
    keyPrefix,
    top: visibleBounds.top,
    bottom: visibleBounds.bottom,
    tone,
    openTop: visibleBounds.firstVisibleRowIndex > region.startRowIndex,
    openBottom: visibleBounds.lastVisibleRowIndex < region.endRowIndex,
  });
}

function buildWorkbookRegionOverlayBoxesFromGeometry(params: {
  geometry: WorkbookCanvasSpanGeometry;
  keyPrefix: string;
  top: number;
  bottom: number;
  tone?: WorkbookRowSemanticTone;
  openTop?: boolean;
  openBottom?: boolean;
}): WorkbookRegionOverlayBox[] {
  const {
    geometry,
    keyPrefix,
    top,
    bottom,
    tone,
    openTop = false,
    openBottom = false,
  } = params;

  return geometry.segments
    .filter((segment) => segment.width > 0)
    .map((segment, segmentIndex) => ({
      key: `${keyPrefix}:segment-${segmentIndex}`,
      top: Math.max(0, top),
      left: Math.max(0, segment.left),
      width: Math.max(0, segment.width),
      height: Math.max(0, bottom - top),
      ...(tone ? { tone } : {}),
      openTop,
      openBottom,
    }));
}

export function buildWorkbookRegionOverlayBoxes(
  options: WorkbookRegionOverlayGeometryOptions,
): WorkbookRegionOverlayBox[] {
  const {
    region,
    visibleRowFrames,
    boundsModes,
    columnLayoutByColumn,
    contentLeft,
    scrollLeft,
    frozenWidth,
    freezeColumnCount,
    key,
  } = options;

  const verticalBounds = getWorkbookRegionOverlayVerticalBounds(region, visibleRowFrames);
  if (!verticalBounds || boundsModes.length === 0) return [];

  return boundsModes.flatMap((mode, modeIndex) => {
    const bounds = getWorkbookColumnSpanBounds(
      region.startCol,
      region.endCol,
      columnLayoutByColumn,
      mode,
      freezeColumnCount,
    );
    const geometry = bounds
      ? getWorkbookCanvasSpanGeometry(bounds, contentLeft, scrollLeft, frozenWidth)
      : null;
    return geometry
      ? buildWorkbookRegionOverlayBoxesFromGeometry({
          geometry,
          keyPrefix: `${key}:${mode}:${modeIndex}`,
          top: verticalBounds.top,
          bottom: verticalBounds.bottom,
          tone: resolveWorkbookRegionTone(region.hasBaseSide, region.hasMineSide),
          openTop: verticalBounds.openTop,
          openBottom: verticalBounds.openBottom,
        })
      : [];
  });
}

export function buildWorkbookRegionOverlayBox(
  options: WorkbookRegionOverlayGeometryOptions,
): WorkbookRegionOverlayBox | null {
  const boxes = buildWorkbookRegionOverlayBoxes(options);
  if (boxes.length === 0) return null;

  const left = Math.min(...boxes.map((box) => box.left));
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  const top = Math.min(...boxes.map((box) => box.top));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));
  const openTop = boxes.some((box) => box.openTop);
  const openBottom = boxes.some((box) => box.openBottom);
  const tone = boxes.reduce<WorkbookRowSemanticTone | undefined>((mergedTone, box) => (
    mergeWorkbookSemanticTone(mergedTone, box.tone)
  ), undefined);

  return {
    key: options.key,
    top: Math.max(0, top),
    left: Math.max(0, left),
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    ...(tone ? { tone } : {}),
    openTop,
    openBottom,
  };
}
