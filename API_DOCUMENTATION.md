# API

The local FastAPI service binds to `127.0.0.1:8765` by default.

## `GET /api/health`

Returns service, speech-model, and local AI readiness. `speech` becomes `"ready"` after the local Whisper model loads. `inference` is `"ready"` when Ollama is running locally and the configured model is installed; otherwise it reports `"runtime_unavailable"` or `"model_not_installed"`.

## `GET /api/sessions`

Returns locally stored sessions, newest first.

## `POST /api/sessions`

Body: `{"title":"Planning","mode":"meeting"}`. Mode accepts `meeting` or `interview`. Returns the created session.

## `POST /api/sessions/{session_id}/end`

Marks the session ended and returns the updated session. Unknown IDs return 404.

## `GET /api/sessions/{session_id}/transcript`

Returns the session's locally stored transcript segments in time order.

## `POST /api/sessions/{session_id}/transcribe`

Accepts raw audio bytes (up to 25 MB), transcribes them locally with Whisper, and stores the recognized segments. The model weights download on the first request if they are not already cached.

## `POST /api/sessions/{session_id}/ask`

Body: `{"question":"Summarize the key points"}`. Sends the saved transcript and question to the configured Ollama model at `127.0.0.1:11434`; no remote inference is used. Returns `{"response":"..."}`. A transcript and a ready local model are required.

## Promise Tracker

- `GET /api/commitments` returns saved commitments with source meeting, attribution, due-date wording, and completion evidence.
- `GET /api/commitments/unscanned` lists transcript sessions not yet processed.
- `POST /api/commitments/scan/{session_id}` extracts explicit commitments and reconciles clear completion evidence from that transcript. Failed scans remain retryable.
- `PATCH /api/commitments/{commitment_id}` accepts `{"status":"pending"}` or `{"status":"completed"}` for manual status changes.
- `POST /api/commitments/ask` accepts `{"question":"Which commitments are still pending?"}` and answers from the locally stored tracker.

Extraction and question answering use the configured local Ollama model. Extracted quotes and completion evidence must match text in the source transcript; unknown people and unresolved dates remain unspecified.

## Conversation Contradiction Detector

- `GET /api/contradictions` returns possible inconsistencies with each exact source quote, statement summary, meeting title, and meeting date.
- `GET /api/contradictions/unscanned` lists transcript sessions not yet analyzed.
- `POST /api/contradictions/scan/{session_id}` extracts comparable statements and checks them against statements from earlier meetings.

The detector uses the local Ollama model and requires quotes to match the transcript. Findings are deliberately framed as possible inconsistencies; they do not determine who is right. `changes_commitment` indicates that a newer statement may revise an earlier explicit commitment, not that anyone is at fault.
