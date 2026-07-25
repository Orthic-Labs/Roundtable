import { z } from "zod";

export const IpcMethod = z.enum([
  "session_join",
  "session_leave",
  "transcript_read",
  "transcript_search",
  "message_reply",
  "handoff_create",
  "approval_verdict",
  "ping",
]);
export type IpcMethodT = z.infer<typeof IpcMethod>;

export const IpcRequestSchema = z.object({
  request_id: z.string().uuid(),
  method: IpcMethod,
  params: z.record(z.unknown()).default({}),
});
export type IpcRequestT = z.infer<typeof IpcRequestSchema>;

export const IpcResponseSchema = z.object({
  request_id: z.string().uuid(),
  ok: z.boolean(),
  payload: z.record(z.unknown()).default({}),
  error: z.string().optional(),
});
export type IpcResponseT = z.infer<typeof IpcResponseSchema>;

export const SessionJoinParams = z.object({
  room_id: z.string().uuid(),
  seat_id: z.string().uuid().optional(),
});
export const SessionLeaveParams = z.object({
  room_id: z.string().uuid(),
});
// `after_seq`, not `since_seq`: the node's IpcRequest::TranscriptRead field is `after_seq`, and
// because it is an Option that serde fills with None for an absent key, sending the wrong name
// failed SILENTLY — every read started from 0 and paging never advanced. Keep these names welded
// to crates/roundtable-node/src/ipc.rs.
export const TranscriptReadParams = z.object({
  room_id: z.string().uuid(),
  after_seq: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(500).default(100),
});
export const TranscriptSearchParams = z.object({
  room_id: z.string().uuid(),
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).default(20),
});
export const MessageReplyParams = z.object({
  room_id: z.string().uuid(),
  seat_id: z.string().uuid(),
  body: z.string().min(1).max(64 * 1024),
  reply_to: z.string().uuid().optional(),
});
// The target is an ALIAS, not a seat UUID. An agent in a room knows the other seats by the names
// it sees in the transcript ("reviewer"), never by UUID, and the node resolves the alias against a
// roster it reads from the hub per handoff. This previously declared `to_seat_id`, which the node
// rejected outright as a missing required field.
export const HandoffCreateParams = z.object({
  from_seat_id: z.string().uuid(),
  to_alias: z.string().min(1),
  body: z.string().min(1).max(64 * 1024),
  evidence_refs: z.array(z.string()).default([]),
});
export const ApprovalVerdictParams = z.object({
  approval_id: z.string().uuid(),
  decision: z.string().min(1),
});
