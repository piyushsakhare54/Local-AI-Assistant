# Audio capture

## Current state

The Windows desktop app records microphone audio using the browser `MediaRecorder` API. Recording state is explicit, and the user stops the recording before local transcription begins. Audio is held in memory, sent to the loopback-only backend, and discarded after transcription; only recognized transcript segments are persisted. Recordings are limited to 25 MB.

Whisper `base` runs on CPU with INT8 quantization through faster-whisper. Its model weights download on the first transcription and are stored under the ignored `storage` directory. This is post-recording transcription, not a live transcript. System-output capture, diarization, and other operating systems are not implemented.
