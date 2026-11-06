# Engineering conventions

- Keep all inference on the local machine; never add remote inference providers.
- Keep audio capture, ASR, diarization, LLM, persistence, and UI responsibilities separated.
- Do not report model availability until a local health check confirms it.
- Do not log conversation content by default.
- Keep model weights, recordings, uploaded documents, and database files out of version control.
- Add typed interfaces and structured errors at service boundaries.
- Use Python 3.12, `uv`, and strict TypeScript checks.
- Every user-visible recording state must be explicit.
