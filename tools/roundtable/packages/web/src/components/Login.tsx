import { useState } from 'react';
export function Login({ onLogin }: { onLogin: (token: string) => Promise<void> }) {
  const [token, setToken] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return <main className="login-shell"><form className="login-card" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { await onLogin(token); } catch { setError('Invalid admin token'); } finally { setBusy(false); } }}><div className="wordmark">Cit<span>adel</span></div><p>Coordinate your local agent sessions.</p><label htmlFor="admin-token">Admin token</label><input id="admin-token" type="password" autoComplete="current-password" required value={token} onChange={e => setToken(e.target.value)} />{error && <p role="alert" className="error">{error}</p>}<button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></form></main>;
}
