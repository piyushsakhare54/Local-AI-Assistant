type LiveAudioHandler = (audio: Blob, offsetSeconds: number) => Promise<void>;
type LiveAudioErrorHandler = (error: Error) => void;

type AudioCaptureErrorCode =
  | 'already_recording'
  | 'cancelled'
  | 'device_unavailable'
  | 'not_recording'
  | 'permission_denied'
  | 'recording_failed'
  | 'unsupported';

const LIVE_CHUNK_SECONDS = 5;
const LIVE_OVERLAP_SECONDS = 1;
const LIVE_SAMPLE_RATE = 16_000;

export class AudioCaptureError extends Error {
  constructor(
    message: string,
    readonly code: AudioCaptureErrorCode,
  ) {
    super(message);
  }
}

export class MicrophoneRecorder {
  private stream: MediaStream | null = null;
  private generation = 0;
  private requesting = false;
  private audioContext: AudioContext | null = null;
  private audioProcessor: ScriptProcessorNode | null = null;
  private audioFrames: Float32Array[] = [];
  private frameOffset = 0;
  private pendingSamples = 0;
  private emittedSamples = 0;
  private liveAudioHandler: LiveAudioHandler | null = null;
  private liveAudioErrorHandler: LiveAudioErrorHandler | null = null;
  private liveAudioQueue: Promise<void> = Promise.resolve();

  async start(
    onLiveAudio: LiveAudioHandler,
    onLiveAudioError: LiveAudioErrorHandler,
  ): Promise<void> {
    if (this.requesting || this.audioContext) {
      throw new AudioCaptureError(
        'A microphone recording is already active or starting.',
        'already_recording',
      );
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
      throw new AudioCaptureError('Microphone recording is not supported on this device.', 'unsupported');
    }

    const generation = ++this.generation;
    this.requesting = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (generation !== this.generation) {
        throw new AudioCaptureError('Microphone setup was cancelled.', 'cancelled');
      }
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
      stream.getTracks().forEach((track) => track.stop());
      throw new AudioCaptureError('Microphone setup was cancelled.', 'cancelled');
    }
    this.requesting = false;
    this.stream = stream;
    this.liveAudioHandler = onLiveAudio;
    this.liveAudioErrorHandler = onLiveAudioError;

