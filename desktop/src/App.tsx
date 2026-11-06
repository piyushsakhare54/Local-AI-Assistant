import { useCallback, useEffect, useState } from 'react';
import { Activity, AudioLines, Clock3, Headphones, ListChecks, MessageSquareText, Plus, ShieldCheck, Sparkles } from 'lucide-react';
import ContradictionDetector from './ContradictionDetector';
import SessionView from './SessionView';
import PromiseTracker from './PromiseTracker';
import { api, ApiError, Health, jsonBody, Session } from './api';

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [showTracker, setShowTracker] = useState(false);
  const [showContradictions, setShowContradictions] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [service, storedSessions] = await Promise.all([
        api<Health>('/health'),
        api<Session[]>('/sessions'),
      ]);
      setHealth(service);
      setSessions(storedSessions);
      setError('');
    } catch (cause) {
      setHealth(null);
      setError(messageFor(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function createSession() {
    try {
      const session = await api<Session>(
        '/sessions',
        jsonBody({ title: `Session ${new Date().toLocaleString()}`, mode: 'meeting' }),
      );
      setShowTracker(false);
      setShowContradictions(false);
      setActiveSession(session);
      await refresh();
    } catch (cause) {
      setError(messageFor(cause));
    }
  }

  function openTracker() {
    setActiveSession(null);
    setShowContradictions(false);
    setShowTracker(true);
  }

  function openContradictions() {
    setActiveSession(null);
    setShowTracker(false);
    setShowContradictions(true);
  }

  function openSession(session: Session) {
    setShowTracker(false);
    setShowContradictions(false);
    setActiveSession(session);
  }

  function openOverview() {
    setActiveSession(null);
    setShowTracker(false);
    setShowContradictions(false);
  }

  if (showContradictions) {
    return (
      <div className="app-shell">
        <Sidebar sessions={sessions} activeView="contradictions" onCreate={() => void createSession()} onSelect={openSession} onTracker={openTracker} onContradictions={openContradictions} onOverview={openOverview} />
        <main className="main-area">
          <header><div className="breadcrumbs">Workspace <span>/</span> Contradiction Detector</div><ServicePill health={health} /></header>
          <div className="content"><ContradictionDetector /></div>
        </main>
      </div>
    );
  }

  if (showTracker) {
    return (
      <div className="app-shell">
        <Sidebar sessions={sessions} activeView="tracker" onCreate={() => void createSession()} onSelect={openSession} onTracker={openTracker} onContradictions={openContradictions} onOverview={openOverview} />
        <main className="main-area">
          <header><div className="breadcrumbs">Workspace <span>/</span> Promise Tracker</div><ServicePill health={health} /></header>
          <div className="content"><PromiseTracker /></div>
        </main>
      </div>
    );
  }

  if (activeSession) {
    return (
      <div className="app-shell">
        <Sidebar sessions={sessions} activeView="session" onCreate={() => void createSession()} onSelect={openSession} onTracker={openTracker} onContradictions={openContradictions} onOverview={openOverview} />
        <main className="main-area">
          <header><div className="breadcrumbs">Workspace <span>/</span> {activeSession.title}</div><ServicePill health={health} /></header>
          <div className="content">
            <SessionView session={activeSession} health={health} onBack={() => { setActiveSession(null); void refresh(); }} />
            {error && <div className="notice" role="alert"><span className="notice-dot" />{error}</div>}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar sessions={sessions} activeView="overview" onCreate={() => void createSession()} onSelect={openSession} onTracker={openTracker} onContradictions={openContradictions} onOverview={openOverview} />
      <main className="main-area">
        <header><div className="breadcrumbs">Workspace <span>/</span> Overview</div><ServicePill health={health} /></header>
        <div className="content">
          <section className="welcome"><div><div className="eyebrow"><span className="eyebrow-line"/> PRIVATE ON-DEVICE CONVERSATION WORKSPACE</div><h1>Make every conversation<br/><em>more useful.</em></h1><p>Record from your microphone, transcribe locally, and ask an on-device AI about the transcript.</p><button className="primary-button" onClick={() => void createSession()}><Plus size={17}/> Start a session</button></div><div className="hero-graphic"><div className="orb orb-one"/><div className="orb orb-two"/><div className="wave-ring ring-one"/><div className="wave-ring ring-two"/><div className="hero-core"><AudioLines size={33}/></div><span className="floating-chip chip-top"><AudioLines size={14}/> Local transcription</span><span className="floating-chip chip-bottom"><Sparkles size={14}/> Local AI</span></div></section>
          {error && <div className="notice" role="alert"><span className="notice-dot"/>{error}</div>}
          <section className="section-heading"><div><h2>Your workspace</h2><p>Sessions stay on this device.</p></div></section>
          <div className="cards">
            <article className="feature-card feature-main"><div className="card-icon green"><Headphones size={19}/></div><div className="card-kicker">LIVE MICROPHONE SESSION</div><h3>Talk, get help live</h3><p>See local live captions and ask the on-device AI questions while your conversation is happening.</p><button className="text-button" onClick={() => void createSession()}>Start a session <span>↗</span></button></article>
            <article className="feature-card"><div className="card-icon amber"><Sparkles size={19}/></div><div className="card-kicker">LOCAL ASSISTANT</div><h3>Ask about your transcript</h3><p>Run a compact language model on your device. The first setup requires Ollama and a one-time model download.</p><span className="coming-soon">{health?.inference === 'ready' ? 'READY' : 'SETUP REQUIRED'}</span></article>
            <article className="feature-card"><div className="card-icon blue"><Clock3 size={19}/></div><div className="card-kicker">RECENT ACTIVITY</div><h3>{sessions.length ? `${sessions.length} saved session${sessions.length === 1 ? '' : 's'}` : 'Your history starts here'}</h3><p>{sessions.length ? 'Transcripts are stored locally on this device.' : 'Create a session to begin.'}</p><div className="recent-meta"><span className="status-dot"/> {sessions.length ? 'LOCAL HISTORY' : 'NO SESSIONS YET'}</div></article>
          </div>
          <section className="bottom-row"><div className="sessions-panel"><div className="panel-title"><div><h2>Recent sessions</h2><p>Your locally saved conversations</p></div><button className="subtle-button" onClick={() => void refresh()}>Refresh</button></div>{sessions.length === 0 ? <div className="empty-state"><div className="empty-icon"><MessageSquareText size={20}/></div><b>No sessions yet</b><span>Create a session to begin organizing your conversation.</span></div> : <div className="session-list">{sessions.slice(0,5).map((session) => <button className="session-row" key={session.id} onClick={() => setActiveSession(session)}><div className="session-symbol"><MessageSquareText size={17}/></div><div className="session-info"><b>{session.title}</b><span>{session.mode} · {new Date(session.created_at).toLocaleString()}</span></div><span className="session-status">{session.status}</span></button>)}</div>}</div>
            <div className="readiness-panel"><div className="panel-title"><div><h2>System readiness</h2><p>Local components and privacy</p></div><span className="readiness-badge">ON DEVICE</span></div><ReadinessItem label="Local service" value={health?.status === 'ok' ? 'Ready' : 'Offline'} ready={health?.status === 'ok'} /><ReadinessItem label="Speech recognition" value={health?.speech === 'ready' ? 'Ready' : 'Loads on first recording'} ready={health?.speech === 'ready'} /><ReadinessItem label="Local AI" value={health?.inference === 'ready' ? 'Ready' : health?.inference === 'runtime_unavailable' ? 'Install Ollama' : health?.inference === 'model_not_installed' ? 'Download model' : 'Checking'} ready={health?.inference === 'ready'} /><div className="readiness-foot"><ShieldCheck size={15}/> Audio and inference stay on this device</div></div></section>
          <footer><span>LOCAL AI CONVERSATION ASSISTANT</span><span><span className="footer-dot"/> No cloud inference</span></footer>
        </div>
      </main>
    </div>
  );
}

type SidebarProps = {
  sessions: Session[];
  activeView: 'overview' | 'session' | 'tracker' | 'contradictions';
  onCreate: () => void;
  onSelect: (session: Session) => void;
  onTracker: () => void;
  onContradictions: () => void;
  onOverview: () => void;
};

function Sidebar({ sessions, activeView, onCreate, onSelect, onTracker, onContradictions, onOverview }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><AudioLines size={20}/></div><div><strong>Local Assistant</strong><span>PRIVATE BY DESIGN</span></div></div>
      <button className="new-session" onClick={onCreate}><Plus size={17}/> New session</button>
      <div className="nav-label">WORKSPACE</div>
      <nav><button className={activeView === 'overview' ? 'active' : ''} onClick={onOverview}><Activity size={17}/> Overview</button><a href="#sessions"><MessageSquareText size={17}/> Sessions <span className="nav-count">{sessions.length}</span></a><button className={activeView === 'tracker' ? 'active' : ''} onClick={onTracker}><ListChecks size={17}/> Promise Tracker</button><button className={activeView === 'contradictions' ? 'active' : ''} onClick={onContradictions}><Sparkles size={17}/> Contradictions</button></nav>
      <div className="sidebar-bottom"><div className="privacy-note"><ShieldCheck size={17}/><div><b>Local processing</b><span>Audio stays on this device.</span></div></div></div>
      <div className="sidebar-history" id="sessions">{sessions.slice(0, 5).map((session) => <button key={session.id} onClick={() => onSelect(session)}>{session.title}</button>)}</div>
    </aside>
  );
}

function ServicePill({ health }: { health: Health | null }) {
  return <div className="header-right"><span className={`service-pill ${health?.status === 'ok' ? 'online' : ''}`}><i/> {health?.status === 'ok' ? 'Local service ready' : 'Service offline'}</span></div>;
}

function ReadinessItem({ label, value, ready }: { label: string; value: string; ready: boolean }) {
  return <div className={`readiness-item ${ready ? '' : 'muted'}`}><span className={ready ? 'ready-check' : 'ready-pending'}>{ready ? '✓' : '·'}</span><span>{label}</span><b>{value}</b></div>;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'An unexpected error occurred. Please try again.';
}
