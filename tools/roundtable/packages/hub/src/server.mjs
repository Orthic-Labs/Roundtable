// Node hub HTTP + WebSocket server.
//
// Route surface mirrors crates/roundtable-hub/src/{router,http}.rs. Handlers are ported
// incrementally; every route is declared here from the start so an unimplemented one returns a
// clear 501 rather than a 404 that looks like a typo.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from './ws.mjs';
import { encodeFrame, decodeFrame, HubFrame, NodeFrame } from './wire.mjs';
import {
  SESSION_COOKIE, hashSecretBytes, tokenMatches, randomToken,
  sessionCookie, clearSessionCookie, sessionFromHeaders, originAllowed,
} from './auth.mjs';

const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const MAX_BODY_BYTES = 1024 * 1024;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Built PWA. `vite build` writes here; the hub serves it directly, so there is no second server. */
export const DEFAULT_WEB_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)), '../../web/dist',
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Typed store errors map to status codes here rather than the handlers string-matching SQLite.
 * Anything unmapped stays a 500, so a new failure mode is loud instead of silently becoming a 400.
 */
const STORE_ERROR_STATUS = {
  slug_taken: 409,
  alias_taken: 409,
  request_id_reused: 409,
  approval_exists: 409,
  already_resolved: 409,
  unknown_room_or_node: 404,
  unknown_or_archived_room: 404,
  unknown_seat: 404,
  unknown_seat_or_delivery: 404,
  unknown_approval: 404,
  body_required: 400,
  handoff_to_self: 400,
  seat_not_in_room: 400,
  invalid_resolution: 400,
};

/** Security headers applied to every response, matching the Rust hub. */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
};

/** Route table. `:param` segments are captured. */
const ROUTES = [
  ['GET', '/healthz'], ['GET', '/readyz'],
  ['POST', '/api/auth/login'], ['POST', '/api/auth/logout'], ['GET', '/api/me'],
  ['GET', '/api/rooms'], ['POST', '/api/rooms'],
  ['GET', '/api/rooms/:room_id'],
  ['GET', '/api/rooms/:room_id/messages'], ['POST', '/api/rooms/:room_id/messages'],
  ['GET', '/api/rooms/:room_id/seats'], ['POST', '/api/rooms/:room_id/seats'],
  ['DELETE', '/api/rooms/:room_id/seats/:seat_id'],
  ['POST', '/api/rooms/:room_id/handoffs'],
  ['POST', '/api/approvals/:approval_id/resolve'],
  ['GET', '/api/nodes'], ['GET', '/api/nodes/:node_id'],
];

function matchRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const [m, pattern] of ROUTES) {
    if (m !== method) continue;
    const pp = pattern.split('/').filter(Boolean);
    if (pp.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i += 1) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (pp[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { pattern, params };
  }
  return null;
}

function send(res, status, body, extraHeaders = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * Serve a file from the built PWA. Returns true if it answered.
 *
 * Vite emits content-hashed asset names, so /assets/* is immutable-cacheable while index.html
 * must never be cached — otherwise a deploy leaves clients holding a stale asset manifest.
 * Unknown paths fall back to index.html so client-side routes survive a refresh.
 */
async function serveStatic(pathname, res, webRoot) {
  if (!webRoot) return false;
  // normalize + prefix check defeats ../ traversal before it reaches the filesystem.
  const candidate = normalize(join(webRoot, pathname === '/' ? 'index.html' : pathname));
  if (!candidate.startsWith(webRoot)) { send(res, 403, { error: 'forbidden' }); return true; }

  let file = candidate;
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(webRoot, 'index.html'); // SPA fallback
  }

  let body;
  try {
    body = await readFile(file);
  } catch {
    return false; // no build present — let the caller 404 rather than pretending
  }

  const ext = extname(file);
  const immutable = pathname.startsWith('/assets/');
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(body);
  return true;
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

/**
 * Build the hub.
 *
 * `adminToken` is the operator's login secret; only its digest is retained.
 * `secure` controls the cookie's Secure attribute — false only for local HTTP testing.
 */
export function createHub({
  store, adminToken, secure = true, allowedOrigins = [], webRoot = DEFAULT_WEB_ROOT,
}) {
  if (!adminToken) throw new Error('adminToken is required');
  const adminDigest = hashSecretBytes(adminToken);
  const sessions = new Map(); // token -> expiresAtMs
  const nodeConnections = new Set();

  const authed = (req) => {
    const token = sessionFromHeaders(req.headers);
    if (!token) return false;
    const expires = sessions.get(token);
    if (!expires) return false;
    if (expires < Date.now()) { sessions.delete(token); return false; }
    return true;
  };

  const server = createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      send(res, 400, { error: 'bad request' });
      return;
    }

    // Health endpoints are unauthenticated: systemd and nginx poll them.
    if (url.pathname === '/healthz' || url.pathname === '/readyz') {
      send(res, 200, { status: 'ok' });
      return;
    }

    if (MUTATING.has(req.method) && !originAllowed(req.headers.origin, allowedOrigins)) {
      send(res, 403, { error: 'origin_not_allowed' });
      return;
    }

    const route = matchRoute(req.method, url.pathname);
    if (!route) {
      // Not an API route — try the built PWA, then fall back to its index for client-side routes.
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        if (await serveStatic(url.pathname, res, webRoot)) return;
      }
      send(res, 404, { error: 'not_found' });
      return;
    }

    try {
      if (route.pattern === '/api/auth/login') {
        const body = await readBody(req);
        if (!tokenMatches(adminDigest, body?.token ?? '')) {
          send(res, 401, { error: 'invalid_token' });
          return;
        }
        const token = randomToken();
        sessions.set(token, Date.now() + SESSION_MAX_AGE * 1000);
        send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, secure, SESSION_MAX_AGE) });
        return;
      }

      if (route.pattern === '/api/auth/logout') {
        const token = sessionFromHeaders(req.headers);
        if (token) sessions.delete(token);
        send(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(secure) });
        return;
      }

      if (!authed(req)) { send(res, 401, { error: 'unauthenticated' }); return; }

      if (route.pattern === '/api/me') { send(res, 200, { authenticated: true }); return; }

      const { room_id: roomId, seat_id: seatId } = route.params;

      switch (route.pattern) {
        case '/api/rooms': {
          if (req.method === 'GET') { send(res, 200, { rooms: store.listRooms() }); return; }
          const body = await readBody(req);
          send(res, 201, { room: store.createRoom(body) });
          return;
        }
        case '/api/rooms/:room_id': {
          const room = store.getRoom(roomId);
          if (!room) { send(res, 404, { error: 'unknown_room' }); return; }
          send(res, 200, { room, seats: store.listSeats(roomId) });
          return;
        }
        case '/api/rooms/:room_id/messages': {
          if (req.method === 'GET') {
            const afterSeq = Number(url.searchParams.get('after_seq') ?? 0) || 0;
            const limit = Number(url.searchParams.get('limit') ?? 50) || 50;
            send(res, 200, { messages: store.listMessages(roomId, { afterSeq, limit }) });
            return;
          }
          const body = await readBody(req);
          const result = store.postMessage({ ...body, roomId });
          send(res, 201, result);
          return;
        }
        case '/api/rooms/:room_id/seats': {
          if (req.method === 'GET') { send(res, 200, { seats: store.listSeats(roomId) }); return; }
          const body = await readBody(req);
          send(res, 201, { seat: store.createSeat({ ...body, roomId }) });
          return;
        }
        case '/api/rooms/:room_id/seats/:seat_id': {
          const detached = store.detachSeat(seatId);
          if (detached) send(res, 200, { ok: true });
          else send(res, 404, { error: 'unknown_seat' });
          return;
        }
        case '/api/rooms/:room_id/handoffs': {
          const body = await readBody(req);
          send(res, 201, store.createHandoff({ ...body, roomId }));
          return;
        }
        case '/api/approvals/:approval_id/resolve': {
          const body = await readBody(req);
          send(res, 200, { approval: store.resolveApproval(route.params.approval_id, body?.resolution) });
          return;
        }
        case '/api/nodes': {
          send(res, 200, { nodes: store.listNodes(), connected: nodeConnections.size });
          return;
        }
        case '/api/nodes/:node_id': {
          const found = store.getNode(route.params.node_id);
          if (!found) { send(res, 404, { error: 'unknown_node' }); return; }
          const online = [...nodeConnections].some((c) => c.meta?.nodeId === found.id);
          send(res, 200, { node: { ...found, online } });
          return;
        }
        default:
          // Declared but not yet ported. 501 distinguishes "known route, no handler yet" from
          // "no such route", so a partially-ported hub stays legible.
          send(res, 501, { error: 'not_implemented', route: route.pattern });
      }
    } catch (e) {
      send(res, e.status ?? STORE_ERROR_STATUS[e.message] ?? 500, { error: e.message ?? 'internal_error' });
    }
  });

  attachWebSocket(server, (conn, req) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path !== '/node/connect' && path !== '/api/events') {
      conn.close(1008, 'unknown websocket path');
      return;
    }

    // A node names itself and where it left off; the browser stream does neither.
    conn.meta = {
      isNode: path === '/node/connect',
      nodeId: url.searchParams.get('node_id') ?? null,
      cursor: Number(url.searchParams.get('cursor') ?? 0) || 0,
    };
    nodeConnections.add(conn);
    conn.on('close', () => nodeConnections.delete(conn));

    // Replay anything missed while disconnected, before any new event is sent. Without this a
    // node that drops mid-delivery silently loses it.
    for (const evt of store.eventsAfter(conn.meta.cursor, { nodeId: conn.meta.nodeId })) {
      conn.send(JSON.stringify(encodeFrame(evt.type, { ...evt.payload, cursor: evt.cursor })));
      conn.meta.cursor = evt.cursor;
    }

    conn.on('message', (text) => {
      let frame;
      try {
        frame = decodeFrame(text);
      } catch {
        conn.close(1003, 'bad frame');
        return;
      }
      if (frame.type === NodeFrame.PONG) return;
      if (frame.type === NodeFrame.DELIVERY_ACK) {
        store.ackDelivery(frame.payload?.delivery_id);
      }
    });
  });

  /**
   * Push one queued delivery to whichever connection owns that seat's node.
   * Returns true if a live connection took it; false means it stays queued for replay.
   */
  function dispatch(delivery, frameType, payload) {
    const envelope = encodeFrame(frameType, payload);
    const evt = store.appendEvent({
      targetNodeId: delivery?.node_id ?? null, type: frameType, payload,
    });
    for (const conn of nodeConnections) {
      if (!conn.meta?.isNode) continue;
      if (delivery?.node_id && conn.meta.nodeId && conn.meta.nodeId !== delivery.node_id) continue;
      conn.send(JSON.stringify({ ...envelope, payload: { ...payload, cursor: evt.cursor } }));
      conn.meta.cursor = evt.cursor;
      return true;
    }
    return false;
  }

  return {
    server,
    // Exposed for tests and for the eventual delivery loop.
    get sessionCount() { return sessions.size; },
    get connectionCount() { return nodeConnections.size; },
    store,
    dispatch,
    /** Push every queued delivery whose node is connected. Returns how many were taken. */
    flushDeliveries() {
      let sent = 0;
      for (const d of store.pendingDispatch()) {
        const message = store.raw.prepare('SELECT * FROM messages WHERE id = ?').get(d.message_id);
        if (dispatch(d, HubFrame.DELIVERY_ASSIGN, { delivery: d, message })) {
          store.raw.prepare("UPDATE deliveries SET state = 'sent', updated_at_ms = ? WHERE id = ?")
            .run(Date.now(), d.id);
          sent += 1;
        }
      }
      return sent;
    },
    listen: (port, host = '127.0.0.1') => new Promise((resolve) => {
      server.listen(port, host, () => resolve(server.address()));
    }),
    close: () => new Promise((resolve) => { for (const c of nodeConnections) c.close(1001, 'shutdown'); server.close(resolve); }),
  };
}

export { SESSION_COOKIE };
