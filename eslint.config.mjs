import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['web-ext-artifacts/**', 'node_modules/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['content.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, chrome: 'readonly' },
    },
  },
  {
    files: ['score-server.js'],
    languageOptions: {
      sourceType: 'script',
      // `crypto` is added by globals.node (Web Crypto), but score-server.js
      // imports the node:crypto module under the same name; turn it off so
      // the require() doesn't trip no-redeclare.
      globals: { ...globals.node, crypto: 'off' },
    },
  },
];
