import type { Approval, CreatedInvite, DiscoveredSession, Invite, Message, QueuedWrite, Room, Run, RunEvent, RunInspection, Seat, ServerEvent, Task } from './types';

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...init });
  if (!response.ok) throw new ApiError(response.status, (await response.text()) || response.statusText);
  return response.status === 204 ? undefined as T : response.json();
}
export const api = {
  me: () => request<{ authenticated: true; actor_id: string }>('/api/me'),
  login: (token: string) => request<{ authenticated: true }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ token, request_id: crypto.randomUUID() }) }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST', body: JSON.stringify({ request_id: crypto.randomUUID() }) }),
  // The hub wraps every collection — {rooms}, {messages}, {seats}, {nodes} — so these unwrap.
  // Typing them as bare arrays was silently wrong: `rooms.find(...)` threw at RENDER time, which
  // React turns into a blank page with no error boundary to catch it. It stayed hidden while the
  // login screen was the first thing rendered; the moment Access authenticated the operator
  // straight into the shell, the app went white.
  rooms: async () => (await request<{ rooms: Room[] }>('/api/rooms')).rooms,
  createRoom: async (input: Pick<Room, 'slug' | 'title' | 'objective'>) => (await request<{ room: Room }>('/api/rooms', { method: 'POST', body: JSON.stringify({ ...input, request_id: crypto.randomUUID() }) })).room,
  archiveRoom: async (id: string) => (await request<{ room: Room }>(`/api/rooms/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: true, request_id: crypto.randomUUID() }) })).room,
  messages: async (id: string, beforeSeq?: number) => (await request<{ messages: Message[] }>(`/api/rooms/${id}/messages?limit=30${beforeSeq ? `&before_seq=${beforeSeq}` : ''}`)).messages,
  tasks: (roomId: string) => request<{ tasks: Task[]; runs: Run[] }>(`/api/rooms/${roomId}/tasks`),
  createTask: (roomId: string, input: Pick<Task, 'executor_seat_id' | 'title' | 'instructions'>) => request<{ task: Task; run: Run }>(`/api/rooms/${roomId}/tasks`, { method: 'POST', body: JSON.stringify({ executorSeatId: input.executor_seat_id, title: input.title, instructions: input.instructions, request_id: crypto.randomUUID() }) }),
  runEvents: async (runId: string) => (await request<{ events: RunEvent[] }>(`/api/runs/${runId}/events`)).events,
  runInspector: (runId: string) => request<RunInspection>(`/api/runs/${runId}`),
  postMessage: async (roomId: string, body: string, mentioned_seat_ids: string[], request_id: string) => (await request<{ message: Message }>(`/api/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify({ body, mentioned_seat_ids, request_id }) })).message,
  seats: async (roomId: string) => (await request<{ seats: Seat[] }>(`/api/rooms/${roomId}/seats`)).seats,
  sessions: async () => (await request<{ nodes: DiscoveredSession[] }>('/api/nodes?include_sessions=true')).nodes ?? [],
  attachSeat: async (roomId: string, session: DiscoveredSession, alias: string) => (await request<{ seat: Seat }>(`/api/rooms/${roomId}/seats`, { method: 'POST', body: JSON.stringify({ ...session, alias, request_id: crypto.randomUUID() }) })).seat,
  detachSeat: (roomId: string, seatId: string) => request<void>(`/api/rooms/${roomId}/seats/${seatId}`, { method: 'DELETE' }),
  createInvite: async (roomId: string, ttlMs?: number) => (await request<{ invite: CreatedInvite }>(`/api/rooms/${roomId}/invites`, { method: 'POST', body: JSON.stringify({ ttl_ms: ttlMs, request_id: crypto.randomUUID() }) })).invite,
  listInvites: async (roomId: string) => (await request<{ invites: Invite[] }>(`/api/rooms/${roomId}/invites`)).invites,
  revokeInvite: async (roomId: string, inviteId: string) => { await request<{ ok: boolean }>(`/api/rooms/${roomId}/invites/${inviteId}`, { method: 'DELETE' }); },
  handoff: async (roomId: string, from_seat_id: string, to_seat_id: string, summary: string, evidence_refs: unknown[], request_id: string) => (await request<{ message: Message }>(`/api/rooms/${roomId}/handoffs`, { method: 'POST', body: JSON.stringify({ from_seat_id, to_seat_id, summary, evidence_refs, request_id }) })).message,
  resolveApproval: (id: string, decision: string, request_id: string) => request<Approval>(`/api/approvals/${id}/resolve`, { method: 'POST', body: JSON.stringify({ decision, request_id }) }),
  replay: (write: QueuedWrite) => request<unknown>(write.path, { method: 'POST', body: JSON.stringify(write.body) }),
  // Reconnects. Without this, ONE drop was permanent: onclose set offline and nothing ever dialled
  // again, so the tab stayed dead until a manual reload. Cloudflare closing the idle socket at
  // ~100s made that the normal case rather than an edge case.
  //
  // Backoff is capped and jittered so a hub restart does not bring every open tab back in the same
  // millisecond. `stopped` guards against a reconnect firing after unmount.
  events(onEvent: (event: ServerEvent) => void, onState: (online: boolean) => void) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(`${protocol}//${location.host}/api/events`);
      socket.onopen = () => { attempt = 0; onState(true); };
      socket.onmessage = (event) => {
        const frame = JSON.parse(event.data);
        // Server keepalive: proves the link is live, carries nothing to render.
        if (frame?.type === 'ping') return;
        onEvent(frame);
      };
      const retry = () => {
        onState(false);
        if (stopped || timer) return;
        const delay = Math.min(30000, 1000 * 2 ** attempt++) * (0.5 + Math.random() / 2);
        timer = setTimeout(() => { timer = undefined; connect(); }, delay);
      };
      socket.onclose = retry;
      socket.onerror = retry;
    };
    connect();

    return () => { stopped = true; if (timer) clearTimeout(timer); socket?.close(); };
  },
};
