import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, ScanSearch } from 'lucide-react';
import {
  ApiError,
  api,
  ConversationContradiction,
  UnscannedSession,
} from './api';

export default function ContradictionDetector() {
  const [findings, setFindings] = useState<ConversationContradiction[]>([]);
  const [unscanned, setUnscanned] = useState<UnscannedSession[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  const refresh = useCallback(async () => {
    setError('');
    const [tracked, backlog] = await Promise.all([
      api<ConversationContradiction[]>('/contradictions'),
      api<UnscannedSession[]>('/contradictions/unscanned'),
    ]);
    setFindings(tracked);
    setUnscanned(backlog);
  }, []);

  useEffect(() => {
    void refresh().catch((cause: unknown) => setError(messageFor(cause)));
  }, [refresh]);

  const findingLabel = findings.length === 1
    ? 'possible inconsistency'
    : 'possible inconsistencies';

  async function scanHistory() {
    setBusy(true);
    setError('');
    let failed = 0;
    let failureMessage = '';
    for (let index = 0; index < unscanned.length; index += 1) {
      const session = unscanned[index];
      setProgress(`Analyzing ${index + 1} of ${unscanned.length}: ${session.title}`);
      try {
        await api(`/contradictions/scan/${session.id}`, { method: 'POST' });
      } catch (cause) {
        failed += 1;
        if (!failureMessage) failureMessage = messageFor(cause);
      }
    }
    setProgress('');
    setBusy(false);
    if (failed > 0) {
      setError(`${failed} meeting${failed === 1 ? '' : 's'} could not be analyzed. ${failureMessage}`);
    }
    await refresh().catch((cause: unknown) => setError(messageFor(cause)));
  }

  return (
    <div className="tracker-page contradiction-page">
      <section className="tracker-banner contradiction-banner">
        <div className="eyebrow"><span className="eyebrow-line" /> REVIEW POSSIBLE CHANGES</div>
        <h1>Conversation Contradiction Detector</h1>
        <p>Compare statements across saved meetings. Findings are possible inconsistencies for review, not a judgment about who is right.</p>
        <div className="tracker-stats">
          <span><b>{findings.length}</b> {findingLabel}</span>
          <span><b>{unscanned.length}</b> meeting{unscanned.length === 1 ? '' : 's'} to analyze</span>
        </div>
      </section>

      <section className="tracker-list-panel">
        <div className="panel-title tracker-list-heading">
          <div><h2><AlertTriangle size={16} /> Findings to review</h2><p>Each finding includes both transcript quotes and the dates of their meetings.</p></div>
          <div className="tracker-actions">
            <button className="subtle-button" onClick={() => void refresh().catch((cause: unknown) => setError(messageFor(cause)))}><RefreshCw size={13} /> Refresh</button>
            {unscanned.length > 0 && (
              <button className="primary-button" disabled={busy} onClick={() => void scanHistory()}>
                <ScanSearch size={14} /> {busy ? 'Analyzing…' : 'Scan history'}
              </button>
            )}
          </div>
        </div>
        {progress && <p className="tracker-progress">{progress}</p>}
        {error && <div className="notice" role="alert"><span className="notice-dot" />{error}</div>}
        {findings.length === 0 ? (
          <div className="empty-state tracker-empty">
            <div className="empty-icon"><AlertTriangle size={19} /></div>
            <b>{unscanned.length ? 'No findings yet' : 'No possible inconsistencies found'}</b>
            <span>{unscanned.length ? 'Scan saved transcripts to compare statements across meetings.' : 'Newly transcribed meetings are checked automatically.'}</span>
          </div>
        ) : (
          <div className="contradiction-list">{findings.map((item) => (
            <article className="contradiction-card" key={item.id}>
              <div className="contradiction-heading">
                <div><span className="contradiction-tag">POSSIBLE INCONSISTENCY</span><h3>{item.topic}</h3></div>
                {item.changes_commitment && <span className="commitment-change">May change an earlier commitment</span>}
              </div>
              <div className="statement-comparison">
                <StatementBlock label="Previous statement" statement={item.previous_statement} />
                <div className="comparison-arrow" aria-hidden="true">→</div>
                <StatementBlock label="Latest statement" statement={item.latest_statement} />
              </div>
              <p className="contradiction-explanation">{item.explanation}</p>
              <p className="contradiction-caveat">Flagged for review only. The statements may reflect an intentional update or missing context.</p>
            </article>
          ))}</div>
        )}
      </section>
    </div>
  );
}

function StatementBlock({
  label,
  statement,
}: {
  label: string;
  statement: ConversationContradiction['previous_statement'];
}) {
  return (
    <div className="statement-block">
      <span className="statement-label">{label}</span>
      <blockquote>“{statement.source_quote}”</blockquote>
      <span className="commitment-source">{statement.meeting_title} · {new Date(statement.meeting_date).toLocaleDateString()}</span>
    </div>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'An unexpected error occurred. Please try again.';
}
