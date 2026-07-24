export type SeatState = 'detached' | 'offline' | 'idle' | 'running' | 'waiting_approval' | 'error';
export type MessageKind = 'chat' | 'question' | 'progress' | 'completion' | 'handoff' | 'approval' | 'system';
export type Seat = { id: string; alias: string; provider: 'claude' | 'codex'; state: SeatState; last_seen_ms: number };
export type Message = { id: string; seq: number; actor: string; kind: MessageKind; body: string; created_at_ms: number; state?: 'queued' | 'running' | 'completed' | 'failed' };
export type Room = { id: string; slug: string; title: string; objective: string; next_seq: number; archived_at?: number };
