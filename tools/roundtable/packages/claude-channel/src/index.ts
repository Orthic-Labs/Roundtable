import { hostname } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { IpcClient } from "./ipc.js";
import {
  SessionJoinParams, SessionLeaveParams, TranscriptReadParams,
  TranscriptSearchParams, MessageReplyParams, HandoffCreateParams, RunCreateParams, ApprovalVerdictParams,
  InviteRedeemParams,
} from "./schemas.js";

/**
 * This channel has no existing per-session identity it passes to the node for other tools
 * (session_join here sends only room_id/seat_id). So citadel_join derives one itself: an
 * operator-supplied CITADEL_SESSION_REF env var wins if set, otherwise a stable per-process id.
 * Never logs the invite code plaintext.
 */
function deriveSessionRef(): string {
  return process.env.CITADEL_SESSION_REF || `claude-${hostname()}-${process.pid}`;
}

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
    "roundtable_delegate",
    "Create a durable child task/run for another seat (Citadel run.create / delegate). Returns run_id after hub commit.",
    {
      from_seat_id: z.string().uuid(),
      executor_alias: z.string().min(1),
      title: z.string().min(1).max(512),
      instructions: z.string().min(1).max(64 * 1024),
    },
    async (args) => {
      const p = RunCreateParams.parse(args);
      const resp = await client.request("run_create", p as unknown as Record<string, unknown>);
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

  server.tool(
    "citadel_join",
    "Redeem a Citadel invite code to join a Roundtable room as a Claude seat.",
    { code: z.string().min(1), alias: z.string().optional() },
    async (args) => {
      const p = InviteRedeemParams.parse({
        code: args.code,
        alias: args.alias,
        session_ref: deriveSessionRef(),
        provider: "claude",
      });
      const resp = await client.request("redeem_invite", p as unknown as Record<string, unknown>);
      if (!resp.ok) {
        return { content: [{ type: "text", text: `invite redemption failed: ${resp.error ?? "unknown_error"}` }], isError: true };
      }
      const seat = (resp.payload as Record<string, unknown>).alias ?? (resp.payload as Record<string, unknown>).seat_id ?? "seat";
      return { content: [{ type: "text", text: `Joined as ${String(seat)}. ${JSON.stringify(resp.payload)}` }] };
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
