import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const typedProjects = [
  './tsconfig.json',
  './tsconfig.electron.json',
  './tsconfig.scripts.json',
];

const lintedFiles = [
  'src/**/*.{ts,tsx}',
  'electron/**/*.ts',
  'scripts/**/*.{ts,mts}',
  'shared/**/*.ts',
];

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-electron/**',
      'release/**',
      '.build-tmp/**',
      'build/**',
      'assets/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: lintedFiles,
    languageOptions: {
      parserOptions: {
        project: typedProjects,
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', {
        checksVoidReturn: {
          attributes: false,
        },
      }],
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: [
              'electron',
              'electron/*',
              '../electron/*',
              '../../electron/*',
              '../../../electron/*',
              '../scripts/*',
              '../../scripts/*',
              '../../../scripts/*',
              '../rust/*',
              '../../rust/*',
              '../../../rust/*',
            ],
            message: 'Renderer code must not import Electron main, scripts, or Rust implementation files.',
          },
        ],
      }],
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    files: ['electron/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: [
              '../src/app/*',
              '../src/components/*',
              '../src/context/*',
              '../src/hooks/*',
              '../src/main*',
            ],
            message: 'Electron code may depend on shared contracts only, not renderer UI layers.',
          },
        ],
      }],
    },
  },
  {
    files: ['scripts/**/*.{ts,mts}'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: [
              '../src/app/*',
              '../src/components/*',
              '../src/context/*',
              '../src/hooks/*',
            ],
            message: 'Build scripts must stay independent from renderer UI layers.',
          },
        ],
      }],
    },
  },
  {
    files: ['src/App.tsx', 'src/components/app-shell/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
);
