import { createInterface } from 'node:readline';
import WebSocket from 'ws';

// Executable CODEX_PATH shim for codex-acp. Owns only this socket, never the Desktop daemon.
if (process.argv[2] !== 'app-server' || !process.env.LEVERFRAME_CODEX_SOCKET) {
  process.stderr.write('Existing Codex Desktop attachment required\n');
  process.exit(64);
}
const socket = new WebSocket(`ws+unix://${process.env.LEVERFRAME_CODEX_SOCKET}:/`, {
  maxPayload: 32 * 1024 * 1024,
});
const lines = createInterface({ input: process.stdin });
const pending: string[] = [];
lines.on('line', (line) =>
  socket.readyState === WebSocket.OPEN ? socket.send(line) : pending.push(line),
);
socket.on('open', () => {
  for (const line of pending.splice(0)) {
    socket.send(line);
  }
});
socket.on('message', (bytes) => {
  const data = Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.from(bytes as ArrayBuffer);
  process.stdout.write(`${data.toString('utf8')}\n`);
});
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
lines.on('close', () => socket.close());
