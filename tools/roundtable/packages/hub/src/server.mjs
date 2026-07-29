// Node hub HTTP + WebSocket server.
//
// Route surface mirrors crates/roundtable-hub/src/{router,http}.rs. Handlers are ported
// incrementally; every route is declared here from the start so an unimplemented one returns a
// clear 501 rather than a 404 that looks like a typo.

import { createServer } from 'node:http';
import { createAccessVerifier } from './access-jwt.mjs';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from './ws.mjs';
import { log } from './log.mjs';
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
  unknown_run: 404,
  executor_not_in_room: 400,
  requester_not_in_room: 400,
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
  ['GET', '/api/rooms/:room_id'], ['PATCH', '/api/rooms/:room_id'],
  ['GET', '/api/rooms/:room_id/messages'], ['POST', '/api/rooms/:room_id/messages'],
  ['GET', '/api/rooms/:room_id/tasks'], ['POST', '/api/rooms/:room_id/tasks'],
  ['GET', '/api/rooms/:room_id/runs'], ['GET', '/api/runs/:run_id/events'],
  ['GET', '/api/rooms/:room_id/seats'], ['POST', '/api/rooms/:room_id/seats'],
  ['DELETE', '/api/rooms/:room_id/seats/:seat_id'],
  ['POST', '/api/rooms/:room_id/handoffs'],
  ['POST', '/api/approvals/:approval_id/resolve'],
  ['POST', '/api/deliveries/:delivery_id/cancel'],
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
  const root = resolve(webRoot);
  const candidate = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
  const fromRoot = relative(root, candidate);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    send(res, 403, { error: 'forbidden' }); return true;
  }

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
  accessTeamDomain = process.env.ROUNDTABLE_ACCESS_TEAM_DOMAIN,
  accessAudience = process.env.ROUNDTABLE_ACCESS_AUD,
}) {
  if (!adminToken) throw new Error('adminToken is required');
  const adminDigest = hashSecretBytes(adminToken);
  // When Cloudflare Access fronts this host it has already authenticated the operator, so asking
  // for the admin token as well is a second login for no extra security. Verifying its signed
  // assertion lets that prompt disappear. Unset -> feature off and the admin token is the only way
  // in, which is what any deployment NOT behind Access needs.
  const verifyAccess = createAccessVerifier({
    teamDomain: accessTeamDomain,
    audience: accessAudience,
  });
  const sessions = new Map(); // token -> expiresAtMs
  const nodeConnections = new Set();

  const authed = async (req) => {
    // Access first: if Cloudflare already vouched for this request there is nothing to log into.
    // The header alone proves nothing (anything reaching the origin could set it) — the signature,
    // audience and expiry are all checked, and nginx separately refuses non-Cloudflare peers.
    if (verifyAccess) {
      const assertion = req.headers['cf-access-jwt-assertion'];
      if (assertion && await verifyAccess(assertion)) return true;
    }
    const token = sessionFromHeaders(req.headers);
    if (!token) return false;
    const expires = sessions.get(token);
    if (!expires) return false;
    if (expires < Date.now()) { sessions.delete(token); return false; }
    return true;
  };

  const server = createServer(async (req, res) => {
    // One access line per request, emitted on finish so it carries the real status and duration.
    // Never the body or query string — a room transcript is private content, not ops data.
    const startedAt = Date.now();
    res.on('finish', () => {
      const fields = {
        method: req.method, path: req.url?.split('?')[0],
        status: res.statusCode, duration_ms: Date.now() - startedAt,
      };
      if (res.statusCode >= 500) log.error('http.request', fields);
      else if (res.statusCode >= 400) log.warn('http.request', fields);
      else log.info('http.request', fields);
    });

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

      if (!(await authed(req))) { send(res, 401, { error: 'unauthenticated' }); return; }

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
          // Archive. `store.archiveRoom` existed and the PWA's X button has always called PATCH
          // here, but the route was never registered — so every archive attempt 404'd and rooms
          // could be created and never removed. Found with a stray blank-slug room stuck in the
          // sidebar and three 404s behind it in the request log.
          if (req.method === 'PATCH') {
            const body = await readBody(req);
            if (body?.archived !== true) { send(res, 400, { error: 'unsupported_patch' }); return; }
            // archiveRoom returns a boolean, not the row — re-read so the client gets a Room.
            store.archiveRoom(roomId);
            send(res, 200, { room: store.getRoom(roomId) });
            return;
          }
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
        case '/api/rooms/:room_id/tasks': {
          if (req.method === 'GET') {
            send(res, 200, { tasks: store.listTasks(roomId), runs: store.listRuns(roomId) });
            return;
          }
          const body = await readBody(req);
          const created = store.createTask({ ...body, roomId });
          api.flushDeliveries();
          send(res, 201, created);
          return;
        }
        case '/api/rooms/:room_id/runs': {
          send(res, 200, { runs: store.listRuns(roomId) });
          return;
        }
        case '/api/runs/:run_id/events': {
          const run = store.getRun(route.params.run_id);
          if (!run) { send(res, 404, { error: 'unknown_run' }); return; }
          send(res, 200, { events: store.listRunEvents(run.id) });
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
          const approval = store.resolveApproval(route.params.approval_id, body?.resolution);
          // Cancellation contract §3: an answer that arrived after the delivery was canceled is
          // recorded but never acted on, so the node is not told about it.
          if (!approval.after_cancel) {
            const delivery = store.getDelivery(approval.delivery_id);
            dispatch(delivery, HubFrame.APPROVAL_RESOLVE, {
              approval_resolve: { approval_id: approval.id, decision: approval.resolution },
            });
          }
          send(res, 200, { approval });
          return;
        }
        // Cancellation contract §2: a delivery the node has already taken needs a real interrupt
        // sent to that node; a still-queued one is simply failed and never reaches a provider.
        case '/api/deliveries/:delivery_id/cancel': {
          const body = await readBody(req);
          const result = store.cancelDelivery(route.params.delivery_id, {
            canceledBy: body?.canceled_by ?? 'human',
            reason: body?.reason ?? '',
          });
          if (result.interrupt) {
            dispatch(result.delivery, HubFrame.SEAT_INTERRUPT, {
              seat_interrupt: {
                delivery_id: result.delivery.id,
                reason: body?.reason ?? 'canceled',
              },
            });
          }
          send(res, 200, result);
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

  // EVERY upgraded connection, not just the handshaken node ones. `nodeConnections` holds only
  // connections that completed `node.hello`; a connection that upgraded and never handshook, or
  // one that was superseded and removed from that set, is invisible to it — and an upgraded
  // socket is detached from the HTTP server, so `closeAllConnections()` cannot reach it either.
  // `close()` would then wait on it forever. This set is what makes shutdown actually terminate.
  const allConnections = new Set();

  attachWebSocket(server, (conn, req) => {
    allConnections.add(conn);
    conn.on('close', () => allConnections.delete(conn));
    // WsConnection re-emits the underlying socket's 'error' (see ws.mjs). Node's EventEmitter
    // throws if 'error' is emitted with no listener attached — an abrupt disconnect (ECONNRESET
    // from a killed process, a network blip) would otherwise crash this entire process and take
    // down every OTHER connection with it. Found by killing the real roundtable-node binary
    // mid-test. 'close' still fires separately and is what actually cleans up state.
    conn.on('error', () => {});

    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path !== '/node/connect' && path !== '/api/events') {
      conn.close(1008, 'unknown websocket path');
      return;
    }
    const isNode = path === '/node/connect';

    if (!isNode) {
      // The browser stream has no handshake — it just names where it left off.
      conn.meta = { isNode: false, nodeId: null, cursor: Number(url.searchParams.get('cursor') ?? 0) || 0 };
      nodeConnections.add(conn);
      // Keepalive. The hub only pushes when something actually happens, so a quiet room leaves
      // this socket idle — and Cloudflare closes an idle WebSocket at around 100 seconds. The
      // browser then showed "Offline" permanently, because the client had no reconnect either.
      // A comment frame well inside that window keeps the connection non-idle. Cleared on close
      // so a dropped socket does not leak a timer per reconnect.
      const keepalive = setInterval(() => {
        try { conn.send(JSON.stringify(encodeFrame('ping', { ts: Date.now() }))); }
        catch { clearInterval(keepalive); }
      }, 30000);
      keepalive.unref?.();
      conn.on('close', () => { clearInterval(keepalive); nodeConnections.delete(conn); });
      for (const evt of store.eventsAfter(conn.meta.cursor, { nodeId: null })) {
        conn.send(JSON.stringify(encodeFrame(evt.type, evt.payload, { cursor: evt.cursor })));
        conn.meta.cursor = evt.cursor;
      }
      return;
    }

    // A real node's connect sequence (crates/roundtable-node/src/hub.rs::connect_and_drive)
    // is: dial the transport, send node.hello FIRST (carrying its own node_id/token/resume
    // cursor), then read exactly one frame back and require it to be hello.accepted or fail the
    // connection outright. There is no `?node_id=`/`?cursor=` query string on the real client's
    // URL at all — those were a manual-testing convenience during earlier development of this
    // hub and never matched what the compiled binary actually sends. Discovered by
    // e2e-rust-node.test.mjs spawning the real binary; every other test in this suite fakes the
    // node side with a raw WebSocket that skipped this handshake entirely.
    conn.meta = { isNode: true, nodeId: null, cursor: 0 };
    let helloReceived = false;

    conn.on('message', (text) => {
      let frame;
      try {
        frame = decodeFrame(text);
      } catch {
        conn.close(1003, 'bad frame');
        return;
      }

      if (!helloReceived) {
        if (frame.type !== NodeFrame.HELLO) {
          conn.close(1003, 'expected node.hello as the first frame');
          return;
        }
        // Wrapped under "hello": the node serializes HubCommand::Hello(HelloFrame) — a tuple
        // variant — which serde's default externally-tagged representation nests as
        // {"hello": {node_id, token, hostname, os, version, resume_cursor}}, not flat. Every
        // HubCommand variant needs this same unwrap; MESSAGE_POST and DELIVERY_ACK below do too.
        // Verified against the real compiled binary's actual bytes on the wire — a hand-guessed
        // flat shape passed every JS-only test while being wrong.
        const { node_id: nodeId, token, resume_cursor: resumeCursor } = frame.payload?.hello ?? {};
        // The token IS checked. It previously was not: any connection quoting an existing node_id
        // was accepted, which is enough to receive that node's deliveries (each carrying a room
        // transcript) and to post as its seats. Revoked nodes are refused here too.
        if (!nodeId || !store.verifyNodeToken(nodeId, token)) {
          log.warn('node.auth_rejected', { node_id: nodeId ?? null });
          conn.close(1008, 'unauthorized');
          return;
        }
        helloReceived = true;
        conn.meta.nodeId = nodeId;
        conn.meta.cursor = Number(resumeCursor ?? 0) || 0;
        // ONE connection per node. A reconnecting node supersedes its previous connection, and
        // any earlier one is dead by definition — but a socket killed abruptly (tunnel dropped,
        // laptop slept, network flap) does not always surface a close event promptly, so the hub
        // can be left holding a stale entry. dispatch() picks the FIRST connection matching the
        // node and returns true, so a stale entry silently swallows deliveries: they are marked
        // `sent` and the live node never sees them. Observed live — two node.connected for one
        // node_id with a single disconnect between them, and two messages that vanished.
        for (const existing of nodeConnections) {
          if (existing !== conn && existing.meta?.nodeId === nodeId) {
            nodeConnections.delete(existing);
            log.info('node.superseded', { node_id: nodeId });
            // destroy, not close: the superseded peer is by definition not answering (that is why
            // it was superseded), so waiting for a closing handshake leaves the socket open.
            try { existing.destroy(); } catch { /* already gone */ }
          }
        }
        nodeConnections.add(conn);
        log.info('node.connected', { node_id: nodeId, resume_cursor: conn.meta.cursor });
        // Drain anything queued while this node was away, rather than waiting for the next
        // dispatch tick. Deferred so hello.accepted is on the wire first — the node closes the
        // connection if any other frame arrives before it.
        setTimeout(() => { try { api.flushDeliveries(); } catch { /* loop will retry */ } }, 0);
        conn.on('close', () => {
          nodeConnections.delete(conn);
          log.info('node.disconnected', { node_id: nodeId });
        });

        // seat_tokens is sent empty: per-seat token issuance/rotation is not implemented and is
        // not invented here.
        conn.send(JSON.stringify(encodeFrame(HubFrame.HELLO_ACCEPTED, {
          node_id: nodeId, heartbeat_ms: 15000, resume_cursor: conn.meta.cursor, seat_tokens: [],
        })));

        // Replay anything missed while disconnected, before any new event is sent. Without this
        // a node that drops mid-delivery silently loses it.
        //
        // Delivery-recovery rule 8: "A completed delivery is never reinjected." The node does not
        // advance its own cursor (it echoes back whatever the handshake gave it), so it reconnects
        // at 0 and the hub would otherwise replay EVERY delivery it has ever sent — re-running
        // finished work on every reconnect. Observed live: one message produced a duplicate reply
        // and a run of "no active turn to steer" errors. Terminal deliveries are skipped here, so
        // replay carries only work that is genuinely still outstanding.
        for (const evt of store.eventsAfter(conn.meta.cursor, { nodeId })) {
          if (evt.type === HubFrame.DELIVERY_ASSIGN) {
            const id = evt.payload?.delivery_assign?.delivery?.id;
            const current = id ? store.getDelivery(id) : null;
            if (!current || !['queued', 'sent'].includes(current.state)) {
              conn.meta.cursor = evt.cursor; // consumed, deliberately not re-sent
              continue;
            }
          }
          conn.send(JSON.stringify(encodeFrame(evt.type, evt.payload, { cursor: evt.cursor })));
          conn.meta.cursor = evt.cursor;
        }
        return;
      }

      if (frame.type === NodeFrame.PONG) return;
      if (frame.type === NodeFrame.DELIVERY_ACK) {
        // HubCommand::DeliveryAck { delivery_id } is a struct variant -> {"delivery_ack": {...}}.
        store.ackDelivery(frame.payload?.delivery_ack?.delivery_id);
        return;
      }
      if (frame.type === NodeFrame.DELIVERY_STATE) {
        handleNodeDeliveryState(conn, frame.payload?.delivery_state);
        return;
      }
      if (frame.type === NodeFrame.RUN_EVENT) {
        handleNodeRunEvent(conn, frame.payload?.run_event);
        return;
      }
      if (frame.type === NodeFrame.MESSAGE_POST) {
        // HubCommand::MessagePost { ... } likewise -> {"message_post": {...}}.
        handleNodeMessagePost(conn, frame.payload?.message_post);
        return;
      }
      if (frame.type === NodeFrame.APPROVAL_REQUEST) {
        handleNodeApprovalRequest(conn, frame.payload?.approval_request);
        return;
      }
      if (frame.type === NodeFrame.SEAT_PRESENCE) {
        handleNodeSeatPresence(conn, frame.payload?.seat_presence);
        return;
      }
      if (frame.type === NodeFrame.HANDOFF_CREATE) {
        handleNodeHandoffCreate(conn, frame.payload?.handoff_create);
        return;
      }
      if (frame.type === NodeFrame.QUERY) {
        handleNodeQuery(conn, frame.payload?.query_request);
      }
    });
  });

  /**
   * A seat handing off to another seat in the same room.
   *
   * `node.handoff.create` was in the wire vocabulary and the node has always sent it, but nothing
   * here consumed it: the frame decoded, matched no branch, and was dropped. The node resolves its
   * caller as soon as the frame is written (same fire-and-forget contract as `message.post`), so
   * the agent was told the handoff succeeded and no handoff row was ever written. Found by reading
   * the production database after a live handoff reported success.
   *
   * Deliberately still fire-and-forget — matching `message.post` rather than inventing an ack for
   * one frame — but failures are logged loudly instead of vanishing.
   */
  function handleNodeHandoffCreate(conn, payload) {
    const {
      from_seat_id: fromSeatId, to_seat_id: toSeatId, body, evidence_refs: evidenceRefs,
    } = payload ?? {};
    if (!fromSeatId || !toSeatId || typeof body !== 'string') {
      log.warn('node.handoff.create.malformed', { reason: 'missing seat ids or body' });
      return;
    }
    const from = store.getSeat(fromSeatId);
    if (!from) { log.warn('node.handoff.create.unknown_seat', { seat_id: fromSeatId }); return; }
    // Same boundary as every other node-authored action: a node may only act as its own seats.
    if (from.node_id !== conn.meta?.nodeId) {
      log.warn('node.handoff.create.forbidden', { seat_id: fromSeatId });
      return;
    }
    try {
      const { handoff } = store.createHandoff({
        roomId: from.room_id,
        fromSeatId,
        toSeatId,
        summary: body,
        evidence: { refs: Array.isArray(evidenceRefs) ? evidenceRefs : [] },
      });
      log.info('handoff.created', {
        handoff_id: handoff.id, from_seat_id: fromSeatId, to_seat_id: toSeatId,
      });
      // The handoff queues a delivery for the target seat; flush so it wakes now rather than on
      // the next dispatch tick.
      api.flushDeliveries();
    } catch (err) {
      log.error('node.handoff.create.failed', { err: String(err), from_seat_id: fromSeatId });
    }
  }

  /**
   * Answer a node's read request with exactly one `query.result`.
   *
   * Reads are scoped to rooms the node is actually seated in. A node authenticates as itself, not
   * as an operator: without that check any node could read every transcript on the hub, which is a
   * far wider grant than "this machine runs one of the agents in that room".
   *
   * Every path replies — including failures. A node that gets no answer would leave its caller
   * (an MCP tool call inside a live Claude session) waiting on a response that never comes.
   */
  function handleNodeQuery(conn, payload) {
    const { request_id: requestId, query } = payload ?? {};
    if (!requestId || !query || typeof query !== 'object') {
      log.warn('node.query.malformed', { reason: 'missing request_id or query' });
      return; // No request_id means nothing to correlate a reply to.
    }
    const reply = (ok, result, error) => {
      conn.send(JSON.stringify(encodeFrame(HubFrame.QUERY_RESULT, {
        query_result: { request_id: requestId, ok, result: result ?? null, error: error ?? null },
      })));
    };
    const nodeId = conn.meta?.nodeId;
    if (!nodeId) { reply(false, null, 'not_authenticated'); return; }

    try {
      const [kind] = Object.keys(query);
      const args = query[kind] ?? {};
      const roomId = args.room_id;
      if (!roomId || !store.nodeHasSeatInRoom(nodeId, roomId)) {
        // Same answer for "no such room" and "not your room" — distinguishing them would let a
        // node probe which rooms exist on the hub.
        reply(false, null, 'room_not_accessible');
        return;
      }
      switch (kind) {
        case 'transcript_read':
          reply(true, {
            messages: store.listMessages(roomId, {
              afterSeq: Number(args.after_seq ?? 0) || 0,
              limit: Number(args.limit ?? 50) || 50,
            }),
          });
          return;
        case 'transcript_search':
          reply(true, {
            messages: store.searchMessages(roomId, String(args.query ?? ''), {
              limit: Number(args.limit ?? 20) || 20,
            }),
          });
          return;
        case 'roster_read':
          // Alias -> seat_id is the whole reason handoff.create could not be served on the node.
          reply(true, { seats: store.listSeats(roomId) });
          return;
        default:
          reply(false, null, `unknown query: ${kind}`);
      }
    } catch (err) {
      log.error('node.query.failed', { err: String(err) });
      reply(false, null, 'query_failed');
    }
  }

  /**
   * A seat (Codex/Claude, via its node) posting its reply back into the room.
   *
   * The Rust node's ClientCommand::PostMessage does not wait for an ack from this frame — it
   * resolves its own caller as soon as the frame is written to the socket, relying entirely on
   * (seat_id, request_id) dedupe for safety across a reconnect-and-retry. There is deliberately no
   * response frame sent back for this message type; match that contract rather than inventing one.
   */
  function handleNodeMessagePost(conn, payload) {
    const {
      request_id: requestId, seat_id: seatId, room_id: roomId,
      message_kind: kind, body, reply_to: replyTo, request_payload_sha256: sha,
    } = payload ?? {};
    if (!requestId || !seatId || !roomId || typeof body !== 'string') {
      log.warn('node.message.post.malformed', { reason: 'missing seat_id or room_id' });
      return;
    }
    const seat = store.getSeat(seatId);
    if (!seat || seat.room_id !== roomId || seat.node_id !== conn.meta?.nodeId) {
      log.warn('node.message.post.unknown_seat', { seat_id: seatId, room_id: roomId });
      return;
    }
    try {
      store.dedupe(seatId, requestId, sha ?? '', () => store.postMessage({
        roomId, actorId: seatId, actorKind: 'agent', kind, body, replyTo,
      }));
    } catch (e) {
      log.error('node.message.post.failed', { seat_id: seatId, room_id: roomId, err: e });
    }
  }

  function handleNodeDeliveryState(conn, payload) {
    const { delivery_id: deliveryId, state, error_code: errorCode = null } = payload ?? {};
    const states = new Set(['queued', 'sent', 'acked', 'running', 'waiting_approval', 'completed', 'failed', 'dead_letter']);
    if (!deliveryId || !states.has(state)) {
      log.warn('node.delivery.state.malformed');
      return;
    }
    const delivery = store.setDeliveryStateForNode({ nodeId: conn.meta?.nodeId, deliveryId, state, errorCode });
    if (!delivery) log.warn('node.delivery.state.forbidden', { delivery_id: deliveryId });
  }

  function handleNodeRunEvent(conn, payload) {
    const { delivery_id: deliveryId, event_key: eventKey, event_type: type, payload: eventPayload = {} } = payload ?? {};
    const delivery = store.getDelivery(deliveryId);
    if (!delivery || delivery.node_id !== conn.meta?.nodeId) {
      log.warn('node.run.event.forbidden', { delivery_id: deliveryId });
      return;
    }
    const run = store.getRunByDelivery(deliveryId);
    if (!run || !eventKey || !type) return;
    try {
      store.appendRunEvent({ runId: run.id, eventKey, type, payload: eventPayload });
    } catch (err) {
      log.error('node.run.event.failed', { err: String(err), run_id: run.id });
    }
  }

  function handleNodeApprovalRequest(conn, payload) {
    const {
      seat_id: seatId, delivery_id: deliveryId, provider_request_id: providerRequestId,
      description, input_preview: inputPreview = '', decisions,
    } = payload ?? {};
    const seat = store.getSeat(seatId);
    const delivery = store.getDelivery(deliveryId);
    if (!seat || !delivery || seat.node_id !== conn.meta?.nodeId || delivery.seat_id !== seatId || delivery.node_id !== conn.meta?.nodeId) {
      log.warn('node.approval.request.forbidden', { seat_id: seatId, delivery_id: deliveryId });
      return;
    }
    try {
      store.createApproval({
        roomId: seat.room_id, seatId, deliveryId, providerRequestId,
        description, inputPreview, decisions,
      });
    } catch (err) {
      if (err.message !== 'approval_exists') log.error('node.approval.request.failed', { err: String(err) });
    }
  }

  function handleNodeSeatPresence(conn, payload) {
    const { seat_id: seatId, state, last_ack_seq: lastAckSeq } = payload ?? {};
    const states = new Set(['detached', 'offline', 'idle', 'running', 'waiting_approval', 'error']);
    if (!seatId || !states.has(state) || !Number.isInteger(lastAckSeq)) {
      log.warn('node.seat.presence.malformed');
      return;
    }
    if (!store.updateSeatPresence({ nodeId: conn.meta?.nodeId, seatId, state, lastAckSeq })) {
      log.warn('node.seat.presence.forbidden', { seat_id: seatId });
    }
  }

  /**
   * Push one queued delivery to whichever connection owns that seat's node.
   * Returns true if a live connection took it; false means it stays queued for replay.
   */
  function dispatch(delivery, frameType, payload) {
    // payload is sent to the node VERBATIM — no cursor is spliced in. roundtable-node's
    // HubEvent is an externally-tagged enum (one top-level key: the variant name, e.g.
    // "delivery_assign"); adding a sibling "cursor" key there would break its own
    // serde_json::from_value deserialization, not just be ignored. Confirmed the node does not
    // even read a per-event cursor field: its only cursor advance in this path
    // (`s.mark_event_acked(Uuid::now_v7(), accepted.resume_cursor)`) reuses the handshake's
    // resume_cursor, not anything from this payload. `conn.meta.cursor` below is purely the
    // HUB's own bookkeeping for what to replay on a future reconnect.
    const evt = store.appendEvent({
      targetNodeId: delivery?.node_id ?? null, type: frameType, payload,
    });
    const envelope = encodeFrame(frameType, payload, { cursor: evt.cursor });
    for (const conn of nodeConnections) {
      if (!conn.meta?.isNode) continue;
      if (delivery?.node_id && conn.meta.nodeId && conn.meta.nodeId !== delivery.node_id) continue;
      conn.send(JSON.stringify(envelope));
      conn.meta.cursor = evt.cursor;
      return true;
    }
    return false;
  }

  const api = {
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
        const room = store.getRoom(d.room_id);
        const parent = message.reply_to
          ? store.raw.prepare('SELECT * FROM messages WHERE id = ?').get(message.reply_to)
          : null;
        // 20 = roundtable-protocol::CONTEXT_MAX_MESSAGES. Roundtable never injects the full
        // transcript into a delivery; this bound is why.
        const contextMessages = store.contextMessages(d.room_id, message.seq, 20);
        const withMentions = (m) => ({ ...m, mentioned_seat_ids: store.mentionsFor(m.id) });

        // Wrapped under "delivery_assign": roundtable-node deserializes this whole payload
        // straight into its own HubEvent enum via serde_json::from_value, which (no explicit
        // tag/content attribute on that enum) uses externally-tagged representation — every
        // variant's fields live one level deeper, under the snake_case variant name. Every field
        // below is required by crates/roundtable-node/src/hub.rs's HubEvent::DeliveryAssign; the
        // node silently drops the whole event (via `.ok()`) if any is missing or misnamed rather
        // than erroring loudly, which is what let this go unnoticed until the real binary was
        // driven end-to-end.
        const payload = {
          delivery_assign: {
            delivery: { ...d, run_id: store.getRunByDelivery(d.id)?.id ?? null },
            message: withMentions(message),
            parent: parent ? withMentions(parent) : null,
            context_messages: contextMessages.map(withMentions),
            room_slug: room.slug,
            room_title: room.title,
            room_objective: room.objective,
            seats: store.listSeats(d.room_id),
          },
        };
        if (dispatch(d, HubFrame.DELIVERY_ASSIGN, payload)) {
          store.raw.prepare("UPDATE deliveries SET state = 'sent', updated_at_ms = ? WHERE id = ?")
            .run(Date.now(), d.id);
          sent += 1;
        }
      }
      return sent;
    },
    /**
     * Periodically push queued deliveries to connected nodes.
     *
     * Without this the hub accepts messages and dispatches NOTHING: `flushDeliveries` was only
     * ever called by tests, so a deployed hub queued every delivery forever. Found by posting a
     * real message to the real box and watching it sit in `queued`.
     *
     * The loop is the safety net (it also picks up expired leases and retries); the latency path
     * is the immediate flush on node connect and after each posted message. `unref()` so the
     * timer never holds the process open on shutdown.
     */
    startDispatchLoop({ intervalMs = 1000 } = {}) {
      const timer = setInterval(() => {
        try {
          const sent = this.flushDeliveries();
          if (sent > 0) log.info('dispatch.flushed', { count: sent });
        } catch (err) {
          log.error('dispatch.failed', { err });
        }
      }, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
    listen: (port, host = '127.0.0.1') => new Promise((resolve) => {
      server.listen(port, host, () => resolve(server.address()));
    }),
    /**
     * Shut down, and actually finish doing so.
     *
     * `server.close()` stops accepting NEW connections and then waits for every existing one to
     * end. A WebSocket upgrade holds its socket open indefinitely by design, so a polite
     * `c.close(1001)` is not enough: if the peer does not complete the closing handshake — a test
     * client that never closed, a node on a dead network — `server.close()` never calls back and
     * the process hangs forever.
     *
     * That is the real cause of the "test-runner quirk" this repo documented for weeks: any test
     * file that opened a hub and left a client socket open hung `node --test`, which looked
     * environmental because it depended on batch position. It is not environmental — the hub
     * genuinely could not shut down.
     *
     * closeAllConnections() (Node 18.2+) destroys the sockets outright, which is what a shutdown
     * actually means here.
     */
    close: () => new Promise((resolve) => {
      // destroy(), not close(): an upgraded WebSocket socket is detached from the HTTP server, so
      // `closeAllConnections()` never reaches it, and a peer that does not complete the closing
      // handshake leaves `server.close()` waiting forever.
      for (const c of allConnections) {
        try { c.destroy(); } catch { /* already gone */ }
      }
      allConnections.clear();
      nodeConnections.clear();
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
  return api;
}

export { SESSION_COOKIE };
