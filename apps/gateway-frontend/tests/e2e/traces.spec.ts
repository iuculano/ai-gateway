import type { Locator, Page } from '@playwright/test';
import { expect, test } from './api-mock';
import { FAILED_TRACE, FAILED_TRACE_DETAIL, LOG_META, TRACE, TRACE_DETAIL, TRACE_IDS } from './fixtures';

test.beforeEach(({ api }) => {
  api.get('/api/traces', { json: { data: [TRACE, FAILED_TRACE], meta: LOG_META } });
  api.get(`/api/traces/${TRACE_IDS.workflow}`, { json: TRACE_DETAIL });
  api.get(`/api/traces/${TRACE_IDS.failed}`, { json: FAILED_TRACE_DETAIL });
});

function traceList(page: Page): Locator {
  return page.getByRole('region', { name: 'Trace list' });
}

function traceDetail(page: Page): Locator {
  return page.getByRole('region', { name: 'Trace detail' });
}

test('the newest run opens on arrival, with spans and the gateway call in one waterfall', async ({ page }) => {
  const detail = traceDetail(page);

  await page.goto('/traces');

  await expect(detail.getByRole('heading', { name: 'checkout-recovery-agent' })).toBeVisible();
  await expect(detail.getByText(TRACE_IDS.workflow, { exact: true })).toBeVisible();

  // The gateway's log sits among the application spans without being counted as
  // one of them.
  await expect(detail.getByRole('button', { name: /gateway · gpt-5-mini/ })).toBeVisible();
  await expect(detail.getByText('2 application spans', { exact: true })).toBeVisible();
});

test('selecting a node shows what that record knows', async ({ page }) => {
  const detail = traceDetail(page);
  await page.goto('/traces');

  await detail.getByRole('button', { name: /gateway · gpt-5-mini/ }).click();

  await expect(detail.getByText(TRACE_IDS.gatewaySpan, { exact: true })).toBeVisible();
  await expect(detail.getByText('1,480 in · 312 out', { exact: true })).toBeVisible();
  await expect(detail.getByRole('link', { name: 'Open gateway log' })).toBeVisible();
});

test('selecting another run loads its own waterfall', async ({ page }) => {
  const detail = traceDetail(page);
  const gatewayCall = detail.getByRole('button', { name: /gateway · gpt-5-mini/ });
  await page.goto('/traces');
  await expect(gatewayCall).toBeVisible();

  await traceList(page)
    .getByRole('button', { name: /customer-support-escalation/ })
    .click();

  await expect(detail.getByRole('heading', { name: 'customer-support-escalation' })).toBeVisible();
  await expect(detail.getByText('Partial detail', { exact: true })).toBeVisible();
  await expect(gatewayCall).toBeHidden();
});

test('a link to a trace opens that run, even one too old to be listed', async ({ page, api }) => {
  api.get('/api/traces', { json: { data: [TRACE], meta: LOG_META } });

  await page.goto(`/traces?trace=${TRACE_IDS.failed}`);

  await expect(traceDetail(page).getByRole('heading', { name: 'customer-support-escalation' })).toBeVisible();
});

test('the waterfall follows the keyboard', async ({ page }) => {
  const detail = traceDetail(page);
  const workflow = detail.getByRole('button', { name: /checkout-recovery-agent/ });
  const llmCall = detail.getByRole('button', { name: /streamText · diagnose checkout/ });
  const gatewayCall = detail.getByRole('button', { name: /gateway · gpt-5-mini/ });
  await page.goto('/traces');

  await workflow.focus();
  await page.keyboard.press('ArrowDown');
  await expect(llmCall).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('ArrowDown');
  await expect(gatewayCall).toHaveAttribute('aria-pressed', 'true');

  // Selection follows focus, so the panel already describes the row the
  // keyboard is on.
  await expect(detail.getByText(TRACE_IDS.gatewaySpan, { exact: true })).toBeVisible();

  await page.keyboard.press('Home');
  await expect(workflow).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('End');
  await expect(gatewayCall).toHaveAttribute('aria-pressed', 'true');
});

test('the Errors tab narrows the list without closing the open run', async ({ page }) => {
  const list = traceList(page);
  const detail = traceDetail(page);
  await page.goto('/traces');
  await expect(list.getByText('checkout-recovery-agent')).toBeVisible();

  await page.getByRole('button', { name: 'Errors', exact: true }).click();

  await expect(list.getByText('customer-support-escalation')).toBeVisible();
  await expect(list.getByText('checkout-recovery-agent')).toBeHidden();
  await expect(list.getByText('1 of 2 on this page', { exact: true })).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'checkout-recovery-agent' })).toBeVisible();
});
