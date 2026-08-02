#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ITEM_IDS = ['P0-1', 'P0-2', 'P0-3', 'P0-4', 'P0-5', 'P0-6', 'P0-7', 'P0-8', 'P1-9', 'P1-10', 'P1-11'];
const DEFERRED = { id: 'P1-12', status: 'DEFERRED', until: 'Link invite, budgets, runtime profiles, and execution bridges reach documented parity and Adrian approves retirement in a follow-up dispatch.' };
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const REPO = resolve(ROOT, '..', '..');

function arg(name) { const i = process.argv.indexOf(name); return i === -1 ? undefined : process.argv[i + 1]; }
function run(file, args, cwd = REPO) {
  try { return { exit: 0, output: execFileSync(file, args, { cwd, env: { ...process.env, CI: '1' }, encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] }).slice(-4000) }; }
  catch (error) { return { exit: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? error.message}`.slice(-4000) }; }
}
function sha(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function atomicJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}
function status() { return run('git', ['status', '--short']).output.trim().split('\n').filter(Boolean); }
function mapPath(path) {
  if (path.includes('citadel-hub') || path.includes('hub-spine-decision')) return 'P0-8';
  if (path.includes('citadel-node') || path.includes('citadel-protocol') || path.includes('durability')) return 'P1-9';
  if (path.includes('RunPanel')) return 'P1-10';
  if (path.includes('claude-channel') || path.includes('delegate')) return 'P1-11';
  if (path.includes('operator-events')) return 'P0-4';
  if (path.includes('dto') || path.includes('wire') || path.includes('/api.')) return 'P0-1';
  if (path.includes('ErrorBoundary') || path.endsWith('/main.tsx')) return 'P0-2';
  if (path.includes('dispatch') || path.includes('payload')) return 'P0-3';
  if (path.includes('access-jwt') || path.includes('ws-auth')) return 'P0-5';
  if (path.includes('transitions') || path.includes('cancel') || path.includes('replay')) return 'P0-7';
  if (path.includes('server') || path.includes('store')) return 'P0-6';
  return 'UNRELATED';
}
function versions() {
  return Object.fromEntries([['git', ['--version']], ['node', ['--version']], ['pnpm', ['--version']], ['cargo', ['--version']], ['rustc', ['--version']]].map(([file, args]) => [file, run(file, args).output.trim()]));
}
function main() {
  const phase = arg('--phase');
  const evidenceRoot = resolve(arg('--evidence-root') ?? '/Volumes/D/claude/tasks/evidence/citadel-phase0-p1-execution');
  const plan = resolve(arg('--plan') ?? '/Volumes/D/claude/docs/plans/sol/CITADEL_SYSTEM_REVIEW_AND_ROADMAP.md');
  const dryRun = process.argv.includes('--dry-run');
  if (!['baseline', 'items', 'final'].includes(phase)) throw new Error('--phase baseline|items|final is required');
  if (!existsSync(plan)) throw new Error(`plan missing: ${plan}`);
  if (dryRun) { console.log(JSON.stringify({ phases: 3, items: ITEM_IDS.length, deferred: 1, max_jobs: 16, mutations: 0 })); return; }
  const revision = run('git', ['rev-parse', 'HEAD']).output.trim();
  const now = new Date().toISOString();
  if (phase === 'baseline') {
    const dirty = status().map((line) => ({ line, item: mapPath(line.slice(3)) }));
    const preflight = { schema: 'citadel-preflight.v1', created_at: now, revision, branch: run('git', ['branch', '--show-current']).output.trim(), status: dirty.map(({ line }) => line), tool_versions: versions(), plan_sha256: sha(plan), packet_sha256: sha('/Volumes/D/claude/tasks/dispatches/2026-08-02/citadel-phase0-p1-execution.md'), mappings: dirty };
    atomicJson(resolve(evidenceRoot, 'preflight.json'), preflight);
    atomicJson(resolve(evidenceRoot, 'baseline.json'), { schema: 'citadel-baseline.v1', created_at: now, revision, items: ITEM_IDS.map((id) => ({ id, status: 'OPEN' })), deferred: DEFERRED, unclassified: dirty.filter(({ item }) => item === 'UNRELATED').map(({ line }) => line) });
    atomicJson(resolve(evidenceRoot, 'checkpoint.json'), { phase, revision, completed_at: now });
    console.log(`BASELINE PASS: ${ITEM_IDS.length} items, 1 deferred, ${dirty.length} dirty paths inventoried`);
    return;
  }
  if (phase === 'items') {
    const groups = [
      ['P0-1', ['node', ['--test', 'src/dto.test.mjs', 'src/wire.test.mjs'], resolve(ROOT, 'packages/hub')]],
      ['P0-2', ['pnpm', ['--filter', '@citadel/web', 'test'], ROOT]],
      ['P0-3', ['node', ['--test', 'src/dispatch.test.mjs'], resolve(ROOT, 'packages/hub')]],
      ['P0-4', ['node', ['--test', 'src/operator-events.test.mjs'], resolve(ROOT, 'packages/hub')]],
      ['P0-5', ['node', ['--test', 'src/access-jwt.test.mjs', 'src/operator-events.test.mjs', 'src/ws.test.mjs'], resolve(ROOT, 'packages/hub')]],
      ['P0-6', ['node', ['--test', 'src/api.test.mjs', 'src/operator-events.test.mjs', 'src/store.test.mjs'], resolve(ROOT, 'packages/hub')]],
      ['P0-7', ['node', ['--test', 'src/cancel.test.mjs', 'src/dto.test.mjs', 'src/replay.test.mjs', 'src/store.test.mjs'], resolve(ROOT, 'packages/hub')]],
      ['P0-8', ['cargo', ['check', '--workspace', '--all-targets'], ROOT]],
      ['P1-9', ['node', ['--test', 'src/durability.test.mjs', 'src/e2e-rust-node.test.mjs'], resolve(ROOT, 'packages/hub')]],
      ['P1-10', ['pnpm', ['--filter', '@citadel/web', 'test'], ROOT]],
      ['P1-11', ['cargo', ['test', '-p', 'citadel-node', '-p', 'citadel-protocol', '-p', 'citadel-store'], ROOT]],
    ];
    const items = groups.map(([id, [file, args, cwd]]) => { const result = run(file, args, cwd); return { id, status: result.exit === 0 ? 'PASS' : 'OPEN', command: [file, ...args].join(' '), exit: result.exit, output: result.output }; });
    atomicJson(resolve(evidenceRoot, 'items.json'), { schema: 'citadel-items.v1', created_at: now, revision, items, deferred: DEFERRED });
    atomicJson(resolve(evidenceRoot, 'launch-count.json'), { schema: 'citadel-launch-count.v1', created_at: now, max_jobs: 16, actual_jobs: groups.length, mode: 'SERIAL_LOCAL' });
    atomicJson(resolve(evidenceRoot, 'checkpoint.json'), { phase, revision, completed_at: now, open: items.filter((item) => item.status !== 'PASS').map((item) => item.id) });
    console.log(`ITEMS ${items.every((item) => item.status === 'PASS') ? 'PASS' : 'OPEN'}: ${items.filter((item) => item.status === 'PASS').length}/${ITEM_IDS.length}`);
    process.exitCode = items.some((item) => item.status !== 'PASS') ? 1 : 0;
    return;
  }
  const itemPath = resolve(evidenceRoot, 'items.json');
  if (!existsSync(itemPath)) throw new Error('items evidence is required before final');
  const itemEvidence = JSON.parse(readFileSync(itemPath));
  const open = itemEvidence.items.filter((item) => item.status !== 'PASS').map((item) => item.id);
  const suites = {
    pnpm_test: run('pnpm', ['test'], ROOT),
    cargo_test: run('cargo', ['test', '--workspace'], ROOT),
    web_build: run('pnpm', ['--filter', '@citadel/web', 'build'], ROOT),
  };
  if (Object.values(suites).some((suite) => suite.exit !== 0)) open.push('suite_failure');
  const diffCheck = run('git', ['diff', '--check']);
  const ledger = { schema: 'citadel-git-ledger.v1', created_at: now, revision, branch: run('git', ['branch', '--show-current']).output.trim(), origin_main: run('git', ['rev-parse', 'origin/main']).output.trim(), ahead_behind: run('git', ['rev-list', '--left-right', '--count', 'origin/main...main']).output.trim(), status: status() };
  atomicJson(resolve(evidenceRoot, 'git-ledger.json'), ledger);
  const result = { schema: 'citadel-final-verification.v1', created_at: now, revision, items: itemEvidence.items, deferred: DEFERRED, open, suites, git_diff_check: diffCheck, git_ledger: ledger };
  atomicJson(resolve(evidenceRoot, 'final-verification.json'), result);
  atomicJson(resolve(evidenceRoot, 'checkpoint.json'), { phase, revision, completed_at: now, open });
  if (process.argv.includes('--require-zero-open') && (open.length || diffCheck.exit)) { console.error(`FINAL OPEN: ${open.join(', ') || 'diff check'}`); process.exitCode = 1; return; }
  console.log(`FINAL PASS: ${ITEM_IDS.length - open.length}/${ITEM_IDS.length}`);
}
main();
