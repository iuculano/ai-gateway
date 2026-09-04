import { expect, test } from './api-mock';
import {
  FAILED_TRACE,
  FAILED_TRACE_DETAIL,
  LOG_META,
  registerEmptyApp,
  TRACE,
  TRACE_DETAIL,
  TRACE_IDS,
} from './fixtures';

test('a run is opened from the list and read down its waterfall', async ({ page, api }) => {
  registerEmptyApp(api);
  api.get('/api/traces', { json: { data: [TRACE, FAILED_TRACE], meta: LOG_META } });
  api.get(`/api/traces/${TRACE_IDS.workflow}`, { json: TRACE_DETAIL });
  api.get(`/api/traces/${TRACE_IDS.failed}`, { json: FAILED_TRACE_DETAIL });

  await page.goto('/traces');

  // The newest run opens on arrival, so the waterfall is never empty.
  await expect(page.getByRole('heading', { name: 'checkout-recovery-agent' })).toBeVisible();
  await expect(page.getByText(TRACE_IDS.workflow, { exact: true })).toBeVisible();

  // Spans and the gateway log correlated to them are one list, indented by the
  // depth the backend resolved.
  const gatewayRow = page.getByRole('button', { name: /gateway · gpt-5-mini/ });
  await expect(gatewayRow).toBeVisible();
  await expect(gatewayRow.locator('div').first()).toHaveCSS('padding-left', '28px');
  await expect(page.getByText('1 application spans', { exact: false })).toBeHidden();
  await expect(page.getByText('2 application spans', { exact: true })).toBeVisible();

  // Clicking a node shows what that record knows, whichever table it came from.
  await gatewayRow.click();
  await expect(page.getByText(TRACE_IDS.gatewaySpan, { exact: true })).toBeVisible();
  await expect(page.getByText('1,480 in · 312 out', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open gateway log' })).toBeVisible();

  // Selecting the other run loads its detail rather than reusing this one.
  await page
    .getByRole('button', { name: /customer-support-escalation/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'customer-support-escalation' })).toBeVisible();
  await expect(page.getByText('Partial detail', { exact: true })).toBeVisible();
  await expect(page.getByText('gateway · gpt-5-mini')).toBeHidden();

  // The waterfall is navigable without a mouse, and selection follows focus so
  // the detail panel and the map track the keyboard rather than needing a
  // second keystroke to commit.
  await page
    .getByRole('button', { name: /customer-support-escalation/ })
    .first()
    .click();
  await page
    .getByRole('button', { name: /checkout-recovery-agent/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'checkout-recovery-agent' })).toBeVisible();

  const rows = page.locator('section[aria-label="Trace detail"] div.overflow-y-auto > button');
  const selected = () =>
    page
      .locator('section[aria-label="Trace detail"] >> text=Selected node')
      .locator('xpath=following-sibling::span[1]')
      .innerText();

  await rows.first().focus();
  await expect.poll(selected).toBe('checkout-recovery-agent');

  await page.keyboard.press('ArrowDown');
  await expect.poll(selected).toBe('streamText · diagnose checkout');

  await page.keyboard.press('ArrowDown');
  await expect.poll(selected).toBe('gateway · gpt-5-mini');

  await page.keyboard.press('ArrowUp');
  await expect.poll(selected).toBe('streamText · diagnose checkout');

  await page.keyboard.press('End');
  await expect.poll(selected).toBe('gateway · gpt-5-mini');

  // The map is shown by default and marks exactly the selected node. Addressed
  // by its own role and label, because the page is full of icons that are also
  // svg rects.
  const map = page.getByRole('img', { name: /^Overview of/ });
  await expect(map).toBeVisible();
  await expect(map.locator('rect[stroke="#fafafa"]')).toHaveCount(1);

  // And it can be put away and brought back.
  const toggle = page.getByRole('button', { name: 'Toggle Map' });
  await toggle.click();
  await expect(map).toHaveCount(0);
  await toggle.click();
  await expect(map).toBeVisible();

  // The tabs filter the page in view.
  await page.getByRole('button', { name: 'Errors', exact: true }).click();

  // Scoped to the list: the filter narrows what is listed, and says nothing
  // about the run still open in the detail panel beside it.
  await expect(page.locator('section[aria-label="Trace list"]').getByText('checkout-recovery-agent')).toBeHidden();
  await expect(page.getByText('1 of 2 on this page', { exact: true })).toBeVisible();
});
