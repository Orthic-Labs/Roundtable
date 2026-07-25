import type { Approval, DiscoveredSession, Message, QueuedWrite, Room, Seat, ServerEvent } from './types';

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
  rooms: () => request<Room[]>('/api/rooms'),
  createRoom: (input: Pick<Room, 'slug' | 'title' | 'objective'>) => request<Room>('/api/rooms', { method: 'POST', body: JSON.stringify({ ...input, request_id: crypto.randomUUID() }) }),
  archiveRoom: (id: string) => request<Room>(`/api/rooms/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: true, request_id: crypto.randomUUID() }) }),
  messages: (id: string, beforeSeq?: number) => request<Message[]>(`/api/rooms/${id}/messages?limit=30${beforeSeq ? `&before_seq=${beforeSeq}` : ''}`),
  postMessage: (roomId: string, body: string, mentioned_seat_ids: string[], request_id: string) => request<Message>(`/api/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify({ body, mentioned_seat_ids, request_id }) }),
  seats: (roomId: string) => request<Seat[]>(`/api/rooms/${roomId}/seats`),
  sessions: () => request<DiscoveredSession[]>('/api/nodes?include_sessions=true'),
  attachSeat: (roomId: string, session: DiscoveredSession, alias: string) => request<Seat>(`/api/rooms/${roomId}/seats`, { method: 'POST', body: JSON.stringify({ ...session, alias, request_id: crypto.randomUUID() }) }),
  detachSeat: (roomId: string, seatId: string) => request<void>(`/api/rooms/${roomId}/seats/${seatId}`, { method: 'DELETE' }),
  handoff: (roomId: string, from_seat_id: string, to_seat_id: string, summary: string, evidence_refs: unknown[], request_id: string) => request<Message>(`/api/rooms/${roomId}/handoffs`, { method: 'POST', body: JSON.stringify({ from_seat_id, to_seat_id, summary, evidence_refs, request_id }) }),
  resolveApproval: (id: string, decision: string, request_id: string) => request<Approval>(`/api/approvals/${id}/resolve`, { method: 'POST', body: JSON.stringify({ decision, request_id }) }),
  replay: (write: QueuedWrite) => request<unknown>(write.path, { method: 'POST', body: JSON.stringify(write.body) }),
  events(onEvent: (event: ServerEvent) => void, onState: (online: boolean) => void) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/api/events`);
    socket.onopen = () => onState(true);
    socket.onclose = () => onState(false);
    socket.onerror = () => onState(false);
    socket.onmessage = event => onEvent(JSON.parse(event.data));
    return () => socket.close();
  },
};
