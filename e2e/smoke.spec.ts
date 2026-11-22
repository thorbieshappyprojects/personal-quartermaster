import { expect, test, type Page } from '@playwright/test';

// One run per viewport: unique names keep the two projects from seeing each other's data.
const tag = (page: Page) => (page.viewportSize()!.width < 600 ? 'phone' : 'desktop');

test('signed in as the owner', async ({ page }) => {
  await page.goto('/more');
  await expect(page.getByTestId('member-name')).toHaveText('Test Owner');
  await expect(page.getByTestId('household')).toHaveText('Test household');
});

test('M1: add an item to a new place, find it, move it', async ({ page }) => {
  const t = tag(page);
  const site = `Flat ${t}`;

  // Places: create a site and a room in it.
  await page.goto('/places');
  await page.getByRole('button', { name: '+ Site' }).click();
  await page.getByLabel('Name').fill(site);
  await page.getByRole('button', { name: 'Add place' }).click();
  await page.getByRole('link', { name: site }).click();
  await page.getByRole('button', { name: `+ Place inside ${site}` }).click();
  await page.getByLabel('Name').fill('Hall');
  await page.getByRole('button', { name: 'Add place' }).click();
  await page.getByRole('link', { name: /Hall/ }).click();

  // Add an item right here.
  await page.getByRole('link', { name: '+ Item here' }).click();
  await page.getByLabel('What is it?').fill(`Camping stove ${t}`);
  await expect(page.getByTestId('pick-location')).toContainText(`${site} › Hall`);
  await page.getByLabel('Price paid').fill('49,99');
  await expect(page.getByText('= €49.99')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('item-name')).toContainText(`Camping stove ${t}`);
  await expect(page.getByTestId('item-path')).toHaveText(`${site} › Hall`);

  // Find it from the search screen with a question.
  await page.getByRole('link', { name: 'Search' }).click();
  await page.getByLabel('Do we have …?').fill(`do we have a camping stove ${t}?`);
  // The other viewport's stove may match too (fuzzy search); ours must come first.
  await expect(page.getByTestId('answer')).toContainText(`Yes: Camping stove ${t} (${site} › Hall)`);

  // Move it to a new place created from the picker.
  await page.getByRole('link', { name: new RegExp(`Camping stove ${t}`) }).click();
  await page.getByTestId('move').click();
  await page.getByRole('button', { name: '+ New place' }).click();
  await page.getByLabel('New place name').fill('Cellar');
  await page.getByRole('combobox').last().selectOption({ label: site });
  await page.getByRole('button', { name: 'Create and choose' }).click();
  await expect(page.getByTestId('item-path')).toHaveText(`${site} › Cellar`);
  await expect(page.getByText(/moved/)).toBeVisible();

  // No horizontal overflow anywhere we went.
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
