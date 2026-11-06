import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Circle, RefreshCw, Search, Sparkles } from 'lucide-react';
import { api, ApiError, Commitment, jsonBody, UnscannedSession } from './api';

export default function PromiseTracker() {
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [unscanned, setUnscanned] = useState<UnscannedSession[]>([]);
  const [question, setQuestion] = useState('Which commitments are still pending?');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [filter, setFilter] = useState<'pending' | 'completed' | 'all'>('pending');

  const refresh = useCallback(async () => {
    const [tracked, backlog] = await Promise.all([
      api<Commitment[]>('/commitments'),
      api<UnscannedSession[]>('/commitments/unscanned'),
    ]);
    setCommitments(tracked);
    setUnscanned(backlog);
  }, []);

  useEffect(() => {
    void refresh().catch((cause: unknown) => setError(messageFor(cause)));
  }, [refresh]);

  const visible = useMemo(
    () => commitments.filter((item) => filter === 'all' || item.status === filter),
    [commitments, filter],
  );
  const pendingCount = commitments.filter((item) => item.status === 'pending').length;
  const completedCount = commitments.length - pendingCount;

  async function scanHistory() {
    setBusy(true);
    setError('');
    let failed = 0;
    const failureMessages: string[] = [];
    for (let index = 0; index < unscanned.length; index += 1) {
      const session = unscanned[index];
      setProgress(`Scanning ${index + 1} of ${unscanned.length}: ${session.title}`);
      try {
        await api(`/commitments/scan/${session.id}`, { method: 'POST' });
      } catch (cause) {
        failed += 1;
        failureMessages.push(messageFor(cause));
      }
    }
    setProgress('');
    setBusy(false);
    if (failed > 0) {
      setError(`${failed} meeting${failed === 1 ? '' : 's'} could not be scanned. ${failureMessages[0]}`);
    }
    await refresh().catch((cause: unknown) => setError(messageFor(cause)));
  }

  async function updateStatus(item: Commitment) {
    setError('');
    try {
      await api<Commitment>(`/commitments/${item.id}`, {
        ...jsonBody({ status: item.status === 'pending' ? 'completed' : 'pending' }),
        method: 'PATCH',
      });
      await refresh();
    } catch (cause) {
      setError(messageFor(cause));
    }
  }

  async function ask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setAnswer('');
    try {
      const result = await api<{ response: string }>('/commitments/ask', jsonBody({ question }));
      setAnswer(result.response);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tracker-page">
      <section className="tracker-banner">
        <div className="eyebrow"><span className="eyebrow-line" /> CROSS-MEETING FOLLOW-THROUGH</div>
        <h1>Promise Tracker</h1>
        <p>Find clear commitments across your saved meeting transcripts. Processing and storage stay on this device.</p>
        <div className="tracker-stats">
          <span><b>{pendingCount}</b> pending</span><span><b>{completedCount}</b> completed</span>
        </div>
      </section>

      <section className="tracker-ask">
        <div className="panel-title"><div><h2><Sparkles size={16} /> Ask across meetings</h2><p>Answers are based on extracted commitments, not guessed details.</p></div></div>
        <form className="tracker-question" onSubmit={(event) => void ask(event)}>
          <input value={question} onChange={(event) => setQuestion(event.target.value)} aria-label="Ask about commitments" />
          <button className="primary-button" disabled={busy || !question.trim()}><Search size={15} /> Ask locally</button>
        </form>
        {answer && <div className="tracker-answer">{answer}</div>}
      </section>

      <section className="tracker-list-panel">
        <div className="panel-title tracker-list-heading">
          <div><h2>Commitments</h2><p>Person attribution is left unknown when a transcript does not identify the speaker.</p></div>
          <div className="tracker-actions">
            <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} aria-label="Filter commitments">
              <option value="pending">Pending</option><option value="completed">Completed</option><option value="all">All</option>
            </select>
            <button className="subtle-button" onClick={() => void refresh().catch((cause: unknown) => setError(messageFor(cause)))}><RefreshCw size={13} /> Refresh</button>
          </div>
        </div>
        {unscanned.length > 0 && (
          <div className="tracker-backfill">
            <div><b>{unscanned.length} saved meeting{unscanned.length === 1 ? '' : 's'} to scan</b><span>Includes transcripts created before Promise Tracker was added.</span></div>
            <button className="primary-button" disabled={busy} onClick={() => void scanHistory()}>{busy ? 'Scanning…' : 'Scan history'}</button>
          </div>
        )}
        {progress && <p className="tracker-progress">{progress}</p>}
        {error && <div className="notice" role="alert"><span className="notice-dot" />{error}</div>}
        {visible.length === 0 ? (
          <div className="empty-state tracker-empty"><div className="empty-icon"><Circle size={19} /></div><b>{filter === 'completed' ? 'No completed commitments' : 'No commitments found yet'}</b><span>Scan saved transcripts or record a new meeting with an explicit commitment.</span></div>
        ) : (
          <div className="commitment-list">{visible.map((item) => (
            <article className={`commitment-card ${item.status}`} key={item.id}>
              <button className="commitment-toggle" onClick={() => void updateStatus(item)} aria-label={item.status === 'pending' ? 'Mark completed' : 'Mark pending'}>
                {item.status === 'completed' ? <Check size={16} /> : <Circle size={16} />}
              </button>
              <div className="commitment-detail">
                <div className="commitment-meta"><span className={`commitment-state ${item.status}`}>{item.status}</span><span>{item.person || 'Person not identified'}</span><span>{dueLabel(item)}</span></div>
                <h3>{item.task}</h3>
                <blockquote>“{item.source_quote}”</blockquote>
                <span className="commitment-source">{item.source_session_title} · {new Date(item.source_session_date).toLocaleDateString()}</span>
                {item.status === 'completed' && item.completion_evidence && <p className="completion-evidence">Completion evidence: “{item.completion_evidence}”</p>}
              </div>
            </article>
          ))}</div>
        )}
      </section>
    </div>
  );
}

function dueLabel(item: Commitment): string {
  if (item.due_date_text) return `Due ${item.due_date_text}`;
  if (item.due_date) return `Due ${new Date(`${item.due_date}T00:00:00`).toLocaleDateString()}`;
  return 'No due date';
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'An unexpected error occurred. Please try again.';
}
