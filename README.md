# Local AI Conversation Assistant

A privacy-first Windows desktop assistant for microphone recording, local speech transcription, and local AI responses. Audio, transcripts, and prompts stay on this device.

## Current status

The desktop app transcribes short microphone chunks locally with Whisper while you speak and saves recognized transcript segments to SQLite as they arrive. Raw audio chunks are not saved. During a live session, you can ask for an on-device answer, optionally enable Auto Answer for clear spoken questions, and capture a screen to analyze with a local vision model. Screen images are previewed before analysis and are not saved.

## Prerequisites

- Windows 10/11 x64
- Python 3.12 (managed using `uv`)
- Node.js 22 LTS and npm

## Start the backend and desktop

```powershell
cd D:\local-ai-conversation-assistant
uv sync --python 3.12
npm --prefix desktop install
```

Install [Ollama for Windows](https://ollama.com/download/windows), open a new PowerShell window, and download the local AI model:

```powershell
ollama pull qwen3:4b
```

For screen capture analysis, also install the local vision model (several GB):

```powershell
ollama pull qwen3-vl:4b
```

The standard text assistant works without the vision model; screenshot analysis remains disabled until Ollama reports the vision model as ready.

Then start the backend and desktop together:

```powershell
npm run dev
```

The first recording downloads the Whisper `base` speech model (~145 MB) to `storage\models\speech`. If a ready backend is already running on port 8765, the desktop reuses it. Check local component readiness at `http://127.0.0.1:8765/api/health`.

To use it, create a session and select **Start microphone**. Live captions appear as you speak; use **Answer** for a response, enable **Auto Answer** to answer clear spoken questions, or open **Chat** to ask your own question about the conversation so far. Live audio is captured from the microphone only; computer/system audio is not recorded directly. The first transcription can take longer while the speech model downloads.
During a live session, choose **Screenshot**, pick a display, review its preview, and select **Analyze on this device** to ask the local vision model about it. Screenshots are sent only to local Ollama for analysis and are not stored.
After you stop, the saved transcript is processed locally. Choose **To the point** for a short bullet summary or **Explain in the simplest way** for a plain-language explanation, then select **Summarize transcript** to preview it or **Download PDF** to save it with the full transcript.
The session also identifies discussion topics locally, adds their transcript timestamps, and lets you jump straight to each section. Topic sections are generated when a transcript is first opened and cached on this device.
To explain a specific technical statement, select it in the transcript and choose **Explain selection**. The local AI returns a short, plain-language explanation.

Open **Promise Tracker** in the sidebar to review explicit commitments detected in meetings, mark items pending or completed, and ask questions across meetings. Older saved transcripts can be scanned from that page. Unclear speaker identities and due dates are left unspecified; only clear completion evidence from a later transcript marks a commitment complete automatically.

Open **Contradictions** to compare statements across meetings. It shows the earlier and latest transcript quotes, the date and meeting for each statement, and whether the newer statement may change an earlier commitment. These are possible inconsistencies for human review, not conclusions that anyone is wrong. Existing transcripts can be scanned from that page.

## Start only one component

```powershell
# Backend only, from the repository root
uv run uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8765

# Desktop only, from the repository root
npm --prefix desktop run dev
```

## Verify the foundation

```powershell
cd D:\local-ai-conversation-assistant
uv run pytest
uv run ruff check backend
cd desktop
npm run typecheck
```

See [model guide](MODEL_GUIDE.md) for model details and [API documentation](API_DOCUMENTATION.md) for the local service endpoints.
