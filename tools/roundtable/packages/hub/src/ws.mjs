// Minimal RFC 6455 WebSocket server.
//
// Hand-rolled deliberately. Node ships a WebSocket *client* (global `WebSocket`) but no server,
// and `ws` cannot be installed here — pnpm is blocked as a broken release and npm fails on
// certificate trust. This keeps the hub dependency-free, which is also what makes its Hetzner
// deploy `git pull` + `pm2 restart` with nothing to compile or install.
//
// Scope: the frames this hub actually uses — text, ping, pong, close, and continuation. Binary
// frames and permessage-deflate are not supported; the protocol is JSON text over the envelope
// defined in wire.mjs.

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = Object.freeze({
  CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa,
});

/** base64(sha1(key + GUID)) — the RFC 6455 handshake proof. */
export function acceptKey(secWebSocketKey) {
  return createHash('sha1').update(secWebSocketKey + GUID).digest('base64');
}

/** Build the 101 response bytes for an upgrade request. */
export function handshakeResponse(secWebSocketKey) {
  return Buffer.from(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey(secWebSocketKey)}\r\n\r\n`,
    'latin1',
  );
}

/**
 * Encode one frame. Server->client frames are never masked (RFC 6455 §5.1).
 * Payload lengths use the 7 / 7+16 / 7+64 forms.
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN set — this server does not fragment outbound frames.
  if (!mask) return Buffer.concat([header, data]);

  header[1] |= 0x80;
  const key = randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) masked[i] = data[i] ^ key[i % 4];
  return Buffer.concat([header, key, masked]);
}

/**
 * Decode as many whole frames as `buf` contains.
 * Returns { frames, rest } so the caller can keep the unconsumed tail.
 */
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;

    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const big = buf.readBigUInt64BE(p); p += 8;
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('frame too large');
      len = Number(big);
    }

    let key = null;
    if (masked) {
      if (buf.length - p < 4) break;
      key = buf.subarray(p, p + 4); p += 4;
    }
    if (buf.length - p < len) break;

    const raw = buf.subarray(p, p + len);
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) payload[i] = key ? raw[i] ^ key[i % 4] : raw[i];
    frames.push({ fin, opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/**
 * One upgraded connection.
 * Emits: 'message' (string), 'close' (code, reason), 'error'.
 */
export class WsConnection extends EventEmitter {
  #socket; #buf = Buffer.alloc(0); #fragments = []; #fragmentOpcode = null; #closed = false;

  constructor(socket) {
    super();
    this.#socket = socket;
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#finish(1006, 'socket closed'));
    socket.on('error', (e) => this.emit('error', e));
  }

  get closed() { return this.#closed; }

  #onData(chunk) {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    let decoded;
    try {
      decoded = decodeFrames(this.#buf);
    } catch (e) {
      this.emit('error', e);
      this.close(1009, 'frame too large');
      return;
    }
    this.#buf = decoded.rest;
    for (const f of decoded.frames) this.#onFrame(f);
  }

  #onFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OPCODE.PING:
        this.#write(encodeFrame(OPCODE.PONG, payload));
        return;
      case OPCODE.PONG:
        this.emit('pong', payload);
        return;
      case OPCODE.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        // Only echo the close if WE did not initiate it. When the server closed first, the
        // socket is already ended and echoing would throw ERR_STREAM_WRITE_AFTER_END.
        if (!this.#closed) {
          this.#write(encodeFrame(OPCODE.CLOSE, payload));
          this.#socket.end();
        }
        this.#finish(code, reason);
        return;
      }
      case OPCODE.TEXT:
      case OPCODE.CONTINUATION: {
        if (opcode === OPCODE.TEXT) this.#fragmentOpcode = OPCODE.TEXT;
        this.#fragments.push(payload);
        if (!fin) return;
        const full = Buffer.concat(this.#fragments);
        this.#fragments = [];
        if (this.#fragmentOpcode === OPCODE.TEXT) this.emit('message', full.toString('utf8'));
        this.#fragmentOpcode = null;
        return;
      }
      default:
        // Binary and reserved opcodes are not part of this protocol.
        this.close(1003, 'unsupported frame type');
    }
  }

  send(text) {
    if (this.#closed) return false;
    this.#write(encodeFrame(OPCODE.TEXT, Buffer.from(text, 'utf8')));
    return true;
  }

  ping(payload = Buffer.alloc(0)) { this.#write(encodeFrame(OPCODE.PING, payload)); }

  close(code = 1000, reason = '') {
    if (this.#closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2, 'utf8');
    this.#write(encodeFrame(OPCODE.CLOSE, body));
    this.#socket.end();
    this.#finish(code, reason);
  }

  #write(buf) {
    if (this.#socket.destroyed || this.#socket.writableEnded) return;
    this.#socket.write(buf);
  }

  #finish(code, reason) {
    if (this.#closed) return;
    this.#closed = true;
    this.emit('close', code, reason);
  }
}

/**
 * Attach to a node:http server's 'upgrade' event.
 * `onConnection(conn, req)` is called once the handshake completes.
 */
export function attachWebSocket(server, onConnection) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(handshakeResponse(key));
    socket.setNoDelay(true);
    onConnection(new WsConnection(socket), req);
  });
  return server;
}
