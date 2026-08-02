// A dropped event socket used to be permanent: onclose flipped the UI to Offline and nothing
// dialled again. Cloudflare closes an idle WebSocket at ~100s, so that was the NORMAL path, not an
// edge case. These pin the two behaviours that fix it — reconnect after a drop, and ignoring the
// server keepalive so it never renders as a message.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from './api';

class FakeSocket {
  static last: FakeSocket | undefined;
  static created = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (e: { data: string }) => void;
  closed = false;
  constructor(public url: string) { FakeSocket.last = this; FakeSocket.created += 1; }
  close() { this.closed = true; }
}

const install = () => {
  FakeSocket.created = 0;
  FakeSocket.last = undefined;
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('event stream', () => {
  it('reports online on open and reconnects after a drop', () => {
    vi.useFakeTimers();
    install();
    const states: boolean[] = [];
    const stop = api.events(() => {}, (s) => states.push(s));

    FakeSocket.last!.onopen!();
    expect(states).toEqual([true]);
    expect(FakeSocket.created).toBe(1);

    // The Cloudflare idle close.
    FakeSocket.last!.onclose!();
    expect(states).toEqual([true, false]);

    vi.advanceTimersByTime(30000);
    expect(FakeSocket.created).toBe(2); // dialled again rather than staying dead

    FakeSocket.last!.onopen!();
    expect(states).toEqual([true, false, true]);
    stop();
  });

  it('does not reconnect after the caller stops it', () => {
    vi.useFakeTimers();
    install();
    const stop = api.events(() => {}, () => {});
    FakeSocket.last!.onopen!();
    stop();
    FakeSocket.last!.onclose!();
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.created).toBe(1);
  });

  it('swallows the keepalive ping instead of surfacing it as an event', () => {
    install();
    const seen: unknown[] = [];
    const stop = api.events((e) => seen.push(e), () => {});
    FakeSocket.last!.onopen!();
    FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: 'ping', payload: { ts: 1 } }) });
    expect(seen).toEqual([]);
    FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: 'message.posted', payload: { id: 'm1' } }) });
    expect(seen).toHaveLength(1);
    stop();
  });
});
