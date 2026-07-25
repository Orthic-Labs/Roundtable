import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { IpcClient } from "./ipc.js";
import {
  SessionJoinParams, SessionLeaveParams, TranscriptReadParams,
  TranscriptSearchParams, MessageReplyParams, HandoffCreateParams, ApprovalVerdictParams,
} from "./schemas.js";

export interface ClaudeChannelOptions {
  socketPath: string;
}

export function createChannel(opts: ClaudeChannelOptions): { server: McpServer; client: IpcClient } {
  const client = new IpcClient({ socketPath: opts.socketPath });
  const server = new McpServer({ name: "roundtable-claude-channel", version: "0.1.0" });

  server.tool(
    "roundtable_join",
    "Join a Roundtable room by room_id. Optional seat_id pins the session to a specific seat.",
    { room_id: z.string().uuid(), seat_id: z.string().uuid().optional() },
    async (args) => {
      const p = SessionJoinParams.parse(args);
      const resp = await client.request("session_join", p as unknown as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(resp) }] };
    },
  );
  server.tool(
    "roundtable_leave",
    "Leave a Roundtable room by room_id.",
    { room_id: z.string().uuid() },
    async (args) => {
      const p = SessionLeaveParams.parse(args);
      const resp = await client.request("session_leave", p as unknown as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(resp) }] };
    },
  );
  server.tool(
    "roundtable_read",
    "Read transcript messages for a room after an optional seq.",
    { room_id: z.string().uuid(), after_seq: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(500).default(100) },
    async (args) => {
      const p = TranscriptReadParams.parse(args);
      const resp = await client.request("transcript_read", p as unknown as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(resp) }] };
    },
  );
  server.tool(
    "roundtable_search",
    "Search transcript messages in a room.",
    { room_id: z.string().uuid(), query: z.string().min(1), limit: z.number().int().positive().max(50).default(20) },
    async (args) => {
      const p = TranscriptSearchParams.parse(args);
      const resp = await client.request("transcript_search", p as unknown as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(resp) }] };
    },
  );
  server.tool(
    "roundtable_reply",
    "Post a message reply from a seat in a room.",
    { room_id: z.string().uuid(), seat_id: z.string().uuid(), body: z.string().min(1).max(64 * 1024), reply_to: z.string().uuid().optional() },
    async (args) => {
      const p = MessageReplyParams.parse(args);
      const resp = await client.request("message_reply", p as unknown as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(resp) }] };
    },
  );
  server.tool(
    "roundtable_handoff",
    "Hand off a task to another seat in the room, addressed by its alias.",
    { from_seat_id: z.string().uuid(), to_alias: z.string().min(1), body: z.string().min(1).max(64 * 1024), evidence_refs: z.array(z.string()).default([]) },
    async (args) => {
      const p = HandoffCreateParams.parse(args);
      const resp = await client.request("handoff_create", p as unknown as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(resp) }] };
    },
  );
  server.tool(
    "roundtable_approval",
    "Submit an approval verdict for a pending approval request.",
    { approval_id: z.string().uuid(), decision: z.string().min(1) },
    async (args) => {
      const p = ApprovalVerdictParams.parse(args);
      const resp = await client.request("approval_verdict", p as unknown as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(resp) }] };
    },
  );

  return { server, client };
}

export async function runStdioServer(opts: ClaudeChannelOptions): Promise<void> {
  const { server, client } = createChannel(opts);
  await client.connect();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
