import { test as base, expect, type Page, type Request, type Route } from '@playwright/test';
import { registerEmptyApp } from './fixtures';

export interface RecordedApiRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockApiResponse {
  status?: number;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
}

type PathMatcher = string | RegExp;
type MockApiHandler = MockApiResponse | ((request: RecordedApiRequest) => MockApiResponse | Promise<MockApiResponse>);

interface Registration {
  method: string;
  path: PathMatcher;
  handler: MockApiHandler;
}

/**
 * The parts of a browser request that tests assert on.
 */
function record(browserRequest: Request, url: URL): RecordedApiRequest {
  let body: unknown;

  // Most bodies are JSON, and the rest are kept as the text that was sent.
  try {
    body = browserRequest.postDataJSON();
  } catch {
    body = browserRequest.postData();
  }

  return {
    method: browserRequest.method(),
    pathname: url.pathname,
    query: url.searchParams,
    headers: browserRequest.headers(),
    body: body,
  };
}

function matches(registration: Registration, request: RecordedApiRequest): boolean {
  if (registration.method !== request.method) {
    return false;
  }

  if (typeof registration.path === 'string') {
    return registration.path === request.pathname;
  }

  return registration.path.test(request.pathname);
}

export class ApiMock {
  readonly calls: RecordedApiRequest[] = [];
  readonly unhandled: string[] = [];
  readonly pageErrors: string[] = [];

  readonly #page: Page;
  readonly #registrations: Registration[] = [];

  constructor(page: Page) {
    this.#page = page;
  }

  async install(): Promise<void> {
    this.#page.on('pageerror', (error) => this.pageErrors.push(error.message));

    await this.#page.route('**/api/**', (route) => this.#answer(route));
  }

  async #answer(route: Route): Promise<void> {
    const browserRequest = route.request();
    const url = new URL(browserRequest.url());

    // The glob is only a prefilter. It also matches things like
    // /src/lib/api/traces.ts, which a dev server serves as a real module -
    // answering those with the unhandled-request stub below breaks the page
    // rather than testing it. Only the BFF's own /api/ prefix is ours.
    if (!url.pathname.startsWith('/api/')) {
      await route.fallback();

      return;
    }

    const request = record(browserRequest, url);
    this.calls.push(request);

    const registration = this.#registrations.find((candidate) => matches(candidate, request));

    if (!registration) {
      const label = `${request.method} ${request.pathname}${url.search}`;
      const error = { code: 500, message: `Unhandled Playwright API request: ${label}` };
      this.unhandled.push(label);

      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: error }) });

      return;
    }

    const handler = registration.handler;
    const response = typeof handler === 'function' ? await handler(request) : handler;
    const status = response.status ?? 200;

    if (response.json !== undefined) {
      await route.fulfill({
        status: status,
        contentType: 'application/json',
        headers: response.headers,
        body: JSON.stringify(response.json),
      });

      return;
    }

    await route.fulfill({
      status: status,
      headers: response.headers,
      body: response.body ?? '',
    });
  }

  on(method: string, path: PathMatcher, handler: MockApiHandler): void {
    // Most-recent registration wins, which lets a test replace one of the
    // shared empty responses without reconstructing the entire app fixture.
    this.#registrations.unshift({ method: method.toUpperCase(), path: path, handler: handler });
  }

  get(path: PathMatcher, handler: MockApiHandler): void {
    this.on('GET', path, handler);
  }

  post(path: PathMatcher, handler: MockApiHandler): void {
    this.on('POST', path, handler);
  }

  delete(path: PathMatcher, handler: MockApiHandler = { status: 204 }): void {
    this.on('DELETE', path, handler);
  }

  matching(method: string, pathname: string): RecordedApiRequest[] {
    return this.calls.filter((call) => call.method === method.toUpperCase() && call.pathname === pathname);
  }

  /**
   * Gives a runaway retry loop time to show itself in `calls`.
   */
  async settle(): Promise<void> {
    // A request that should not happen cannot be awaited, so this is a fixed
    // wait.
    await this.#page.waitForTimeout(500);
  }
}

export const test = base.extend<{ api: ApiMock }>({
  // Automatic, so every page is mocked whether or not the test asks for `api`.
  api: [
    async ({ page }, use) => {
      const api = new ApiMock(page);
      await api.install();

      // Every page loads with no data. A test replaces only what it cares
      // about.
      registerEmptyApp(api);
      await use(api);

      expect.soft(api.unhandled, 'every browser API request should have an explicit mock').toEqual([]);
      expect.soft(api.pageErrors, 'the page should not raise uncaught browser errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
