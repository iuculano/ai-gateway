import { afterEach, expect, spyOn, test } from 'bun:test';
import * as dns from 'node:dns/promises';
import { assertPublicUrl, BlockedUrlError, publicFetch } from '../../src/public-fetch';

afterEach(() => {
  delete process.env.ALLOW_PRIVATE_NETWORK_URLS;
});

const blocked = [
  'http://127.0.0.1:8123/',
  'http://localhost:10428/insert',
  'http://10.0.0.5/',
  'http://172.20.0.3:8123/?query=x',
  'http://192.168.1.1/',
  'http://169.254.169.254/latest/meta-data',
  'http://100.64.0.1/',
  'http://0.0.0.0/',
  'http://[::]/',
  // Other spellings of 127.0.0.1.
  'http://2130706433/',
  'http://0x7f.1/',
  'http://[::1]/',
  'http://[::ffff:127.0.0.1]/',
  'http://[fd00::1]/',
  'http://[fe80::1]/',
  // NAT64 wrapping of 169.254.169.254.
  'http://[64:ff9b::a9fe:a9fe]/',
  'file:///etc/passwd',
  'http://no-such-host.invalid/',
];

for (const url of blocked) {
  test(`refuses ${url}`, async () => {
    await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(BlockedUrlError);
  });
}

test('allows a public address', async () => {
  await assertPublicUrl('https://8.8.8.8/v1');
  await assertPublicUrl('https://[2001:4860:4860::8888]/v1');
});

test('ALLOW_PRIVATE_NETWORK_URLS turns the check off', async () => {
  process.env.ALLOW_PRIVATE_NETWORK_URLS = 'true';
  await assertPublicUrl('http://127.0.0.1:8123/');
});

test('publicFetch refuses before connecting, and returns a redirect instead of following it', async () => {
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      hits++;
      return new URL(request.url).pathname === '/redirect'
        ? Response.redirect('http://169.254.169.254/latest/meta-data', 302)
        : new Response('followed');
    },
  });

  await expect(publicFetch(`http://127.0.0.1:${server.port}/`)).rejects.toBeInstanceOf(BlockedUrlError);
  expect(hits).toBe(0);

  process.env.ALLOW_PRIVATE_NETWORK_URLS = 'true';
  const response = await publicFetch(`http://127.0.0.1:${server.port}/redirect`);
  expect(response.status).toBe(302);
  server.stop(true);
});

// A host that answers with a public address when checked, then a private one.
function rebindingLookup() {
  let calls = 0;
  const lookup = spyOn(dns, 'lookup').mockImplementation((async () => {
    calls++;
    return [{ address: calls === 1 ? '203.0.113.10' : '127.0.0.1', family: 4 }];
  }) as never);
  return { lookup, calls: () => calls };
}

test('publicFetch connects to the address it checked, so a second lookup cannot change it', async () => {
  const dnsStub = rebindingLookup();
  const sent = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

  try {
    await publicFetch('https://provider.test/v1/chat/completions?x=1', {
      method: 'POST',
      headers: { authorization: 'Bearer k' },
      body: '{}',
    });

    expect(dnsStub.calls()).toBe(1);
    const [url, init] = sent.mock.calls[0] as [URL, RequestInit & { tls?: { serverName?: string } }];
    expect(String(url)).toBe('https://203.0.113.10/v1/chat/completions?x=1');
    expect(new Headers(init.headers).get('host')).toBe('provider.test');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer k');
    expect(init.tls?.serverName).toBe('provider.test');
    expect(init).toMatchObject({ method: 'POST', body: '{}', redirect: 'manual' });
  } finally {
    sent.mockRestore();
    dnsStub.lookup.mockRestore();
  }
});

test('publicFetch keeps the port in Host, and plain http gets no TLS options', async () => {
  const dnsStub = rebindingLookup();
  const sent = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

  try {
    await publicFetch('http://provider.test:8080/hook');

    const [url, init] = sent.mock.calls[0] as [URL, RequestInit & { tls?: unknown }];
    expect(String(url)).toBe('http://203.0.113.10:8080/hook');
    expect(new Headers(init.headers).get('host')).toBe('provider.test:8080');
    expect(init.tls).toBeUndefined();
  } finally {
    sent.mockRestore();
    dnsStub.lookup.mockRestore();
  }
});

test('publicFetch prefers an IPv4 address, whatever order DNS returns them in', async () => {
  const lookup = spyOn(dns, 'lookup').mockResolvedValue([
    { address: '2001:db8::10', family: 6 },
    { address: '203.0.113.10', family: 4 },
  ] as never);
  const sent = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

  try {
    await publicFetch('https://provider.test/');
    expect(String(sent.mock.calls[0]?.[0])).toBe('https://203.0.113.10/');
  } finally {
    sent.mockRestore();
    lookup.mockRestore();
  }
});
