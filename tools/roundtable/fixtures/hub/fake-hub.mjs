#!/usr/bin/env node
import net from 'node:net';
import { randomUUID } from 'node:crypto';
const port = process.argv[2] ? Number(process.argv[2]) : 0;
const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let env;
      try { env = JSON.parse(line); } catch { continue; }
      if (env.type === 'node.hello') {
        const accepted = { version: 1, event_id: randomUUID(), sent_at_ms: Date.now(),
          type: 'hello.accepted', payload: { node_id: env.payload.node_id, heartbeat_ms: 250,
            resume_cursor: env.payload.resume_cursor ?? 0, seat_tokens: [] } };
        socket.write(JSON.stringify(accepted) + '\n');
      } else if (env.type === 'node.delivery.ack' || env.type === 'node.message.post') {
        const echo = { version: 1, event_id: randomUUID(), sent_at_ms: Date.now(),
          type: 'ack.echo', payload: { saw_type: env.type, payload: env.payload } };
        socket.write(JSON.stringify(echo) + '\n');
      }
    }
  });
  socket.on('error', () => {});
});
server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write(JSON.stringify({ port: addr.port }) + '\n');
});
const timer = setInterval(() => {
  for (const s of server.connections) {
    if (!s.writable) continue;
    const ping = { version: 1, event_id: randomUUID(), sent_at_ms: Date.now(),
      type: 'ping', payload: { nonce: randomUUID() } };
    s.write(JSON.stringify(ping) + '\n');
  }
}, 1000);
process.on('SIGINT', () => { clearInterval(timer); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { clearInterval(timer); server.close(() => process.exit(0)); });
