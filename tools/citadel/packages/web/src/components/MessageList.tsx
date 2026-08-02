import { useLayoutEffect, useRef } from 'react'; import type { Message, Seat } from '../types';
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Provider drives the avatar hue so a glance tells claude from codex from human. */
function avatarClass(m: Message, seats: Seat[]): string {
  if (m.actor_kind === 'human') return 'av-human';
  const alias = m.actor.replace(/^@/, '');
  const provider = seats.find((s) => s.alias === alias)?.provider;
  if (provider === 'claude') return 'av-claude';
  if (provider === 'codex' || provider === 'cdx') return 'av-codex';
  return 'av-other';
}

export function MessageList({ messages, seats = [], hasOlder, onLoadOlder }: { messages: Message[]; seats?: Seat[]; hasOlder: boolean; onLoadOlder: () => Promise<void> }) {
  const scroller = useRef<HTMLElement>(null); const height = useRef(0);
  useLayoutEffect(() => { if (height.current && scroller.current) scroller.current.scrollTop += scroller.current.scrollHeight - height.current; height.current = 0; }, [messages]);
  return <section ref={scroller} className="transcript" aria-label="Room transcript" aria-live="polite">
    {hasOlder && <button className="load-older" onClick={async () => { if (scroller.current) height.current = scroller.current.scrollHeight; await onLoadOlder(); }}>Load older messages</button>}
    {!messages.length && !hasOlder && <div className="transcript-empty"><b>No messages yet</b><p>Message a seat below, or create a task in the rail to put an agent to work.</p></div>}
    {messages.map((m) => m.kind === 'system'
      ? <div className="sys-line" key={m.id}>{m.body}</div>
      : <article className={`turn ${m.kind} ${m.actor_kind === 'human' ? 'self' : ''} ${m.pending ? 'pending' : ''}`} key={m.id}>
          <span className={`av ${avatarClass(m, seats)}`} aria-hidden="true">{m.actor.replace(/^@/, '').charAt(0).toUpperCase()}</span>
          <div className="bubble">
            <header><b>{m.actor}</b>{m.kind !== 'chat' && m.kind !== 'handoff' && <span className="kind-chip">{m.kind}</span>}<time dateTime={new Date(m.created_at_ms).toISOString()}>{time(m.created_at_ms)}</time></header>
            {m.handoff
              ? <div className="handoff-card"><span className="kind-chip handoff-chip">handoff</span><b>@{m.handoff.from_alias} → @{m.handoff.to_alias}</b><p>{m.handoff.summary}</p>{m.handoff.evidence_refs.length > 0 && <ul>{m.handoff.evidence_refs.map((r, i) => <li key={i}><span>{r.kind}</span> {r.value}</li>)}</ul>}</div>
              : <p>{m.body}</p>}
            {m.delivery_state && <span className={`state ${m.delivery_state}`}>{m.delivery_state}</span>}
            {m.pending && <span className="state queued">queued locally</span>}
          </div>
        </article>)}
  </section>;
}
