import { expect, test } from '@playwright/test';

test('about update action keeps inverse contrast while hovered in every theme', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('versora.locale', 'zh-CN');
    window.versora = {
      getLaunchContext: async () => ({
        hasDiffRequest: false,
        isDevMode: false,
        usesNativeWindowControls: false,
        windowFrameState: { isMaximized: true },
        launchedAfterUpdate: false,
        updateState: {
          status: 'idle',
          platform: 'win32',
          supportsAutoUpdate: true,
          currentVersion: '1.0.28',
          availableVersion: null,
          downloadPercent: 0,
          releaseName: null,
          releaseNotes: null,
          publishedAt: null,
          lastCheckedAt: null,
          errorMessage: null,
        },
      }),
      getDiffData: async () => ({
        baseName: '',
        mineName: '',
        svnUrl: '',
        fileName: '',
        baseContent: null,
        mineContent: null,
      }),
      checkForAppUpdate: async () => undefined,
    } as unknown as NonNullable<typeof window.versora>;
  });

  await page.goto('/');
  await page.getByRole('button', { name: '关于 Versora' }).click();

  const action = page.getByRole('dialog').getByRole('button', { name: '检查更新' });
  await expect(action).toBeEnabled();

  const expectedTextColor = {
    light: 'rgb(250, 250, 250)',
    dark: 'rgb(9, 9, 11)',
    hc: 'rgb(0, 0, 0)',
  } as const;

  for (const theme of ['light', 'dark', 'hc'] as const) {
    await page.evaluate((nextTheme) => {
      document.documentElement.classList.remove('theme-light', 'theme-dark', 'theme-hc');
      document.documentElement.classList.add(`theme-${nextTheme}`);
    }, theme);
    await action.hover();

    const style = await action.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        backgroundImage: computed.backgroundImage,
      };
    });

    expect(style.color).toBe(expectedTextColor[theme]);
    expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    if (theme === 'hc') {
      expect(style.backgroundImage).toBe('none');
    } else {
      expect(style.backgroundImage).toContain('linear-gradient');
    }
  }
});
