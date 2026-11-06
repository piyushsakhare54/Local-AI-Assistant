# Testing

Run from the repository root:

```powershell
uv run pytest
uv run ruff check backend
```

Run from `desktop`:

```powershell
npm run typecheck
npm run build
npm audit
```

Backend API tests cover health, session and transcript flows, plus AI request behavior with mocked model services. They do not prove real AI inference.

Local transcription was also checked with generated speech and WebM/Opus audio against the downloaded Whisper base model. Real Ollama inference and physical microphone permission/capture still require manual verification on a machine with Ollama and a microphone configured.

For an end-to-end desktop smoke test:

1. Run `npm run dev` from the repository root.
2. Create a session, grant microphone permission, record a short utterance, and stop recording.
3. Confirm the recognized transcript appears in the session.
4. To test AI answers, install Ollama, run `ollama pull qwen3:4b`, restart the app, and ask a question about the transcript.
