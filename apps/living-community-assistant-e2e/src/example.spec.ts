import { test, expect } from '@playwright/test';

test('shows the workspace and connects to the backend', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Living Community Assistant',
  );
  await page.getByRole('button', { name: 'Check backend' }).click();
  await expect(page.getByRole('status')).toContainText('Backend ok', {
    timeout: 60_000,
  });
});
