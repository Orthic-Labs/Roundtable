CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    requested_by_seat_id TEXT REFERENCES seats(id) ON DELETE SET NULL,
    executor_seat_id TEXT NOT NULL REFERENCES seats(id),
    title TEXT NOT NULL,
    instructions TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    executor_seat_id TEXT NOT NULL REFERENCES seats(id),
    delivery_id TEXT UNIQUE REFERENCES deliveries(id) ON DELETE SET NULL,
    state TEXT NOT NULL,
    reasoning_model TEXT,
    execution_runtime TEXT,
    tool_executor TEXT,
    observability_grade TEXT NOT NULL,
    result_json TEXT,
    error_code TEXT,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    finished_at_ms INTEGER
);

CREATE TABLE run_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    event_key TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE(run_id, seq),
    UNIQUE(run_id, event_key)
);

CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    locator TEXT NOT NULL,
    digest TEXT,
    metadata_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE(run_id, kind, locator)
);

CREATE INDEX tasks_room_created ON tasks(room_id, created_at_ms);
CREATE INDEX runs_room_created ON runs(room_id, created_at_ms);
CREATE INDEX run_events_run_seq ON run_events(run_id, seq);
