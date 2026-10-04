import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const bundle = new URL('../dist/connector/bundle/', import.meta.url);
mkdirSync(bundle, { recursive: true });
copyFileSync(
  fileURLToPath(import.meta.resolve('@agentclientprotocol/codex-acp')),
  new URL('codex-acp.mjs', bundle),
);
mkdirSync(new URL('leverframe-ask/scripts/', bundle), { recursive: true });
for (const file of ['SKILL.md', 'scripts/ask.py']) {
  copyFileSync(
    new URL(`../../../.agents/skills/leverframe-ask/${file}`, import.meta.url),
    new URL(`leverframe-ask/${file}`, bundle),
  );
}
writeFileSync(new URL('package.json', bundle), '{"type":"module"}\n');
chmodSync(new URL('desktop-bridge.js', bundle), 0o755);
cpSync(
  new URL('../resources/install-connector.sh', import.meta.url),
  new URL('../dist/connector/install.sh', import.meta.url),
);
execFileSync('tar', [
  '-czf',
  fileURLToPath(new URL('../dist/connector/connector.tar.gz', import.meta.url)),
  '-C',
  fileURLToPath(bundle),
  '.',
]);
console.log('Connector bundle prepared');
