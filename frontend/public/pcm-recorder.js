// Buffer mono PCM in the audio thread; WAV avoids browser-specific codec/FFmpeg requirements.
class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.offset = 0;
    this.recording = true;
    this.port.onmessage = ({ data }) => {
      if (data === 'stop') {
        this.recording = false;
        if (this.offset) this.port.postMessage(this.buffer.slice(0, this.offset));
        this.port.postMessage('stopped');
      }
    };
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (this.recording && samples) {
      for (const sample of samples) {
        this.buffer[this.offset++] = sample;
        if (this.offset === this.buffer.length) {
          this.port.postMessage(this.buffer);
          this.offset = 0;
        }
      }
    }
    return this.recording;
  }
}
registerProcessor('pcm-recorder', PCMRecorder);
