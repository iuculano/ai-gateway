import type { Page } from '@playwright/test';
import { expect, test } from './api-mock';
import { IDS, PAGE_META, PROMPT, PROMPT_VERSION } from './fixtures';

const PROMPTS = '/api/prompts';
const VERSIONS = `/api/prompts/${IDS.prompt}/versions`;
const VERSION = `${VERSIONS}/1`;

const VERSIONED_PROMPT = { ...PROMPT, active_version: 1 };

async function pickPrompt(page: Page): Promise<void> {
  await page.goto('/playground');

  // The webhook picker also starts at None, and the prompt picker comes after
  // it.
  await page.getByRole('button', { name: 'None', exact: true }).last().click();
  await page.getByRole('option', { name: new RegExp(PROMPT.name) }).click();
}

// Managing prompts

test('a created prompt is listed as unversioned', async ({ page, api }) => {
  let created = false;
  api.get(PROMPTS, () => ({ json: { data: created ? [PROMPT] : [], meta: PAGE_META } }));
  api.get(VERSIONS, { json: { data: [], meta: PAGE_META } });
  api.post(PROMPTS, () => {
    created = true;

    return { status: 201, json: PROMPT };
  });

  await page.goto('/prompts');
  await page.getByRole('button', { name: 'Create prompt' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(PROMPT.name);
  await dialog.getByLabel(/Description/).fill(PROMPT.description ?? '');
  await dialog.getByRole('button', { name: 'Create prompt' }).click();

  await expect(page.getByText(PROMPT.name, { exact: true })).toBeVisible();
  await expect(page.getByText('Unversioned', { exact: true }).first()).toBeVisible();
  expect(api.matching('POST', PROMPTS)).toHaveLength(1);
  expect(api.matching('POST', PROMPTS)[0]?.body).toMatchObject({ name: PROMPT.name, description: PROMPT.description });

  await page.getByText(PROMPT.name, { exact: true }).click();

  await expect(page.getByText('No versions yet')).toBeVisible();
});

test('the first version of a prompt becomes its active one', async ({ page, api }) => {
  let prompt = PROMPT;
  api.get(PROMPTS, () => ({ json: { data: [prompt], meta: PAGE_META } }));
  api.get(VERSIONS, { json: { data: [], meta: PAGE_META } });
  api.post(VERSIONS, () => {
    prompt = VERSIONED_PROMPT;

    return { status: 201, json: PROMPT_VERSION };
  });

  await page.goto('/prompts');
  await page.getByText(PROMPT.name, { exact: true }).click();
  await page.getByRole('button', { name: 'New version' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Template').fill(PROMPT_VERSION.prompt);
  await dialog.getByRole('button', { name: 'Create version' }).click();

  await expect(page.getByText('Version 1 created')).toBeVisible();
  await expect(page.getByText('active', { exact: true })).toBeVisible();
  expect(api.matching('POST', VERSIONS)[0]?.body).toEqual({ prompt: PROMPT_VERSION.prompt });
});

test('a preview renders the template with the inputs typed into it', async ({ page, api }) => {
  api.get(PROMPTS, { json: { data: [VERSIONED_PROMPT], meta: PAGE_META } });
  api.get(VERSIONS, { json: { data: [PROMPT_VERSION], meta: PAGE_META } });
  api.get(VERSION, { json: PROMPT_VERSION });
  api.post(`${VERSION}/render`, (request) => {
    const { inputs } = request.body as { inputs?: Record<string, string> };
    const customer = inputs?.customer_name;

    if (!customer) {
      return { json: { prompt: PROMPT_VERSION.prompt, unresolved: ['customer_name'] } };
    }

    return { json: { prompt: `Help ${customer} with their support request.`, unresolved: [] } };
  });

  await page.goto('/prompts');
  await page.getByText(PROMPT.name, { exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /Preview support-triage/ })).toBeVisible();

  await dialog.getByLabel('customer_name').fill('Ada');

  await expect(dialog.getByText('Help Ada with their support request.', { exact: true })).toBeVisible();
});

// Picking a prompt in the playground

test('a failed version list is shown as a failure and retried only when asked', async ({ page, api }) => {
  let attempts = 0;
  api.get(PROMPTS, { json: { data: [VERSIONED_PROMPT], meta: PAGE_META } });
  api.get(VERSION, { json: PROMPT_VERSION });
  api.get(VERSIONS, () => {
    attempts += 1;

    if (attempts <= 2) {
      return { status: 503, json: { error: { message: 'Versions temporarily unavailable' } } };
    }

    return { json: { data: [PROMPT_VERSION], meta: PAGE_META } };
  });
  const error = page.getByText('Versions temporarily unavailable', { exact: true });
  const retry = page.getByRole('button', { name: 'Retry versions', exact: true });

  await pickPrompt(page);

  await expect(error).toBeVisible();
  await api.settle();
  expect(attempts).toBe(1);
  expect(api.matching('GET', VERSION)).toHaveLength(0);

  await retry.click();
  await expect.poll(() => attempts).toBe(2);
  await expect(error).toBeVisible();

  await retry.click();

  await expect(error).toBeHidden();
  await expect(page.getByRole('button', { name: 'v1', exact: true })).toBeVisible();
  await expect(page.getByLabel('customer_name', { exact: true })).toBeVisible();
  expect(api.matching('GET', VERSION)).toHaveLength(1);
});

test('a prompt with no versions says the request would be refused', async ({ page, api }) => {
  let attempts = 0;
  api.get(PROMPTS, { json: { data: [PROMPT], meta: PAGE_META } });
  api.get(VERSIONS, () => {
    attempts += 1;

    if (attempts === 1) {
      return { status: 503, json: { error: { message: 'Versions temporarily unavailable' } } };
    }

    return { json: { data: [], meta: PAGE_META } };
  });
  const empty = page.getByText('This prompt has no versions, so the request would be refused.', { exact: true });

  await pickPrompt(page);

  // A list that failed to load is not the same as a prompt with nothing in it.
  await expect(page.getByText('Versions temporarily unavailable', { exact: true })).toBeVisible();
  await expect(empty).toBeHidden();

  await page.getByRole('button', { name: 'Retry versions', exact: true }).click();

  await expect(empty).toBeVisible();
  expect(api.matching('GET', VERSION)).toHaveLength(0);
});
