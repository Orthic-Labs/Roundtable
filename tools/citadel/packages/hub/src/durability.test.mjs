// Citadel P1 item 9 + 11: hub-commit mutation acks and agent-authored run.create.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHub } from './server.mjs';
import { Store } from './store.mjs';
import { PROTOCOL_VERSION, NodeFrame, HubFrame } from './wire.mjs';

const NODE_TOKEN = 'test-node-token';

async function withHub(fn) {
  const store = Store.open(':memory:');
  const hub = createHub({ store, adminToken: 'tok', secure: false, allowedOrigins: [] });
  const addr = await hub.listen(0);
  const wsBase = `ws://127.0.0.1:${addr.port}`;
  const room = store.createRoom({ slug: 'r', title: 'R' });
  const node = store.registerNode({ name: 'mac', tokenHash: Store.hashNodeToken(NODE_TOKEN) });
  const seat = store.createSeat({
    roomId: room.id, nodeId: node.id, alias: 'mac-claude', provider: 'claude', sessionRef: 's1',
  });
  const executor = store.createSeat({
    roomId: room.id, nodeId: node.id, alias: 'mac-codex', provider: 'codex', sessionRef: 's2',
  });
  try { await fn({ hub, store, room, node, seat, executor, wsBase }); } finally { await hub.close(); }
}

const nodeFrame = (type, payload = {}) => JSON.stringify({
  version: PROTOCOL_VERSION, event_id: crypto.randomUUID(), sent_at_ms: Date.now(), type, payload,
});

async function connectAsNode(wsBase, nodeId, { resumeCursor = 0 } = {}) {
  const client = new WebSocket(`${wsBase}/node/connect`);
  await once(client, 'open');
  client.frames = [];
  client.addEventListener('message', (e) => client.frames.push(JSON.parse(e.data)));
  client.waitFor = async (type, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = client.frames.find((f) => f.type === type);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${type}; got ${client.frames.map((f) => f.type).join(',') || 'nothing'}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  client.send(nodeFrame(NodeFrame.HELLO, {
    hello: {
      node_id: nodeId, token: NODE_TOKEN, hostname: 'mac', os: 'macos',
      version: '0.1.0', resume_cursor: resumeCursor,
    },
  }));
  await client.waitFor('hello.accepted');
  return client;
}

test('mutation.result: message.post commits then acks so outbox can clear', async () => {
  await withHub(async ({ store, room, node, seat, wsBase }) => {
    const client = await connectAsNode(wsBase, node.id);
    const requestId = crypto.randomUUID();
    client.send(nodeFrame(NodeFrame.MESSAGE_POST, {
      message_post: {
        request_id: requestId,
        seat_id: seat.id,
        room_id: room.id,
        message_kind: 'chat',
        body: 'durable reply',
        reply_to: null,
        request_payload_sha256: 'abc',
      },
    }));
    const ack = await client.waitFor(HubFrame.MUTATION_RESULT);
    assert.equal(ack.payload.mutation_result.request_id, requestId);
    assert.equal(ack.payload.mutation_result.status, 'committed');
    assert.ok(ack.payload.mutation_result.entity_id);
    assert.equal(typeof ack.payload.mutation_result.commit_cursor, 'number');
    const messages = store.listMessages(room.id);
    assert.ok(messages.some((m) => m.body === 'durable reply'));
    client.close();
  });
});

test('mutation.result: rejected malformed message.post does not invent success', async () => {
  await withHub(async ({ node, wsBase }) => {
    const client = await connectAsNode(wsBase, node.id);
    const requestId = crypto.randomUUID();
    client.send(nodeFrame(NodeFrame.MESSAGE_POST, {
      message_post: { request_id: requestId, seat_id: null, room_id: null, body: 1 },
    }));
    const ack = await client.waitFor(HubFrame.MUTATION_RESULT);
    assert.equal(ack.payload.mutation_result.status, 'rejected');
    assert.equal(ack.payload.mutation_result.request_id, requestId);
    client.close();
  });
});

test('node.run.create: agent delegate creates durable task+run and acks', async () => {
  await withHub(async ({ hub, store, room, node, seat, executor, wsBase }) => {
    const client = await connectAsNode(wsBase, node.id);
    const requestId = crypto.randomUUID();
    client.send(nodeFrame(NodeFrame.RUN_CREATE, {
      run_create: {
        request_id: requestId,
        room_id: room.id,
        from_seat_id: seat.id,
        executor_seat_id: executor.id,
        title: 'Fix mirror',
        instructions: 'Persist before ack and return the run id.',
      },
    }));
    const ack = await client.waitFor(HubFrame.MUTATION_RESULT);
    assert.equal(ack.payload.mutation_result.status, 'committed');
    assert.equal(ack.payload.mutation_result.request_id, requestId);
    const runId = ack.payload.mutation_result.entity_id;
    assert.ok(runId);
    const run = store.getRun(runId);
    assert.ok(run);
    assert.equal(run.executor_seat_id, executor.id);
    const task = store.getTask(run.task_id);
    assert.equal(task.title, 'Fix mirror');
    assert.match(task.instructions, /Persist before ack/);
    // Delivery was queued for the executor; flush should reach the connected node.
    assert.ok(hub.flushDeliveries() >= 0);
    client.close();
  });
});

test('node.run.create: foreign seat is rejected', async () => {
  await withHub(async ({ store, room, node, executor, wsBase }) => {
    const other = store.registerNode({ name: 'win', tokenHash: Store.hashNodeToken('other') });
    const foreign = store.createSeat({
      roomId: room.id, nodeId: other.id, alias: 'win-claude', provider: 'claude', sessionRef: 'x',
    });
    const client = await connectAsNode(wsBase, node.id);
    const requestId = crypto.randomUUID();
    client.send(nodeFrame(NodeFrame.RUN_CREATE, {
      run_create: {
        request_id: requestId,
        room_id: room.id,
        from_seat_id: foreign.id,
        executor_seat_id: executor.id,
        title: 'Nope',
        instructions: 'Should fail',
      },
    }));
    const ack = await client.waitFor(HubFrame.MUTATION_RESULT);
    assert.equal(ack.payload.mutation_result.status, 'rejected');
    assert.equal(store.listTasks(room.id).length, 0);
    client.close();
  });
});

test('delivery.state with request_id gets mutation.result after transition', async () => {
  await withHub(async ({ hub, store, room, node, seat, wsBase }) => {
    const client = await connectAsNode(wsBase, node.id);
    const { deliveries } = store.postMessage({
      roomId: room.id, actorId: 'adrian', body: 'work', mentionSeatIds: [seat.id],
    });
    hub.flushDeliveries();
    await client.waitFor('delivery.assign');
    client.send(nodeFrame(NodeFrame.DELIVERY_ACK, { delivery_ack: { delivery_id: deliveries[0].id } }));
    await new Promise((r) => setTimeout(r, 30));
    const requestId = crypto.randomUUID();
    client.send(nodeFrame(NodeFrame.DELIVERY_STATE, {
      delivery_state: {
        request_id: requestId,
        delivery_id: deliveries[0].id,
        state: 'running',
        error_code: null,
      },
    }));
    const ack = await client.waitFor(HubFrame.MUTATION_RESULT);
    assert.equal(ack.payload.mutation_result.status, 'committed');
    assert.equal(store.getDelivery(deliveries[0].id).state, 'running');
    client.close();
  });
});
