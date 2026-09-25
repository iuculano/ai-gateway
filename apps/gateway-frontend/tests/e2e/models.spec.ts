import { expect, test } from './api-mock';
import { CATALOG, registerEmptyApp } from './fixtures';

test('models load one provider page at a time and support next, previous, and refresh', async ({ page, api }) => {
  registerEmptyApp(api);
  api.get('/api/models/providers', (request) => {
    const query = new URLSearchParams(request.search);
    expect(query.get('limit')).toBe('20');
    const second = query.get('after_id') === 'anthropic';
    return {
      json: {
        data: [{ ...CATALOG[0], id: second ? 'openai' : 'anthropic' }],
        meta: { oldest_id: second ? 'openai' : 'anthropic', more_data: !second },
      },
    };
  });

  await page.goto('/models');
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
  expect(api.matching('GET', '/api/models/providers')).toHaveLength(1);

  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => api.matching('GET', '/api/models/providers').length).toBe(3);
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  expect(new URLSearchParams(api.matching('GET', '/api/models/providers').at(-1)?.search).get('after_id')).toBe(
    'anthropic',
  );

  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  expect(new URLSearchParams(api.matching('GET', '/api/models/providers').at(-1)?.search).has('after_id')).toBe(false);

  await page.getByPlaceholder('Search this page…').fill('no matching model');
  await expect(page.getByText('No providers match your filters')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
});