    try {
      this.audioFrames = [];
      this.frameOffset = 0;
      this.pendingSamples = 0;
      this.emittedSamples = 0;
      this.liveAudioQueue = Promise.resolve();
      await this.startLiveAudioCapture();
    } catch (error) {
      await this.releaseLiveAudioCapture();
      this.releaseStream();
      throw new AudioCaptureError(
        `Could not start live microphone transcription: ${error instanceof Error ? error.message : 'unknown error'}`,
        'recording_failed',
      );
    }
  }

  async stop(): Promise<void> {
    if (!this.stream || !this.audioContext) {
      throw new AudioCaptureError(
        'There is no active microphone recording to stop.',
        'not_recording',
      );
    }
    await this.releaseLiveAudioCapture();
    this.releaseStream();
  }

  dispose(): void {
    this.generation += 1;
    this.requesting = false;
    this.audioFrames = [];
    void this.releaseLiveAudioCapture();
    this.releaseStream();
  }

  private async startLiveAudioCapture(): Promise<void> {
    const stream = this.stream;
    if (!stream) throw new Error('The microphone stream is unavailable.');

    const context = new AudioContext();
    this.audioContext = context;
    await context.resume();
    if (this.audioContext !== context || !this.stream) {
      throw new AudioCaptureError('Microphone setup was cancelled.', 'cancelled');
    }
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const silentOutput = context.createGain();
    silentOutput.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (this.audioContext?.state !== 'running') return;
      const samples = Float32Array.from(event.inputBuffer.getChannelData(0));
      this.audioFrames.push(samples);
      this.pendingSamples += samples.length;
      this.emitReadyChunks(context.sampleRate);
    };
    source.connect(processor);
    processor.connect(silentOutput);
    silentOutput.connect(context.destination);
    this.audioProcessor = processor;
  }

  private emitReadyChunks(sourceSampleRate: number): void {
    const chunkSize = Math.round(sourceSampleRate * LIVE_CHUNK_SECONDS);
    const overlapSize = Math.round(sourceSampleRate * LIVE_OVERLAP_SECONDS);
    while (this.pendingSamples >= chunkSize + overlapSize) {
      const samples = this.takeSamples(chunkSize + overlapSize);
      const offsetSeconds = this.emittedSamples / sourceSampleRate;
      this.emittedSamples += chunkSize;
      this.enqueueLiveAudio(encodeWav(samples, sourceSampleRate), offsetSeconds);
      if (this.frameOffset > 0) {
        const remaining = this.audioFrames[0];
        if (!remaining) throw new Error('The microphone audio buffer is unavailable.');
        this.audioFrames[0] = remaining.subarray(this.frameOffset);
        this.frameOffset = 0;
      }
      this.audioFrames.unshift(samples.slice(chunkSize));
      this.pendingSamples += overlapSize;
    }
  }

  private takeSamples(count: number): Float32Array {
    if (count > this.pendingSamples) throw new Error('The microphone audio buffer is incomplete.');
    const output = new Float32Array(count);
    let written = 0;
    while (written < count) {
      const frame = this.audioFrames[0];
      if (!frame) throw new Error('The microphone audio buffer is unavailable.');
      const available = frame.length - this.frameOffset;
      const copied = Math.min(available, count - written);
      output.set(frame.subarray(this.frameOffset, this.frameOffset + copied), written);
      written += copied;
      this.frameOffset += copied;
      this.pendingSamples -= copied;
      if (this.frameOffset === frame.length) {
        this.audioFrames.shift();
        this.frameOffset = 0;
      }
    }
    return output;
  }

  private enqueueLiveAudio(audio: Blob, offsetSeconds: number): void {
    const handler = this.liveAudioHandler;
    if (!handler) return;
    this.liveAudioQueue = this.liveAudioQueue
      .then(() => handler(audio, offsetSeconds))
      .catch((cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error('Live transcription failed.');
        this.liveAudioErrorHandler?.(error);
      });
  }

  private async releaseLiveAudioCapture(): Promise<void> {
    const context = this.audioContext;
    const processor = this.audioProcessor;
    if (processor) {
      processor.onaudioprocess = null;
      processor.disconnect();
    }
    this.audioProcessor = null;

    if (context && context.state !== 'closed' && this.pendingSamples > 0) {
      const samples = this.takeSamples(this.pendingSamples);
      if (samples.length >= Math.round(context.sampleRate * 0.4)) {
        const offsetSeconds = this.emittedSamples / context.sampleRate;
        this.enqueueLiveAudio(encodeWav(samples, context.sampleRate), offsetSeconds);
      }
    }
    this.audioFrames = [];
    this.pendingSamples = 0;
    this.frameOffset = 0;
    this.liveAudioHandler = null;
    this.liveAudioErrorHandler = null;
    this.audioContext = null;
    if (context && context.state !== 'closed') await context.close();
    await this.liveAudioQueue;
  }

  private releaseStream(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}

function encodeWav(samples: Float32Array, sourceSampleRate: number): Blob {
  const outputLength = Math.floor(samples.length * LIVE_SAMPLE_RATE / sourceSampleRate);
  const output = new ArrayBuffer(44 + outputLength * 2);
  const view = new DataView(output);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + outputLength * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, LIVE_SAMPLE_RATE, true);
  view.setUint32(28, LIVE_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, outputLength * 2, true);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * sourceSampleRate / LIVE_SAMPLE_RATE;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(leftIndex + 1, samples.length - 1);
    const fraction = sourceIndex - leftIndex;
    const sample = samples[leftIndex] * (1 - fraction) + samples[rightIndex] * fraction;
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Blob([output], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
