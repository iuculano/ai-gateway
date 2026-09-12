import { expect, test } from 'bun:test';
import { renderMarkdown } from '../../src/lib/data/markdown';

test('renders message formatting and tables', () => {
  const html = renderMarkdown('# Heading\n\n**bold** and `code`\n\n- item\n\n| A | B |\n|---|---|\n| 1 | 2 |');
  for (const tag of ['<h1>', '<strong>', '<code>', '<ul>', '<table>']) expect(html).toContain(tag);
});

test('escapes raw HTML and fenced code', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n```html\n<img src=x onerror=alert(1)>\n```');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('<pre><code');
});

test('blocks unsafe and relative links', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', '/auth/logout', 'file:///tmp/test']) {
    expect(renderMarkdown(`[link](${url})`)).not.toContain('<a ');
  }
  expect(renderMarkdown('[docs](https://example.com)')).toContain('rel="noopener noreferrer"');
});

test('does not load embedded images', () => {
  expect(renderMarkdown('![image](https://example.com/tracker.png)')).not.toContain('<img');
});
