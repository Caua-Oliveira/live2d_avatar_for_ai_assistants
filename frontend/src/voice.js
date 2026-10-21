export function encodeWav(chunks, sampleRate) {
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true);
  write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped * (clamped < 0 ? 0x8000 : 0x7fff), true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export class VoiceRecorder {
  generation = 0;
  chunks = [];

  async start(onEnded) {
    const generation = ++this.generation;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('O microfone precisa de HTTPS ou localhost para funcionar.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return false; }
      this.stream = stream;
      stream.getAudioTracks()[0].addEventListener('ended', onEnded);
      this.context = new AudioContext();
      await this.context.resume();
      await this.context.audioWorklet.addModule('/pcm-recorder.js');
      if (generation !== this.generation) return false;
      this.chunks = [];
      this.source = this.context.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(this.context, 'pcm-recorder');
      this.node.port.onmessage = ({ data }) => {
        if (data === 'stopped') this.onStopped?.();
        else this.chunks.push(data);
      };
      this.source.connect(this.node);
      // The worklet emits silence, keeping it scheduled without microphone feedback.
      this.node.connect(this.context.destination);
      return true;
    } catch (error) {
      if (generation === this.generation) this.cancel();
      throw error;
    }
  }

  async stop() {
    if (!this.node) return null;
    const sampleRate = this.context.sampleRate;
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 500);
      this.onStopped = () => { clearTimeout(timeout); resolve(); };
      this.node.port.postMessage('stop');
    });
    const wav = encodeWav(this.chunks, sampleRate);
    this.cancel();
    return wav;
  }

  cancel() {
    this.generation++;
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    this.context?.close().catch(() => {});
    this.context = this.source = this.node = this.stream = null;
    this.onStopped?.();
    this.onStopped = null;
    this.chunks = [];
  }
}

export class VoicePlayer {
  generation = 0;

  constructor(audio, onState, onLevel, onError) {
    Object.assign(this, { audio, onState, onLevel, onError });
  }

  async unlock() {
    if (!this.context) {
      this.context = new AudioContext();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      this.samples = new Uint8Array(this.analyser.fftSize);
      this.source = this.context.createMediaElementSource(this.audio);
      this.source.connect(this.analyser);
      this.analyser.connect(this.context.destination);
    }
    await this.context.resume();
  }

  async play(source, emotion, onStarted = () => {}) {
    this.stop();
    const generation = this.generation;
    try {
      await this.unlock();
      if (generation !== this.generation) return;
      if (typeof source !== 'string' || !source) throw new Error('Missing speech audio');
      this.audio.onended = () => {
        if (generation === this.generation) this.stop();
      };
      this.audio.onerror = () => this.playbackError(new Error('Audio unavailable'), generation);
      this.audio.src = source;
      await this.audio.play();
      if (generation !== this.generation) return;
      this.onState(true, emotion);
      onStarted();
      const update = () => {
        if (generation !== this.generation) return;
        let level = 0;
        if (!this.audio.paused && !this.audio.ended) {
          this.analyser.getByteTimeDomainData(this.samples);
          level = Math.sqrt(this.samples.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) / this.samples.length) * 5;
        }
        this.onLevel(Math.min(1, level));
        this.frame = requestAnimationFrame(update);
      };
      update();
    } catch (error) {
      this.playbackError(error, generation);
    }
  }

  playbackError(error, generation) {
    if (generation !== this.generation) return;
    this.stop();
    this.onError(error.name === 'NotAllowedError' ? 'Toque em “Ouvir resposta” para liberar o áudio.' : 'Não foi possível reproduzir a voz. A resposta está na conversa.');
  }

  stop() {
    this.generation++;
    this.audio.onended = this.audio.onerror = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    cancelAnimationFrame(this.frame);
    this.onLevel(0);
    this.onState(false);
  }

  destroy() { this.stop(); this.context?.close(); }
}
