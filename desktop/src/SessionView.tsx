import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  AudioLines,
  Camera,
  Download,
  List,
  MessageCircle,
  Mic,
  MicOff,
  Send,
  Sparkles,
  WandSparkles,
  X,
} from 'lucide-react';
import {
  api,
  ApiError,
  Health,
  jsonBody,
  LiveTranscriptSegment,
  ScreenSource,
  Session,
  SessionTopic,
  SessionTopics,
  TranscriptSegment,
} from './api';
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
  const [liveSegments, setLiveSegments] = useState<LiveTranscriptSegment[]>([]);
  const [liveStatus, setLiveStatus] = useState<'idle' | 'listening' | 'transcribing' | 'error'>('idle');
  const [liveAnswer, setLiveAnswer] = useState('');
  const [liveAnswerBusy, setLiveAnswerBusy] = useState(false);
  const [autoAnswer, setAutoAnswer] = useState(false);
  const [showLiveChat, setShowLiveChat] = useState(false);
  const [liveQuestion, setLiveQuestion] = useState('');
  const [screenSources, setScreenSources] = useState<ScreenSource[]>([]);
  const [selectedScreenSourceId, setSelectedScreenSourceId] = useState('');
  const [screenImage, setScreenImage] = useState('');
  const [screenQuestion, setScreenQuestion] = useState(
    'Explain the important information on this screen in the context of our conversation.',
  );
  const [screenAnswer, setScreenAnswer] = useState('');
  const [screenDialogOpen, setScreenDialogOpen] = useState(false);
  const [screenCaptureBusy, setScreenCaptureBusy] = useState(false);
  const [screenAnalysisBusy, setScreenAnalysisBusy] = useState(false);
  const [topics, setTopics] = useState<SessionTopic[]>([]);
  const [topicStatus, setTopicStatus] = useState<'idle' | 'analyzing' | 'ready' | 'error'>('idle');
  const [topicError, setTopicError] = useState('');
  const [selectedText, setSelectedText] = useState('');
  const [explanation, setExplanation] = useState('');
  const [explanationBusy, setExplanationBusy] = useState(false);
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
  const transcriptRef = useRef<HTMLDivElement>(null);
  const liveSegmentsRef = useRef<LiveTranscriptSegment[]>([]);
  const autoAnswerRef = useRef(false);
  const liveAnswerBusyRef = useRef(false);
  const liveCaptureFailureRef = useRef(false);

  const refreshTopics = useCallback(async () => {
    setTopicStatus('analyzing');
    setTopicError('');
    try {
      const result = await api<SessionTopics>(`/sessions/${session.id}/topics`, { method: 'POST' });
      setTopics(result.topics);
      setTopicStatus('ready');
    } catch (cause) {
      setTopicError(messageFor(cause));
      setTopicStatus('error');
    }
  }, [session.id]);

  useEffect(() => {
    let active = true;
    setSegments([]);
    setLiveSegments([]);
    setTopics([]);
    setTopicStatus('idle');
    void api<TranscriptSegment[]>(`/sessions/${session.id}/transcript`)
      .then((loadedSegments) => {
        if (!active) return;
        setSegments(loadedSegments);
        if (loadedSegments.length > 0) {
          void refreshTopics();
        } else {
          setTopics([]);
          setTopicStatus('idle');
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(messageFor(cause));
      });
    return () => { active = false; };
  }, [session.id, refreshTopics]);

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
    setLiveAnswer('');
    setLiveQuestion('');
    setLiveStatus('listening');
    liveSegmentsRef.current = [];
    setLiveSegments([]);
    liveCaptureFailureRef.current = false;
    setAutoAnswer(false);
    autoAnswerRef.current = false;
    setSelectedText('');
    setExplanation('');
    setTopics([]);
    setTopicStatus('idle');
    setElapsedSeconds(0);
    setRecordingState('starting');
    try {
      await recorder.start(handleLiveAudioChunk, (cause) => {
        liveCaptureFailureRef.current = true;
        setLiveStatus('error');
        setError(messageFor(cause));
      });
      setRecordingState('recording');
    } catch (cause) {
      setError(messageFor(cause));
      setRecordingState('ready');
    } finally {
      startPendingRef.current = false;
    }
  }

  async function handleLiveAudioChunk(audio: Blob, offsetSeconds: number) {
    if (liveCaptureFailureRef.current) return;
    setLiveStatus('transcribing');
    try {
      const result = await api<LiveTranscriptSegment[]>(
        `/sessions/${session.id}/live-transcribe?offset_seconds=${offsetSeconds}&unique_from_seconds=${offsetSeconds}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body: audio,
        },
      );
      const previousText = liveSegmentsRef.current.map((segment) => segment.text).join('\n');
      const merged = mergeLiveSegments(liveSegmentsRef.current, result);
      liveSegmentsRef.current = merged;
      setLiveSegments(merged);
      setLiveStatus('listening');
      const hasNewSpeech = merged.map((segment) => segment.text).join('\n') !== previousText;
      if (autoAnswerRef.current && hasNewSpeech) {
        void requestLiveAnswer(undefined, true, merged);
      }
    } catch (cause) {
      liveCaptureFailureRef.current = true;
      setLiveStatus('error');
      setError(messageFor(cause));
    }
  }

  async function requestLiveAnswer(
    prompt?: string,
    automatic = false,
    transcriptSegments = liveSegmentsRef.current,
  ) {
    if (liveAnswerBusyRef.current || transcriptSegments.length === 0) return;
    const transcript = transcriptSegments
      .map((segment) => segment.text)
      .join('\n')
      .slice(-16000);
    if (!transcript.trim()) return;

    liveAnswerBusyRef.current = true;
    setLiveAnswerBusy(true);
    if (!automatic) setLiveAnswer('');
    try {
      const result = await api<{ answered: boolean; response: string }>(
        `/sessions/${session.id}/live-answer`,
        jsonBody({
          transcript,
          question: prompt?.trim() || null,
          auto_answer: automatic,
        }),
      );
      if (result.answered) setLiveAnswer(result.response);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      liveAnswerBusyRef.current = false;
      setLiveAnswerBusy(false);
    }
  }

  async function openScreenCapture() {
    const desktop = window.desktop;
    if (!desktop) {
      setError('Screen capture is available in the desktop app only.');
      return;
    }
    setError('');
    setScreenImage('');
    setScreenAnswer('');
    setScreenDialogOpen(true);
    setScreenCaptureBusy(true);
    try {
      const sources = await desktop.listScreenSources();
      setScreenSources(sources);
      setSelectedScreenSourceId((selected) => (
        sources.some((source) => source.id === selected) ? selected : sources[0]?.id ?? ''
      ));
    } catch (cause) {
      setScreenDialogOpen(false);
      setError(messageFor(cause));
    } finally {
      setScreenCaptureBusy(false);
    }
  }

  async function captureSelectedScreen() {
    const desktop = window.desktop;
    if (!desktop || !selectedScreenSourceId || screenCaptureBusy) return;
    setError('');
    setScreenCaptureBusy(true);
    try {
      const result = await desktop.captureScreen(selectedScreenSourceId);
      setScreenImage(result.imageBase64);
      setScreenAnswer('');
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setScreenCaptureBusy(false);
    }
  }

  async function analyzeCapturedScreen() {
    if (!screenImage || screenAnalysisBusy || health?.vision !== 'ready') return;
    const transcriptSegments = liveSegmentsRef.current.length > 0
      ? liveSegmentsRef.current
      : segments;
    const transcript = transcriptSegments.map((segment) => segment.text).join('\n').slice(-12000);
    setScreenAnswer('');
    setError('');
    setScreenAnalysisBusy(true);
    try {
      const result = await api<{ response: string }>(
        `/sessions/${session.id}/analyze-screen`,
        jsonBody({
          image_base64: screenImage,
          question: screenQuestion,
          transcript,
        }),
      );
      setScreenAnswer(result.response);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setScreenAnalysisBusy(false);
    }
  }

  async function finishRecording() {
    try {
      await recorder.stop();
      await api<Session>(`/sessions/${session.id}/end`, { method: 'POST' });
      const result = await api<TranscriptSegment[]>(`/sessions/${session.id}/transcript`);
      setSegments(result);
      if (result.length === 0) {
        setError('No speech was recognized. Check your microphone level and try again.');
      } else {
        await refreshTopics();
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
      setLiveStatus('idle');
      setLiveSegments([]);
      liveSegmentsRef.current = [];
    }
  }

  function stopRecording() {
    if (recordingState !== 'recording') return;
    setRecordingState('transcribing');
    void finishRecording();
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

  function captureTranscriptSelection() {
    const selection = window.getSelection();
    const transcript = transcriptRef.current;
    if (
      !selection
      || selection.isCollapsed
      || !transcript
      || !selection.anchorNode
      || !selection.focusNode
      || !transcript.contains(selection.anchorNode)
      || !transcript.contains(selection.focusNode)
    ) {
      setSelectedText('');
      setExplanation('');
      return;
    }
    setSelectedText(selection.toString().trim());
    setExplanation('');
  }

  async function explainSelection() {
    if (!selectedText.trim() || selectedText.length > 4000 || explanationBusy) return;
    setError('');
    setExplanation('');
    setExplanationBusy(true);
    try {
      const result = await api<{ response: string }>(
        `/sessions/${session.id}/explain`,
        jsonBody({ text: selectedText }),
      );
      setExplanation(result.response);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setExplanationBusy(false);
    }
  }

  async function downloadSummaryPdf() {
    if (aiBusy || summaryBusy || pdfBusy || explanationBusy) return;
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
    if (aiBusy || summaryBusy || pdfBusy || explanationBusy) return;
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
  const displayedSegments = (
    (recordingState === 'recording' || recordingState === 'transcribing')
    && liveSegments.length > 0
  ) ? liveSegments : segments;
  const topicsByStartSegmentId = new Map(
    topics.map((topic, index) => [topic.start_segment_id, { topic, index }]),
  );

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

      {recordingState === 'recording' && (
        <section className="live-assistant-bar" aria-label="Live session controls">
          <div className="live-assistant-header">
            <div className="live-session-status">
              <span className="live-indicator"><i /> LIVE SESSION</span>
              <span>
                {liveStatus === 'transcribing' ? 'Transcribing locally…'
                  : liveStatus === 'error' ? 'Live transcription needs attention'
                    : 'Listening on this device'}
              </span>
            </div>
            <label className="auto-answer-toggle">
              <input
                type="checkbox"
                checked={autoAnswer}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  autoAnswerRef.current = enabled;
                  setAutoAnswer(enabled);
                }}
                disabled={health?.inference !== 'ready'}
              />
              <span>Auto Answer {autoAnswer ? 'On' : 'Off'}</span>
            </label>
          </div>
          {displayedSegments.length > 0 && (
            <p className="live-caption" aria-live="polite">
              {displayedSegments.slice(-2).map((segment) => segment.text).join(' ')}
            </p>
          )}
          <div className="live-action-row">
            <button
              className="live-action-button answer"
              onClick={() => void requestLiveAnswer()}
              disabled={liveSegments.length === 0 || liveAnswerBusy || health?.inference !== 'ready'}
            >
              <Sparkles size={14} /> {liveAnswerBusy ? 'Answering…' : 'Answer'}
            </button>
            <button className="live-action-button" onClick={() => void openScreenCapture()}>
              <Camera size={14} /> Screenshot
            </button>
            <button
              className={`live-action-button ${showLiveChat ? 'selected' : ''}`}
              onClick={() => setShowLiveChat((visible) => !visible)}
            >
              <MessageCircle size={14} /> Chat
            </button>
            <span className="live-private-note">Audio and screen analysis stay on this device.</span>
          </div>
          {showLiveChat && (
            <form
              className="live-chat-form"
              onSubmit={(event) => {
                event.preventDefault();
                void requestLiveAnswer(liveQuestion);
              }}
            >
              <input
                aria-label="Ask the live assistant"
                value={liveQuestion}
                onChange={(event) => setLiveQuestion(event.target.value)}
                placeholder="Ask about the conversation so far…"
                maxLength={1000}
              />
              <button
                className="live-action-button answer"
                type="submit"
                disabled={liveSegments.length === 0 || liveAnswerBusy || health?.inference !== 'ready' || !liveQuestion.trim()}
              >
                <Send size={14} /> Ask
              </button>
            </form>
          )}
          {liveAnswer && (
            <div className="live-answer" aria-live="polite">
              <b>Local AI answer</b>
              <p>{liveAnswer}</p>
            </div>
          )}
          {liveStatus === 'error' && (
            <div className="live-transcription-warning" role="alert">
              Live captions stopped after an error. Already transcribed segments remain saved on this device.
            </div>
          )}
        </section>
      )}

      <section className="session-grid">
        <article className="session-panel transcript-panel">
          <div className="panel-title">
            <div><h2><AudioLines size={17} /> Transcript</h2><p>Recognized locally after you stop recording</p></div>
          </div>
          {displayedSegments.length === 0
            ? <div className="transcript-empty"><Mic size={22} /><b>{recordingState === 'recording' ? 'Listening for speech…' : 'Your transcript will appear here'}</b><span>{recordingState === 'recording' ? 'Live transcription runs on this device. The first phrase may take longer while the local speech model loads.' : 'Start a recording, speak clearly, then stop to transcribe.'}</span></div>
            : <>
              <section className="topic-navigation" aria-label="Discussion topics">
                <div className="topic-navigation-heading">
                  <div>
                    <b>Discussion topics</b>
                    <span>Jump to a subject in this conversation</span>
                  </div>
                  {topicStatus === 'analyzing' && <span className="topic-status" role="status">Finding topics locally…</span>}
                </div>
                {topicStatus === 'error' && (
                  <div className="topic-error" role="alert">
                    <span>{topicError}</span>
                    <button className="subtle-button" onClick={() => void refreshTopics()} disabled={health?.inference !== 'ready'}>
                      Retry
                    </button>
                  </div>
                )}
                {topicStatus === 'ready' && topics.length === 0 && (
                  <p className="topic-empty">No discussion topics were detected.</p>
                )}
                {topics.length > 0 && (
                  <ol className="topic-list">
                    {topics.map((topic, index) => (
                      <li key={`${topic.start_segment_id}-${topic.end_segment_id}`}>
                        <button
                          className="topic-jump"
                          onClick={() => {
                            document.getElementById(`transcript-segment-${topic.start_segment_id}`)
                              ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          }}
                          aria-label={`Jump to topic ${index + 1}: ${topic.title}, ${formatDuration(topic.start_time)}`}
                        >
                          <span className="topic-number">{index + 1}</span>
                          <span className="topic-copy">
                            <b>{topic.title}</b>
                            <small>{topic.summary}</small>
                          </span>
                          <time>
                            {formatDuration(topic.start_time)}–{formatDuration(topic.end_time)}
                            <ArrowDownToLine size={13} />
                          </time>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              <div
                className="transcript-list"
                ref={transcriptRef}
                onMouseUp={captureTranscriptSelection}
                onKeyUp={captureTranscriptSelection}
              >
                {displayedSegments.map((segment) => {
                  const topicStart = topicsByStartSegmentId.get(segment.id);
                  return (
                    <div className="transcript-segment-group" key={segment.id}>
                      {topicStart && (
                        <div className="transcript-topic-heading">
                          <span>Topic {topicStart.index + 1}</span>
                          <b>{topicStart.topic.title}</b>
                          <time>
                            {formatDuration(topicStart.topic.start_time)}
                            {' – '}
                            {formatDuration(topicStart.topic.end_time)}
                          </time>
                          <p>{topicStart.topic.summary}</p>
                        </div>
                      )}
                      <p className="transcript-segment" id={`transcript-segment-${segment.id}`}>
                        <time>{formatDuration(segment.start_time)}</time>{segment.text}
                      </p>
                    </div>
                  );
                })}
              </div>
            </>}
          {displayedSegments.length > 0 && (
            <div className="transcript-explainer">
              <span>
                {selectedText.length > 4000
                  ? 'Select no more than 4,000 characters.'
                  : 'Select a sentence above to get a simple explanation.'}
              </span>
              <button
                className="subtle-button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void explainSelection()}
                disabled={
                  !selectedText.trim()
                  || selectedText.length > 4000
                  || health?.inference !== 'ready'
                  || explanationBusy
                  || aiBusy
                  || summaryBusy
                  || pdfBusy
                }
              >
                <WandSparkles size={14} />
                {explanationBusy ? 'Explaining locally…' : 'Explain selection'}
              </button>
              {explanation && (
                <div className="ai-answer">
                  <b>Simple explanation</b>
                  <p>{explanation}</p>
                </div>
              )}
            </div>
          )}
          {recordingState === 'ready' && (
            <div className="record-controls">
              <button className="primary-button" onClick={() => void startRecording()}><Mic size={16} /> Start microphone</button>
              <span>The local speech model may download (~145 MB) if it is not already cached.</span>
            </div>
          )}
          {recordingState === 'recording' && (
            <div className="record-controls">
              <button className="stop-button" onClick={stopRecording}><MicOff size={16} /> Stop and save transcript</button>
              <span>Live captions use your microphone only. Computer/system audio is not captured directly.</span>
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
          <fieldset className="summary-style-picker" disabled={!canAskAI || aiBusy || summaryBusy || pdfBusy || explanationBusy}>
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
              disabled={!canAskAI || aiBusy || summaryBusy || pdfBusy || explanationBusy}
            >
              <Sparkles size={15} /> {summaryBusy ? 'Summarizing locally…' : 'Summarize transcript'}
            </button>
            <button
              className="subtle-button"
              onClick={() => void downloadSummaryPdf()}
              disabled={!canAskAI || pdfBusy || aiBusy || summaryBusy || explanationBusy}
            >
              <Download size={14} /> {pdfBusy ? 'Creating PDF…' : 'Download PDF'}
            </button>
          </div>
          {pdfMessage && <p className="export-message" role="status">{pdfMessage}</p>}
          <div className="assistant-divider"><span>OR ASK A QUESTION</span></div>
          <form onSubmit={(event) => void askAI(event)} className="question-form">
            <label htmlFor="question">Question or instruction</label>
            <textarea id="question" value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} maxLength={4000} />
            <button className="primary-button" type="submit" disabled={!canAskAI || aiBusy || summaryBusy || pdfBusy || explanationBusy || !question.trim()}>
              <Send size={15} /> {aiBusy ? 'Thinking locally…' : 'Ask about this session'}
            </button>
          </form>
          {answer && <div className="ai-answer"><b>Local AI response</b><p>{answer}</p></div>}
        </article>
      </section>
      {error && <div className="notice" role="alert"><span className="notice-dot" />{error}</div>}
      {screenDialogOpen && (
        <div className="screen-capture-backdrop" role="presentation">
          <section
            className="screen-capture-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="screen-capture-title"
          >
            <header className="screen-capture-header">
              <div>
                <h2 id="screen-capture-title"><Camera size={17} /> Screen context</h2>
                <p>Choose and preview a screen. Nothing is sent to AI until you select Analyze.</p>
              </div>
              <button
                className="screen-close-button"
                onClick={() => setScreenDialogOpen(false)}
                aria-label="Close screen context"
              >
                <X size={17} />
              </button>
            </header>
            {screenCaptureBusy && <p className="screen-capture-status">Preparing screen capture…</p>}
            {!screenCaptureBusy && screenSources.length === 0 && (
              <p className="screen-capture-status">No screens are available to capture.</p>
            )}
            {!screenImage && screenSources.length > 0 && (
              <>
                <div className="screen-source-list">
                  {screenSources.map((source, index) => (
                    <label
                      className={`screen-source-option ${selectedScreenSourceId === source.id ? 'selected' : ''}`}
                      key={source.id}
                    >
                      <input
                        type="radio"
                        name="screen-source"
                        value={source.id}
                        checked={selectedScreenSourceId === source.id}
                        onChange={() => setSelectedScreenSourceId(source.id)}
                      />
                      <img src={source.thumbnail} alt="" />
                      <span>{source.name || `Display ${index + 1}`}</span>
                    </label>
                  ))}
                </div>
                <button
                  className="primary-button screen-primary-action"
                  onClick={() => void captureSelectedScreen()}
                  disabled={!selectedScreenSourceId || screenCaptureBusy}
                >
                  <Camera size={14} /> Capture selected screen
                </button>
              </>
            )}
            {screenImage && (
              <div className="screen-preview">
                <img src={`data:image/jpeg;base64,${screenImage}`} alt="Preview of the selected screen" />
                <label htmlFor="screen-question">What should the local AI look for?</label>
                <textarea
                  id="screen-question"
                  value={screenQuestion}
                  onChange={(event) => setScreenQuestion(event.target.value)}
                  rows={2}
                  maxLength={1000}
                />
                {health?.vision !== 'ready' && (
                  <div className="model-help screen-model-help">
                    {health?.vision === 'runtime_unavailable'
                      ? 'Start Ollama to enable local screenshot analysis.'
                      : <>Install the on-device vision model with <code>ollama pull qwen3-vl:4b</code>.</>}
                  </div>
                )}
                <div className="screen-dialog-actions">
                  <button className="subtle-button" onClick={() => setScreenImage('')}>
                    Choose another screen
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => void analyzeCapturedScreen()}
                    disabled={health?.vision !== 'ready' || screenAnalysisBusy || !screenQuestion.trim()}
                  >
                    <Sparkles size={14} />
                    {screenAnalysisBusy ? 'Analyzing locally…' : 'Analyze on this device'}
                  </button>
                </div>
                {screenAnswer && (
                  <div className="ai-answer screen-answer">
                    <b>Local screen analysis</b>
                    <p>{screenAnswer}</p>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
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

function mergeLiveSegments(
  existing: LiveTranscriptSegment[],
  incoming: LiveTranscriptSegment[],
): LiveTranscriptSegment[] {
  const merged = [...existing];
  for (const candidate of incoming) {
    const normalized = normalizeTranscriptText(candidate.text);
    const duplicate = merged.some((segment) => (
      normalizeTranscriptText(segment.text) === normalized
      && Math.abs(segment.start_time - candidate.start_time) < 2
    ));
    if (!duplicate) merged.push(candidate);
  }
  return merged.sort((first, second) => first.start_time - second.start_time);
}

function normalizeTranscriptText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
