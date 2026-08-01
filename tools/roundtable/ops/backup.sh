#!/usr/bin/env bash
# Roundtable SQLite backup.
#
# Uses node:sqlite's native backup() rather than `cp`: the hub runs in WAL mode, so copying the
# .sqlite3 file alone can capture a torn snapshot with its -wal unmerged. backup() takes a
# consistent copy of a live database.
#
# It uses NODE, not the sqlite3 CLI, because the sqlite3 CLI is NOT installed on the box and
# installing it needs sudo. Node is already there (the hub runs on it) and node:sqlite exposes
# both backup() and integrity_check — so this script needs no packages and no root.
#
# Exits nonzero if integrity_check does not return exactly "ok", so a silently corrupt backup
# fails the job instead of being retained as if it were good.
#
# Cron (box):  15 4 * * *  /home/vendure/sites/roundtable/tools/roundtable/ops/backup.sh

set -Eeuo pipefail

DB="${CITADEL_DATABASE:-${ROUND_TABLE_DATABASE:-$HOME/.local/share/citadel/roundtable.sqlite3}}"
DEST="${ROUND_TABLE_BACKUP_DIR:-$HOME/backups/roundtable}"
RETAIN_DAYS="${ROUND_TABLE_BACKUP_RETAIN:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/roundtable-$STAMP.sqlite3"

command -v node >/dev/null || { echo "backup: node not installed" >&2; exit 1; }
[ -f "$DB" ] || { echo "backup: database not found at $DB" >&2; exit 1; }
mkdir -p "$DEST"

# backup() is async and returns a promise. integrity_check runs against the COPY, so a corrupt
# result condemns the artifact about to be retained, not the live database.
if ! DB="$DB" OUT="$OUT" node --input-type=module -e '
import { DatabaseSync, backup } from "node:sqlite";
const src = new DatabaseSync(process.env.DB, { readOnly: true });
await backup(src, process.env.OUT);
src.close();
const copy = new DatabaseSync(process.env.OUT);
const result = Object.values(copy.prepare("PRAGMA integrity_check").get())[0];
if (result !== "ok") {
  console.error(`integrity_check FAILED: ${result}`);
  process.exit(1);
}
// The check opened the copy in WAL mode; fold the sidecars back in so the retained artifact is a
// single self-contained file and the checksum covers all of it.
copy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
copy.close();
'; then
  echo "backup: FAILED for $OUT" >&2
  rm -f "$OUT" "$OUT-wal" "$OUT-shm"
  exit 1
fi

rm -f "$OUT-wal" "$OUT-shm"

if command -v sha256sum >/dev/null; then
  sha256sum "$OUT" > "$OUT.sha256"
else
  shasum -a 256 "$OUT" > "$OUT.sha256"   # macOS
fi

find "$DEST" -name 'roundtable-*.sqlite3' -type f -mtime "+$RETAIN_DAYS" -print -delete
find "$DEST" -name 'roundtable-*.sqlite3.sha256' -type f -mtime "+$RETAIN_DAYS" -delete
find "$DEST" \( -name 'roundtable-*.sqlite3-wal' -o -name 'roundtable-*.sqlite3-shm' \) -type f -delete

echo "backup: ok $OUT ($(stat -c %s "$OUT" 2>/dev/null || stat -f %z "$OUT") bytes)"
