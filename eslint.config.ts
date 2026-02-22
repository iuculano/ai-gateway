import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';


export default defineConfig([
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/.vite/**',
    ]
  },

  // Base rules
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Frontend rules
  {
    files: ['apps/gateway-frontend/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },

  // Backend & packagefs rules
  {
    files: [
      'apps/gateway-api/**/*.ts',
      'apps/worker-*/**/*.ts',
      'packages/**/*.ts'
    ],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  }
]);
