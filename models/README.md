# Local models

Model weights are stored locally and are never committed to this repository. Downloads are opt-in.

For this machine (24 GiB RAM, RTX 4060 Laptop GPU with 4 GiB VRAM), start with a small Whisper model or `large-v3-turbo` on CPU/INT8 after measuring throughput. For the LLM, prefer a Qwen3 GGUF quantized 4B-class option first; Qwen3-8B can use system RAM with partial GPU offload, but 4 GiB VRAM is insufficient for full residency. The app must report actual backend/model health before enabling inference.

The `pyannote/speaker-diarization` repository is gated. Diarization must remain optional, and the user must accept the model conditions and have Hub access before downloading it.
