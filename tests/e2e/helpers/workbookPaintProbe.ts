import { expect, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

interface CompositedFrame {
  data: string;
  timestamp: number;
}

export interface WorkbookPaintProbe {
  start(): Promise<void>;
  stop(): Promise<CompositedFrame[]>;
  dispose(): Promise<void>;
}

export async function createWorkbookPaintProbe(page: Page): Promise<WorkbookPaintProbe> {
  const session: CDPSession = await page.context().newCDPSession(page);
  let frames: CompositedFrame[] = [];
  let recording = false;
  let disposed = false;
  let ackErrors: string[] = [];
  const pendingAcks = new Set<Promise<void>>();
  const onFrame = (event: {
    data: string; metadata: { timestamp?: number }; sessionId: number;
  }) => {
    if (recording) frames.push({ data: event.data, timestamp: typeof event.metadata.timestamp === 'number'
      ? event.metadata.timestamp * 1_000 : Number.NaN });
    // Acknowledge immediately so screenshots do not hold up later compositor frames.
    const reportError = recording;
    const ack = session.send('Page.screencastFrameAck', { sessionId: event.sessionId })
      .then(() => {}, (error: unknown) => {
        if (reportError && !disposed) ackErrors.push(String(error));
      }).finally(() => { pendingAcks.delete(ack); });
    pendingAcks.add(ack);
  };
  session.on('Page.screencastFrame', onFrame);
  return {
    async start() {
      frames = []; ackErrors = []; recording = true;
      try {
        await session.send('Page.startScreencast', { format: 'png', maxWidth: 900, maxHeight: 500, everyNthFrame: 1 });
      } catch (error) { recording = false; throw error; }
    },
    async stop() {
      try { await session.send('Page.stopScreencast'); } finally { recording = false; }
      await Promise.all(pendingAcks);
      expect(ackErrors, 'compositor screenshots were acknowledged').toEqual([]);
      const result = frames; frames = [];
      return result;
    },
    async dispose() {
      recording = false; disposed = true;
      session.off('Page.screencastFrame', onFrame);
      await Promise.all(pendingAcks);
      await session.detach();
    },
  };
}

interface PaintState {
  wallTime: number;
  pending: number;
}

export async function assertWorkbookCompositedPaint(
  page: Page, testInfo: TestInfo, label: string, frames: CompositedFrame[], states: PaintState[],
  surface: { x: number; y: number; width: number },
) {
  const viewport = page.viewportSize()!;
  const pixelReports = await page.evaluate(async ({ images, cropSurface, view }) => {
    const reports = [];
    for (const frame of images) {
      const bytes = Uint8Array.from(atob(frame.data), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0); bitmap.close();
      const scaleX = canvas.width / view.width;
      const scaleY = canvas.height / view.height;
      // These crops lie below the frozen header and inside data columns. Paired
      // columns and the right pane keep one-sided added worksheets observable.
      const crops = [100, 255, cropSurface.width / 2 + 100].map((offset) => ({
        x: Math.floor((cropSurface.x + offset) * scaleX),
        y: Math.floor((cropSurface.y + 60) * scaleY),
        width: Math.floor(80 * scaleX), height: Math.floor(144 * scaleY),
      }));
      const inkPixels = crops.map((crop) => {
        const pixels = context.getImageData(crop.x, crop.y, crop.width, crop.height).data;
        let ink = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          const luminance = pixels[index]! * 0.2126 + pixels[index + 1]! * 0.7152 + pixels[index + 2]! * 0.0722;
          if (pixels[index + 3]! > 220 && luminance < 180) ink++;
        }
        return ink;
      });
      reports.push({ timestamp: frame.timestamp, width: canvas.width, height: canvas.height, inkPixels, crops });
    }
    return reports;
  }, { images: frames, cropSurface: surface, view: viewport });
  const orderedStates = [...states].sort((left, right) => right.wallTime - left.wallTime);
  const captureStart = orderedStates.at(-1)?.wallTime ?? Number.POSITIVE_INFINITY;
  const reports = pixelReports.map((report, index) => ({
    ...report, index,
    // Chromium can send its previously composited image when screencasting
    // starts. Keep that image in the report, outside this action's capture window.
    outsideCapture: report.timestamp < captureStart,
    pending: orderedStates.find((state) => state.wallTime <= report.timestamp)?.pending ?? null,
  }));
  const reportPath = testInfo.outputPath(`${label}-paint.json`);
  await writeFile(reportPath, JSON.stringify(reports, null, 2));
  await testInfo.attach(`${label}-paint`, { path: reportPath, contentType: 'application/json' });
  const capturedReports = reports.filter((frame) => !frame.outsideCapture);
  const blankReadyFrames = capturedReports.filter((frame) => frame.pending === 0 && !frame.inkPixels.some((ink) => ink > 20));
  for (const frame of blankReadyFrames) {
    const path = testInfo.outputPath(`${label}-blank-paint-${frame.index}.png`);
    await writeFile(path, Buffer.from(frames[frame.index]!.data, 'base64'));
    await testInfo.attach(`${label}-blank-paint-${frame.index}`, { path, contentType: 'image/png' });
  }
  expect.soft(capturedReports.length, `${label}: compositor frames inside the action window were captured`).toBeGreaterThan(0);
  expect.soft(reports.filter((frame) => !Number.isFinite(frame.timestamp) || frame.timestamp <= 0),
    `${label}: compositor timestamps are valid`).toEqual([]);
  expect.soft(capturedReports.filter((frame) => frame.pending === null),
    `${label}: each compositor frame has a preceding DOM state`).toEqual([]);
  expect.soft(blankReadyFrames, `${label}: presented available cell content disappears`).toEqual([]);
}
