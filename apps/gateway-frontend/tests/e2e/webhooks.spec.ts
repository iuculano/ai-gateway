import type { Webhook } from '../../src/lib/api/types';
import { expect, test } from './api-mock';
import { PAGE_META, WEBHOOK } from './fixtures';

const WEBHOOKS = '/api/webhooks';
const WEBHOOK_PATH = `/api/webhooks/${WEBHOOK.id}`;

// What is typed into the description field, and what should reach the backend
// for it.
const DESCRIPTIONS = [
  { typed: '', stored: null },
  { typed: '   ', stored: null },
  { typed: '  Updated description  ', stored: 'Updated description' },
];

test('a webhook can be created', async ({ page, api }) => {
  api.post(WEBHOOKS, { status: 201, json: WEBHOOK });

  await page.goto('/webhooks');
  await page.getByRole('button', { name: 'Create webhook', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(`  ${WEBHOOK.name}  `);
  await dialog.getByLabel(/Endpoint/).fill(WEBHOOK.endpoint);
  await dialog.getByRole('button', { name: 'Create webhook', exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText(WEBHOOK.name, { exact: true })).toBeVisible();
  expect(api.matching('POST', WEBHOOKS)[0]?.body).toEqual({ name: WEBHOOK.name, endpoint: WEBHOOK.endpoint });
});

test('an endpoint that is not a URL is refused before anything is sent', async ({ page, api }) => {
  // The API stores whatever string it is given, so a typo would only surface as
  // failed deliveries.
  await page.goto('/webhooks');
  await page.getByRole('button', { name: 'Create webhook', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(WEBHOOK.name);
  await dialog.getByLabel(/Endpoint/).fill('example.com/hooks/relay');

  await dialog.getByRole('button', { name: 'Create webhook', exact: true }).click();

  await expect(page.getByText('Enter a full URL, including https://.', { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(api.matching('POST', WEBHOOKS)).toHaveLength(0);
});

test('a webhook is deleted only after confirming', async ({ page, api }) => {
  api.get(WEBHOOKS, { json: { data: [WEBHOOK], meta: PAGE_META } });
  api.delete(WEBHOOK_PATH);

  await page.goto('/webhooks');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Delete this webhook?' })).toBeVisible();
  expect(api.matching('DELETE', WEBHOOK_PATH)).toHaveLength(0);

  await dialog.getByRole('button', { name: 'Delete webhook', exact: true }).click();

  await expect(page.getByText('No webhooks yet')).toBeVisible();
  expect(api.matching('DELETE', WEBHOOK_PATH)).toHaveLength(1);
});

for (const { typed, stored } of DESCRIPTIONS) {
  test(`a description typed as ${JSON.stringify(typed)} is stored as ${JSON.stringify(stored)}`, async ({
    page,
    api,
  }) => {
    let webhook = WEBHOOK;
    api.get(WEBHOOKS, () => ({ json: { data: [webhook], meta: PAGE_META } }));
    api.on('PATCH', WEBHOOK_PATH, (request) => {
      // Like the real endpoint, fields left out of the body keep their values.
      webhook = { ...webhook, ...(request.body as Partial<Webhook>) };

      return { json: webhook };
    });
    const dialog = page.getByRole('dialog');
    const description = dialog.getByLabel(/Description/);

    await page.goto('/webhooks');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(description).toHaveValue('Original description');
    await description.fill(typed);
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();

    await expect(dialog).toBeHidden();
    expect(api.matching('PATCH', WEBHOOK_PATH)).toHaveLength(1);
    expect(api.matching('PATCH', WEBHOOK_PATH)[0]?.body).toHaveProperty('description', stored);

    // A reload shows what was stored rather than what the form still
    // remembered.
    await page.reload();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();

    await expect(description).toHaveValue(stored ?? '');
  });
}
