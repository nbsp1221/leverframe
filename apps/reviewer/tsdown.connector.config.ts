import { defineConfig } from 'tsdown';
export default defineConfig({
  entry: {
    'connector': 'src/connectors/cli.ts',
    'desktop-bridge': 'src/connectors/desktop-bridge.ts',
  },
  outExtensions: () => ({ js: '.js' }),
  outDir: 'dist/connector/bundle',
  clean: true,
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);",
  },
  deps: { alwaysBundle: [/.*/] },
});
