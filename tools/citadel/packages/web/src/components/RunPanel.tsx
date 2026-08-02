import { useState } from 'react';
import type { Run, RunEvent, RunInspection, Seat, Task } from '../types';
import './RunPanel.css';

/** Channels the operator UI cannot observe for a given observability grade. */
const UNOBSERVABLE: Record<Run['observability_grade'], string[]> = {
  partial: ['terminal', 'files', 'command stdout/stderr', 'tool args'],
  full: [],
};

function formatPayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function EventRow({ event }: { event: RunEvent }) {
  const [open, setOpen] = useState(false);
  const hasPayload = event.payload && Object.keys(event.payload).length > 0;
  return (
    <li className="run-event">
      <button
        type="button"
        className="run-event-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={!hasPayload}
      >
        <span className="run-event-seq">#{event.seq}</span>
        <span className="run-event-type">{event.type}</span>
        <time dateTime={new Date(event.created_at_ms).toISOString()}>
          {new Date(event.created_at_ms).toLocaleTimeString()}
        </time>
      </button>
      {open && hasPayload && (
        <pre className="run-event-payload" aria-label={`Payload for ${event.type}`}>
          {formatPayload(event.payload)}
        </pre>
      )}
    </li>
  );
}

function RunCard({
  run,
  task,
  events,
  inspection,
  seats,
}: {
  run: Run;
  task?: Task;
  events: RunEvent[];
  inspection?: RunInspection;
  seats: Seat[];
}) {
  // Live runs open; finished runs collapse to a summary row until asked for.
  const [expanded, setExpanded] = useState(!['completed', 'failed', 'cancelled'].includes(run.state));
  const executor = seats.find((s) => s.id === run.executor_seat_id)?.alias ?? run.executor_seat_id;
  const unobservable = UNOBSERVABLE[run.observability_grade] ?? UNOBSERVABLE.partial;
  const timeline = [...events].sort((a, b) => a.seq - b.seq);

  return (
    <article className="run" data-run-id={run.id}>
      <header className="run-head">
        <button type="button" className="run-title" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          <b>{task?.title ?? 'Task'}</b>
          <span className={`state ${run.state}`}>{run.state}</span>
        </button>
        <small>
          @{executor}
          {run.execution_runtime ? ` · ${run.execution_runtime}` : ''}
          {run.reasoning_model ? ` · ${run.reasoning_model}` : ''}
        </small>
      </header>

      {expanded && (
        <div className="run-inspector">
          <div className={`observability grade-${run.observability_grade}`} role="status">
            <strong>{run.observability_grade} observability</strong>
            {unobservable.length > 0 ? (
              <p>
                Unobservable on this harness:{' '}
                {unobservable.map((ch) => (
                  <span key={ch} className="unobservable-channel">{ch}</span>
                ))}
              </p>
            ) : (
              <p>Full event stream available for this run.</p>
            )}
          </div>
          {task?.instructions && (
            <details className="run-packet">
              <summary>Work packet</summary>
              <pre>{task.instructions}</pre>
            </details>
          )}
          <details className="run-detail">
          <summary>Inspector</summary>
          <section className="run-observable-details" aria-label="Terminal and files">
            <h3>Terminal &amp; files</h3>
            {unobservable.some((channel) => channel === 'terminal' || channel === 'files')
              ? <p className="muted">Not observable on this harness.</p>
              : <p className="muted">No terminal or file records reported.</p>}
          </section>
          <section className="run-artifacts" aria-label="Artifacts">
            <h3>Artifacts</h3>
            {inspection ? (inspection.artifacts.length
              ? <ul>{inspection.artifacts.map((artifact) => <li key={artifact.id}>{artifact.kind}: {artifact.locator}</li>)}</ul>
              : <p className="muted">No artifacts reported.</p>)
              : <p className="muted">Artifact inventory unavailable until this run is refreshed.</p>}
          </section>
          <section className="run-lineage" aria-label="Lineage">
            <h3>Lineage</h3>
            {inspection ? <p className="muted">{inspection.lineage.delegated_from_seat_id ? `Delegated from ${inspection.lineage.delegated_from_seat_id}` : 'Operator-created'} → {inspection.lineage.executor_seat_id}</p>
              : <p className="muted">Lineage unavailable until this run is refreshed.</p>}
          </section>
          </details>
          <h3>Timeline</h3>
          {timeline.length === 0 ? (
            <p className="muted">No run events yet.</p>
          ) : (
            <ol className="run-timeline">
              {timeline.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </ol>
          )}
          {run.error_code && <small className="error">{run.error_code}</small>}
        </div>
      )}
    </article>
  );
}

export function RunPanel({
  tasks,
  runs,
  events,
  inspections = {},
  seats,
  online,
  onCreate,
}: {
  tasks: Task[];
  runs: Run[];
  events: Record<string, RunEvent[]>;
  inspections?: Record<string, RunInspection>;
  seats: Seat[];
  online: boolean;
  onCreate: (input: Pick<Task, 'executor_seat_id' | 'title' | 'instructions'>) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [executor, setExecutor] = useState(seats[0]?.id ?? '');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !instructions.trim() || !executor) return;
    await onCreate({
      executor_seat_id: executor,
      title: title.trim(),
      instructions: instructions.trim(),
    });
    setTitle('');
    setInstructions('');
  };
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  return (
    <section className="panel runs">
      <h2>Task runs</h2>
      {runs.map((run) => (
        <RunCard
          key={run.id}
          run={run}
          task={taskById.get(run.task_id)}
          events={events[run.id] ?? []}
          inspection={inspections[run.id]}
          seats={seats}
        />
      ))}
      {!runs.length && <p className="muted">No task runs yet.</p>}
      <details className="task-form-wrap" open={!runs.length}>
      <summary>New task</summary>
      <form className="task-form" onSubmit={submit}>
        <label>
          Task title
          <input aria-label="Task title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label>
          Instructions
          <textarea
            aria-label="Task instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            required
          />
        </label>
        <label>
          Executor
          <select
            aria-label="Task executor"
            value={executor}
            onChange={(e) => setExecutor(e.target.value)}
            required
          >
            {seats.map((seat) => (
              <option key={seat.id} value={seat.id}>
                @{seat.alias} ({seat.provider})
              </option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={!online || !seats.length}>
          Run task
        </button>
      </form>
      </details>
    </section>
  );
}
