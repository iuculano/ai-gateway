import { expect, test } from './api-mock';
import { FAILED_LOG, IDS, LOG_META, registerEmptyApp, SUCCESS_LOG, TRACE_IDS } from './fixtures';

test('a stored request can be inspected and replayed in the playground', async ({ page, api }) => {
  registerEmptyApp(api);
  api.get('/api/logs', { json: { data: [SUCCESS_LOG, FAILED_LOG], meta: LOG_META } });
  api.get(`/api/logs/${IDS.successLog}/request`, {
    json: {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Investigate this production incident.' }],
      temperature: 0.2,
    },
  });
  api.get(`/api/logs/${IDS.successLog}/response`, {
    json: {
      model: 'gpt-5-2026-08-01',
      choices: [
        {
          message: { role: 'assistant', content: 'Recovered answer.', refusal: null },
          finish_reason: 'stop',
        },
      ],
    },
  });

  await page.goto('/logs');
  await expect(page.getByText(SUCCESS_LOG.model, { exact: true })).toBeVisible();
  await expect(page.getByText(FAILED_LOG.model, { exact: true })).toBeVisible();

  // A correlated request shows its trace and links back to the run; an
  // uncorrelated one says so rather than linking nowhere.
  const trace = page.getByRole('link', { name: `Open trace ${TRACE_IDS.workflow}` }).first();
  await expect(trace).toHaveAttribute('href', `/traces?trace=${TRACE_IDS.workflow}`);
  await expect(trace).toHaveText(TRACE_IDS.workflow.slice(0, 8));

  await page.getByRole('button', { name: 'Errors' }).click();
  await expect(page.getByText(FAILED_LOG.model, { exact: true })).toBeVisible();
  await expect(page.getByText(SUCCESS_LOG.model, { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'All', exact: true }).click();

  await page.getByText(SUCCESS_LOG.model, { exact: true }).click();
  await expect(page.getByText('Investigate this production incident.', { exact: true })).toBeVisible();
  await expect(page.getByText('Recovered answer.', { exact: true })).toBeVisible();
  await expect(page.getByText('gpt-5-2026-08-01', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Replay in playground' }).click();
  await expect(page).toHaveURL(`/playground?from=${IDS.successLog}`);
  await expect(page.getByPlaceholder('What do you want to ask?')).toHaveValue('Investigate this production incident.');
  await expect(page.locator('#playground-model-0')).toHaveValue('gpt-5');
  await expect(page.getByText('Loaded the request from that log')).toBeVisible();
});
