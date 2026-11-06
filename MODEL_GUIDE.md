# Model guide

## Speech recognition

The application uses faster-whisper with the multilingual `base` model on CPU using INT8. It downloads the model weights the first time the user transcribes a recording; subsequent runs use the local cache under `storage\models\speech`. During recording, five-second microphone chunks with one second of overlap are transcribed on-device for live captions. Only in-flight audio chunks are held in memory; audio is not saved, while accepted transcript segments are persisted locally as they arrive.

## Local language model

The application connects only to Ollama at `127.0.0.1:11434` and uses `qwen3:4b` by default. Install Ollama locally, then run `ollama pull qwen3:4b`. Health reports AI as ready only when the local runtime and selected model are available. No prompts or transcripts are sent to a remote inference service.

## Local screen vision model

Screen analysis uses `qwen3-vl:4b` by default and is optional. Install it with `ollama pull qwen3-vl:4b`; the UI enables analysis only after a local health check confirms the model is installed. A screenshot is captured only when you request it, previewed before analysis, sent to local Ollama only after you confirm, and not saved by the app. Set `OLLAMA_VISION_MODEL` to use another compatible local Ollama vision model.

## Speaker diarization

`pyannote/speaker-diarization` is gated on Hugging Face. It remains optional, and core transcription must work without it. Native source separation can label microphone versus system audio even when diarization is unavailable. Users must accept model terms and authenticate with Hub access before downloading a gated model.

## Hardware detected

Windows 10, 24 GiB system RAM, RTX 4060 Laptop GPU (4 GiB reported VRAM), and about 133 GiB free disk space. These are planning inputs, not benchmarks. No model weights have been downloaded or tested on this machine.
