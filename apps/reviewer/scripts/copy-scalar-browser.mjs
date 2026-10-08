import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const scalarEntry = require.resolve('@scalar/api-reference');
const source = join(dirname(scalarEntry), 'browser', 'standalone.js');
const destination = new URL('../dist/scalar-api-reference.js', import.meta.url);

copyFileSync(source, destination);
copyFileSync(
  new URL('../resources/codex-desktop-bridge.sh', import.meta.url),
  new URL('../dist/codex-desktop-bridge.sh', import.meta.url),
);
