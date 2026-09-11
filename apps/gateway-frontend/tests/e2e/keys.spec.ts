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

test('failed key usage stays idle until retry and successful usage is cached', async ({ page, api }) => {
  registerEmptyApp(api);
  api.get('/api/api-keys', { json: { data: [API_KEY], meta: { oldest_id: null, more_data: false } } });
  const statsPath = `/api/api-keys/${IDS.apiKey}/stats`;
  let attempts = 0;
  api.get(statsPath, () => {
    attempts += 1;
    return attempts <= 2
      ? { status: 500, json: { error: { message: 'Usage temporarily unavailable' } } }
      : { json: { total_requests: 42, last_used_at: null, current_window: null } };
  });

  await page.goto('/keys');
  const keyName = page.getByText(API_KEY.name, { exact: true });
  expect(api.matching('GET', statsPath)).toHaveLength(0);
  await keyName.click();

  const error = page.getByText('Usage temporarily unavailable', { exact: true });
  await expect(error).toBeVisible();
  // Allow asynchronous effect reruns and network round trips to expose a retry loop.
  await page.waitForTimeout(500);
  expect(api.matching('GET', statsPath)).toHaveLength(1);
  await keyName.click();
  await keyName.click();
  await expect(error).toBeVisible();
  await page.waitForTimeout(500);
  expect(api.matching('GET', statsPath)).toHaveLength(1);

  await page.getByRole('button', { name: 'Retry usage', exact: true }).click();
  await expect(error).toBeVisible();
  await page.waitForTimeout(500);
  expect(api.matching('GET', statsPath)).toHaveLength(2);

  await page.getByRole('button', { name: 'Retry usage', exact: true }).click();
  await expect(page.getByText('42', { exact: true })).toBeVisible();
  expect(api.matching('GET', statsPath)).toHaveLength(3);
  await keyName.click();
  await keyName.click();
  await expect(page.getByText('42', { exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  expect(api.matching('GET', statsPath)).toHaveLength(3);
});

for (const outcome of ['success', 'rejected', 'unavailable'] as const) {
  test(`copying a generated key reports clipboard ${outcome}`, async ({ page, api }) => {
    registerEmptyApp(api);
    api.post('/api/api-keys', { status: 201, json: CREATED_API_KEY });
    await page.addInitScript((outcome) => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value:
          outcome === 'unavailable'
            ? undefined
            : {
                writeText: (text: string) =>
                  new Promise<void>((resolve, reject) => {
                    Object.assign(window, {
                      copiedText: text,
                      finishCopy: () => (outcome === 'success' ? resolve() : reject(new Error('Permission denied'))),
                    });
                  }),
              },
      });
    }, outcome);
    await page.goto('/keys');
    await page.getByRole('button', { name: 'Create key', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Key name').fill('Clipboard test');
    await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
    await expect(dialog.getByText(CREATED_API_KEY.key, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();

    if (outcome !== 'unavailable') {
      await expect
        .poll(() => page.evaluate(() => (window as typeof window & { copiedText: string }).copiedText))
        .toBe(CREATED_API_KEY.key);
      await expect(dialog.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
      await expect(page.getByText('Key copied to clipboard', { exact: true })).toBeHidden();
      await page.evaluate(() => (window as typeof window & { finishCopy: () => void }).finishCopy());
    }
    if (outcome === 'success') {
      await expect(dialog.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
      await expect(page.getByText('Key copied to clipboard', { exact: true })).toBeVisible();
    } else {
      await expect(
        page.getByText('Could not copy to clipboard. Please select and copy the text manually.', { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
      await expect(page.getByText('Key copied to clipboard', { exact: true })).toBeHidden();
      await expect(dialog.getByText(CREATED_API_KEY.key, { exact: true })).toBeVisible();
    }
  });
}

for (const succeeds of [true, false]) {
  test(`key creation prevents dismissal until ${succeeds ? 'the secret arrives' : 'failure'}`, async ({
    page,
    api,
  }) => {
    registerEmptyApp(api);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    api.post('/api/api-keys', async () => {
      await pending;
      return succeeds
        ? { status: 201, json: CREATED_API_KEY }
        : { status: 503, json: { error: { message: 'Creation unavailable' } } };
    });
    await page.goto('/keys');
    await page.getByRole('button', { name: 'Create key', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Key name').fill('Pending key');
    await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
    await expect.poll(() => api.matching('POST', '/api/api-keys').length).toBe(1);
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Creating…', exact: true })).toBeDisabled();
    expect(api.matching('POST', '/api/api-keys')).toHaveLength(1);
    finish();
    if (succeeds) {
      await expect(dialog.getByText(CREATED_API_KEY.key, { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    } else {
      await expect(page.getByText('Creation unavailable', { exact: true })).toBeVisible();
      await expect(dialog.getByLabel('Key name')).toHaveValue('Pending key');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    await expect(dialog).toBeHidden();
  });
}

test('key edits are saved through the modal while expanded details stay read-only', async ({ page, api }) => {
  registerEmptyApp(api);
  const key = {
    ...API_KEY,
    creator_id: null,
    expires_at: '2020-01-01T12:34:56.789Z',
    rate_limit_requests: 5,
    rate_limit_window: 60,
  };
  api.get('/api/api-keys', { json: { data: [key], meta: { oldest_id: null, more_data: false } } });
  api.get(`/api/api-keys/${IDS.apiKey}/stats`, {
    json: { id: IDS.apiKey, total_requests: 0, last_used_at: null, current_window: null },
  });
  api.on('PATCH', `/api/api-keys/${IDS.apiKey}`, (request) => ({ json: { ...key, ...(request.body as object) } }));
  await page.goto('/keys');
  await page.getByText(key.name, { exact: true }).click();
  await expect(
    page.getByText('Permissions & scopes', { exact: true }).locator('..').locator('..').getByRole('switch'),
  ).toHaveCount(0);
  await expect(page.getByText('Enabled', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Requests', { exact: true })).toHaveValue('5');
  await dialog.getByLabel('Requests', { exact: true }).fill('10');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(api.matching('PATCH', `/api/api-keys/${IDS.apiKey}`)).toHaveLength(0);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(dialog.getByLabel('Requests', { exact: true })).toHaveValue('5');
  await dialog.getByRole('switch', { name: 'Enable rate limit', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(api.matching('PATCH', `/api/api-keys/${IDS.apiKey}`)[0]?.body).toEqual({
    rate_limit_requests: null,
    rate_limit_window: null,
  });
  await expect(
    page.getByText('Permissions & scopes', { exact: true }).locator('..').locator('..').getByRole('switch'),
  ).toHaveCount(0);
});

test('API key status filters reset pagination and only page through matching keys', async ({ page, api }) => {
  registerEmptyApp(api);
  api.get('/api/api-keys', (request) => {
    const query = new URLSearchParams(request.search);
    expect(query.get('limit')).toBe('20');
    if (query.get('status') === 'revoked') {
      expect(query.has('after_id')).toBe(false);
      return {
        json: {
          data: [{ ...API_KEY, name: 'Revoked key', revoked_at: '2026-01-01T00:00:00Z' }],
          meta: { oldest_id: IDS.apiKey, more_data: false },
        },
      };
    }
    const older = query.has('after_id');
    return {
      json: {
        data: [{ ...API_KEY, creator_id: null, name: older ? 'Older key' : 'Newest key' }],
        meta: { oldest_id: IDS.apiKey, more_data: !older },
      },
    };
  });
  await page.goto('/keys');
  await expect(page.getByText('Newest key', { exact: true })).toBeVisible();
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  await expect.poll(() => api.matching('GET', '/api/api-keys/count').length).toBe(4);
  await page.getByRole('button', { name: 'Older', exact: true }).click();
  await expect(page.getByText('Older key', { exact: true })).toBeVisible();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  expect(api.matching('GET', '/api/api-keys/count')).toHaveLength(4);
  expect(new URLSearchParams(api.matching('GET', '/api/api-keys')[1]?.search).get('after_id')).toBe(IDS.apiKey);
  await page.getByRole('button', { name: 'Revoked', exact: true }).click();
  await expect(page.getByText('Revoked key', { exact: true })).toBeVisible();
  await expect.poll(() => api.matching('GET', '/api/api-keys/count').length).toBe(5);
  await expect(page.getByRole('button', { name: 'Older', exact: true })).not.toBeVisible();
  expect(new URLSearchParams(api.matching('GET', '/api/api-keys')[2]?.search).has('after_id')).toBe(false);
});
