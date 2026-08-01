import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { RunPanel } from './RunPanel';

it('renders timeline, explicit unavailable channels, artifacts, and delegation lineage', () => {
  render(<RunPanel
    tasks={[{ id: 'task', room_id: 'room', executor_seat_id: 'seat', title: 'Inspect', instructions: 'Read state.', state: 'queued', created_at_ms: 1, updated_at_ms: 1 }]}
    runs={[{ id: 'run', task_id: 'task', room_id: 'room', executor_seat_id: 'seat', delivery_id: 'delivery', state: 'queued', observability_grade: 'partial' }]}
    events={{ run: [{ id: 'event', run_id: 'run', seq: 1, type: 'run.started', payload: {}, created_at_ms: 1 }] }}
    inspections={{ run: { run: { id: 'run', task_id: 'task', room_id: 'room', executor_seat_id: 'seat', delivery_id: 'delivery', state: 'queued', observability_grade: 'partial' }, events: [], artifacts: [{ id: 'artifact', run_id: 'run', kind: 'report', locator: '/tmp/report.json', metadata: {}, created_at_ms: 1 }], lineage: { task_id: 'task', delegated_from_seat_id: 'seat-a', executor_seat_id: 'seat' } } }}
    seats={[{ id: 'seat', room_id: 'room', node_id: 'node', alias: 'codex', provider: 'codex', session_ref: 'session', state: 'idle', last_seen_ms: 1, last_ack_seq: 0 }]}
    online
    onCreate={async () => {}}
  />);
  expect(screen.getByText('Timeline')).toBeVisible();
  expect(screen.getByText('Not observable on this harness.')).toBeVisible();
  expect(screen.getByText('report: /tmp/report.json')).toBeVisible();
  expect(screen.getByText('Delegated from seat-a → seat')).toBeVisible();
});
