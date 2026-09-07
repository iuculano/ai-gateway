import type { Webhook } from '../../src/lib/api/types';
import { expect, test } from './api-mock';
import { PAGE_META, registerEmptyApp } from './fixtures';

for (const description of ['', '   ', '  Updated description  ']) {
  test(`webhook description updates persist: ${JSON.stringify(description)}`, async ({ page, api }) => {
    registerEmptyApp(api);
    let webhook: Webhook = {
      id: '0198f100-0000-7000-8000-000000000009',
      name: 'Billing webhook',
      description: 'Original description',
      endpoint: 'https://example.com/webhook',
      filter: {},
      tags: {},
      created_at: '2026-08-20T14:00:00.000Z',
      updated_at: '2026-08-20T14:00:00.000Z',
    };
    const path = `/api/webhooks/${webhook.id}`;
    api.get('/api/webhooks', () => ({ json: { data: [webhook], meta: PAGE_META } }));
    api.on('PATCH', path, (request) => {
      // Omitted fields preserve existing values, as they do in the real PATCH endpoint.
      webhook = { ...webhook, ...(request.body as Partial<Webhook>) };
      return { json: webhook };
    });

    await page.goto('/webhooks');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(/Description/)).toHaveValue('Original description');
    await dialog.getByLabel(/Description/).fill(description);
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(dialog).toBeHidden();
    const calls = api.matching('PATCH', path);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toHaveProperty('description', description.trim() || null);

    await page.reload();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(dialog.getByLabel(/Description/)).toHaveValue(description.trim());
  });
}
