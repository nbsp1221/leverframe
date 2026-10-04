import { defineConfig } from 'tsdown';

export default defineConfig({
  banner: {
    js: '#!/usr/bin/env node',
  },
  entry: ['src/cli.ts'],
  format: ['esm'],
  outExtensions: () => ({ js: '.js' }),
  deps: {
    alwaysBundle: [/^@repo\/contracts(?:\/|$)/, '@scalar/openapi-to-markdown'],
  },
  platform: 'node',
  sourcemap: true,
  target: 'node24',
});
