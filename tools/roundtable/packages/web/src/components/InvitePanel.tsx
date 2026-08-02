import { useState } from 'react';
import { api } from '../api';
import type { Invite } from '../types';

function formatExpiry(expiresAtMs: number): string {
  const deltaMin = Math.round((expiresAtMs - Date.now()) / 60000);
  if (deltaMin <= 0) return 'expired';
  if (deltaMin < 60) return `${deltaMin}m left`;
  return `${Math.round(deltaMin / 60)}h left`;
}

/** One-click invite for the seat strip: mints on press, shows the code + copy inline until
 * dismissed. The full list/revoke management stays in the drawer's InvitePanel. */
export function InviteQuick({ roomId }: { roomId: string }) {
  const [code, setCode] = useState<string>();
  const [expiresAt, setExpiresAt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  const create = async () => {
    setPending(true); setError(false); setCopied(false);
    try {
      const invite = await api.createInvite(roomId);
      setCode(invite.code); setExpiresAt(invite.expires_at_ms);
      // The code lands on the clipboard the moment it exists — the chip is confirmation and
      // re-copy, not a required second step.
      try { await navigator.clipboard.writeText(invite.code); setCopied(true); } catch { /* user copies manually */ }
    } catch { setError(true); }
    finally { setPending(false); }
  };
  const copy = async () => { if (!code) return; await navigator.clipboard.writeText(code); setCopied(true); };

  if (code) return <span className="invite-chip">
    <code>{code}</code>
    <button type="button" onClick={copy} aria-label="Copy invite code">{copied ? 'Copied' : 'Copy'}</button>
    <small>{formatExpiry(expiresAt)} · run citadel_join with this code</small>
    <button type="button" className="chip-x" aria-label="Dismiss invite code" onClick={() => setCode(undefined)}>×</button>
  </span>;
  return <button type="button" className="strip-btn invite" onClick={create} disabled={pending}>
    {pending ? 'Creating…' : error ? 'Retry invite' : '+ Invite agent'}
  </button>;
}

/** "Invite an agent" — lives inside the Seats panel next to Attach session. Lazy: the invite list
 * loads only when the section is opened, so mounting SeatPanel never fires a network call. */
export function InvitePanel({ roomId }: { roomId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [code, setCode] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const load = () => { if (loaded) return; setLoaded(true); api.listInvites(roomId).then(setInvites).catch(() => setError('Could not load invites.')); };

  const create = async () => {
    setPending(true); setError(undefined); setCopied(false);
    try {
      const invite = await api.createInvite(roomId);
      setCode(invite.code);
      setLoaded(true);
      setInvites((value) => [{ id: invite.id, room_id: invite.room_id, created_at_ms: invite.created_at_ms, expires_at_ms: invite.expires_at_ms, state: 'active' }, ...value]);
    } catch {
      setError('Could not create invite.');
    } finally {
      setPending(false);
    }
  };

  const copy = async () => { if (!code) return; await navigator.clipboard.writeText(code); setCopied(true); };

  const revoke = async (inviteId: string) => {
    await api.revokeInvite(roomId, inviteId);
    setInvites((value) => value.map((invite) => invite.id === inviteId ? { ...invite, state: 'revoked' } : invite));
  };

  return (
    <details className="invite-panel" onToggle={(e) => (e.target as HTMLDetailsElement).open && load()}>
      <summary>Invite an agent</summary>
      <button type="button" className="primary" onClick={create} disabled={pending}>{pending ? 'Creating…' : 'Create invite'}</button>
      {error && <small className="error">{error}</small>}
      {code && (
        <div className="invite-code">
          <code>{code}</code>
          <button type="button" onClick={copy} aria-label="Copy invite code">{copied ? 'Copied' : 'Copy'}</button>
        </div>
      )}
      {code && <p className="mention-meta">In the agent&rsquo;s session, run the citadel_join tool with this code.</p>}
      {invites.length > 0 && (
        <ul className="seat-list invite-list">
          {invites.map((invite) => (
            <li key={invite.id}>
              <span><b>{invite.id.slice(0, 8)}</b><small>{invite.state} · {formatExpiry(invite.expires_at_ms)}</small></span>
              {invite.state === 'active' && <button type="button" aria-label={`Revoke invite ${invite.id.slice(0, 8)}`} onClick={() => revoke(invite.id)}>×</button>}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
