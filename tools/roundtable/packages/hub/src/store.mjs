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
    let sql;
    try {
      sql = readFileSync(migrationPath, 'utf8');
    } catch (e) {
      throw new StoreError(`cannot read migration at ${migrationPath}: ${e.message}`);
    }
    db.exec(sql);
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

  createSeat({ id = randomUUID(), roomId, nodeId, alias, provider, sessionRef, state = 'attached' }) {
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

  seatByAlias(roomId, alias) {
    return this.#db.prepare('SELECT * FROM seats WHERE room_id = ? AND alias = ?').get(roomId, alias) ?? null;
  }

  detachSeat(seatId) {
    return this.#db.prepare("UPDATE seats SET state = 'detached' WHERE id = ?").run(seatId).changes > 0;
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
  postMessage({
    id = randomUUID(), roomId, actorId, actorKind = 'human', kind = 'chat',
    body, replyTo = null, mentionSeatIds = [], deliveryReason = 'human_mention',
  }) {
    if (typeof body !== 'string' || body.length === 0) throw new StoreError('body_required');
    return this.tx(() => {
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
    });
  }

  /** Page a room's transcript. `afterSeq` is exclusive; results ascend by seq. */
  listMessages(roomId, { afterSeq = 0, limit = 50 } = {}) {
    const capped = Math.min(Math.max(1, limit), 200);
    return this.#db
      .prepare('SELECT * FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(roomId, afterSeq, capped);
  }

  mentionsFor(messageId) {
    return this.#db.prepare('SELECT seat_id FROM message_mentions WHERE message_id = ?').all(messageId).map((r) => r.seat_id);
  }

  queuedDeliveries(seatId) {
    return this.#db.prepare("SELECT * FROM deliveries WHERE seat_id = ? AND state = 'queued' ORDER BY created_at_ms ASC").all(seatId);
  }

  /** Escape hatch for slices not yet ported. Prefer adding a method over reaching for this. */
  get raw() { return this.#db; }

  close() { this.#db.close(); }
}
