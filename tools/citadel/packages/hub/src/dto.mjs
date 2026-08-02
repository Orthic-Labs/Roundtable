// Row → API DTO mappers for the operator PWA contract.
// The SQLite schema and the PWA types intentionally differ on a few fields; every HTTP/WS
// response passes through here so the two sides cannot drift silently again.

/** Sentinel stored in events.target_node_id for browser-only replay. */
export const OPERATOR_TARGET = '__operator__';

export function toRoom(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    objective: row.objective,
    next_seq: row.next_seq,
    ...(row.archived_at_ms != null ? { archived_at: row.archived_at_ms } : {}),
  };
}

export function toSeat(row) {
  if (!row) return null;
  return {
    id: row.id,
    room_id: row.room_id,
    node_id: row.node_id,
    alias: row.alias,
    provider: row.provider,
    session_ref: row.session_ref,
    state: row.state,
    last_seen_ms: row.last_seen_ms,
    last_ack_seq: row.last_ack_seq,
  };
}

export function toApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    room_id: row.room_id,
    seat_id: row.seat_id,
    description: row.description,
    input_preview: row.input_preview ?? '',
    decisions: typeof row.decisions_json === 'string'
      ? JSON.parse(row.decisions_json)
      : (row.decisions ?? []),
    state: row.state,
    ...(row.resolution != null ? { resolution: row.resolution } : {}),
  };
}

export function toTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    room_id: row.room_id,
    ...(row.requested_by_seat_id != null ? { requested_by_seat_id: row.requested_by_seat_id } : {}),
    executor_seat_id: row.executor_seat_id,
    title: row.title,
    instructions: row.instructions,
    state: row.state,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  };
}

export function toRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    room_id: row.room_id,
    executor_seat_id: row.executor_seat_id,
    delivery_id: row.delivery_id,
    state: row.state,
    observability_grade: row.observability_grade,
    ...(row.reasoning_model != null ? { reasoning_model: row.reasoning_model } : {}),
    ...(row.execution_runtime != null ? { execution_runtime: row.execution_runtime } : {}),
    ...(row.tool_executor != null ? { tool_executor: row.tool_executor } : {}),
    ...(row.error_code != null ? { error_code: row.error_code } : {}),
    ...(row.started_at_ms != null ? { started_at_ms: row.started_at_ms } : {}),
    ...(row.finished_at_ms != null ? { finished_at_ms: row.finished_at_ms } : {}),
  };
}

export function toRunEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    run_id: row.run_id,
    seq: row.seq,
    type: row.type,
    payload: row.payload ?? (row.payload_json ? JSON.parse(row.payload_json) : {}),
    created_at_ms: row.created_at_ms,
  };
}

/**
 * @param {object} row message row
 * @param {object} ctx seatById, handoffByMessageId, deliveryStateByMessageId
 */
export function toMessage(row, ctx = {}) {
  if (!row) return null;
  const seat = ctx.seatById?.get(row.actor_id);
  const actor = row.actor_kind === 'human'
    ? (ctx.humanActor ?? 'adrian')
    : (seat?.alias ?? row.actor_id);
  const handoff = ctx.handoffByMessageId?.get(row.id);
  const out = {
    id: row.id,
    room_id: row.room_id,
    seq: row.seq,
    actor_id: row.actor_id,
    actor,
    actor_kind: row.actor_kind,
    kind: row.kind,
    body: row.body,
    mentioned_seat_ids: ctx.mentionedSeatIds ?? [],
    created_at_ms: row.created_at_ms,
  };
  if (row.reply_to) out.reply_to = row.reply_to;
  const deliveryState = ctx.deliveryStateByMessageId?.get(row.id);
  if (deliveryState) out.delivery_state = deliveryState;
  if (handoff) {
    out.handoff = {
      from_alias: handoff.from_alias,
      to_alias: handoff.to_alias,
      summary: row.body,
      evidence_refs: handoff.evidence_refs,
    };
  }
  return out;
}

export function toDiscoveredSession(node, seat) {
  return {
    node_id: node.id,
    node_name: node.name,
    provider: seat.provider,
    session_ref: seat.session_ref,
    title: seat.title ?? seat.session_ref,
    ...(seat.attached_seat_id ? { attached_seat_id: seat.attached_seat_id } : {}),
  };
}

/** Normalize inbound mutation bodies that historically used mixed camelCase/snake_case. */
export function normalizePostMessage(body = {}) {
  return {
    request_id: body.request_id,
    body: body.body,
    kind: body.kind ?? 'chat',
    reply_to: body.reply_to ?? body.replyTo ?? null,
    mentionSeatIds: body.mentioned_seat_ids ?? body.mentionSeatIds ?? [],
    actorId: body.actorId ?? body.actor_id ?? 'human',
  };
}

export function normalizeCreateSeat(body = {}) {
  return {
    request_id: body.request_id,
    roomId: body.roomId,
    nodeId: body.node_id ?? body.nodeId,
    alias: body.alias,
    provider: body.provider,
    sessionRef: body.session_ref ?? body.sessionRef,
  };
}

export function normalizeCreateHandoff(body = {}) {
  return {
    request_id: body.request_id,
    fromSeatId: body.from_seat_id ?? body.fromSeatId,
    toSeatId: body.to_seat_id ?? body.toSeatId,
    summary: body.summary ?? body.body,
    evidence: {
      refs: Array.isArray(body.evidence_refs) ? body.evidence_refs
        : (Array.isArray(body.evidence?.refs) ? body.evidence.refs : []),
    },
  };
}

export function normalizeResolveApproval(body = {}) {
  return body.decision ?? body.resolution;
}

export function normalizeCreateTask(body = {}) {
  return {
    request_id: body.request_id,
    executorSeatId: body.executor_seat_id ?? body.executorSeatId,
    title: body.title,
    instructions: body.instructions,
    requestedBySeatId: body.requested_by_seat_id ?? body.requestedBySeatId ?? null,
  };
}
