import { expect, test } from '@playwright/test';

test('the shell loads and shows the signed-in member', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Quartermaster' })).toBeVisible();
  await expect(page.getByTestId('member-name')).toHaveText('Test Owner');
  await expect(page.getByTestId('household')).toHaveText('Test household');
  // Nothing may overflow horizontally at phone width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
