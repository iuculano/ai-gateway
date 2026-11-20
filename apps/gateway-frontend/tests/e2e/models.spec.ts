import { expect, type MockApiResponse, type RecordedApiRequest, test } from './api-mock';
import { CATALOG, PAGE_META } from './fixtures';

const PROVIDERS = '/api/models/providers';

/**
 * A catalog of two pages with one provider each, where a provider's id is the
 * cursor past it.
 */
function twoPageCatalog(request: RecordedApiRequest): MockApiResponse {
  const second = request.query.get('after_id') === 'anthropic';
  const id = second ? 'openai' : 'anthropic';

  return {
    json: {
      data: [{ ...CATALOG[0], id: id }],
      meta: { oldest_id: id, more_data: !second },
    },
  };
}

test('a failed catalog load can be retried', async ({ page, api }) => {
  let attempts = 0;
  api.get(PROVIDERS, () => {
    attempts += 1;

    if (attempts === 1) {
      return { status: 503, json: { error: { code: 503, message: 'Catalog temporarily unavailable.' } } };
    }

    return { json: { data: CATALOG, meta: PAGE_META } };
  });

  await page.goto('/models');
  await expect(page.getByText('Catalog temporarily unavailable.')).toBeVisible();

  await page.getByRole('button', { name: 'Retry' }).click();

  await expect(page.getByText('OpenAI', { exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});

test('the catalog is paged through one provider page at a time', async ({ page, api }) => {
  api.get(PROVIDERS, twoPageCatalog);
  const next = page.getByRole('button', { name: 'Next', exact: true });
  const previous = page.getByRole('button', { name: 'Previous', exact: true });

  await page.goto('/models');

  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  await expect(previous).toBeDisabled();
  expect(api.matching('GET', PROVIDERS)).toHaveLength(1);
  expect(api.matching('GET', PROVIDERS)[0]?.query.get('limit')).toBe('20');

  await next.click();

  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  await expect(next).toBeDisabled();
  expect(api.matching('GET', PROVIDERS).at(-1)?.query.get('after_id')).toBe('anthropic');

  await previous.click();

  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  expect(api.matching('GET', PROVIDERS).at(-1)?.query.has('after_id')).toBe(false);
});

test('refresh reloads the page in view rather than the first', async ({ page, api }) => {
  api.get(PROVIDERS, twoPageCatalog);
  await page.goto('/models');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Refresh', exact: true }).click();

  await expect.poll(() => api.matching('GET', PROVIDERS).length).toBe(3);
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  expect(api.matching('GET', PROVIDERS).at(-1)?.query.get('after_id')).toBe('anthropic');
});

test('searching narrows the page in view without ending pagination', async ({ page, api }) => {
  api.get(PROVIDERS, twoPageCatalog);
  await page.goto('/models');

  await page.getByPlaceholder('Search this page…').fill('no matching model');

  await expect(page.getByText('No providers match your filters')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
});
