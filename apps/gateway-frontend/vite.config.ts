import adapter from '@sveltejs/adapter-bun';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 8081,
  },
  preview: {
    port: 8081,
  },

  plugins: [
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Runes mode for the project and not for libraries. It can go once
        // Svelte 6 makes it the only mode.
        runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
      },

      // Off by default in this adapter, on in the one it replaced.
      adapter: adapter({ precompress: true }),

      // Everything the app loads is its own, so nothing from another site may
      // run in it or frame it. SvelteKit adds a nonce for the scripts it
      // inlines itself. Styles keep 'unsafe-inline', because Svelte sets
      // inline styles on elements.
      csp: {
        directives: {
          'default-src': ['self'],
          'script-src': ['self'],
          'style-src': ['self', 'unsafe-inline'],
          'img-src': ['self', 'data:'],
          'object-src': ['none'],
          'base-uri': ['self'],
          'frame-ancestors': ['none'],
        },
      },
    }),
  ],
});
