type AudioCaptureErrorCode =
  | 'already_recording'
  | 'cancelled'
  | 'device_unavailable'
  | 'not_recording'
  | 'permission_denied'
  | 'recording_failed'
  | 'unsupported';

export class AudioCaptureError extends Error {
  constructor(
    message: string,
    readonly code: AudioCaptureErrorCode,
  ) {
    super(message);
  }
}

export class MicrophoneRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private captureError: AudioCaptureError | null = null;
  private generation = 0;
  private requesting = false;

  async start(): Promise<void> {
    if (this.requesting || this.recorder?.state === 'recording') {
      throw new AudioCaptureError('A microphone recording is already active or starting.', 'already_recording');
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new AudioCaptureError('Microphone recording is not supported on this device.', 'unsupported');
    }

    const generation = ++this.generation;
    this.requesting = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      this.requesting = false;
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        throw new AudioCaptureError(
          'Microphone access was denied. Allow microphone access in Windows and try again.',
          'permission_denied',
        );
      }
      throw new AudioCaptureError(
        'Could not open the microphone. Check that it is connected and not in use by another app.',
        'device_unavailable',
      );
    }

    if (generation !== this.generation) {
      this.requesting = false;
      stream.getTracks().forEach((track) => track.stop());
      throw new AudioCaptureError('Microphone setup was cancelled.', 'cancelled');
    }
    this.requesting = false;
    this.stream = stream;

    try {
      this.chunks = [];
      this.captureError = null;
      this.recorder = new MediaRecorder(this.stream);
      this.recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      };
      this.recorder.onerror = () => {
        this.captureError = new AudioCaptureError('Microphone recording failed.', 'recording_failed');
      };
      this.recorder.start();
    } catch (error) {
      this.releaseStream();
      this.recorder = null;
      throw new AudioCaptureError(
        `Could not start microphone recording: ${error instanceof Error ? error.message : 'unknown error'}`,
        'recording_failed',
      );
    }
  }

  stop(): Promise<Blob> {
    const recorder = this.recorder;
    if (!recorder) {
      return Promise.reject(
        new AudioCaptureError('There is no active microphone recording to stop.', 'not_recording'),
      );
    }
    if (recorder.state !== 'recording') {
      const error = this.captureError
        ?? new AudioCaptureError('There is no active microphone recording to stop.', 'not_recording');
      this.releaseStream();
      this.recorder = null;
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      recorder.addEventListener(
        'stop',
        () => {
          this.releaseStream();
          this.recorder = null;
          const chunks = this.chunks;
          this.chunks = [];
          if (this.captureError) {
            reject(this.captureError);
            return;
          }
          resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
        },
        { once: true },
      );
      try {
        recorder.stop();
      } catch {
        this.releaseStream();
        this.recorder = null;
        this.chunks = [];
        reject(new AudioCaptureError('Could not stop the microphone recording.', 'recording_failed'));
      }
    });
  }

  dispose(): void {
    this.generation += 1;
    this.requesting = false;
    const recorder = this.recorder;
    if (recorder?.state === 'recording') {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      recorder.stop();
    }
    this.recorder = null;
    this.chunks = [];
    this.releaseStream();
  }

  private releaseStream(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}
