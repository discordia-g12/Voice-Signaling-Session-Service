const tseslint = require('typescript-eslint');
const security = require('eslint-plugin-security');
const globals = require('globals');

module.exports = tseslint.config(
  tseslint.configs.recommended,
  security.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    ignores: ['coverage/', 'dist/', 'node_modules/', 'eslint.config.js'],
  },
);
