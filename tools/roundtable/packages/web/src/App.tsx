import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { offlineStore } from './offline';
import { Login } from './components/Login';
import { RoomList } from './components/RoomList';
import { RoomView } from './components/RoomView';
import type { Approval, DiscoveredSession, Message, Room, Run, RunEvent, RunInspection, Seat, ServerEvent, Task } from './types';
import './styles.css';

const emptyByRoom = <T,>(): Record<string, T[]> => ({});

export default function App() {
  const [auth, setAuth] = useState<'loading' | 'out' | 'in'>('loading');
  const [rooms, setRooms] = useState<Room[]>([]); const [activeId, setActiveId] = useState<string>();
  const [messages, setMessages] = useState<Record<string, Message[]>>(emptyByRoom);
  const [seats, setSeats] = useState<Record<string, Seat[]>>(emptyByRoom);
  const [tasks, setTasks] = useState<Record<string, Task[]>>(emptyByRoom);
  const [runs, setRuns] = useState<Record<string, Run[]>>(emptyByRoom);
  const [runEvents, setRunEvents] = useState<Record<string, RunEvent[]>>(emptyByRoom);
  const [runInspections, setRunInspections] = useState<Record<string, RunInspection>>({});
  const [sessions, setSessions] = useState<DiscoveredSession[]>([]); const [approvals, setApprovals] = useState<Approval[]>([]);
  const [online, setOnline] = useState(navigator.onLine); const active = rooms.find((room) => room.id === activeId);

  const load = useCallback(async () => {
    const loadedRooms = await api.rooms(); setRooms(loadedRooms); setActiveId((id) => id || loadedRooms.find((room) => !room.archived_at)?.id); setSessions(await api.sessions());
    for (const room of loadedRooms.filter((entry) => !entry.archived_at)) {
      const [roomMessages, roomSeats, work] = await Promise.all([api.messages(room.id), api.seats(room.id), api.tasks(room.id)]);
      const inspections = await Promise.all(work.runs.map((run) => api.runInspector(run.id)));
      setMessages((value) => ({ ...value, [room.id]: roomMessages })); setSeats((value) => ({ ...value, [room.id]: roomSeats })); setTasks((value) => ({ ...value, [room.id]: work.tasks })); setRuns((value) => ({ ...value, [room.id]: work.runs }));
      setRunEvents((value) => ({ ...value, ...Object.fromEntries(inspections.map((inspection) => [inspection.run.id, inspection.events])) }));
      setRunInspections((value) => ({ ...value, ...Object.fromEntries(inspections.map((inspection) => [inspection.run.id, inspection])) }));
    }
  }, []);

  useEffect(() => { api.me().then(() => { setAuth('in'); return load(); }).catch(async () => { setAuth('out'); const cache = await offlineStore.loadSnapshot().catch(() => undefined); if (cache) { setRooms(cache.rooms); setMessages(cache.messages); setSeats(cache.seats); setApprovals(cache.approvals); } }); }, [load]);
  const handleEvent = useCallback((event: ServerEvent) => { if (event.type === 'seat.presence') { const seat = event.payload as unknown as Seat; setSeats((value) => ({ ...value, [seat.room_id]: (value[seat.room_id] || []).map((old) => old.id === seat.id ? { ...old, ...seat } : old) })); } if (event.type === 'delivery.state') { const payload = event.payload as { room_id: string; message_id: string; state: Message['delivery_state'] }; setMessages((value) => ({ ...value, [payload.room_id]: (value[payload.room_id] || []).map((message) => message.id === payload.message_id ? { ...message, delivery_state: payload.state } : message) })); } if (event.type === 'message.posted') { const message = event.payload as unknown as Message; setMessages((value) => ({ ...value, [message.room_id]: [...(value[message.room_id] || []).filter((old) => old.id !== message.id), message].sort((a, b) => a.seq - b.seq) })); } if (event.type === 'approval.requested') setApprovals((value) => [...value, event.payload as unknown as Approval]); }, []);
  useEffect(() => { if (auth !== 'in') return; return api.events(handleEvent, async (connected) => { setOnline(connected); if (connected) { for (const write of await offlineStore.list().catch(() => [])) { try { await api.replay(write); await offlineStore.remove(write.request_id); } catch { break; } } } }); }, [auth, handleEvent]);
  useEffect(() => { if (auth === 'in') offlineStore.saveSnapshot({ rooms, messages, seats, approvals }).catch(() => undefined); }, [auth, rooms, messages, seats, approvals]);
  const actions = useMemo(() => ({
    create: async (input: Pick<Room, 'slug' | 'title' | 'objective'>) => { const room = await api.createRoom(input); setRooms((value) => [...value, room]); setActiveId(room.id); setMessages((value) => ({ ...value, [room.id]: [] })); setSeats((value) => ({ ...value, [room.id]: [] })); setTasks((value) => ({ ...value, [room.id]: [] })); setRuns((value) => ({ ...value, [room.id]: [] })); },
    archive: async (id: string) => { const room = await api.archiveRoom(id); setRooms((value) => value.map((entry) => entry.id === id ? room : entry)); if (activeId === id) setActiveId(rooms.find((entry) => entry.id !== id && !entry.archived_at)?.id); },
    send: async (body: string, mentioned_seat_ids: string[]) => { if (!active) return; const request_id = crypto.randomUUID(); const optimistic: Message = { id: request_id, room_id: active.id, seq: active.next_seq, actor_id: 'human', actor: 'adrian', actor_kind: 'human', kind: 'chat', body, mentioned_seat_ids, created_at_ms: Date.now(), pending: true, delivery_state: 'queued' }; setMessages((value) => ({ ...value, [active.id]: [...(value[active.id] || []), optimistic] })); if (!online) { await offlineStore.enqueue({ request_id, kind: 'message', path: `/api/rooms/${active.id}/messages`, body: { body, mentioned_seat_ids, request_id }, created_at_ms: Date.now(), attempt_at_ms: Date.now() }); return; } const posted = await api.postMessage(active.id, body, mentioned_seat_ids, request_id); setMessages((value) => ({ ...value, [active.id]: (value[active.id] || []).map((message) => message.id === request_id ? posted : message) })); },
    older: async () => { if (!active) return; const current = messages[active.id] || []; const older = await api.messages(active.id, current[0]?.seq); setMessages((value) => ({ ...value, [active.id]: [...older, ...current] })); },
    attach: async (session: DiscoveredSession, alias: string) => { if (!active) return; const seat = await api.attachSeat(active.id, session, alias); setSeats((value) => ({ ...value, [active.id]: [...(value[active.id] || []), seat] })); },
    detach: async (id: string) => { if (!active) return; await api.detachSeat(active.id, id); setSeats((value) => ({ ...value, [active.id]: (value[active.id] || []).filter((seat) => seat.id !== id) })); },
    createTask: async (input: Pick<Task, 'executor_seat_id' | 'title' | 'instructions'>) => { if (!active) return; const created = await api.createTask(active.id, input); setTasks((value) => ({ ...value, [active.id]: [...(value[active.id] || []), created.task] })); setRuns((value) => ({ ...value, [active.id]: [...(value[active.id] || []), created.run] })); setRunEvents((value) => ({ ...value, [created.run.id]: [] })); setRunInspections((value) => ({ ...value, [created.run.id]: { run: created.run, events: [], artifacts: [], lineage: { task_id: created.task.id, delegated_from_seat_id: created.task.requested_by_seat_id ?? null, executor_seat_id: created.run.executor_seat_id } } })); },
    resolve: async (approval: Approval, decision: string) => { const resolved = await api.resolveApproval(approval.id, decision, crypto.randomUUID()); setApprovals((value) => value.map((entry) => entry.id === approval.id ? resolved : entry)); },
    handoff: async (target: Seat, summary: string) => { if (!active) return; const source = (seats[active.id] || [])[0]; if (!source) return; const posted = await api.handoff(active.id, source.id, target.id, summary, [], crypto.randomUUID()); setMessages((value) => ({ ...value, [active.id]: [...(value[active.id] || []), posted] })); },
  }), [active, activeId, rooms, messages, seats, online]);
  if (auth === 'loading') return <div className="loading" role="status">Loading Roundtable…</div>;
  if (auth === 'out') return <Login onLogin={async (token) => { await api.login(token); setAuth('in'); await load(); }} />;
  return <div className="shell"><header className="topbar"><div className="wordmark">Round<span>table</span></div><span className={`connection ${online ? 'live' : 'lost'}`}>{online ? 'Hub live' : 'Offline'}</span><button onClick={async () => { await api.logout(); setAuth('out'); }}>Sign out</button></header><div className="workspace"><RoomList rooms={rooms} activeId={activeId} onSelect={setActiveId} onCreate={actions.create} onArchive={actions.archive} />{active ? <RoomView room={active} seats={seats[active.id] || []} sessions={sessions} messages={messages[active.id] || []} tasks={tasks[active.id] || []} runs={runs[active.id] || []} runEvents={runEvents} runInspections={runInspections} approvals={approvals} online={online} onSend={actions.send} onLoadOlder={actions.older} onAttach={actions.attach} onDetach={actions.detach} onCreateTask={actions.createTask} onResolve={actions.resolve} onHandoff={actions.handoff} /> : <main className="empty"><h1>Create a room</h1><p>Attach a local session and begin a cross-device conversation.</p></main>}</div></div>;
}
