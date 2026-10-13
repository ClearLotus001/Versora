import { expect, test, type Page } from '@playwright/test';

async function loadSvnConfigFixture(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.addInitScript(() => {
    const updateState = {
      status: 'idle',
      platform: 'win32',
      supportsAutoUpdate: false,
      currentVersion: '1.0.19',
      availableVersion: null,
      downloadPercent: 0,
      releaseName: null,
      releaseNotes: null,
      publishedAt: null,
      lastCheckedAt: null,
      errorMessage: null,
    };
    const status = {
      available: true,
      reason: 'ready',
      executablePath: 'C:\\Tools\\Versora\\resources\\bin\\svn_diff_launcher.exe',
      command: '"C:\\Tools\\Versora\\resources\\bin\\svn_diff_launcher.exe" %base %mine',
      currentMode: 'all-files',
      canRestoreDefault: true,
      globalDiffCommand: '"C:\\Tools\\Versora\\resources\\bin\\svn_diff_launcher.exe" %base %mine',
      workbookDiffCommands: {},
      workbookExtensions: ['.xlsx', '.xls'],
    };

    Object.defineProperty(window, 'versora', {
      configurable: true,
      value: {
        getLaunchContext: async () => ({
          hasDiffRequest: false,
          isDevMode: true,
          usesNativeWindowControls: false,
          windowFrameState: { isMaximized: true },
          launchedAfterUpdate: false,
          updateState,
        }),
        getDiffData: async () => ({
          baseName: '',
          mineName: '',
          svnUrl: '',
          fileName: '',
          baseContent: null,
          mineContent: null,
        }),
        getSvnDiffViewerStatus: async () => status,
        configureSvnDiffViewer: async () => status,
        restoreSvnDefaultDiffViewerConfiguration: async () => status,
      },
    });
  });

  await page.goto('/?__e2e=1');
  const openButton = page.locator('.home-action-card--svn .home-action-card__button');
  await expect(openButton).toBeEnabled();
  await openButton.click();

  const actions = page.locator('.svn-config-dialog__scope-action');
  await expect(actions).toHaveCount(3);
  await expect(actions.first()).toBeVisible();
  return actions;
}

async function applyThemeClass(page: Page, theme: 'light' | 'dark' | 'hc') {
  await page.evaluate((nextTheme) => {
    document.documentElement.classList.remove('theme-light', 'theme-dark', 'theme-hc');
    document.documentElement.classList.add(`theme-${nextTheme}`);
  }, theme);
  await page.waitForTimeout(200);
}

test('SVN scope action text stays legible in every theme', async ({ page }) => {
  const actions = await loadSvnConfigFixture(page);

  for (const theme of ['light', 'dark', 'hc'] as const) {
    await applyThemeClass(page, theme);
    const styles = await actions.evaluateAll((buttons) => buttons.map((button) => {
      const style = getComputedStyle(button);
      return {
        color: style.color,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
      };
    }));

    const expectedTextColor = theme === 'light'
      ? 'rgb(250, 250, 250)'
      : theme === 'dark'
        ? 'rgb(9, 9, 11)'
        : 'rgb(0, 0, 0)';

    for (const style of styles) {
      expect(style.color).toBe(expectedTextColor);
      if (theme === 'hc') {
        expect(style.backgroundImage).toBe('none');
        expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      } else {
        expect(style.backgroundImage).toContain('135deg');
      }
    }
  }
});
