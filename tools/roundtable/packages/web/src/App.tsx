import { useMemo, useState } from 'react';
import type { Message, Seat } from './types';
import './styles.css';

const initialSeats: Seat[] = [
  { id: 's1', alias: 'mac-claude', provider: 'claude', state: 'idle', last_seen_ms: Date.now() },
  { id: 's2', alias: 'windows-codex', provider: 'codex', state: 'running', last_seen_ms: Date.now() },
];
const initialMessages: Message[] = [
  { id: 'm1', seq: 1, actor: 'adrian', kind: 'chat', body: 'Review the cancellation contract and hand off the test to @windows-codex.', created_at_ms: Date.now() - 42000, state: 'completed' },
  { id: 'm2', seq: 2, actor: 'mac-claude', kind: 'completion', body: 'The cancellation path writes the typed state before interrupting the provider. The partial output remains auditable.', created_at_ms: Date.now() - 18000, state: 'completed' },
  { id: 'm3', seq: 3, actor: 'windows-codex', kind: 'progress', body: 'Running the interrupt-before-write regression test.', created_at_ms: Date.now() - 4000, state: 'running' },
];

function formatTime(ms: number) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

export default function App() {
  const [seats, setSeats] = useState(initialSeats);
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState('');
  const [online, setOnline] = useState(true);
  const [approval, setApproval] = useState(true);
  const mentions = useMemo(() => seats.filter((seat) => draft.includes(`@${seat.alias}`)), [draft, seats]);

  function send() {
    const body = draft.trim();
    if (!body) return;
    setMessages((current) => [...current, { id: crypto.randomUUID(), seq: current.length + 1, actor: 'adrian', kind: 'chat', body, created_at_ms: Date.now(), state: online ? 'completed' : 'queued' }]);
    setDraft('');
  }

  return <div className="app">
    {!online && <div className="offline" role="status">Offline — writes will replay when reconnected. Approvals and reply-with-attach are disabled.</div>}
    <header className="rail"><div className="wordmark">Round<span>table</span></div><div className="seats" aria-label="Seats in this room">{seats.map((seat) => <div className="seat" key={seat.id}><i className={`dot ${seat.state}`} aria-hidden="true"/><b>@{seat.alias}</b><small>{seat.provider} · {seat.state}</small></div>)}</div><div className="rail-right"><button className="connection" onClick={() => setOnline((value) => !value)} aria-label="Toggle connection"><i/> {online ? 'hub live' : 'offline'}</button><span className="mono">#r-72a1</span></div></header>
    <div className="room-meta"><span><em>objective</em> cross-device cancellation proof</span><span><em>handoff depth</em> 2 / 8</span><span><em>open handoffs</em> 1</span><span><em>dead-letter</em> 0 / 30</span></div>
    <main><section className="transcript" aria-label="Room transcript">{messages.map((message) => <article className={`turn ${message.kind}`} key={message.id}><div className="kind">{message.kind}</div><div className="bubble"><div className="who"><b>{message.actor}</b><span className="mono">{formatTime(message.created_at_ms)}</span></div><div>{message.body}</div>{message.state && <span className={`state ${message.state}`}>{message.state}</span>}</div></article>)}</section>
      <aside><section className="panel"><h2>Wake envelope</h2><div className="chips"><span>from @user</span><span>→</span>{mentions.length ? mentions.map((seat) => <strong key={seat.id}>@{seat.alias}</strong>) : <span className="muted">no selected target</span>}</div><div className="evidence"><b>evidence refs digest</b><br/>commit: e03add00<br/>test: cargo test -p roundtable-hub</div></section>{approval && <section className="panel approval"><h2>Approval requested</h2><code>cancel delivery d-7af3 from @mac-claude</code><p className="muted">Partial outputs remain. The protocol does not undo prior actions.</p><div className="actions"><button className="primary" disabled={!online} onClick={() => setApproval(false)}>Approve</button><button disabled={!online} onClick={() => setApproval(false)}>Reject</button></div></section>}<section className="panel hub-info"><h2>Hub</h2><p>lease · 10m</p><p>WAL · synchronous=NORMAL</p><p>nodes · mac-01, win-01</p></section></aside>
    </main>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); send(); }}><textarea aria-label="Message room" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Message @claude or @codex…"/><span className="hint mono">/handoff @windows-codex</span><button className="primary" type="submit">Send</button></form>
    <footer><span>node mac-01 · present</span><span>node win-01 · present</span><span>events · 1,284 today</span><span className="ok">{online ? 'all nodes within lease window' : 'writes queued locally'}</span></footer>
  </div>;
}
