import { useState } from 'react';
import type { Approval, DiscoveredSession, Message, Room, Run, RunEvent, RunInspection, Seat, Task } from '../types';
import { Composer } from './Composer';
import { InviteQuick } from './InvitePanel';
import { MessageList } from './MessageList';
import { RunPanel } from './RunPanel';
import { SeatPanel } from './SeatPanel';

const AV: Record<string, string> = { claude: 'av-claude', codex: 'av-codex', cdx: 'av-codex' };

/** V1 "cockpit strip": seats + quick actions live in one compact strip under the header; the
 *  transcript owns the full width; tasks/attach/approvals live in a drawer opened on demand.
 *  A pending approval force-opens the drawer — action required beats minimalism. */
export function RoomView({ room, seats, sessions, messages, tasks = [], runs = [], runEvents = {}, runInspections = {}, approvals, online, onSend, onLoadOlder, onAttach, onDetach, onCreateTask = async () => {}, onResolve, onHandoff }: {
  room: Room; seats: Seat[]; sessions: DiscoveredSession[]; messages: Message[]; tasks?: Task[]; runs?: Run[];
  runEvents?: Record<string, RunEvent[]>; runInspections?: Record<string, RunInspection>; approvals: Approval[]; online: boolean;
  onSend: (body: string, mentions: string[]) => Promise<void>; onLoadOlder: () => Promise<void>;
  onAttach: (session: DiscoveredSession, alias: string) => Promise<void>; onDetach: (id: string) => Promise<void>;
  onCreateTask?: (input: Pick<Task, 'executor_seat_id' | 'title' | 'instructions'>) => Promise<void>;
  onResolve: (approval: Approval, decision: string) => Promise<void>; onHandoff: (target: Seat, summary: string) => Promise<void>;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pending = approvals.filter((approval) => approval.room_id === room.id && approval.state === 'pending');
  const showDrawer = drawerOpen || pending.length > 0;
  const runningCount = runs.filter((run) => run.state === 'running' || run.state === 'waiting_approval').length;
  return <div className="room-view">
    <header className="room-header"><div className="room-id"><div className="room-title-row"><h1>{room.title}</h1><span className="room-slug">#{room.slug}</span></div>{room.objective && <p className="objective" title={room.objective}>{room.objective}</p>}</div></header>
    <div className="seat-strip" aria-label="Seats in this room">
      {seats.map((seat) => <span className={`seat-chip ${seat.state}`} key={seat.id} title={`${seat.provider}${seat.model ? ` · ${seat.model}` : ''} · ${seat.state}`}>
        <i className={`av ${AV[seat.provider] ?? 'av-other'}`} aria-hidden="true">{seat.alias.charAt(0).toUpperCase()}</i>
        @{seat.alias}
        <i className={`presence ${seat.state}`} />
        <button className="chip-x" aria-label={`Remove ${seat.alias}`} onClick={() => onDetach(seat.id)}>×</button>
      </span>)}
      <InviteQuick roomId={room.id} />
      <button className={`strip-btn drawer-toggle ${pending.length ? 'alert' : ''}`} aria-expanded={showDrawer} onClick={() => setDrawerOpen((open) => !open)}>
        {pending.length ? `Approvals · ${pending.length}` : `Tasks${runningCount ? ` · ${runningCount}` : ''}`} {showDrawer ? '▾' : '▸'}
      </button>
    </div>
    {!online && <div className="offline" role="status">Offline — writes will replay when reconnected. Approvals and reply-with-attach are disabled.</div>}
    <main className={`room-main ${showDrawer ? 'with-drawer' : ''}`}>
      <MessageList messages={messages} seats={seats} hasOlder={messages.length > 0 && messages[0].seq > 1} onLoadOlder={onLoadOlder} />
      {showDrawer && <aside>
        {pending.map((approval) => <section className="panel approval" key={approval.id}><h2>Approval requested</h2><b>{approval.description}</b><pre>{approval.input_preview}</pre><div className="actions">{approval.decisions.map((decision) => <button key={decision} className={decision === 'approve' ? 'primary' : ''} disabled={!online} aria-label={`${decision} ${approval.description}`} onClick={() => onResolve(approval, decision)}>{decision}</button>)}</div></section>)}
        <RunPanel tasks={tasks} runs={runs} events={runEvents} inspections={runInspections} seats={seats} online={online} onCreate={onCreateTask} />
        <SeatPanel roomId={room.id} seats={seats} sessions={sessions} onAttach={onAttach} onDetach={onDetach} />
      </aside>}
    </main>
    <Composer seats={seats} online={online} onSend={onSend} onHandoff={onHandoff} />
  </div>;
}
