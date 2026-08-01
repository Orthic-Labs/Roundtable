import type { Approval, DiscoveredSession, Message, Room, Run, RunEvent, RunInspection, Seat, Task } from '../types';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { RunPanel } from './RunPanel';
import { SeatPanel } from './SeatPanel';

export function RoomView({ room, seats, sessions, messages, tasks = [], runs = [], runEvents = {}, runInspections = {}, approvals, online, onSend, onLoadOlder, onAttach, onDetach, onCreateTask = async () => {}, onResolve, onHandoff }: {
  room: Room; seats: Seat[]; sessions: DiscoveredSession[]; messages: Message[]; tasks?: Task[]; runs?: Run[];
  runEvents?: Record<string, RunEvent[]>; runInspections?: Record<string, RunInspection>; approvals: Approval[]; online: boolean;
  onSend: (body: string, mentions: string[]) => Promise<void>; onLoadOlder: () => Promise<void>;
  onAttach: (session: DiscoveredSession, alias: string) => Promise<void>; onDetach: (id: string) => Promise<void>;
  onCreateTask?: (input: Pick<Task, 'executor_seat_id' | 'title' | 'instructions'>) => Promise<void>;
  onResolve: (approval: Approval, decision: string) => Promise<void>; onHandoff: (target: Seat, summary: string) => Promise<void>;
}) {
  return <div className="room-view">
    <header className="room-header"><div><span className="eyebrow">Room #{room.slug}</span><h1>{room.title}</h1><p>{room.objective}</p></div><div className="seat-rail" aria-label="Seats in this room">{seats.map((seat) => <span key={seat.id}><i className={`presence ${seat.state}`} />@{seat.alias}</span>)}</div></header>
    {!online && <div className="offline" role="status">Offline — writes will replay when reconnected. Approvals and reply-with-attach are disabled.</div>}
    <main className="room-main"><MessageList messages={messages} hasOlder={messages.length > 0 && messages[0].seq > 1} onLoadOlder={onLoadOlder} /><aside><RunPanel tasks={tasks} runs={runs} events={runEvents} inspections={runInspections} seats={seats} online={online} onCreate={onCreateTask} /><SeatPanel roomId={room.id} seats={seats} sessions={sessions} onAttach={onAttach} onDetach={onDetach} />{approvals.filter((approval) => approval.room_id === room.id && approval.state === 'pending').map((approval) => <section className="panel approval" key={approval.id}><h2>Approval requested</h2><b>{approval.description}</b><pre>{approval.input_preview}</pre><div className="actions">{approval.decisions.map((decision) => <button key={decision} className={decision === 'approve' ? 'primary' : ''} disabled={!online} aria-label={`${decision} ${approval.description}`} onClick={() => onResolve(approval, decision)}>{decision}</button>)}</div></section>)}</aside></main>
    <Composer seats={seats} online={online} onSend={onSend} onHandoff={onHandoff} />
  </div>;
}
