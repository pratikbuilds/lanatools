import { tanstackConfig } from '@tanstack/eslint-config'

export default [
  {
    ignores: [
      '**/dist/**',
      '**/.wrangler/**',
      '**/routeTree.gen.ts',
      '**/worker-configuration.d.ts',
      '.playwright-mcp/**',
      'playwright-report/**',
      'test-results/**',
      '**/*.config.js',
      // Hand-written dashboard mocks, outside every tsconfig.
      'docs/design/**',
    ],
  },
  ...tanstackConfig,
  {
    rules: {
      'import/no-cycle': 'off',
      'import/order': 'off',
      'sort-imports': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/require-await': 'off',
      'pnpm/json-enforce-catalog': 'off',
    },
  },
]
