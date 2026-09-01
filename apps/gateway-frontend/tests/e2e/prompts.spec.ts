import { expect, test } from './api-mock';
import { IDS, PAGE_META, PROMPT, PROMPT_VERSION, registerEmptyApp } from './fixtures';

test('a prompt can be created, versioned, and rendered with an input', async ({ page, api }) => {
  registerEmptyApp(api);
  api.post('/api/prompts', { status: 201, json: PROMPT });
  api.get(`/api/prompts/${IDS.prompt}/versions`, { json: { data: [], meta: PAGE_META } });
  api.post(`/api/prompts/${IDS.prompt}/versions`, { status: 201, json: PROMPT_VERSION });
  api.get(`/api/prompts/${IDS.prompt}/versions/1`, { json: PROMPT_VERSION });
  api.post(`/api/prompts/${IDS.prompt}/versions/1/render`, (request) => {
    const inputs = (request.body as { inputs?: Record<string, string> }).inputs ?? {};
    const customer = inputs.customer_name;

    return {
      json: customer
        ? { prompt: `Help ${customer} with their support request.`, unresolved: [] }
        : { prompt: PROMPT_VERSION.prompt, unresolved: ['customer_name'] },
    };
  });

  await page.goto('/prompts');
  await page.getByRole('button', { name: 'Create prompt' }).click();

  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(PROMPT.name);
  await dialog.getByLabel(/Description/).fill(PROMPT.description ?? '');
  await dialog.getByRole('button', { name: 'Create prompt' }).click();

  await expect(page.getByText(PROMPT.name, { exact: true })).toBeVisible();
  await expect(page.getByText('Unversioned', { exact: true }).first()).toBeVisible();
  await page.getByText(PROMPT.name, { exact: true }).click();
  await expect(page.getByText('No versions yet')).toBeVisible();

  await page.getByRole('button', { name: 'New version' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Template').fill(PROMPT_VERSION.prompt);
  await dialog.getByRole('button', { name: 'Create version' }).click();

  await expect(page.getByText('Version 1 created')).toBeVisible();
  await expect(page.getByText('active', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();

  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /Preview support-triage/ })).toBeVisible();
  await dialog.getByLabel('customer_name').fill('Ada');
  await expect(dialog.getByText('Help Ada with their support request.', { exact: true })).toBeVisible();

  const createPrompt = api.matching('POST', '/api/prompts');
  expect(createPrompt).toHaveLength(1);
  expect(createPrompt[0]?.body).toMatchObject({ name: PROMPT.name, description: PROMPT.description });

  const createVersion = api.matching('POST', `/api/prompts/${IDS.prompt}/versions`);
  expect(createVersion).toHaveLength(1);
  expect(createVersion[0]?.body).toEqual({ prompt: PROMPT_VERSION.prompt });
});
