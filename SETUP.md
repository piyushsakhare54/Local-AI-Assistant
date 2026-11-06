# Setup

The backend supports Python 3.12. Use `uv sync --python 3.12` from the repository root and `npm --prefix desktop install`.

Install Ollama for Windows and run `ollama pull qwen3:4b`. Start both services from the repository root with `npm run dev`. The first recording downloads the Whisper `base` model automatically. Speech and AI inference run locally; only transcript text is persisted.
