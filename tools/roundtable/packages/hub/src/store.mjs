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

  /** Escape hatch for slices not yet ported. Prefer adding a method over reaching for this. */
  get raw() { return this.#db; }

  close() { this.#db.close(); }
}
