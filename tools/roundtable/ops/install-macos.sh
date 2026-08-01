#!/usr/bin/env bash
# Install roundtable-node as a login agent on macOS.
#
# Builds the release binary from this checkout, writes config + token, and registers a launchd
# agent that starts it at login and keeps it alive. Idempotent: re-running updates the binary and
# reloads the agent without touching an existing token.
#
# Enrol the node on the box FIRST — it prints the node_id and token this needs:
#   ssh vendure 'node ~/sites/roundtable/tools/roundtable/ops/enrol-node.mjs node mac'
#
# Then here:
#   ROUNDTABLE_NODE_ID=<uuid> ROUNDTABLE_NODE_TOKEN=<token> ops/install-macos.sh
#
# Uninstall:
#   launchctl bootout gui/$(id -u)/com.orthiclabs.roundtable-node
#   rm -rf ~/Library/LaunchAgents/com.orthiclabs.roundtable-node.plist ~/.config/roundtable

set -Eeuo pipefail

HUB_URL="${CITADEL_HUB_URL:-${ROUNDTABLE_HUB_URL:-wss://citadel.spoares.com/node/connect}}"
LABEL="com.orthiclabs.roundtable-node"
CONFIG_DIR="$HOME/.config/roundtable"
DATA_DIR="$HOME/.local/share/roundtable"
LOG_DIR="$HOME/Library/Logs/roundtable"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DEST="$HOME/.local/bin/roundtable-node"

[ "$(uname -s)" = "Darwin" ] || { echo "install-macos.sh is for macOS" >&2; exit 1; }
command -v cargo >/dev/null || { echo "cargo not found — install Rust first" >&2; exit 1; }

mkdir -p "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR" "$(dirname "$BIN_DEST")" "$(dirname "$PLIST")"
chmod 700 "$CONFIG_DIR"

# ---- token -------------------------------------------------------------------
if [ -n "${ROUNDTABLE_NODE_TOKEN:-}" ]; then
  printf '%s' "$ROUNDTABLE_NODE_TOKEN" > "$CONFIG_DIR/node.token"
  chmod 600 "$CONFIG_DIR/node.token"
  echo "token: written"
elif [ -f "$CONFIG_DIR/node.token" ]; then
  echo "token: reusing existing $CONFIG_DIR/node.token"
else
  echo "ERROR: no token. Enrol on the box, then re-run with ROUNDTABLE_NODE_TOKEN=..." >&2
  exit 1
fi

# ---- config ------------------------------------------------------------------
# node_id is required on a first install; on a re-install the existing config keeps it.
if [ -n "${ROUNDTABLE_NODE_ID:-}" ]; then
  NODE_ID="$ROUNDTABLE_NODE_ID"
elif [ -f "$CONFIG_DIR/config.json" ]; then
  NODE_ID="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).node_id)' "$CONFIG_DIR/config.json")"
  echo "node_id: reusing $NODE_ID"
else
  echo "ERROR: no ROUNDTABLE_NODE_ID and no existing config" >&2
  exit 1
fi

# Codex must be on PATH for the node to spawn it. Resolved at install time so the launchd agent —
# which does NOT get an interactive shell's PATH — has an absolute path.
CODEX_BIN="$(command -v codex || true)"
[ -n "$CODEX_BIN" ] || echo "WARNING: codex not on PATH; codex seats will fail until it is" >&2

cat > "$CONFIG_DIR/config.json" <<JSON
{
  "hub_url": "$HUB_URL",
  "node_id": "$NODE_ID",
  "hostname": "$(scutil --get ComputerName 2>/dev/null || hostname)",
  "os": "macos",
  "version": "0.1.0",
  "ipc_socket_path": "$DATA_DIR/ipc.sock",
  "state_path": "$DATA_DIR/state.json",
  "codex_command": ["${CODEX_BIN:-codex}", "app-server"],
  "codex_cwd": null,
  "reconnect_base_ms": 1000,
  "heartbeat_ms": 15000,
  "heartbeat_offline_after_ms": 45000
}
JSON
chmod 600 "$CONFIG_DIR/config.json"
echo "config: $CONFIG_DIR/config.json"

# ---- binary ------------------------------------------------------------------
echo "building release binary..."
( cd "$REPO_ROOT" && cargo build --release -p roundtable-node )
# Copy rather than symlink into the checkout: a rebuild mid-session would otherwise swap the
# binary under a running agent.
cp "$REPO_ROOT/target/release/roundtable-node" "$BIN_DEST"
chmod 755 "$BIN_DEST"
echo "binary: $BIN_DEST"

# ---- launchd -----------------------------------------------------------------
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>$BIN_DEST</string></array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>ROUNDTABLE_NODE_CONFIG</key><string>$CONFIG_DIR/config.json</string>
        <key>ROUNDTABLE_NODE_TOKEN_FILE</key><string>$CONFIG_DIR/node.token</string>
        <key>RUST_LOG</key><string>info</string>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>WorkingDirectory</key><string>$DATA_DIR</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>$LOG_DIR/node.out.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/node.err.log</string>
</dict>
</plist>
PLISTEOF

# bootout first so a re-install reloads cleanly; ignore the error when it was not loaded.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

echo
echo "installed. status:"
sleep 2
launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E '^\s+(state|pid|last exit)' || true
echo
echo "logs:  tail -f $LOG_DIR/node.err.log"
echo "stop:  launchctl bootout gui/$(id -u)/$LABEL"
