import type { Locator, Page } from '@playwright/test';
import { expect, type MockApiResponse, type RecordedApiRequest, test } from './api-mock';
import { API_KEY, CREATED_API_KEY, IDS, PAGE_META } from './fixtures';

const KEYS = '/api/api-keys';
const KEY = `/api/api-keys/${IDS.apiKey}`;
const KEY_STATS = `${KEY}/stats`;

type ClipboardOutcome = 'accepts' | 'refuses' | 'missing';

const UNUSABLE_CLIPBOARDS = [
  { outcome: 'refuses', title: 'a clipboard that refuses the key leaves it to be copied by hand' },
  { outcome: 'missing', title: 'a browser without a clipboard leaves the key to be copied by hand' },
] as const;

/**
 * Opens the keys page and submits the create dialog, leaving it open on
 * whatever comes back.
 */
async function submitNewKey(page: Page, name: string): Promise<Locator> {
  await page.goto('/keys');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Key name').fill(name);
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();

  return dialog;
}

/**
 * Swaps the page's clipboard for one the test controls. Runs in the browser,
 * so it can use nothing from this file.
 */
function stubClipboard(outcome: ClipboardOutcome): void {
  const clipboard = {
    writeText(text: string): Promise<void> {
      if (outcome === 'refuses') {
        return Promise.reject(new Error('Permission denied'));
      }

      // An accepted copy stays pending until the test calls finishCopy, which
      // lets it look at the page before the clipboard has answered.
      return new Promise<void>((resolve) => {
        Object.assign(window, { copiedText: text, finishCopy: resolve });
      });
    },
  };

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: outcome === 'missing' ? undefined : clipboard,
  });
}

function copiedText(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { copiedText: string }).copiedText);
}

function finishCopy(page: Page): Promise<void> {
  return page.evaluate(() => (window as unknown as { finishCopy: () => void }).finishCopy());
}

/**
 * Keys as the backend filters and pages them, one to a page, with the key's id
 * as the cursor.
 */
function pagedKeys(request: RecordedApiRequest): MockApiResponse {
  if (request.query.get('status') === 'revoked') {
    const revoked = { ...API_KEY, name: 'Revoked key', revoked_at: '2026-01-01T00:00:00Z' };

    return { json: { data: [revoked], meta: { oldest_id: IDS.apiKey, more_data: false } } };
  }

  const older = request.query.has('after_id');
  const name = older ? 'Older key' : 'Newest key';
  const key = { ...API_KEY, name: name };

  return { json: { data: [key], meta: { oldest_id: IDS.apiKey, more_data: !older } } };
}

// Creating

