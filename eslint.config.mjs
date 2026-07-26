import nextPlugin from '@next/eslint-plugin-next';
import js from '@eslint/js';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * One flat config for the whole monorepo — apps *and* packages — so a rule
 * can't be enforced in the POS but silently skipped in a shared package.
 *
 * Deliberately runs the non-type-checked preset: it needs no per-package
 * `project` wiring and stays fast enough to run on every commit. `tsc
 * --noEmit` already covers type correctness via `pnpm typecheck`.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      // Generated or vendored assets that aren't ours to style.
      'apps/pos/resources/**',
      'apps/web/public/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    /**
     * Registered everywhere, not just where their rules run. The source
     * already carries `eslint-disable-next-line` comments for these rules
     * (they were written against a lint setup whose plugins were never
     * actually installed), and ESLint errors on a disable comment naming a
     * rule it cannot resolve — so the plugins must at least be *defined* in
     * every file that references them, e.g. packages/ui/src/ImagePicker.tsx.
     */
    plugins: {
      '@next/next': nextPlugin,
      'jsx-a11y': jsxA11y,
      'react-hooks': reactHooks,
    },
  },

  {
    files: ['**/*.{jsx,tsx}'],
    rules: {
      /**
       * A deliberately narrow slice of these plugins: the rules this codebase
       * was actually written against (every one of them appears in an
       * existing eslint-disable comment), plus rules-of-hooks because a
       * violation there is a real bug rather than a style opinion.
       *
       * The rest of jsx-a11y/recommended is a genuine backlog, not something
       * to silently pretend we enforce — turning it on today lights up 78
       * findings, mostly label-has-associated-control. Worth its own pass.
       * no-autofocus in particular is wrong for a POS, where autofocus on PIN
       * and barcode fields is the entire point of a till.
       *
       * react-hooks v7 also ships set-state-in-effect and purity, which flag
       * standard patterns here (useState(Date.now()) for a wall clock). Left
       * off rather than refactoring working till UI to satisfy them.
       */
      'jsx-a11y/alt-text': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    // Next-specific rules belong only to the website.
    files: ['apps/web/**/*.{js,jsx,ts,tsx}'],
    rules: {
      ...nextPlugin.configs.recommended.rules,
      // Pages-router rule. apps/web is App Router only, so it has no
      // pages/ directory to scan and warns to stderr on every single run.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },

  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      /**
       * The house rule from CLAUDE.md: no `any` without a documented reason.
       * The codebase is currently clean, so this is a ratchet, not a cleanup
       * task — an escape hatch still exists via an eslint-disable line, which
       * is exactly the "write down why" the convention asks for.
       */
      '@typescript-eslint/no-explicit-any': 'error',

      // Unused code is the single most common review nit here; let an
      // underscore prefix mark a deliberate throwaway.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Money is in cents and ids are uuid strings — an accidental `==`
      // coercion is never what we want.
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      /**
       * There is not a single console.log/info/debug in the codebase — the
       * only console calls are warn/error on genuine failure paths, which
       * both the Electron main process and the API routes need. So ban the
       * chatty ones and leave the diagnostic ones alone.
       */
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  {
    // Config and build scripts are plain Node CLI code, not app source —
    // printing progress to stdout is their job.
    files: ['**/*.config.{js,mjs,cjs,ts}', '**/scripts/**/*.{js,mjs}'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-console': 'off',
    },
  },
);
