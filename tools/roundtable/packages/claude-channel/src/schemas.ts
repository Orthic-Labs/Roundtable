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
export const TranscriptReadParams = z.object({
  room_id: z.string().uuid(),
  since_seq: z.number().int().nonnegative().default(0),
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
export const HandoffCreateParams = z.object({
  from_seat_id: z.string().uuid(),
  to_seat_id: z.string().uuid(),
  body: z.string().min(1).max(64 * 1024),
  evidence_refs: z.array(z.string()).default([]),
});
export const ApprovalVerdictParams = z.object({
  approval_id: z.string().uuid(),
  decision: z.string().min(1),
});
