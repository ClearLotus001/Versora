import { expect, test, type Page } from '@playwright/test';
import '../../src/utils/app/e2eBridge';

interface SearchWorkerProbe {
  created: number;
  searches: number;
  terminated: number;
}

declare global {
  interface Window {
    __SEARCH_WORKER_PROBE__?: SearchWorkerProbe;
    __FAIL_PENDING_SEARCH__?: () => void;
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.setItem('versora.locale', 'en-US');
    const probe = { created: 0, searches: 0, terminated: 0 };
    window.__SEARCH_WORKER_PROBE__ = probe;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        if (!String(scriptURL).includes('textSearchWorker')) return;
        probe.created += 1;
        window.__FAIL_PENDING_SEARCH__ = () => {
          this.dispatchEvent(new ErrorEvent('error', { message: 'Search source read failed' }));
        };
        const send = this.postMessage.bind(this);
        const terminate = this.terminate.bind(this);
        let terminated = false;
        this.postMessage = (message: unknown) => {
          if ((message as { type?: string }).type === 'search') {
            // Keep the real hook's search promise pending without running a
            // pathological regular expression or waiting for its deadline.
            probe.searches += 1;
            return;
          }
          send(message);
        };
        this.terminate = () => {
          if (!terminated) probe.terminated += 1;
          terminated = true;
          terminate();
        };
      }
    };
  });
  await page.goto('/?__e2e=1');
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));
  await page.evaluate(async () => {
    const content = 'header\nNeedle remains in the searchable text\ntail';
    await window.__SVN_DIFF_E2E__!.loadTextDiff({
      fileName: 'search-worker-cleanup.txt',
      baseContent: content,
      mineContent: content,
      collapseCtx: false,
    });
  });
  await page.keyboard.press('Control+f');
  await expect(page.locator('.searchbar-input')).toBeVisible();
});

async function startPendingSearch(page: Page, isRegex = false) {
  if (isRegex) await page.getByRole('button', { name: 'Regex', exact: true }).click();
  await page.locator('.searchbar-input').fill('Needle');
  await expect.poll(() => page.evaluate(() => window.__SEARCH_WORKER_PROBE__?.searches)).toBe(1);
  await expect(page.locator('#search-pattern-status')).toHaveText('Searching…');
  expect(await page.evaluate(() => window.__SEARCH_WORKER_PROBE__)).toEqual({
    created: 1, searches: 1, terminated: 0,
  });
}

test('clearing the search query terminates the pending worker through the search hook', async ({ page }) => {
  await startPendingSearch(page);
  await page.locator('.searchbar-input').fill('');

  await expect.poll(
    () => page.evaluate(() => window.__SEARCH_WORKER_PROBE__?.terminated),
    { timeout: 5_000 },
  ).toBe(1);
  await expect(page.locator('#search-pattern-status')).toHaveCount(0);
  await expect(page.locator('.searchbar-input')).toHaveAttribute('aria-invalid', 'false');
  expect(await page.evaluate(() => window.__SEARCH_WORKER_PROBE__?.created)).toBe(1);
});

test('an invalid regular expression terminates the pending worker through the search hook', async ({ page }) => {
  await startPendingSearch(page, true);
  await page.locator('.searchbar-input').fill('[');

  await expect.poll(
    () => page.evaluate(() => window.__SEARCH_WORKER_PROBE__?.terminated),
    { timeout: 5_000 },
  ).toBe(1);
  await expect(page.locator('.searchbar-input')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#search-pattern-status')).toHaveText('Invalid regular expression');
  expect(await page.evaluate(() => window.__SEARCH_WORKER_PROBE__?.created)).toBe(1);
});

test('a current search failure reaches the visible error notice', async ({ page }) => {
  await startPendingSearch(page);
  await page.evaluate(() => window.__FAIL_PENDING_SEARCH__!());
  await expect(page.getByRole('alert').filter({ hasText: 'Search source read failed' })).toBeVisible();
  await expect(page.locator('#search-pattern-status')).not.toHaveText('Searching…');
});
