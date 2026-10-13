export function getWorkbookCanvasDevicePixelRatio(): number {
  return typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
}

export function paintWorkbookCanvasBackdrop(
  ctx: CanvasRenderingContext2D,
  rect: { left: number; top: number; width: number; height: number },
  opaqueBackground: string,
  rowBackground: string,
): void {
  // Both frozen and scrolling cells must blend state colors over a fresh,
  // opaque surface rather than over chrome or a previous drawing pass.
  ctx.fillStyle = opaqueBackground;
  ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
  if (rowBackground !== opaqueBackground) {
    ctx.fillStyle = rowBackground;
    ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
  }
}

export function syncWorkbookCanvasSurface(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
) {
  const width = Math.max(1, Math.ceil(cssWidth));
  const height = Math.max(1, Math.ceil(cssHeight));
  const pixelWidth = Math.max(1, Math.ceil(width * dpr));
  const pixelHeight = Math.max(1, Math.ceil(height * dpr));
  const styleWidth = `${width}px`;
  const styleHeight = `${height}px`;

  if (canvas.width !== pixelWidth) {
    canvas.width = pixelWidth;
  }
  if (canvas.height !== pixelHeight) {
    canvas.height = pixelHeight;
  }
  if (canvas.style.width !== styleWidth) {
    canvas.style.width = styleWidth;
  }
  if (canvas.style.height !== styleHeight) {
    canvas.style.height = styleHeight;
  }
}
