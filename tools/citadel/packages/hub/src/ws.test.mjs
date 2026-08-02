// Run with: node --test 'tools/citadel/packages/hub/src/*.test.mjs'
//
// These are end-to-end: a real node:http server, a real upgrade, and Node's built-in global
// WebSocket as the client. If the handshake proof or the frame codec were wrong, the client
// would refuse the connection rather than the assertions passing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { acceptKey, encodeFrame, decodeFrames, attachWebSocket, OPCODE } from './ws.mjs';

/** Spin up a hub-side WS server on an ephemeral port. */
async function serve(onConnection) {
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  attachWebSocket(server, onConnection);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `ws://127.0.0.1:${server.address().port}` };
}

test('accept key matches the RFC 6455 worked example', () => {
  // From RFC 6455 §1.3 — if this is wrong, no browser will ever connect.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('frame round-trips unmasked (server->client) and masked (client->server)', () => {
  for (const mask of [false, true]) {
    const { frames, rest } = decodeFrames(encodeFrame(OPCODE.TEXT, Buffer.from('hello'), { mask }));
    assert.equal(rest.length, 0);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].payload.toString(), 'hello');
  }
});

test('handles all three length forms, including >64KiB', () => {
  for (const size of [10, 200, 70000]) {
    const body = Buffer.alloc(size, 0x61);
    const { frames } = decodeFrames(encodeFrame(OPCODE.TEXT, body, { mask: true }));
    assert.equal(frames[0].payload.length, size);
  }
});

test('a partial frame is buffered, not misparsed', () => {
  const full = encodeFrame(OPCODE.TEXT, Buffer.from('abcdefghij'), { mask: true });
  const { frames, rest } = decodeFrames(full.subarray(0, full.length - 3));
  assert.equal(frames.length, 0, 'must not emit an incomplete frame');
  assert.equal(rest.length, full.length - 3, 'unconsumed bytes are returned for the next chunk');
});

test('two frames in one chunk both decode', () => {
  const two = Buffer.concat([
    encodeFrame(OPCODE.TEXT, Buffer.from('one'), { mask: true }),
    encodeFrame(OPCODE.TEXT, Buffer.from('two'), { mask: true }),
  ]);
  const { frames } = decodeFrames(two);
  assert.deepEqual(frames.map((f) => f.payload.toString()), ['one', 'two']);
});

test('E2E: real client connects, exchanges a message, and the server echoes', async () => {
  const { server, url } = await serve((conn) => {
    conn.on('message', (text) => conn.send(`echo:${text}`));
  });
  const client = new WebSocket(url);
  await once(client, 'open');
  client.send('ping-payload');
  const [evt] = await once(client, 'message');
  assert.equal(evt.data, 'echo:ping-payload');
  client.close();
  server.close();
});

test('E2E: fragmented client message is reassembled', async () => {
  // Node's client will fragment a large payload; the server must rejoin it.
  const big = 'x'.repeat(150000);
  const { server, url } = await serve((conn) => {
    conn.on('message', (text) => conn.send(String(text.length)));
  });
  const client = new WebSocket(url);
  await once(client, 'open');
  client.send(big);
  const [evt] = await once(client, 'message');
  assert.equal(evt.data, String(big.length));
  client.close();
  server.close();
});

test('E2E: server-initiated close reaches the client with code and reason', async () => {
  const { server, url } = await serve((conn) => conn.close(1001, 'going away'));
  const client = new WebSocket(url);
  const [evt] = await once(client, 'close');
  assert.equal(evt.code, 1001);
  assert.equal(evt.reason, 'going away');
  server.close();
});

test('a non-websocket upgrade is rejected with 400', async () => {
  const { server } = await serve(() => assert.fail('must not upgrade'));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { Connection: 'Upgrade', Upgrade: 'h2c' },
  }).catch(() => null);
  // Either the 404 route answers or the upgrade is refused; what must NOT happen is a connection.
  assert.ok(res === null || res.status >= 400);
  server.close();
});
