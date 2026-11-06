import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, AudioLines, Download, List, Mic, MicOff, Send, Sparkles, WandSparkles } from 'lucide-react';
import { api, ApiError, Health, jsonBody, Session, TranscriptSegment } from './api';
import { MicrophoneRecorder } from './audioRecorder';
import {
  createSummaryPdfHtml,
  summaryPdfFileName,
  summaryQuestion,
  SummaryStyle,
} from './sessionSummaryPdf';

type Props = {
  session: Session;
  health: Health | null;
  onBack: () => void;
};

type RecordingState = 'ready' | 'starting' | 'recording' | 'transcribing' | 'ended';

export default function SessionView({ session, health, onBack }: Props) {
  const [recordingState, setRecordingState] = useState<RecordingState>(
    session.status === 'ended' ? 'ended' : 'ready',
  );
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [question, setQuestion] = useState('Summarize the key points and action items.');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfMessage, setPdfMessage] = useState('');
  const [summaryStyle, setSummaryStyle] = useState<SummaryStyle>('to-the-point');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const recorder = useMemo(() => new MicrophoneRecorder(), []);
  const startPendingRef = useRef(false);

  useEffect(() => {
    void api<TranscriptSegment[]>(`/sessions/${session.id}/transcript`)
      .then(setSegments)
      .catch((cause: unknown) => setError(messageFor(cause)));
  }, [session.id]);

  useEffect(() => {
    if (recordingState !== 'recording') return undefined;
    const timer = window.setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recordingState]);

  useEffect(() => () => recorder.dispose(), [recorder]);

  async function startRecording() {
    if (recordingState !== 'ready' || startPendingRef.current) return;
    startPendingRef.current = true;
    setError('');
    setAnswer('');
    setElapsedSeconds(0);
    setRecordingState('starting');
    try {
      await recorder.start();
      setRecordingState('recording');
    } catch (cause) {
      setError(messageFor(cause));
      setRecordingState('ready');
    } finally {
      startPendingRef.current = false;
    }
  }

  async function transcribeRecording(recording: Blob) {
    try {
      await api<Session>(`/sessions/${session.id}/end`, { method: 'POST' });
      if (recording.size === 0) {
        setError('No audio was captured. Check the microphone and try a new session.');
        return;
      }
      if (recording.size > 25 * 1024 * 1024) {
        setError('This recording is over 25 MB. Keep recordings shorter and try again.');
        return;
      }
      const result = await api<TranscriptSegment[]>(
        `/sessions/${session.id}/transcribe`,
        {
          method: 'POST',
          headers: { 'Content-Type': recording.type || 'audio/webm' },
          body: recording,
        },
      );
      setSegments((previous) => [...previous, ...result]);
      if (result.length === 0) {
        setError('No speech was recognized. Check your microphone level and try again.');
      } else {
        const analysisFailures: string[] = [];
        for (const [path, feature] of [
          [`/commitments/scan/${session.id}`, 'Promise Tracker'],
          [`/contradictions/scan/${session.id}`, 'contradiction analysis'],
        ]) {
          try {
            await api(path, { method: 'POST' });
          } catch (cause) {
            analysisFailures.push(`${feature}: ${messageFor(cause)}`);
          }
        }
        if (analysisFailures.length > 0) {
          setError(`Transcript saved, but analysis needs attention. ${analysisFailures.join(' ')}`);
        }
      }
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setRecordingState('ended');
    }
  }

  function stopRecording() {
    if (recordingState !== 'recording') return;
    setRecordingState('transcribing');
    void finishRecording();
  }

  async function finishRecording() {
    try {
      await transcribeRecording(await recorder.stop());
    } catch (cause) {
      setError(messageFor(cause));
      setRecordingState('ended');
    }
  }

  async function askAI(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setAnswer('');
    setAiBusy(true);
    try {
      const result = await api<{ response: string }>(
        `/sessions/${session.id}/ask`,
        jsonBody({ question }),
      );
      setAnswer(result.response);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setAiBusy(false);
    }
  }

  async function downloadSummaryPdf() {
    if (aiBusy || summaryBusy || pdfBusy) return;
    setError('');
    setPdfMessage('');
    setPdfBusy(true);
    try {
      const result = await api<{ response: string }>(
        `/sessions/${session.id}/ask`,
        jsonBody({ question: summaryQuestion(summaryStyle) }),
      );
      const savePdf = window.desktop?.saveSummaryPdf;
      if (!savePdf) {
        throw new Error('PDF export is available in the desktop app.');
      }
      const saved = await savePdf(
        createSummaryPdfHtml(session, segments, result.response),
        summaryPdfFileName(session.title),
      );
      if (saved.saved) setPdfMessage(`PDF saved to ${saved.filePath}`);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setPdfBusy(false);
    }
  }

  async function summarizeTranscript() {
    if (aiBusy || summaryBusy || pdfBusy) return;
    setError('');
    setPdfMessage('');
    setAnswer('');
    setSummaryBusy(true);
    try {
      const result = await api<{ response: string }>(
        `/sessions/${session.id}/ask`,
        jsonBody({ question: summaryQuestion(summaryStyle) }),
      );
      setAnswer(result.response);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setSummaryBusy(false);
    }
  }

  const canAskAI = segments.length > 0 && health?.inference === 'ready';

  return (
    <div className="session-page">
      <button className="back-button" onClick={onBack} disabled={recordingState === 'starting' || recordingState === 'recording' || recordingState === 'transcribing'}><ArrowLeft size={16} /> Back to workspace</button>
      <section className="session-banner">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> PRIVATE SESSION</div>
          <h1>{session.title}</h1>
          <p>Microphone audio is processed on this device. Recordings are not saved.</p>
        </div>
        <div className={`recording-indicator ${recordingState}`}>
          <i />
          {recordingState === 'recording' ? `Recording · ${formatDuration(elapsedSeconds)}`
            : recordingState === 'transcribing' ? 'Transcribing locally…'
              : recordingState === 'starting' ? 'Requesting microphone…'
              : recordingState === 'ended' ? 'Session stopped'
                : 'Microphone off'}
        </div>
      </section>

      <section className="session-grid">
        <article className="session-panel transcript-panel">
          <div className="panel-title">
            <div><h2><AudioLines size={17} /> Transcript</h2><p>Recognized locally after you stop recording</p></div>
          </div>
          {segments.length === 0
            ? <div className="transcript-empty"><Mic size={22} /><b>Your transcript will appear here</b><span>Start a recording, speak clearly, then stop to transcribe.</span></div>
            : <div className="transcript-list">{segments.map((segment) => (
              <p className="transcript-segment" key={segment.id}>
                <time>{formatDuration(segment.start_time)}</time>{segment.text}
              </p>
            ))}</div>}
          {recordingState === 'ready' && (
            <div className="record-controls">
              <button className="primary-button" onClick={() => void startRecording()}><Mic size={16} /> Start microphone</button>
              <span>The local speech model may download (~145 MB) if it is not already cached.</span>
            </div>
          )}
          {recordingState === 'recording' && (
            <div className="record-controls">
              <button className="stop-button" onClick={stopRecording}><MicOff size={16} /> Stop and transcribe</button>
              <span>Your microphone is active. Audio stays in memory and is discarded after transcription.</span>
            </div>
          )}
          {recordingState === 'starting' && (
            <div className="record-controls"><span className="loading-dot" /> Waiting for microphone permission…</div>
          )}
          {recordingState === 'transcribing' && (
            <div className="record-controls"><span className="loading-dot" /> Transcribing on this device. The first use may take longer while the model downloads.</div>
          )}
          {recordingState === 'ended' && (
            <div className="record-controls"><span>Recording stopped. Start a new session to record again.</span></div>
          )}
        </article>

        <article className="session-panel ai-panel">
          <div className="panel-title">
            <div><h2><Sparkles size={17} /> Session assistant</h2><p>Summarize or ask about this transcript with local AI</p></div>
          </div>
          {health?.inference !== 'ready' && (
            <div className="model-help">
              {health?.inference === 'runtime_unavailable'
                ? <>Install and start <a href="https://ollama.com/download/windows" target="_blank" rel="noreferrer">Ollama for Windows</a>, then run <code>ollama pull qwen3:4b</code>.</>
                : health?.inference === 'model_not_installed'
                  ? <>Run <code>ollama pull qwen3:4b</code> to download the local model.</>
                  : 'Checking local AI readiness…'}
            </div>
          )}
          <fieldset className="summary-style-picker" disabled={!canAskAI || aiBusy || summaryBusy || pdfBusy}>
            <legend>Choose a summary style</legend>
            <label className={`summary-style-option ${summaryStyle === 'to-the-point' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="summary-style"
                value="to-the-point"
                checked={summaryStyle === 'to-the-point'}
                onChange={() => setSummaryStyle('to-the-point')}
              />
              <span className="summary-style-icon"><List size={16} /></span>
              <span className="summary-style-copy">
                <b>To the point</b>
                <small>Short, clear bullet points</small>
              </span>
              <span className="summary-style-check" aria-hidden="true">✓</span>
            </label>
            <label className={`summary-style-option ${summaryStyle === 'simple-explanation' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="summary-style"
                value="simple-explanation"
                checked={summaryStyle === 'simple-explanation'}
                onChange={() => setSummaryStyle('simple-explanation')}
              />
              <span className="summary-style-icon"><WandSparkles size={16} /></span>
              <span className="summary-style-copy">
                <b>Explain in the simplest way</b>
                <small>Plain words, with context</small>
              </span>
              <span className="summary-style-check" aria-hidden="true">✓</span>
            </label>
          </fieldset>
          <div className="summary-actions">
            <button
              className="primary-button"
              onClick={() => void summarizeTranscript()}
              disabled={!canAskAI || aiBusy || summaryBusy || pdfBusy}
            >
              <Sparkles size={15} /> {summaryBusy ? 'Summarizing locally…' : 'Summarize transcript'}
            </button>
            <button
              className="subtle-button"
              onClick={() => void downloadSummaryPdf()}
              disabled={!canAskAI || pdfBusy || aiBusy || summaryBusy}
            >
              <Download size={14} /> {pdfBusy ? 'Creating PDF…' : 'Download PDF'}
            </button>
          </div>
          {pdfMessage && <p className="export-message" role="status">{pdfMessage}</p>}
          <div className="assistant-divider"><span>OR ASK A QUESTION</span></div>
          <form onSubmit={(event) => void askAI(event)} className="question-form">
            <label htmlFor="question">Question or instruction</label>
            <textarea id="question" value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} maxLength={4000} />
            <button className="primary-button" type="submit" disabled={!canAskAI || aiBusy || summaryBusy || pdfBusy || !question.trim()}>
              <Send size={15} /> {aiBusy ? 'Thinking locally…' : 'Ask about this session'}
            </button>
          </form>
          {answer && <div className="ai-answer"><b>Local AI response</b><p>{answer}</p></div>}
        </article>
      </section>
      {error && <div className="notice" role="alert"><span className="notice-dot" />{error}</div>}
    </div>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'An unexpected error occurred. Please try again.';
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
}
