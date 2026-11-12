import { afterEach, expect, test } from 'bun:test';
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
