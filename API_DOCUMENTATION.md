# API

The local FastAPI service binds to `127.0.0.1:8765` by default.

## `GET /api/health`

Returns service, speech-model, text-model, and vision-model readiness. `speech` becomes `"ready"` after the local Whisper model loads. `inference` and `vision` are `"ready"` when Ollama is running locally and each configured model is installed; otherwise they report `"runtime_unavailable"` or `"model_not_installed"`.

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

## `POST /api/sessions/{session_id}/live-transcribe`

Accepts a short WAV audio chunk (up to 5 MB) and `offset_seconds` / `unique_from_seconds` query parameters. Returns timestamp-adjusted speech segments transcribed on-device, filters repeated segments at chunk overlaps, and persists accepted transcript segments locally as they arrive. Audio chunks are not saved. The renderer captures microphone audio only.

## `POST /api/sessions/{session_id}/live-answer`

Body: `{"transcript":"...","question":null,"auto_answer":true}`. Generates a concise answer using only the supplied live conversation and the local text model. With `auto_answer` enabled, it answers only when it detects a clear spoken question; otherwise it returns `{"answered":false,"response":""}`.

## `POST /api/sessions/{session_id}/analyze-screen`

Body: `{"image_base64":"...","question":"What is on screen?","transcript":"..."}`. Sends the user-confirmed screenshot and optional recent transcript context to the configured local vision model. Screenshots are limited to 5 MB and are not persisted.

## `POST /api/sessions/{session_id}/ask`

Body: `{"question":"Summarize the key points"}`. Sends the saved transcript and question to the configured Ollama model at `127.0.0.1:11434`; no remote inference is used. Returns `{"response":"..."}`. A transcript and a ready local model are required.

## `POST /api/sessions/{session_id}/explain`

Body: `{"text":"asynchronous event-driven ingestion pipeline with idempotent processing"}`. Sends the selected text to the configured local Ollama model and returns a concise, plain-language explanation in `{"response":"..."}`. Text is limited to 4,000 characters; a valid session and ready local model are required.

## `POST /api/sessions/{session_id}/topics`

Analyzes the saved transcript with the local Ollama model and returns ordered topic sections with a short summary, start/end timestamps, and transcript segment IDs for navigation. Topic sections are cached locally per session and invalidated when new transcript segments are saved. Longer transcripts are analyzed in overlapping chunks. A valid session and ready local model are required.

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
