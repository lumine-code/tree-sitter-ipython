const js = require('@eslint/js');
const globals = require('globals');
const eslintConfigPrettier = require('eslint-config-prettier');

module.exports = [
  {
    ignores: ['build/**', 'node_modules/**', 'src/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        grammar: 'readonly',
        seq: 'readonly',
        choice: 'readonly',
        repeat: 'readonly',
        repeat1: 'readonly',
        optional: 'readonly',
        field: 'readonly',
        prec: 'readonly',
        token: 'readonly',
        alias: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-useless-escape': 'off',
    },
  },
  eslintConfigPrettier,
];
