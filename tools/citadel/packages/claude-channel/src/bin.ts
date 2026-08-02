#!/usr/bin/env node
/**
 * stdio entrypoint so a Claude session can load this package as an MCP server.
 * The library exported runStdioServer but nothing called it, so the channel's tools
 * (including citadel_join) were unreachable from any session.
 *
 * The pipe/socket name is runtime-frozen: \\.\pipe\roundtable-<node_id> on Windows.
 * It is derived from the node's own config so the two can never drift; CITADEL_IPC_PATH
 * overrides for local fixtures.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runStdioServer } from "./index.js";

function defaultConfigPath(): string {
  const appData = process.env.APPDATA;
  if (process.platform === "win32" && appData) return join(appData, "Roundtable", "config.json");
  return join(homedir(), ".config", "roundtable", "config.json");
}

function resolveSocketPath(): string {
  const override = process.env.CITADEL_IPC_PATH;
  if (override) return override;
  const cfgPath = process.env.CITADEL_NODE_CONFIG || process.env.ROUNDTABLE_NODE_CONFIG || defaultConfigPath();
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { ipc_socket_path?: string };
  if (!cfg.ipc_socket_path) throw new Error(`no ipc_socket_path in ${cfgPath}`);
  return cfg.ipc_socket_path;
}

runStdioServer({ socketPath: resolveSocketPath() }).catch((err) => {
  // stdout is the MCP transport, so diagnostics must go to stderr.
  console.error(`claude-channel failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
