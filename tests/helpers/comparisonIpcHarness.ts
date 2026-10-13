import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import type { IpcMainInvokeEvent } from 'electron';
import type { VersoraBridge } from '../../src/types/bridge';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/** Uses the real preload and registered handlers; only Electron's IPC transport is in-process. */
export async function createComparisonIpcHarness(): Promise<VersoraBridge> {
  const testRequire = createRequire(__filename);
  const electronPath = testRequire.resolve('electron');
  const previousModule = testRequire.cache[electronPath];
  const electronModule = new Module(electronPath);
  const handlers = new Map<string, Handler>();
  let bridge: VersoraBridge | undefined;
  electronModule.exports = {
    app: {},
    nativeTheme: { shouldUseDarkColors: false },
    ipcMain: {
      handle(channel: string, handler: Handler) { handlers.set(channel, handler); },
      on() {},
    },
    ipcRenderer: {
      async invoke(channel: string, ...args: unknown[]) {
        const handler = handlers.get(channel);
        assert.ok(handler, `Missing IPC handler: ${channel}`);
        return handler({} as IpcMainInvokeEvent, ...args);
      },
    },
    contextBridge: {
      exposeInMainWorld(name: string, value: VersoraBridge) {
        assert.equal(name, 'versora');
        bridge = value;
      },
    },
  };
  electronModule.loaded = true;
  testRequire.cache[electronPath] = electronModule;
  try {
    const { registerIpcHandlers } = await import('../../electron/main/ipcHandlers');
    registerIpcHandlers();
    await import('../../electron/preload');
    assert.ok(bridge);
    return bridge;
  } finally {
    if (previousModule) testRequire.cache[electronPath] = previousModule;
    else delete testRequire.cache[electronPath];
  }
}
