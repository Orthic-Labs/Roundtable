PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;

CREATE TABLE rooms (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, objective TEXT NOT NULL, next_seq INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL, archived_at_ms INTEGER);
CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, last_seen_ms INTEGER);
CREATE TABLE seats (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), node_id TEXT NOT NULL REFERENCES nodes(id), alias TEXT NOT NULL, provider TEXT NOT NULL, session_ref TEXT NOT NULL, state TEXT NOT NULL, last_seen_ms INTEGER NOT NULL, last_ack_seq INTEGER NOT NULL DEFAULT 0, UNIQUE(room_id, alias), UNIQUE(room_id, node_id, provider, session_ref));
CREATE TABLE messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), seq INTEGER NOT NULL, actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT REFERENCES messages(id), created_at_ms INTEGER NOT NULL, UNIQUE(room_id, seq));
CREATE TABLE message_mentions (message_id TEXT NOT NULL REFERENCES messages(id), seat_id TEXT NOT NULL REFERENCES seats(id), PRIMARY KEY(message_id, seat_id));
CREATE TABLE deliveries (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), message_id TEXT NOT NULL REFERENCES messages(id), seat_id TEXT NOT NULL REFERENCES seats(id), reason TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, lease_until_ms INTEGER, error_code TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, UNIQUE(message_id, seat_id, reason));
CREATE TABLE handoffs (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), message_id TEXT NOT NULL REFERENCES messages(id), from_seat_id TEXT NOT NULL REFERENCES seats(id), to_seat_id TEXT NOT NULL REFERENCES seats(id), evidence_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE approvals (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), seat_id TEXT NOT NULL REFERENCES seats(id), delivery_id TEXT NOT NULL REFERENCES deliveries(id), provider_request_id TEXT NOT NULL, description TEXT NOT NULL, input_preview TEXT NOT NULL, decisions_json TEXT NOT NULL, state TEXT NOT NULL, resolution TEXT, created_at_ms INTEGER NOT NULL, resolved_at_ms INTEGER, UNIQUE(seat_id, provider_request_id));
CREATE TABLE request_dedupe (actor_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_sha256 TEXT NOT NULL, response_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY(actor_id, request_id));
CREATE TABLE browser_sessions (id_hash TEXT PRIMARY KEY, expires_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL);
CREATE TABLE events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, target_node_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
