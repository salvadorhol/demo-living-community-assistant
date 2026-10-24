import { test, expect, type Page } from '@playwright/test';

async function storedUser(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ uid: string; isAnonymous: boolean }>((resolve, reject) => {
        const request = indexedDB.open('firebaseLocalStorageDb');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const read = db
            .transaction('firebaseLocalStorage')
            .objectStore('firebaseLocalStorage')
            .getAll();
          read.onerror = () => {
            db.close();
            reject(read.error);
          };
          read.onsuccess = () => {
            db.close();
            resolve(
              read.result.find((record) =>
                record.fbase_key.startsWith('firebase:authUser:'),
              )?.value,
            );
          };
        };
      }),
  );
}

test('shows the workspace and connects to the backend', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Living Community Assistant',
  );
  await expect(
    page.getByRole('status', { name: 'Socket connection status' }),
  ).toHaveText('Socket connected', { timeout: 60_000 });
  const user = await storedUser(page);
  expect(user?.isAnonymous).toBe(true);
  expect(user?.uid).toBeTruthy();
  await page.reload();
  await expect(
    page.getByRole('status', { name: 'Socket connection status' }),
  ).toHaveText('Socket connected', { timeout: 60_000 });
  expect((await storedUser(page))?.uid).toBe(user.uid);
  await page.getByRole('button', { name: 'Check backend' }).click();
  await expect(
    page.getByRole('status', { name: 'Backend health status' }),
  ).toContainText('Backend ok', {
    timeout: 60_000,
  });
});
