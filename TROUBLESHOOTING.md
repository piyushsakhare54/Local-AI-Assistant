# Troubleshooting

- **Service offline in the desktop:** run `npm run dev` from the repository root and reload the app.
- **Outdated backend already running:** stop the old backend terminal/process on port 8765, then start `npm run dev` again so the updated transcript API is loaded.
- **Python dependency resolution fails:** use the managed Python 3.12 runtime (`uv sync --python 3.12`). Python 3.14 is not the project target.
- **Microphone access denied:** allow microphone access in Windows privacy settings, then restart the session.
- **Speech model download or transcription fails:** check internet access for the initial Whisper model download and available disk space under `storage\models\speech`; inference itself runs locally.
- **AI runtime unavailable:** install Ollama for Windows and make sure it is running.
- **AI model missing:** run `ollama pull qwen3:4b` in PowerShell, then refresh the app.
- **System audio missing:** only microphone capture is implemented; system-output capture is not available.
