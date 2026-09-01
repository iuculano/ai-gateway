import { expect, test } from './api-mock';
import { API_KEY, CREATED_API_KEY, IDS, registerEmptyApp } from './fixtures';

test('an API key can be created, revealed once, and revoked', async ({ page, api }) => {
  registerEmptyApp(api);
  api.post('/api/api-keys', { status: 201, json: CREATED_API_KEY });
  api.delete(`/api/api-keys/${IDS.apiKey}`);

  await page.goto('/keys');
  await expect(page.getByText('No API keys yet')).toBeVisible();

  await page.getByRole('button', { name: 'Create key' }).click();
  const createDialog = page.getByRole('dialog');
  await createDialog.getByLabel('Key name').fill(API_KEY.name);
  await createDialog.getByLabel(/Description/).fill(API_KEY.description ?? '');
  await createDialog.getByRole('button', { name: 'Create key' }).click();

  await expect(createDialog.getByRole('heading', { name: 'Your API key is ready' })).toBeVisible();
  await expect(createDialog.getByText(CREATED_API_KEY.key, { exact: true })).toBeVisible();
  await createDialog.getByRole('button', { name: 'Done' }).click();

  await expect(page.getByText(API_KEY.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  const confirmDialog = page.getByRole('dialog');
  await expect(confirmDialog.getByRole('heading', { name: 'Revoke this API key?' })).toBeVisible();
  await confirmDialog.getByRole('button', { name: 'Revoke key' }).click();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();

  const createCall = api.matching('POST', '/api/api-keys');
  expect(createCall).toHaveLength(1);
  expect(createCall[0]?.body).toMatchObject({
    name: API_KEY.name,
    description: API_KEY.description,
    scopes: 'api-keys:read',
  });
  expect(api.matching('DELETE', `/api/api-keys/${IDS.apiKey}`)).toHaveLength(1);
  expect(api.matching('GET', '/api/api-keys')[0]?.search).toContain('status=all');
});
