import { expect, test } from '@playwright/test';

test('two-file dialog explains automatic Git/SVN detection and local fallback behavior', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('versora.locale', 'zh-CN');
    window.versora = {
      getPathForDroppedFile: (file: File) => `E:\\Dropped\\${file.name}`,
      loadLocalFileDiff: () => new Promise<never>(() => {}),
      getLaunchContext: async () => ({
        hasDiffRequest: false,
        isDevMode: true,
        usesNativeWindowControls: false,
        windowFrameState: { isMaximized: true },
        launchedAfterUpdate: false,
        updateState: {
          status: 'disabled',
          platform: 'win32',
          supportsAutoUpdate: false,
          currentVersion: 'test',
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
        svnUrl: '',
        fileName: '',
        baseName: '',
        mineName: '',
        launchBaseName: '',
        launchMineName: '',
        compareContext: 'literal_two_file_compare',
        baseContent: null,
        mineContent: null,
        revisionOptions: null,
        baseRevisionInfo: null,
        mineRevisionInfo: null,
        canSwitchRevisions: false,
        workbookArtifactDiff: null,
        sourceNoticeCode: null,
        perf: null,
      }),
    } as unknown as NonNullable<typeof window.versora>;
  });
  const testBaseUrl = process.env.SVN_DIFF_E2E_BASE_URL ?? '';
  await page.goto(`${testBaseUrl}/?__e2e=1`);
  await page.waitForFunction(() => Boolean(window.__SVN_DIFF_E2E__));

  const openDialog = page.getByRole('button', { name: '选择两份文件', exact: true });
  await expect(openDialog).toBeVisible();
  await openDialog.click();

  await expect(page.getByRole('heading', { name: '对比两份文件', exact: true })).toBeVisible();
  await expect(page.locator('.local-file-compare-dialog [title]')).toHaveCount(0);
  await expect(page.getByText('自动选择对比来源', { exact: true })).toBeVisible();
  const versionedRule = page.getByText('Git / SVN：逐侧识别，并支持历史版本切换。', { exact: true });
  const plainRule = page.getByText('普通文件：直接对比当前内容；仅版本库一侧可切换。', { exact: true });
  await expect(versionedRule).toBeVisible();
  await expect(plainRule).toBeVisible();
  await expect.poll(async () => versionedRule.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(async () => plainRule.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  const dialogVisuals = await page.evaluate(() => {
    const overlay = document.querySelector<HTMLElement>('.motion-dialog-overlay');
    const dialog = document.querySelector<HTMLElement>('.motion-dialog-surface');
    return {
      overlayBackdropFilter: overlay ? getComputedStyle(overlay).backdropFilter : '',
      dialogBackdropFilter: dialog ? getComputedStyle(dialog).backdropFilter : '',
    };
  });
  expect(dialogVisuals.overlayBackdropFilter).toContain('blur(14px)');
  expect(dialogVisuals.dialogBackdropFilter).toContain('blur(');
  expect(dialogVisuals.dialogBackdropFilter).not.toBe('none');

  const baseDropZone = page.getByTestId('local-file-drop-base');
  const mineDropZone = page.getByTestId('local-file-drop-mine');
  await expect(baseDropZone.getByText('可拖放', { exact: true })).toBeVisible();
  await expect(mineDropZone.getByText('可拖放', { exact: true })).toBeVisible();
  await baseDropZone.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['base'], 'publish.xlsx'));
    element.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(baseDropZone.getByText('松开以放入此文件', { exact: true })).toBeVisible();
  await baseDropZone.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['base'], 'publish.xlsx'));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(baseDropZone.getByText('publish.xlsx', { exact: true })).toBeVisible();
  await expect(baseDropZone.getByText('拖入可替换', { exact: true })).toBeVisible();

  await mineDropZone.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['first'], 'first.xlsx'));
    transfer.items.add(new File(['second'], 'second.xlsx'));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.getByRole('alert')).toContainText('每侧一次只能拖入一个文件。');

  await mineDropZone.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['mine'], 'trunk.xlsx'));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(mineDropZone.getByText('trunk.xlsx', { exact: true })).toBeVisible();
  const compareAction = page.getByRole('button', { name: '开始对比', exact: true });
  await expect(compareAction).toBeEnabled();
  await compareAction.click();

  await expect(page.locator('.local-file-compare-dialog')).toBeHidden();
  await expect(page.getByTestId('diff-loading-state')).toBeVisible();
  await expect(page.getByTestId('diff-loading-state')).toContainText('正在准备差异视图');
  await expect(page.getByText('正在识别并对比…', { exact: true })).toHaveCount(0);
});
