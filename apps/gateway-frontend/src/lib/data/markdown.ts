import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });

// Previews should not fetch external images embedded in stored messages.
markdown.disable('image');
markdown.validateLink = (url) => /^(https?:|mailto:)/i.test(url);
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index]?.attrSet('target', '_blank');
  tokens[index]?.attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};

export function renderMarkdown(text: string): string {
  return markdown.render(text);
}
