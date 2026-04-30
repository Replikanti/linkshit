import js from '@eslint/js';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';

export default [
  {
    ignores: ['web-ext-artifacts/**', 'node_modules/**', 'dist/**'],
  },
  js.configs.recommended,
  {
    plugins: { unicorn },
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
      // Targeted unicorn rules that catch the SonarQube findings as we go,
      // so the same code smells don't return.
      'radix': 'error',
      'unicorn/prefer-node-protocol': 'error',
      'unicorn/prefer-number-properties': 'error',
      'unicorn/prefer-string-replace-all': 'error',
      'unicorn/prefer-math-trunc': 'error',
      'unicorn/prefer-dom-node-dataset': 'error',
      'unicorn/prefer-dom-node-append': 'error',
      'unicorn/prefer-modern-dom-apis': 'error',
      'unicorn/prefer-spread': 'error',
    },
  },
  {
    files: ['content.js', 'background.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        chrome: 'readonly',
      },
    },
  },
  {
    files: ['score-server.js', 'host.js'],
    languageOptions: {
      sourceType: 'script',
      // `crypto` is added by globals.node (Web Crypto), but these files
      // import the node:crypto module under the same name; turn it off so
      // the require() doesn't trip no-redeclare.
      globals: { ...globals.node, crypto: 'off' },
    },
  },
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: globals.node,
    },
  },
];
