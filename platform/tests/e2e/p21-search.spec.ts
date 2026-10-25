import { expect, test } from '@playwright/test';
import { CITY, SUN } from './helpers';

// Phase 21 demo: a patient types a symptom, not a specialty. "chest pain" finds City Care's cardiologists, the one who
// can see them soonest first; "sugar test" finds HbA1c and fasting sugar. Another hospital's search is its own.
test.describe('search', () => {
  test('"chest pain" finds cardiologists sorted by next available slot', async ({ page }) => {
    await page.goto(`${CITY}/care/doctors`);
    await page.getByLabel('Name, specialty or symptom').fill('chest pain');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page).toHaveURL(/q=chest\+pain/);

    const results = page.getByRole('region', { name: 'Results' });
    await expect(results).toHaveAttribute('data-source', 'search');
    const cards = results.locator('article.mc-doctor');
    await expect(cards.first()).toBeVisible();
    await expect(results.getByRole('link', { name: 'Dr. Asha Rao' })).toBeVisible();
    for (const card of await cards.all()) await expect(card).toContainText('Cardiology');

    await expect(cards.first()).toContainText('Next available:');
    const times = await results.locator('time').evaluateAll((els) => els.map((e) => e.getAttribute('datetime') ?? ''));
    expect(times.length).toBeGreaterThan(0);
    expect([...times].sort()).toEqual(times);
  });

  test('"sugar test" finds HbA1c and fasting blood sugar', async ({ page }) => {
    await page.goto(`${CITY}/care/tests`);
    await page.getByLabel('Search').fill('sugar test');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByRole('checkbox', { name: 'Package Diabetes Screening' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /HbA1c \(Glycated Haemoglobin\)$/ })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /Fasting Blood Sugar$/ })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /Lipid Profile$/ })).toHaveCount(0);
  });

  test("another hospital's search only shows its own doctors", async ({ page }) => {
    await page.goto(`${SUN}/care/doctors?q=chest+pain`);
    await expect(page.getByRole('link', { name: 'Dr. Asha Rao' })).toHaveCount(0);
  });
});
