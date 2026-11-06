from __future__ import annotations

import os
from dataclasses import dataclass
from io import BytesIO
from threading import Lock

import av
import numpy as np
from av.error import FFmpegError
from numpy.typing import NDArray

# Use resumable HTTP downloads for reliable first-run model setup on Windows.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from faster_whisper import WhisperModel

from app.config import settings

_model: WhisperModel | None = None
_model_lock = Lock()


class TranscriptionError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class TranscribedSegment:
    text: str
    start_time: float
    end_time: float
    language: str | None


def speech_status() -> str:
    return "ready" if _model is not None else "not_configured"


def _get_model() -> WhisperModel:
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is None:
            _model = WhisperModel(
                settings.speech_model,
                device="cpu",
                compute_type="int8",
                download_root=str(settings.speech_model_dir),
            )
    return _model


def _decode_audio(audio: bytes) -> NDArray[np.float32]:
    try:
        with av.open(BytesIO(audio), mode="r") as container:
            if not container.streams.audio:
                raise TranscriptionError("invalid_audio", "The recording contains no audio track.")
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16_000)
            frames = [
                resampled
                for frame in container.decode(audio=0)
                for resampled in resampler.resample(frame)
            ]
            frames.extend(resampler.resample(None))
    except TranscriptionError:
        raise
    except (FFmpegError, OSError, ValueError) as error:
        raise TranscriptionError(
            "invalid_audio",
            f"The audio recording could not be decoded: {error}",
        ) from error

    if not frames:
        raise TranscriptionError("invalid_audio", "The recording contains no readable audio.")
    samples = np.concatenate([frame.to_ndarray().reshape(-1) for frame in frames])
    return samples.astype(np.float32) / np.float32(32_768)


def transcribe_audio(audio: bytes) -> list[TranscribedSegment]:
    if not audio:
        raise TranscriptionError("empty_audio", "No audio was captured.")
    try:
        samples = _decode_audio(audio)
        model = _get_model()
        segments, info = model.transcribe(samples, vad_filter=True)
        return [
            TranscribedSegment(
                text=segment.text.strip(),
                start_time=segment.start,
                end_time=segment.end,
                language=info.language,
            )
            for segment in segments
            if segment.text.strip()
        ]
    except TranscriptionError:
        raise
    except (OSError, RuntimeError, ValueError) as error:
        raise TranscriptionError(
            "transcription_failed",
            f"Local speech recognition failed: {error}",
        ) from error
