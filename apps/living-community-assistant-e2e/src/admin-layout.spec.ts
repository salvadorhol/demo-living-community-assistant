import { test, expect } from '@playwright/test';

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 640 },
]) {
  test(`admin configuration scrolls and saves appointments at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/admin');
    await page
      .getByLabel('Password', { exact: true })
      .fill('fixture-admin-password');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/configuration$/);
    const editor = page.getByLabel('Appointments JSON');
    const original = await editor.inputValue();
    // Whitespace changes the draft without changing the available slots.
    await editor.fill(original + ' ');
    const save = page.getByRole('button', {
      name: 'Save appointments',
      exact: true,
    });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    const content = page.getByRole('region', {
      name: 'Administration content',
    });
    expect(await content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await save.click();
    await expect(
      page.getByText(
        'Appointments saved. The next lookup will use these options.',
      ),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Review', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Review' })).toContainText(
      'Listen to calls',
    );
    await page.reload();
    await expect(
      page.getByRole('link', { name: 'Review', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(page.getByLabel('Appointments JSON')).toHaveCount(0);
  });
}
