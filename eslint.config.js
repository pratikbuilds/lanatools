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
      // Git-ignored local media work, outside every tsconfig.
      'output/**',
      // Local agent worktrees: whole copies of this repository.
      '.claude/worktrees/**',
    ],
  },
  ...tanstackConfig,
  {
    languageOptions: {
      parserOptions: {
        // One shared TypeScript service instead of a program per tsconfig,
        // which ran CI out of memory.
        project: false,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
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
