# Architecture decisions

- Electron owns the desktop shell and explicit recording states. React owns the views; a separate microphone recorder service captures audio.
- FastAPI runs on loopback and owns REST API contracts, SQLite persistence, and orchestration.
- The current audio source is the microphone. Audio is held in memory, sent to local transcription after recording stops, and not persisted as a recording.
- ASR runs through a local faster-whisper service. The Ollama service uses loopback only; there is no cloud inference fallback.
- SQLite stores sessions and transcript segments. Model files and user content live outside Git.
- Diarization and system-audio capture are not implemented. They are not required for microphone transcription or transcript questions.

## Machine assessment (2026-11-06)

The initial setup assessment recorded Windows, Node 22, Python 3.12 through uv, and 24 GiB RAM. Whisper base is configured for CPU INT8 and its weights have been downloaded locally. Ollama and its configured `qwen3:4b` model are not installed, so real AI answers remain unavailable until the user installs them.

## Current milestone

The app starts its desktop frontend and backend together, creates and lists persisted sessions, records microphone audio, transcribes it locally after recording stops, and stores transcript segments. Local Ollama integration and readiness reporting are implemented, but actual AI inference is unavailable until Ollama and `qwen3:4b` are installed. Audio capture and transcription run locally; transcription weights are downloaded only if they are not already cached.
