import retn0 from '@retn0/eslint-config';
import eslintConfigOxlint from '@retn0/eslint-config-oxlint';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = retn0(
  {
    environments: ['node', 'vitest', 'browser'],
    react: true,
  },
  eslintConfigOxlint,
);

export default [
  ...config,
  {
    name: 'leverframe/ignore-generated',
    ignores: ['**/dist/**', '**/.turbo/**', '**/.next/**', '**/.internal/**', '**/*.tsbuildinfo'],
  },
  // The final core-web-vitals entry contains the official Next rules. The
  // preceding compatibility entry re-registers react-hooks under ESLint 10.
  nextVitals[3],
  ...nextTypescript,
  {
    name: 'leverframe/next-overrides',
    rules: {
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
];
