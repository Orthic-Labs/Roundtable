import { useState } from 'react'; import type { DiscoveredSession, Seat } from '../types'; import { InvitePanel } from './InvitePanel';

const AV: Record<string, string> = { claude: 'av-claude', codex: 'av-codex', cdx: 'av-codex' };

export function SeatPanel({ roomId, seats, sessions, onAttach, onDetach }: { roomId: string; seats: Seat[]; sessions: DiscoveredSession[]; onAttach: (s: DiscoveredSession, a: string) => Promise<void>; onDetach: (id: string) => Promise<void> }) {
  const [alias, setAlias] = useState('');
  return <section className="panel">
    <h2>Seats</h2>
    <ul className="seat-list">{seats.map((s) => <li className="seat-card" key={s.id}>
      <span className={`av ${AV[s.provider] ?? 'av-other'}`} aria-hidden="true">{s.alias.charAt(0).toUpperCase()}</span>
      <span className="seat-id"><b>@{s.alias}</b><small>{s.provider}{s.model ? ` · ${s.model}` : ''}</small></span>
      <span className={`seat-state ${s.state}`} aria-label={`${s.alias} ${s.state}`}><i className={`presence ${s.state}`} />{s.state}</span>
      <button className="ghost" aria-label={`Detach ${s.alias}`} onClick={() => onDetach(s.id)}>Detach</button>
    </li>)}</ul>
    {!seats.length && <p className="muted">No seats yet — attach a session or invite an agent.</p>}
    <details><summary>Attach session</summary><label>Seat alias<input value={alias} onChange={(e) => setAlias(e.target.value)} pattern="[a-z0-9-]+" placeholder="mac-claude" /></label>{sessions.filter((s) => !s.attached_seat_id).map((s) => <button className="session" key={s.session_ref} disabled={!alias} onClick={() => onAttach(s, alias)}><b>{s.title}</b><small>{s.node_name} · {s.provider}</small></button>)}</details>
    <InvitePanel roomId={roomId} />
  </section>;
}
