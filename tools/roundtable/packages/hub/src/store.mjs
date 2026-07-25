// SQLite store for the Node hub.
//
// Uses the SAME migration the Rust store uses — crates/roundtable-store/migrations/0001_initial.sql
// is the schema contract and is applied here verbatim. Verified 2026-07-25: it loads under
// node:sqlite with no modification (11 tables, 3 indexes).
//
// node:sqlite is built into Node 22.5+ (this box runs v26), so the hub needs no package manager.
// That is not a stylistic choice: pnpm is blocked locally as a broken release and npm fails on
// certificate trust, so a dependency-free hub is the only thing that can be built and verified
// on the dev Mac today.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { hashSecretBytes, tokenMatches } from './auth.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATION_PATH = resolve(
  HERE, '../../../crates/roundtable-store/migrations/0001_initial.sql',
);

export class StoreError extends Error {}

export class Store {
  #db;

  constructor(db) { this.#db = db; }

  /**
   * Open a store and apply the schema.
   * `path` may be ':memory:' for tests.
   */
  static open(path, { migrationPath = MIGRATION_PATH } = {}) {
    const db = new DatabaseSync(path);
    // Match the Rust store's pragmas: WAL for concurrent readers, enforced foreign keys, and a
    // busy timeout so a concurrent writer waits instead of failing the request.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');

    // Guarded by user_version, exactly as the Rust store does it (see roundtable-store's
    // `open_connection`). Without this the migration is re-applied on every open and the SECOND
    // start against a persistent database dies with "table rooms already exists" — the hub comes
    // up once on a fresh file and can never restart. Every test opens ':memory:', so nothing
    // caught it until a real restart on the box did.
    const version = Number(Object.values(db.prepare('PRAGMA user_version').get())[0] ?? 0);
    if (version === 0) {
      // A database created by the pre-guard code is fully migrated but still reports version 0.
      // Re-running the migration on it throws "table rooms already exists"; stamping it is
      // correct, because the schema it already has IS version 1. Without this, every database
      // written before the guard existed is permanently unopenable.
      const migrated = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rooms'")
        .get();
      if (migrated) {
        db.exec('PRAGMA user_version = 1');
      } else {
        let sql;
        try {
          sql = readFileSync(migrationPath, 'utf8');
        } catch (e) {
          throw new StoreError(`cannot read migration at ${migrationPath}: ${e.message}`);
        }
        db.exec(sql);
        db.exec('PRAGMA user_version = 1');
      }
    }
    return new Store(db);
  }

  /** Table names present, excluding sqlite internals. Used by the schema test. */
  tables() {
    return this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
  }

  /**
   * Request dedupe, mirroring the Rust store's contract:
   *   same (actor_id, request_id) + same payload hash  -> returns the original response
   *   same (actor_id, request_id) + different payload  -> throws (caller maps to HTTP 409)
   *
   * This is what makes node retries safe after an ambiguous disconnect.
   */
  dedupe(actorId, requestId, payloadSha256, produce) {
    const found = this.#db
      .prepare('SELECT payload_sha256, response_json FROM request_dedupe WHERE actor_id = ? AND request_id = ?')
      .get(actorId, requestId);
    if (found) {
      if (found.payload_sha256 !== payloadSha256) {
        throw new StoreError('request_id_reused');
      }
      return { replayed: true, response: JSON.parse(found.response_json) };
    }
    const response = produce();
    this.#db
      .prepare('INSERT INTO request_dedupe (actor_id, request_id, payload_sha256, response_json, created_at_ms) VALUES (?, ?, ?, ?, ?)')
      .run(actorId, requestId, payloadSha256, JSON.stringify(response), Date.now());
    return { replayed: false, response };
  }

  /** Run `fn` inside a transaction, rolling back on any throw. */
  tx(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.#db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.#db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }

  // ---- rooms -------------------------------------------------------------

  createRoom({ id = randomUUID(), slug, title, objective = '' }) {
    if (!slug) throw new StoreError('slug is required');
    const now = Date.now();
    try {
      this.#db
        .prepare('INSERT INTO rooms (id, slug, title, objective, next_seq, created_at_ms) VALUES (?, ?, ?, ?, 1, ?)')
        .run(id, slug, title ?? slug, objective, now);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new StoreError('slug_taken');
      throw e;
    }
    return this.getRoom(id);
  }

  getRoom(id) {
    return this.#db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) ?? null;
  }

  getRoomBySlug(slug) {
    return this.#db.prepare('SELECT * FROM rooms WHERE slug = ?').get(slug) ?? null;
  }

  /** Active rooms, newest first. Archived rooms are excluded unless asked for. */
  listRooms({ includeArchived = false } = {}) {
    const sql = includeArchived
      ? 'SELECT * FROM rooms ORDER BY created_at_ms DESC'
      : 'SELECT * FROM rooms WHERE archived_at_ms IS NULL ORDER BY created_at_ms DESC';
    return this.#db.prepare(sql).all();
  }

  archiveRoom(id) {
    const info = this.#db.prepare('UPDATE rooms SET archived_at_ms = ? WHERE id = ? AND archived_at_ms IS NULL').run(Date.now(), id);
    return info.changes > 0;
  }

  // ---- nodes and seats ---------------------------------------------------

  registerNode({ id = randomUUID(), name, tokenHash }) {
    const now = Date.now();
    this.#db
      .prepare('INSERT INTO nodes (id, name, token_hash, created_at_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET last_seen_ms = excluded.last_seen_ms')
      .run(id, name, tokenHash, now, now);
    return this.#db.prepare('SELECT * FROM nodes WHERE name = ?').get(name);
  }

  /** Enrolled nodes. token_hash is never returned — it is a credential, not status. */
  listNodes() {
    return this.#db
      .prepare('SELECT id, name, created_at_ms, revoked_at_ms, last_seen_ms FROM nodes ORDER BY name')
      .all();
  }

  getNode(id) {
    return this.#db
      .prepare('SELECT id, name, created_at_ms, revoked_at_ms, last_seen_ms FROM nodes WHERE id = ?')
      .get(id) ?? null;
  }

  /**
   * Authenticate a node's `node.hello`. Returns the node row on success, `null` on any failure.
   *
   * This exists because the hub previously accepted ANY connection whose `node_id` merely existed
   * — the `token` the node sends was read off the wire and never checked, and a revoked node was
   * still admitted. A delivery carries a room's transcript, so that was enough to read private
   * conversations and post as any seat the node owns, knowing only a UUID.
   *
   * Comparison is constant-time over fixed-length digests, matching the admin-token path.
   */
  verifyNodeToken(id, token) {
    const row = this.#db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    if (!row) return null;
    if (row.revoked_at_ms) return null;
    if (!tokenMatches(Buffer.from(row.token_hash, 'hex'), token)) return null;
    const { token_hash: _omit, ...safe } = row;
    return safe;
  }

  /** Hex sha256 of a node token, for `registerNode({ tokenHash })`. */
  static hashNodeToken(token) {
    return hashSecretBytes(token).toString('hex');
  }

  touchNode(id) {
    return this.#db.prepare('UPDATE nodes SET last_seen_ms = ? WHERE id = ?').run(Date.now(), id).changes > 0;
  }

  // Default 'idle', not 'attached': roundtable_protocol::SeatState's real variants are
  // detached/offline/idle/running/waiting_approval/error — 'attached' isn't one of them and
  // fails roundtable-node's deserialization of any Seat row that reaches it (e.g. inside a
  // delivery.assign's seat roster). Found the same way as the Message.actor_id UUID mismatch:
  // this hub's own tests never round-tripped a Seat through the real Rust struct until
  // e2e-rust-node.test.mjs did.
  createSeat({ id = randomUUID(), roomId, nodeId, alias, provider, sessionRef, state = 'idle' }) {
    const now = Date.now();
    try {
      this.#db
        .prepare('INSERT INTO seats (id, room_id, node_id, alias, provider, session_ref, state, last_seen_ms, last_ack_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)')
        .run(id, roomId, nodeId, alias, provider, sessionRef, state, now);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new StoreError('alias_taken');
      if (/FOREIGN KEY/.test(e.message)) throw new StoreError('unknown_room_or_node');
      throw e;
    }
    return this.#db.prepare('SELECT * FROM seats WHERE id = ?').get(id);
  }

  listSeats(roomId) {
    return this.#db.prepare('SELECT * FROM seats WHERE room_id = ? ORDER BY alias').all(roomId);
  }

  /** A single seat by id, or null. Used to validate an incoming node frame names a real seat
   * before persisting anything on its behalf. */
  getSeat(seatId) {
    return this.#db.prepare('SELECT * FROM seats WHERE id = ?').get(seatId) ?? null;
  }

  /**
   * Does this node own a seat in this room?
   *
   * The authorisation predicate for node reads. A node authenticates as itself, not as an
   * operator, so it must not be able to read a room it was never seated in — without this a single
   * compromised or buggy node could pull every transcript on the hub.
   */
  nodeHasSeatInRoom(nodeId, roomId) {
    const row = this.#db
      .prepare('SELECT 1 AS present FROM seats WHERE node_id = ? AND room_id = ? LIMIT 1')
      .get(nodeId, roomId);
    return row !== undefined;
  }

  seatByAlias(roomId, alias) {
    return this.#db.prepare('SELECT * FROM seats WHERE room_id = ? AND alias = ?').get(roomId, alias) ?? null;
  }

  /** Returns false if the seat is unknown OR already detached, so callers never report a no-op as success. */
  detachSeat(seatId) {
    return this.#db
      .prepare("UPDATE seats SET state = 'detached' WHERE id = ? AND state != 'detached'")
      .run(seatId).changes > 0;
  }

  // ---- messages ----------------------------------------------------------

  /**
   * Append a message and, for each explicitly mentioned seat, one delivery.
   *
   * The whole thing is one transaction because `messages` has UNIQUE(room_id, seq) and the
   * sequence comes from `rooms.next_seq`: allocating outside a transaction lets two concurrent
   * posts claim the same seq and one of them fails after the caller was told it succeeded.
   *
   * Deliveries are created ONLY for seats passed in `mentionSeatIds`. Agent prose is never
   * scanned for @aliases — that is the wake rule the architecture locks, and it is what stops a
   * message from waking every seat in the room.
   */
  postMessage(args) {
    return this.tx(() => this.#postMessageLocked(args));
  }

  /**
   * The body of postMessage, assuming a transaction is already open.
   *
   * Split out so createHandoff can compose message + handoff + delivery into ONE transaction —
   * SQLite has no nested BEGIN, so calling postMessage from inside tx() would throw.
   */
  #postMessageLocked({
    id = randomUUID(), roomId, actorId, actorKind = 'human', kind = 'chat',
    body, replyTo = null, mentionSeatIds = [], deliveryReason = 'human_mention',
  }) {
    if (typeof body !== 'string' || body.length === 0) throw new StoreError('body_required');
    {
      const room = this.#db.prepare('SELECT next_seq FROM rooms WHERE id = ? AND archived_at_ms IS NULL').get(roomId);
      if (!room) throw new StoreError('unknown_or_archived_room');
      const seq = room.next_seq;
      const now = Date.now();

      this.#db
        .prepare('INSERT INTO messages (id, room_id, seq, actor_id, actor_kind, kind, body, reply_to, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, roomId, seq, actorId, actorKind, kind, body, replyTo, now);
      this.#db.prepare('UPDATE rooms SET next_seq = ? WHERE id = ?').run(seq + 1, roomId);

      const deliveries = [];
      for (const seatId of mentionSeatIds) {
        this.#db.prepare('INSERT INTO message_mentions (message_id, seat_id) VALUES (?, ?)').run(id, seatId);
        const deliveryId = randomUUID();
        this.#db
          .prepare("INSERT INTO deliveries (id, room_id, message_id, seat_id, reason, state, attempt, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)")
          .run(deliveryId, roomId, id, seatId, deliveryReason, now, now);
        deliveries.push({ id: deliveryId, seat_id: seatId });
      }

      return { message: this.#db.prepare('SELECT * FROM messages WHERE id = ?').get(id), deliveries };
    }
  }

  /** Page a room's transcript. `afterSeq` is exclusive; results ascend by seq. */
  listMessages(roomId, { afterSeq = 0, limit = 50 } = {}) {
    const capped = Math.min(Math.max(1, limit), 200);
    return this.#db
      .prepare('SELECT * FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(roomId, afterSeq, capped);
  }

  /**
   * Substring search over a room's message bodies, most recent first.
   *
   * Deliberately `LIKE` and not FTS5: the transcript is small (one room is a working session, not
   * a corpus), and an FTS virtual table would need its own migration and sync triggers for a
   * feature whose whole job is "find the message where we decided X". Revisit if a room ever grows
   * past the point where a scan is cheap.
   *
   * `escapeLike` matters — an agent searching for a literal `%` or `_` (a percentage, a
   * snake_case symbol) would otherwise get wildcard behaviour it never asked for.
   */
  searchMessages(roomId, query, { limit = 20 } = {}) {
    const capped = Math.min(Math.max(1, limit), 100);
    const escaped = String(query).replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.#db.prepare(
      `SELECT * FROM messages
        WHERE room_id = ? AND body LIKE '%' || ? || '%' ESCAPE '\\'
        ORDER BY seq DESC LIMIT ?`,
    ).all(roomId, escaped, capped);
  }

  /**
   * Bounded room context for a delivery, matching `CONTEXT_MAX_MESSAGES` (20) in
   * roundtable-protocol — the last `limit` messages strictly before `beforeSeq`, ascending.
   * Roundtable never injects the full transcript into a delivery; this is the whole reason.
   */
  contextMessages(roomId, beforeSeq, limit = 20) {
    const capped = Math.min(Math.max(0, limit), 200);
    if (capped === 0) return [];
    // Innermost query takes the last N by seq DESC, outer flips it back to ascending order —
    // "last N before X" cannot be expressed as a single ascending LIMIT.
    return this.#db.prepare(
      `SELECT * FROM (
         SELECT * FROM messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?
       ) ORDER BY seq ASC`,
    ).all(roomId, beforeSeq, capped);
  }

  mentionsFor(messageId) {
    return this.#db.prepare('SELECT seat_id FROM message_mentions WHERE message_id = ?').all(messageId).map((r) => r.seat_id);
  }

  /** Mark a delivery acknowledged. Returns false if it is unknown or already past queued/sent. */
  ackDelivery(deliveryId) {
    if (!deliveryId) return false;
    return this.#db
      .prepare("UPDATE deliveries SET state = 'acked', updated_at_ms = ? WHERE id = ? AND state IN ('queued','sent')")
      .run(Date.now(), deliveryId).changes > 0;
  }

  /** Queued deliveries across all rooms, joined to the node that owns each seat, oldest first. */
  pendingDispatch({ limit = 100 } = {}) {
    return this.#db
      .prepare(`SELECT d.*, s.node_id, s.alias
                FROM deliveries d JOIN seats s ON s.id = d.seat_id
                WHERE d.state = 'queued' ORDER BY d.created_at_ms ASC LIMIT ?`)
      .all(Math.min(Math.max(1, limit), 500));
  }

  queuedDeliveries(seatId) {
    return this.#db.prepare("SELECT * FROM deliveries WHERE seat_id = ? AND state = 'queued' ORDER BY created_at_ms ASC").all(seatId);
  }

  // ---- handoffs ----------------------------------------------------------

  /**
   * A structured handoff: the only way one seat may wake another.
   *
   * Posts the handoff message, records the evidence, and queues a delivery for the target — all in
   * one transaction, so a handoff can never exist without its wake, or vice versa.
   */
  createHandoff({
    id = randomUUID(), roomId, fromSeatId, toSeatId, summary, evidence = {},
  }) {
    if (fromSeatId === toSeatId) throw new StoreError('handoff_to_self');
    return this.tx(() => {
      const from = this.#db.prepare('SELECT id, room_id FROM seats WHERE id = ?').get(fromSeatId);
      const to = this.#db.prepare('SELECT id, room_id FROM seats WHERE id = ?').get(toSeatId);
      if (!from || !to) throw new StoreError('unknown_seat');
      if (from.room_id !== roomId || to.room_id !== roomId) throw new StoreError('seat_not_in_room');

      const { message, deliveries } = this.#postMessageLocked({
        roomId, actorId: fromSeatId, actorKind: 'agent', kind: 'handoff',
        body: summary, mentionSeatIds: [toSeatId], deliveryReason: 'structured_handoff',
      });
      this.#db
        .prepare('INSERT INTO handoffs (id, room_id, message_id, from_seat_id, to_seat_id, evidence_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, roomId, message.id, fromSeatId, toSeatId, JSON.stringify(evidence), Date.now());

      return { handoff: this.#db.prepare('SELECT * FROM handoffs WHERE id = ?').get(id), message, deliveries };
    });
  }

  listHandoffs(roomId) {
    return this.#db.prepare('SELECT * FROM handoffs WHERE room_id = ? ORDER BY created_at_ms ASC').all(roomId);
  }

  // ---- approvals ---------------------------------------------------------

  createApproval({
    id = randomUUID(), roomId, seatId, deliveryId, providerRequestId,
    description, inputPreview = '', decisions = ['allow', 'deny'],
  }) {
    const now = Date.now();
    try {
      this.#db
        .prepare("INSERT INTO approvals (id, room_id, seat_id, delivery_id, provider_request_id, description, input_preview, decisions_json, state, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
        .run(id, roomId, seatId, deliveryId, providerRequestId, description, inputPreview, JSON.stringify(decisions), now);
    } catch (e) {
      // The same provider request arriving twice is a retry, not a second approval.
      if (/UNIQUE/.test(e.message)) throw new StoreError('approval_exists');
      if (/FOREIGN KEY/.test(e.message)) throw new StoreError('unknown_seat_or_delivery');
      throw e;
    }
    return this.#db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
  }

  /** Resolve once. A second resolution is refused so a late click cannot overturn a decision. */
  /**
   * Resolve a pending approval.
   *
   * Cancellation contract §3: an approval whose delivery was canceled is in state `canceled`, not
   * `pending`. A human clicking Allow/Deny after that is NOT an error and must not be silently
   * dropped — it is recorded as `approval_resolved_after_cancel` and a system message marks the
   * approval stale. The node is never told to invoke the provider in that case; the caller can
   * tell the two outcomes apart by the returned `after_cancel` flag.
   */
  resolveApproval(approvalId, resolution) {
    return this.tx(() => {
      const row = this.#db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
      if (!row) throw new StoreError('unknown_approval');
      if (row.state === 'resolved') throw new StoreError('already_resolved');
      const decisions = JSON.parse(row.decisions_json);
      if (!decisions.includes(resolution)) throw new StoreError('invalid_resolution');

      if (row.state === 'canceled') {
        this.#db
          .prepare("UPDATE approvals SET state = 'resolved', resolution = 'approval_resolved_after_cancel', resolved_at_ms = ? WHERE id = ?")
          .run(Date.now(), approvalId);
        this.#postMessageLocked({
          roomId: row.room_id,
          actorId: row.seat_id,
          actorKind: 'system',
          kind: 'system',
          body: `Approval was answered "${resolution}" after the delivery had already been canceled. The answer was recorded but NOT acted on; the provider was not invoked.`,
        });
        const approval = this.#db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
        return { ...approval, after_cancel: true };
      }

      this.#db
        .prepare("UPDATE approvals SET state = 'resolved', resolution = ?, resolved_at_ms = ? WHERE id = ?")
        .run(resolution, Date.now(), approvalId);
      const approval = this.#db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
      return { ...approval, after_cancel: false };
    });
  }

  /**
   * Cancel a delivery, per the architecture's Cancellation contract.
   *
   * Implements §1 (cancel before the provider starts — straight to `failed`, no provider call),
   * §2 (cancel while running — caller must post `seat.interrupt` to the node; signalled by the
   * returned `interrupt` flag), §3 (cancel while waiting on approval — the in-flight approval is
   * killed so a later click lands in the after-cancel path above), and §7 (audit trail — a typed
   * system message carrying canceled_by, delivery_id, seat_alias, and reason).
   *
   * §5 — **no rollback** — is enforced by what this method deliberately does NOT do: it never
   * deletes or retracts messages already in the transcript. Work already done stays recorded;
   * cancel prevents further work, it does not undo prior work. The test
   * `cancel_does_not_roll_back_work_already_recorded` is what holds that invariant.
   */
  cancelDelivery(deliveryId, { canceledBy = 'human', reason = '' } = {}) {
    return this.tx(() => {
      const d = this.#db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId);
      if (!d) throw new StoreError('unknown_delivery');
      if (['completed', 'failed', 'dead_letter'].includes(d.state)) {
        throw new StoreError('delivery_not_cancelable');
      }

      // The provider is only actually running once the node has taken the delivery. A `queued`
      // delivery has never been sent to a node, so there is nothing to interrupt (§1).
      const interrupt = ['sent', 'acked', 'running', 'waiting_approval'].includes(d.state);
      const errorCode = `canceled_by_${canceledBy}`;
      const now = Date.now();

      this.#db
        .prepare('UPDATE deliveries SET state = ?, error_code = ?, lease_until_ms = NULL, updated_at_ms = ? WHERE id = ?')
        .run('failed', errorCode, now, deliveryId);

      // §3: kill any approval still waiting on this delivery.
      const killed = this.#db
        .prepare("SELECT id FROM approvals WHERE delivery_id = ? AND state = 'pending'")
        .all(deliveryId);
      if (killed.length > 0) {
        this.#db
          .prepare("UPDATE approvals SET state = 'canceled' WHERE delivery_id = ? AND state = 'pending'")
          .run(deliveryId);
      }

      // §7: audit trail. seat_alias is resolved here so the transcript reads without a join.
      const seat = this.#db.prepare('SELECT alias FROM seats WHERE id = ?').get(d.seat_id);
      const alias = seat?.alias ?? d.seat_id;
      const detail = reason ? ` Reason: ${reason}` : '';
      this.#postMessageLocked({
        roomId: d.room_id,
        actorId: d.seat_id,
        actorKind: 'system',
        kind: 'system',
        body: `Delivery ${deliveryId} to ${alias} was canceled by ${canceledBy} (${errorCode}).${detail} Work already completed is NOT rolled back.`,
      });

      return {
        delivery: this.#db.prepare(
          `SELECT d.*, s.node_id FROM deliveries d JOIN seats s ON s.id = d.seat_id WHERE d.id = ?`,
        ).get(deliveryId),
        interrupt,
        canceledApprovals: killed.map((r) => r.id),
      };
    });
  }

  /**
   * A delivery plus the `node_id` that owns its seat. The join matters: `dispatch()` routes a
   * frame to the connection for `delivery.node_id`, and a bare `SELECT * FROM deliveries` has no
   * such column — it would silently broadcast to whichever node answered first.
   */
  getDelivery(deliveryId) {
    return this.#db.prepare(
      `SELECT d.*, s.node_id FROM deliveries d JOIN seats s ON s.id = d.seat_id WHERE d.id = ?`,
    ).get(deliveryId);
  }

  /** Marks a delivery as running/waiting_approval etc. from a node's `delivery.state` post. */
  setDeliveryState(deliveryId, state, errorCode = null) {
    this.#db
      .prepare('UPDATE deliveries SET state = ?, error_code = ?, updated_at_ms = ? WHERE id = ?')
      .run(state, errorCode, Date.now(), deliveryId);
    return this.getDelivery(deliveryId);
  }

  pendingApprovals(roomId) {
    return this.#db.prepare("SELECT * FROM approvals WHERE room_id = ? AND state = 'pending' ORDER BY created_at_ms ASC").all(roomId);
  }

  // ---- durable event log -------------------------------------------------

  /**
   * Append to the replay log. `targetNodeId` null means "every node".
   * The autoincrement cursor is what lets a node resume exactly where it left off.
   */
  appendEvent({ eventId = randomUUID(), targetNodeId = null, type, payload }) {
    this.#db
      .prepare('INSERT INTO events (event_id, target_node_id, type, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?)')
      .run(eventId, targetNodeId, type, JSON.stringify(payload ?? {}), Date.now());
    return this.#db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId);
  }

  /** Events after `cursor`, addressed to this node or broadcast. Ascending, capped. */
  eventsAfter(cursor = 0, { nodeId = null, limit = 200 } = {}) {
    const capped = Math.min(Math.max(1, limit), 500);
    return this.#db
      .prepare('SELECT * FROM events WHERE cursor > ? AND (target_node_id IS NULL OR target_node_id = ?) ORDER BY cursor ASC LIMIT ?')
      .all(cursor, nodeId, capped)
      .map((e) => ({ ...e, payload: JSON.parse(e.payload_json) }));
  }

  latestCursor() {
    return this.#db.prepare('SELECT COALESCE(MAX(cursor), 0) AS c FROM events').get().c;
  }

  /** Escape hatch for slices not yet ported. Prefer adding a method over reaching for this. */
  get raw() { return this.#db; }

  close() { this.#db.close(); }
}