test('a created key is shown once and then listed', async ({ page, api }) => {
  let created = false;
  api.get(KEYS, () => ({ json: { data: created ? [API_KEY] : [], meta: PAGE_META } }));
  api.post(KEYS, () => {
    created = true;

    return { status: 201, json: CREATED_API_KEY };
  });

  await page.goto('/keys');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Key name').fill(API_KEY.name);
  await dialog.getByLabel(/Description/).fill(API_KEY.description ?? '');
  await dialog.getByRole('button', { name: 'Create key', exact: true }).click();

  await expect(dialog.getByRole('heading', { name: 'Your API key is ready' })).toBeVisible();
  await expect(dialog.getByText(CREATED_API_KEY.key, { exact: true })).toBeVisible();
  expect(api.matching('POST', KEYS)[0]?.body).toMatchObject({
    name: API_KEY.name,
    description: API_KEY.description,
    scopes: 'api-keys:read',
  });

  await dialog.getByRole('button', { name: 'Done', exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText(API_KEY.name, { exact: true })).toBeVisible();
});

test('a key being created cannot be dismissed before the secret arrives', async ({ page, api }) => {
  // Dismissing the dialog mid-request would throw away the only copy of the
  // secret.
  const answer = Promise.withResolvers<void>();
  api.post(KEYS, async () => {
    await answer.promise;

    return { status: 201, json: CREATED_API_KEY };
  });

  const dialog = await submitNewKey(page, 'Pending key');
  await expect.poll(() => api.matching('POST', KEYS).length).toBe(1);

  await expect(dialog.getByRole('button', { name: 'Creating…', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();

  await page.mouse.click(5, 5);
  await expect(dialog).toBeVisible();

  answer.resolve();

  await expect(dialog.getByText(CREATED_API_KEY.key, { exact: true })).toBeVisible();
  expect(api.matching('POST', KEYS)).toHaveLength(1);
});

test('a failed creation keeps the form filled in for another try', async ({ page, api }) => {
  api.post(KEYS, { status: 503, json: { error: { message: 'Creation unavailable' } } });

  const dialog = await submitNewKey(page, 'Unlucky key');

  await expect(page.getByText('Creation unavailable', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Key name')).toHaveValue('Unlucky key');
  await expect(dialog.getByRole('button', { name: 'Create key', exact: true })).toBeEnabled();
});

// Copying the secret

test('copying a key says so only once the clipboard has taken it', async ({ page, api }) => {
  api.post(KEYS, { status: 201, json: CREATED_API_KEY });
  await page.addInitScript<ClipboardOutcome>(stubClipboard, 'accepts');
  const dialog = await submitNewKey(page, 'Clipboard key');
  const confirmation = page.getByText('Key copied to clipboard', { exact: true });

  await dialog.getByRole('button', { name: 'Copy', exact: true }).click();

  await expect.poll(() => copiedText(page)).toBe(CREATED_API_KEY.key);
  await expect(dialog.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
  await expect(confirmation).toBeHidden();

  await finishCopy(page);

  await expect(dialog.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  await expect(confirmation).toBeVisible();
});

for (const { outcome, title } of UNUSABLE_CLIPBOARDS) {
  test(title, async ({ page, api }) => {
    api.post(KEYS, { status: 201, json: CREATED_API_KEY });
    await page.addInitScript<ClipboardOutcome>(stubClipboard, outcome);
    const dialog = await submitNewKey(page, 'Clipboard key');

    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();

    await expect(
      page.getByText('Could not copy to clipboard. Please select and copy the text manually.', { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
    await expect(dialog.getByText(CREATED_API_KEY.key, { exact: true })).toBeVisible();
  });
}

// Revoking

test('revoking a key asks first, then marks it revoked', async ({ page, api }) => {
  let revoked = false;
  api.get(KEYS, () => ({
    json: { data: [{ ...API_KEY, revoked_at: revoked ? '2026-01-01T00:00:00Z' : null }], meta: PAGE_META },
  }));
  api.delete(KEY, () => {
    revoked = true;

    return { status: 204 };
  });
  const row = page.getByRole('button', { name: new RegExp(API_KEY.name) });

  await page.goto('/keys');
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Revoke this API key?' })).toBeVisible();
  expect(api.matching('DELETE', KEY)).toHaveLength(0);

  await dialog.getByRole('button', { name: 'Revoke key' }).click();

  await expect(row.getByText('Revoked', { exact: true })).toBeVisible();
  expect(api.matching('DELETE', KEY)).toHaveLength(1);
});

// Editing

test('cancelling an edit sends nothing and forgets the change', async ({ page, api }) => {
  const key = { ...API_KEY, rate_limit_requests: 5, rate_limit_window: 60 };
  api.get(KEYS, { json: { data: [key], meta: PAGE_META } });
  const dialog = page.getByRole('dialog');
  const requests = dialog.getByLabel('Requests', { exact: true });

  await page.goto('/keys');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await requests.fill('10');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  await expect(dialog).toBeHidden();
  expect(api.matching('PATCH', KEY)).toHaveLength(0);

  await page.getByRole('button', { name: 'Edit', exact: true }).click();

  await expect(requests).toHaveValue('5');
});

test('turning the rate limit off clears both of its fields', async ({ page, api }) => {
  // The backend rejects a limit without a window, so one cannot be cleared
  // without the other.
  const key = { ...API_KEY, rate_limit_requests: 5, rate_limit_window: 60 };
  api.get(KEYS, { json: { data: [key], meta: PAGE_META } });
  api.on('PATCH', KEY, (request) => ({ json: { ...key, ...(request.body as object) } }));
  const dialog = page.getByRole('dialog');

  await page.goto('/keys');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await dialog.getByRole('switch', { name: 'Enable rate limit', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();

  await expect(dialog).toBeHidden();
  expect(api.matching('PATCH', KEY)[0]?.body).toEqual({ rate_limit_requests: null, rate_limit_window: null });
});

// Usage

test('failed key usage waits for a retry, and loaded usage is not fetched again', async ({ page, api }) => {
  let attempts = 0;
  api.get(KEYS, { json: { data: [API_KEY], meta: PAGE_META } });
  api.get(KEY_STATS, () => {
    attempts += 1;

    if (attempts <= 2) {
      return { status: 500, json: { error: { message: 'Usage temporarily unavailable' } } };
    }

    return { json: { id: IDS.apiKey, total_requests: 42, last_used_at: null, current_window: null } };
  });
  const keyName = page.getByText(API_KEY.name, { exact: true });
  const error = page.getByText('Usage temporarily unavailable', { exact: true });
  const retry = page.getByRole('button', { name: 'Retry usage', exact: true });
  const usage = page.getByText('42', { exact: true });

  // Usage is asked for when a key is opened, not for every row in the list.
  await page.goto('/keys');
  await expect(keyName).toBeVisible();
  expect(attempts).toBe(0);

  // A failure stays a failure, however often the row is closed and reopened.
  await keyName.click();
  await expect(error).toBeVisible();
  await keyName.click();
  await keyName.click();
  await api.settle();
  expect(attempts).toBe(1);

  await retry.click();
  await expect.poll(() => attempts).toBe(2);
  await expect(error).toBeVisible();

  await retry.click();
  await expect(usage).toBeVisible();

  await keyName.click();
  await keyName.click();
  await expect(usage).toBeVisible();
  await api.settle();
  expect(attempts).toBe(3);
});

// Filtering and paging

test('paging asks for the keys after the last one shown', async ({ page, api }) => {
  api.get(KEYS, pagedKeys);

  await page.goto('/keys');

  await expect(page.getByText('Newest key', { exact: true })).toBeVisible();
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  expect(api.matching('GET', KEYS)[0]?.query.get('limit')).toBe('20');
  expect(api.matching('GET', KEYS)[0]?.query.get('status')).toBe('all');

  await page.getByRole('button', { name: 'Older', exact: true }).click();

  await expect(page.getByText('Older key', { exact: true })).toBeVisible();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  expect(api.matching('GET', KEYS).at(-1)?.query.get('after_id')).toBe(IDS.apiKey);
});

test('the sidebar counts every key, and not only the page of them on show', async ({ page, api }) => {
  api.get(KEYS, pagedKeys);
  api.get(`${KEYS}/count`, { json: { count: 45, estimated: false } });

  await page.goto('/keys');

  await expect(page.getByRole('link', { name: /^API Keys/ })).toContainText('45');
});

test('changing the status filter starts again from the first page', async ({ page, api }) => {
  api.get(KEYS, pagedKeys);
  const older = page.getByRole('button', { name: 'Older', exact: true });
  await page.goto('/keys');
  await older.click();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Revoked', exact: true }).click();

  await expect(page.getByText('Revoked key', { exact: true })).toBeVisible();
  await expect(older).toBeHidden();
  expect(api.matching('GET', KEYS).at(-1)?.query.get('status')).toBe('revoked');
  expect(api.matching('GET', KEYS).at(-1)?.query.has('after_id')).toBe(false);
});
