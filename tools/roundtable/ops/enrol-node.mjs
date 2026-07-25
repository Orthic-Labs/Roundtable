#!/usr/bin/env node
// Enrol a node (or a seat) directly against the hub's database.
//
// Deliberately NOT an HTTP route: this mints a credential, and a credential-minting endpoint
// reachable from the internet is a much bigger target than a command that requires shell access
// to the box. The hub has GET /api/nodes for status; creation lives here.
//
// The token is printed ONCE and only its hash is stored. There is no recovery path — losing it
// means enrolling again.
//
// Usage (on the box, hub can stay running — SQLite is WAL):
//   node ops/enrol-node.mjs node <name>
//   node ops/enrol-node.mjs room <slug> <title>
//   node ops/enrol-node.mjs seat <room-slug> <node-name> <alias> <codex|claude>
//   node ops/enrol-node.mjs list

import { Store } from '../packages/hub/src/store.mjs';
import { randomToken } from '../packages/hub/src/auth.mjs';

const DB = process.env.ROUND_TABLE_DATABASE
  ?? `${process.env.HOME}/.local/share/roundtable/roundtable.sqlite3`;
const [cmd, ...args] = process.argv.slice(2);
const store = Store.open(DB);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

switch (cmd) {
  case 'node': {
    const [name] = args;
    if (!name) die('usage: enrol-node.mjs node <name>');
    const token = randomToken();
    const node = store.registerNode({ name, tokenHash: Store.hashNodeToken(token) });
    console.log(`node_id: ${node.id}`);
    console.log(`token:   ${token}`);
    console.log('\nStore the token on that machine; it is not recoverable from here.');
    break;
  }
  case 'room': {
    const [slug, ...title] = args;
    if (!slug) die('usage: enrol-node.mjs room <slug> [title]');
    const room = store.createRoom({ slug, title: title.join(' ') || slug });
    console.log(`room_id: ${room.id}  slug: ${room.slug}`);
    break;
  }
  case 'seat': {
    const [roomSlug, nodeName, alias, provider] = args;
    if (!roomSlug || !nodeName || !alias || !provider) {
      die('usage: enrol-node.mjs seat <room-slug> <node-name> <alias> <codex|claude>');
    }
    if (!['codex', 'claude'].includes(provider)) die('provider must be codex or claude');
    const room = store.getRoomBySlug(roomSlug) ?? die(`no room with slug ${roomSlug}`);
    const node = store.listNodes().find((n) => n.name === nodeName) ?? die(`no node named ${nodeName}`);
    const seat = store.createSeat({
      roomId: room.id, nodeId: node.id, alias, provider,
      // The node creates the real thread on first delivery; this is a placeholder until then.
      sessionRef: 'pending',
    });
    console.log(`seat_id: ${seat.id}  alias: ${seat.alias}  provider: ${seat.provider}`);
    break;
  }
  case 'list': {
    console.log('nodes:');
    for (const n of store.listNodes()) {
      console.log(`  ${n.id}  ${n.name}${n.revoked_at_ms ? '  [REVOKED]' : ''}`);
    }
    console.log('rooms:');
    for (const r of store.listRooms()) {
      console.log(`  ${r.id}  ${r.slug}`);
      for (const s of store.listSeats(r.id)) {
        console.log(`      seat ${s.id}  ${s.alias}  ${s.provider}  ${s.state}`);
      }
    }
    break;
  }
  default:
    die('usage: enrol-node.mjs <node|room|seat|list> ...');
}

store.close();
