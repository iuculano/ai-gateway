import { test as base, expect, type Page } from '@playwright/test';

export interface RecordedApiRequest {
  method: string;
  pathname: string;
  search: string;
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

    await this.#page.route('**/api/**', async (route) => {
      const browserRequest = route.request();
      const url = new URL(browserRequest.url());
      let body: unknown;

      try {
        body = browserRequest.postDataJSON();
      } catch {
        body = browserRequest.postData();
      }

      const request: RecordedApiRequest = {
        method: browserRequest.method(),
        pathname: url.pathname,
        search: url.search,
        headers: browserRequest.headers(),
        body: body,
      };
      this.calls.push(request);

      const registration = this.#registrations.find(
        (candidate) =>
          candidate.method === request.method &&
          (typeof candidate.path === 'string'
            ? candidate.path === request.pathname
            : candidate.path.test(request.pathname)),
      );

      if (!registration) {
        const label = `${request.method} ${request.pathname}${request.search}`;
        this.unhandled.push(label);
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 500, message: `Unhandled Playwright API request: ${label}` } }),
        });
        return;
      }

      const response =
        typeof registration.handler === 'function' ? await registration.handler(request) : registration.handler;
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
    });
  }

  on(method: string, path: PathMatcher, handler: MockApiHandler): void {
    // Most-recent registration wins, which lets a test replace one of the
    // shared empty responses without reconstructing the entire app fixture.
    this.#registrations.unshift({ method: method.toUpperCase(), path, handler });
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
}

export const test = base.extend<{ api: ApiMock }>({
  api: async ({ page }, use) => {
    const api = new ApiMock(page);
    await api.install();
    await use(api);

    expect.soft(api.unhandled, 'every browser API request should have an explicit mock').toEqual([]);
    expect.soft(api.pageErrors, 'the page should not raise uncaught browser errors').toEqual([]);
  },
});

export { expect } from '@playwright/test';
