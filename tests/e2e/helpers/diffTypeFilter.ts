import { expect, type Page } from '@playwright/test';
import type { DiffTypeFilter } from '../../../src/types';

export async function openDiffTypeFilterOptions(page: Page) {
  const trigger = page.getByTestId('diff-type-filter-trigger');
  if (await trigger.isVisible() && await trigger.getAttribute('aria-expanded') !== 'true') {
    await trigger.click();
    await expect(page.getByTestId('diff-type-filter-menu')).toBeVisible();
  }
}

export async function selectDiffTypeFilter(page: Page, value: DiffTypeFilter) {
  await openDiffTypeFilterOptions(page);
  await page.getByTestId(`diff-filter-${value}`).click();
}

export async function expectDiffTypeFilter(page: Page, value: DiffTypeFilter) {
  await openDiffTypeFilterOptions(page);
  await expect(page.getByTestId(`diff-filter-${value}`)).toHaveAttribute('aria-checked', 'true');
  if (await page.getByTestId('diff-type-filter-trigger').isVisible()) {
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('diff-type-filter-menu')).toHaveCount(0);
  }
}
