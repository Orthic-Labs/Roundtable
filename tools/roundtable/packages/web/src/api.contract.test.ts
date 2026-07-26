// The client and the hub disagreed about every collection response for as long as both existed:
// the hub sends {rooms:[...]}, the client typed it as Room[]. TypeScript could not catch it —
// the shape comes off `response.json()` as `any` — and no test asserted it, so the first thing
// that actually indexed into the result blew up at render time as a blank page.
//
// These tests pin the contract on the CLIENT side, against the exact JSON the hub sends.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from './api';

const respond = (body: unknown) => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
  })));
};

afterEach(() => vi.unstubAllGlobals());

describe('collection endpoints return arrays, not the hub envelope', () => {
  it('rooms unwraps {rooms}', async () => {
    respond({ rooms: [{ id: 'r1', slug: 'main' }] });
    const rooms = await api.rooms();
    expect(Array.isArray(rooms)).toBe(true);
    // The exact call that produced the blank screen.
    expect(rooms.find((r) => r.id === 'r1')).toBeDefined();
    expect(rooms.filter((r) => !r.archived_at)).toHaveLength(1);
  });

  it('messages unwraps {messages}', async () => {
    respond({ messages: [{ id: 'm1', seq: 1 }] });
    const messages = await api.messages('r1');
    expect(Array.isArray(messages)).toBe(true);
    expect(messages).toHaveLength(1);
  });

  it('seats unwraps {seats}', async () => {
    respond({ seats: [{ id: 's1', alias: 'mac-codex' }] });
    const seats = await api.seats('r1');
    expect(Array.isArray(seats)).toBe(true);
    expect(seats[0].alias).toBe('mac-codex');
  });

  it('keeps task and run activity separate from messages', async () => {
    respond({ tasks: [{ id: 't1' }], runs: [{ id: 'run1', task_id: 't1' }] });
    const work = await api.tasks('r1');
    expect(work.tasks[0].id).toBe('t1');
    expect(work.runs[0].task_id).toBe('t1');
  });

  it('reads ordered activity per run', async () => {
    respond({ events: [{ id: 'e1', seq: 1, type: 'item.completed' }] });
    expect((await api.runEvents('run1')).map((event) => event.seq)).toEqual([1]);
  });

  it('sessions unwraps {nodes} and tolerates the key being absent', async () => {
    respond({ nodes: [{ node_id: 'n1' }], connected: 1 });
    expect(await api.sessions()).toHaveLength(1);
    // /api/nodes also answers without `nodes` in some shapes; an undefined here would crash the
    // same way, so it must degrade to an empty list rather than propagate undefined.
    respond({ connected: 0 });
    expect(await api.sessions()).toEqual([]);
  });
});
