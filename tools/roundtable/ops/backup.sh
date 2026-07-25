#!/usr/bin/env bash
# Roundtable SQLite backup.
#
# Uses sqlite3 .backup rather than cp: the hub runs in WAL mode, so copying the .sqlite3 file
# alone can capture a torn snapshot with its -wal unmerged. .backup takes a consistent copy of a
# live database.
#
# Exits nonzero if integrity_check does not return exactly "ok", so a silently corrupt backup
# fails the job instead of being retained as if it were good.
#
# Cron (box):  15 4 * * *  /home/vendure/sites/roundtable/tools/roundtable/ops/backup.sh

set -Eeuo pipefail

DB="${ROUND_TABLE_DATABASE:-/var/lib/roundtable/roundtable.sqlite3}"
DEST="${ROUND_TABLE_BACKUP_DIR:-/var/backups/roundtable}"
RETAIN_DAYS="${ROUND_TABLE_BACKUP_RETAIN:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/roundtable-$STAMP.sqlite3"

command -v sqlite3 >/dev/null || { echo "backup: sqlite3 not installed" >&2; exit 1; }
[ -f "$DB" ] || { echo "backup: database not found at $DB" >&2; exit 1; }
mkdir -p "$DEST"

sqlite3 "$DB" ".backup '$OUT'"

check="$(sqlite3 "$OUT" 'PRAGMA integrity_check;')"
if [ "$check" != "ok" ]; then
  echo "backup: integrity_check FAILED for $OUT: $check" >&2
  rm -f "$OUT"
  exit 1
fi

# The integrity check opens the copy, which leaves -wal/-shm sidecars next to it. Checkpoint them
# away so the retained artifact is a single self-contained file and the checksum covers all of it.
sqlite3 "$OUT" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1 || true
rm -f "$OUT-wal" "$OUT-shm"

sha256sum "$OUT" > "$OUT.sha256"

find "$DEST" -name 'roundtable-*.sqlite3' -type f -mtime "+$RETAIN_DAYS" -print -delete
find "$DEST" -name 'roundtable-*.sqlite3.sha256' -type f -mtime "+$RETAIN_DAYS" -delete
find "$DEST" \( -name 'roundtable-*.sqlite3-wal' -o -name 'roundtable-*.sqlite3-shm' \) -type f -delete

echo "backup: ok $OUT ($(stat -c %s "$OUT" 2>/dev/null || stat -f %z "$OUT") bytes)"
